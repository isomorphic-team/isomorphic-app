// Golden test for the content index (src/lib/brain-index.ts) over the real
// githubStore. Pure, no network: D1 is shimmed over node:sqlite and GitHub is
// scripts/fake-github.ts, so this runs in CI.
//
// Most of it pins that a read does BOUNDED work: one ensureFresh does at most one
// slice of a reindex or a rebuild, and successive reads converge. An unbounded pass
// is not slow, it is permanent: it exceeds the host's 60s tool timeout, the meta row
// is never written, and the next read starts the same pass over. The rest pins
// write-through after a direct commit, needs-config detection, the config read at
// the indexed revision, the GitHub round-trip budget of a read, and migrations
// re-run against a persisted database.
//
//   pnpm test:index

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	detectNeedsConfig,
	ensureFresh,
	INDEX_SCHEMA_VERSION,
	listIndexedPages,
	writeThroughIndex,
	REBUILD_PAGE_BUDGET,
	REINDEX_PAGE_BUDGET
} from '../src/lib/brain-index.ts';
import { githubStore, MAX_SCAN_PAGES } from '../src/lib/brain-repo.ts';
import { applyMigrations, replayMigrations } from '../src/local/d1-sqlite.ts';
import { DEFAULT_BRAIN_CONFIG, type BrainConfig } from '../src/lib/brain-policy.ts';
import { pageTitle } from '../src/lib/wiki.ts';

import { checker } from './check.ts';
import { fakeGithub, type FakePage } from './fake-github.ts';

const { check, done } = checker('content-index checks');

// ---- D1 shim over node:sqlite, instrumented to count the work each read does ----
//
// Schema comes from the real migrations, not src/db/index-schema.sql, which is a
// reference copy that can drift from what a deployment actually runs. Its own shim
// rather than localD1's, because this test counts statements and batches.

let sqlite = new DatabaseSync(':memory:');
applyMigrations(sqlite);

let stmtCount = 0; // statements executed since the last resetCounters()
let batchCount = 0;
let failBatchStatement: number | null = null;
let beforeBatch: (() => void) | null = null;
function resetCounters() {
	stmtCount = 0;
	batchCount = 0;
}

function shimStatement(sql: string, params: unknown[] = []): any {
	return {
		bind: (...p: unknown[]) => shimStatement(sql, p),
		first: async () => {
			stmtCount++;
			return sqlite.prepare(sql).get(...(params as [])) ?? null;
		},
		all: async () => {
			stmtCount++;
			return { results: sqlite.prepare(sql).all(...(params as [])) };
		},
		run: async () => {
			stmtCount++;
			const result = sqlite.prepare(sql).run(...(params as []));
			return { success: true, meta: { changes: Number(result.changes) } };
		}
	};
}
const db = {
	prepare: (sql: string) => shimStatement(sql),
	batch: async (stmts: { run: () => Promise<unknown> }[]) => {
		batchCount++;
		beforeBatch?.();
		beforeBatch = null;
		const results: unknown[] = [];
		sqlite.exec('BEGIN');
		try {
			for (let i = 0; i < stmts.length; i++) {
				if (i === failBatchStatement) throw new Error('injected batch failure');
				results.push(await stmts[i].run());
			}
			sqlite.exec('COMMIT');
			return results;
		} catch (err) {
			sqlite.exec('ROLLBACK');
			throw err;
		}
	}
} as never;

// ---- a fake brain: N pages with frontmatter, an H1, and links ----

function makePages(n: number, rev = 0): FakePage[] {
	const out: FakePage[] = [];
	for (let i = 0; i < n; i++) {
		const id = String(i).padStart(4, '0');
		const content = [
			'---',
			`type: Note`,
			`status: ${i % 2 === 0 ? 'draft' : 'stable'}`,
			`rank: ${i}`,
			'---',
			'',
			`# Page ${id} rev${rev}`,
			'',
			`Links to [neighbour](./p-${String((i + 1) % n).padStart(4, '0')}.md) and [[Page 0000 rev${rev}]].`
		].join('\n');
		out.push({ path: `wiki/p-${id}.md`, sha: `sha-${id}-r${rev}`, content });
	}
	return out;
}

// The REAL githubStore over a fake octokit, so this still exercises fetchPages'
// GraphQL batching (which gh.calls.graphql asserts) and not just the index logic
// sitting on top of it.
const gh = fakeGithub();
const store = githubStore(gh.octokit);

const repo = { owner: 'example-org', repo: 'brain' };
const brainId = 'example-org/brain';
const config: BrainConfig = { ...DEFAULT_BRAIN_CONFIG };

function resetDb() {
	sqlite = new DatabaseSync(':memory:');
	applyMigrations(sqlite);
	failBatchStatement = null;
	beforeBatch = null;
	gh.configFilesByRef.clear();
	gh.configReadRefs.length = 0;
}

function meta() {
	return sqlite.prepare(`SELECT * FROM brain_index_meta WHERE brain_id = ?`).get(brainId) as
		| { indexed_commit_sha: string | null; schema_version: number; rebuild_cursor: string | null }
		| undefined;
}

function storedTitles(): Map<string, string> {
	const rows = sqlite
		.prepare(`SELECT path, title FROM brain_pages WHERE brain_id = ?`)
		.all(brainId) as { path: string; title: string }[];
	return new Map(rows.map((r) => [r.path, r.title]));
}

function fieldRowCount(): number {
	return (
		sqlite
			.prepare(`SELECT COUNT(*) AS n FROM brain_page_fields WHERE brain_id = ?`)
			.get(brainId) as { n: number }
	).n;
}

// Drive ensureFresh until the index reports itself current, with a hard cap so a
// non-converging implementation fails the test instead of hanging CI.
async function readUntilConverged(maxReads: number): Promise<{ reads: number; peak: number }> {
	let reads = 0;
	let peak = 0;
	for (;;) {
		resetCounters();
		await ensureFresh(db, store, repo, brainId, config);
		reads++;
		peak = Math.max(peak, stmtCount);
		const m = meta();
		if (
			m &&
			m.indexed_commit_sha === gh.head &&
			m.schema_version === INDEX_SCHEMA_VERSION &&
			!m.rebuild_cursor
		) {
			return { reads, peak };
		}
		if (reads >= maxReads) throw new Error(`did not converge in ${maxReads} reads`);
	}
}

// A read must never issue more statements than ONE bounded slice can produce.
// Calibrated from the measured peaks: a reindex slice of 600 pages costs ~4,800
// statements, a rebuild slice of 300 costs ~1,500, and the worst case (a stale
// brain that is also mid-version-bump, doing both in one read) is ~6,300. 8,000
// leaves headroom for linkier pages while still failing loudly if a whole-brain
// pass ever creeps back in — which is the regression this file exists to catch.
const PER_READ_STATEMENT_CEILING = 8_000;

// A read that does a full slice converges in ceil(pages / slice) reads; more than that
// means some read made less progress than it could.
const REINDEX_SLICE = REINDEX_PAGE_BUDGET;
const REBUILD_SLICE = REBUILD_PAGE_BUDGET;
const readsFor = (pages: number, slice: number) => Math.ceil(pages / slice);

console.log('\nContent index — bounded, resumable ensureFresh\n');

// ---------------------------------------------------------------- scenario 1
// A brain small enough to index in one pass still does so in one pass.
{
	console.log('small brain (50 pages), first build');
	resetDb();
	gh.pages = makePages(50);
	gh.head = 'commit-small';
	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	const m = meta();
	check('indexed in a single read', m?.indexed_commit_sha === gh.head);
	check('schema_version at current', m?.schema_version === INDEX_SCHEMA_VERSION);
	check('no rebuild cursor left behind', !m?.rebuild_cursor);
	check('all 50 pages indexed', (await listIndexedPages(db, brainId)).length === 50);

	// Steady state: an unchanged brain must cost essentially nothing.
	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	check('steady-state read writes no batches', batchCount === 0, `batches=${batchCount}`);
}

// ---------------------------------------------------------------- scenario 2
// FIRST build of a brain too big for one request. Before the fix this wrote no
// meta row at all when it ran long, so every later read retried it from scratch.
{
	console.log('\nlarge brain (1500 pages), first build');
	resetDb();
	gh.pages = makePages(1500);
	gh.head = 'commit-large';

	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	const first = stmtCount;
	check('first read is bounded', first < PER_READ_STATEMENT_CEILING, `statements=${first}`);
	check('first read recorded progress (meta row exists)', !!meta());
	check(
		'first read did NOT claim to cover HEAD',
		meta()?.indexed_commit_sha !== gh.head,
		`sha=${meta()?.indexed_commit_sha}`
	);

	const { reads, peak } = await readUntilConverged(20);
	check(
		'converged in one read per reindex slice',
		reads + 1 <= readsFor(1500, REINDEX_SLICE),
		`reads=${reads + 1}`
	);
	check('every read stayed bounded', peak < PER_READ_STATEMENT_CEILING, `peak=${peak}`);
	console.log(`    (peak statements in one read: ${peak})`);
	check('all 1500 pages indexed', (await listIndexedPages(db, brainId)).length === 1500);

	const titles = storedTitles();
	check(
		'titles resolve from the body H1',
		titles.get('wiki/p-0007.md') === 'Page 0007 rev0',
		`got ${titles.get('wiki/p-0007.md')}`
	);
	check('field rows populated', fieldRowCount() > 1500, `fields=${fieldRowCount()}`);
}

// ---------------------------------------------------------------- scenario 3
// THE PRODUCTION WEDGE. Content is current, but the rows predate a schema bump.
// The whole-brain rebuild used to run inline and write schema_version only at the
// end, so on a big brain it timed out and every subsequent read repeated it.
{
	console.log('\nschema_version bump on a 2500-page brain (the production wedge)');
	resetDb();
	gh.pages = makePages(2500);
	gh.head = 'commit-wedge';
	await readUntilConverged(30); // build it normally first

	// Roll the stored rows back to a pre-bump state: stale titles, no field rows.
	sqlite.prepare(`UPDATE brain_index_meta SET schema_version = 0 WHERE brain_id = ?`).run(brainId);
	sqlite.prepare(`UPDATE brain_pages SET title = 'stale' WHERE brain_id = ?`).run(brainId);
	sqlite.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?`).run(brainId);

	resetCounters();
	const graphqlBefore = gh.calls.graphql;
	await ensureFresh(db, store, repo, brainId, config);
	const first = stmtCount;
	check(
		'first read after the bump is bounded',
		first < PER_READ_STATEMENT_CEILING,
		`statements=${first}`
	);
	check('rebuild refetched nothing from GitHub', gh.calls.graphql === graphqlBefore);
	check('schema_version NOT yet advanced (work is unfinished)', meta()?.schema_version === 0);
	check('a resume cursor was recorded', !!meta()?.rebuild_cursor);
	check(
		'indexed_commit_sha untouched (content was already current)',
		meta()?.indexed_commit_sha === gh.head
	);

	const { reads, peak } = await readUntilConverged(30);
	check(
		'rebuild converged in one read per rebuild slice',
		reads + 1 <= readsFor(2500, REBUILD_SLICE),
		`reads=${reads + 1}`
	);
	check('every rebuild read stayed bounded', peak < PER_READ_STATEMENT_CEILING, `peak=${peak}`);
	console.log(`    (peak statements in one read: ${peak})`);
	check('schema_version advanced only at the end', meta()?.schema_version === INDEX_SCHEMA_VERSION);
	check('cursor cleared', !meta()?.rebuild_cursor);

	// Equivalence: the incremental rebuild must produce exactly what a correct
	// whole-brain pass would have.
	const titles = storedTitles();
	const expected = new Map(gh.pages.map((p) => [p.path, pageTitle(p.path, p.content)]));
	const mismatched = [...expected].filter(([path, t]) => titles.get(path) !== t);
	check('every title rebuilt correctly', mismatched.length === 0, `${mismatched.length} wrong`);
	check('no page left with the stale title', ![...titles.values()].includes('stale'));
	check('field rows fully repopulated', fieldRowCount() >= 2500 * 3, `fields=${fieldRowCount()}`);
}

// ---------------------------------------------------------------- scenario 4
// The exact production shape: index BOTH behind HEAD and below the schema version.
{
	console.log('\nstale HEAD + schema bump together (the large-brain shape)');
	resetDb();
	gh.pages = makePages(900);
	gh.head = 'commit-a';
	await readUntilConverged(20);

	// Every page rewritten (new blob shas) AND the row shape rolled back.
	gh.pages = makePages(900, 1);
	gh.head = 'commit-b';
	sqlite.prepare(`UPDATE brain_index_meta SET schema_version = 0 WHERE brain_id = ?`).run(brainId);

	const { reads, peak } = await readUntilConverged(25);
	check(
		'converged within one read per reindex slice plus one per rebuild slice',
		reads <= readsFor(900, REINDEX_SLICE) + readsFor(900, REBUILD_SLICE),
		`reads=${reads}`
	);
	check('every read stayed bounded', peak < PER_READ_STATEMENT_CEILING, `peak=${peak}`);
	console.log(`    (peak statements in one read: ${peak})`);
	check('index now reflects the new HEAD', meta()?.indexed_commit_sha === 'commit-b');
	check('schema_version at current', meta()?.schema_version === INDEX_SCHEMA_VERSION);

	const titles = storedTitles();
	check(
		'content refetched (titles show the new revision)',
		titles.get('wiki/p-0042.md') === 'Page 0042 rev1',
		`got ${titles.get('wiki/p-0042.md')}`
	);
	check('page count unchanged', (await listIndexedPages(db, brainId)).length === 900);
}

// ---------------------------------------------------------------- scenario 5
// Deletions still land, and a shrinking brain converges.
{
	console.log('\ndeletions');
	resetDb();
	gh.pages = makePages(700);
	gh.head = 'commit-c';
	await readUntilConverged(20);

	gh.pages = gh.pages.slice(0, 300);
	gh.head = 'commit-d';
	await readUntilConverged(20);
	check(
		'removed pages dropped from the index',
		(await listIndexedPages(db, brainId)).length === 300
	);
	check('index reflects the new HEAD', meta()?.indexed_commit_sha === 'commit-d');
}

// ---------------------------------------------------------------- scenario 6
// getHead with a named branch: the write path's hottest call used to pay a
// repos.get just to learn the default branch that config already holds.
{
	console.log('\ngetHead with a named branch');
	const before = gh.calls.reposGet;
	const h = await store.getHead(repo, 'main');
	check('named branch skips the repos.get discovery', gh.calls.reposGet === before);
	check(
		'named branch resolves head',
		h.branch === 'main' && h.commitSha === gh.head && !!h.treeSha,
		JSON.stringify(h)
	);
	const h2 = await store.getHead(repo, 'missing');
	check(
		'a missing branch falls back to discovery',
		gh.calls.reposGet === before + 1 && h2.branch === 'main',
		JSON.stringify(h2)
	);
}

// ---------------------------------------------------------------- scenario 7
// Write-through: a direct commit folds its own pages into a FRESH index and
// advances the recorded sha, so the read an agent makes to verify the write is
// the cheap fresh path instead of an incremental reindex (issue #31). Also the
// guard rails: a write based on a stale index must not advance it, deletes
// remove rows, and non-content files in the bundle are ignored.
{
	console.log('\nwrite-through after a direct commit');
	resetDb();
	gh.pages = makePages(20);
	gh.head = 'commit-wt-0';
	await ensureFresh(db, store, repo, brainId, config);
	check('precondition: index fresh at HEAD', meta()?.indexed_commit_sha === gh.head);

	// Simulate a write_page create landing on top: one new page + the changelog.
	const newPage = {
		path: 'wiki/new-page.md',
		content: '---\ntitle: New Page\n---\n\n# New Page\n\nBody text.\n'
	};
	gh.pages = [...gh.pages, { path: newPage.path, sha: 'sha-new-1', content: newPage.content }];
	gh.head = 'commit-wt-1';
	const advanced = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-wt-0',
		'commit-wt-1',
		[newPage, { path: 'wiki/log.md', content: '- created new-page' }],
		[]
	);
	check('write-through advanced a fresh index', advanced === true);
	check('meta records the landed commit', meta()?.indexed_commit_sha === 'commit-wt-1');
	const pages = await listIndexedPages(db, brainId);
	check(
		'the new page is indexed without a reconcile',
		pages.some((p) => p.path === 'wiki/new-page.md' && p.title === 'New Page'),
		JSON.stringify(pages.slice(-2))
	);
	check('the changelog is not indexed', !pages.some((p) => p.path === 'wiki/log.md'));

	// The payoff: the verifying read does no GitHub fetch and writes no batches.
	resetCounters();
	const graphqlBefore = gh.calls.graphql;
	await ensureFresh(db, store, repo, brainId, config);
	check(
		'the verifying read is the cheap fresh path',
		gh.calls.graphql === graphqlBefore && batchCount === 0,
		`graphql=${gh.calls.graphql - graphqlBefore} batches=${batchCount}`
	);

	// A write whose BASE does not match the indexed sha must not advance it —
	// other pages may have changed under it; the next read reconciles.
	const refused = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-wt-0',
		'commit-wt-2',
		[newPage],
		[]
	);
	check(
		'a write based on a stale index is refused',
		refused === false && meta()?.indexed_commit_sha === 'commit-wt-1'
	);

	// Deletes remove rows (the delete half of a move).
	gh.head = 'commit-wt-3';
	const deleted = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-wt-1',
		'commit-wt-3',
		[],
		['wiki/new-page.md']
	);
	check(
		'a delete write-through removes the row',
		deleted === true &&
			!(await listIndexedPages(db, brainId)).some((p) => p.path === 'wiki/new-page.md')
	);

	// The stored blob sha is the REAL git object id, so a later incremental
	// reindex diffs it as unchanged instead of refetching it.
	gh.head = 'commit-wt-4';
	await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-wt-3',
		'commit-wt-4',
		[{ path: 'wiki/empty.md', content: '' }],
		[]
	);
	const row = sqlite
		.prepare(`SELECT blob_sha FROM brain_pages WHERE brain_id = ? AND path = ?`)
		.get(brainId, 'wiki/empty.md') as { blob_sha: string };
	check(
		'blob sha matches git (empty blob)',
		row.blob_sha === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
		row.blob_sha
	);
}

// ---------------------------------------------------------------- scenario 7b
// The "needs setup" flag (issue #94). It must see the config file: listTree
// defaults to markdown only, so the file was never in the tree it inspected and a
// repo whose config put its content under a non-default root was flagged as
// unconfigured. The recommended remedy for that flag overwrites the config, which
// is what makes a false positive here destructive rather than cosmetic.
{
	console.log('\nneeds-config detection sees an existing config');
	resetDb();
	gh.head = 'commit-needs-config';
	gh.pages = [{ path: 'brain/page.md', sha: 'sha-brain-page', content: '# Page\n' }];
	check(
		'markdown outside the default roots with NO config is flagged',
		(await detectNeedsConfig(store, repo, config)) === true
	);
	gh.configFilesByRef.set(gh.head, JSON.stringify({ paths: { 'brain/': 'content' } }));
	check(
		'the same tree WITH a .isomorphic.json is not flagged, whatever config the caller holds',
		(await detectNeedsConfig(store, repo, config)) === false
	);
	gh.configFilesByRef.clear();
	gh.pages = [];
	check(
		'an empty repo is not flagged (nothing to configure)',
		(await detectNeedsConfig(store, repo, config)) === false
	);
	gh.pages = [{ path: 'wiki/page.md', sha: 'sha-wiki-page', content: '# Page\n' }];
	check(
		'markdown under the default roots is not flagged',
		(await detectNeedsConfig(store, repo, config)) === false
	);
}

// ---------------------------------------------------------------- scenario 8
// The request context can predate a config commit. The stale path must read the
// index-shaping config from the exact HEAD it is about to record, otherwise the
// wrong page set is stamped permanently current.
{
	console.log('\nconfig changes at the captured revision');
	resetDb();
	gh.head = 'commit-config-1';
	gh.pages = [
		{ path: 'wiki/old-root.md', sha: 'sha-old-root', content: '# Old root\n' },
		{ path: 'notes/new-root.md', sha: 'sha-new-root', content: '# New root\n' }
	];
	gh.configFilesByRef.set(
		gh.head,
		JSON.stringify({ paths: { 'notes/': 'content' }, index: { fields: ['owner'] } })
	);
	await ensureFresh(db, store, repo, brainId, config); // caller still holds the old wiki/ config
	const paths = (await listIndexedPages(db, brainId)).map((p) => p.path);
	check(
		'the config blob was pinned to the indexed commit',
		gh.configReadRefs.length === 1 && gh.configReadRefs[0] === gh.head,
		JSON.stringify(gh.configReadRefs)
	);
	check(
		'the new root is indexed and the old root is absent',
		paths.length === 1 && paths[0] === 'notes/new-root.md',
		JSON.stringify(paths)
	);
	const batchesBefore = batchCount;
	await ensureFresh(db, store, repo, brainId, {
		...config,
		paths: { 'notes/': 'content' },
		indexedFields: ['owner']
	});
	check('the next read recognizes those rows as fresh', batchCount === batchesBefore);
}

// ---------------------------------------------------------------- scenario 9
// Write-through is one bounded transaction. Failure rolls everything back, a
// generation race makes every mutation a no-op, and bundles too large for one
// transaction retain the normal reconcile path.
{
	console.log('\natomic and conditional write-through');
	resetDb();
	const oldPage = {
		path: 'wiki/atomic.md',
		sha: 'sha-atomic-old',
		content: '---\nowner: old\n---\n\n# Atomic old\n\n[Old](./old.md)\n'
	};
	gh.pages = [oldPage];
	gh.head = 'commit-atomic-0';
	await ensureFresh(db, store, repo, brainId, config);

	const replacement = {
		path: oldPage.path,
		content: '---\nowner: new\n---\n\n# Atomic new\n\n[New](./new.md)\n'
	};
	failBatchStatement = 3;
	let failed = false;
	try {
		await writeThroughIndex(
			db,
			brainId,
			config,
			'commit-atomic-0',
			'commit-atomic-1',
			[replacement],
			[]
		);
	} catch {
		failed = true;
	}
	failBatchStatement = null;
	const afterFailure = sqlite
		.prepare(`SELECT title, content FROM brain_pages WHERE brain_id = ? AND path = ?`)
		.get(brainId, oldPage.path) as { title: string; content: string };
	check('an injected write-through failure is reported', failed);
	check(
		'the failed transaction leaves page and metadata untouched',
		afterFailure.title === 'Atomic old' &&
			afterFailure.content === oldPage.content &&
			meta()?.indexed_commit_sha === 'commit-atomic-0'
	);

	// Simulate another request advancing metadata after the optimistic pre-read but
	// before this transaction starts. Its rows must not be touched.
	beforeBatch = () => {
		sqlite
			.prepare(`UPDATE brain_index_meta SET indexed_commit_sha = ? WHERE brain_id = ?`)
			.run('commit-race-winner', brainId);
	};
	const lostRace = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-atomic-0',
		'commit-race-loser',
		[replacement],
		[]
	);
	const afterRace = sqlite
		.prepare(`SELECT title FROM brain_pages WHERE brain_id = ? AND path = ?`)
		.get(brainId, oldPage.path) as { title: string };
	check(
		'a generation race is a complete no-op',
		lostRace === false &&
			afterRace.title === 'Atomic old' &&
			meta()?.indexed_commit_sha === 'commit-race-winner'
	);

	// Restore the expected base, then exceed the 40-statement transaction budget
	// with distinct links. No partial rows or metadata may land.
	sqlite
		.prepare(`UPDATE brain_index_meta SET indexed_commit_sha = ? WHERE brain_id = ?`)
		.run('commit-atomic-0', brainId);
	const manyLinks = Array.from({ length: 40 }, (_, i) => `[L${i}](./target-${i}.md)`).join('\n');
	const oversized = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-atomic-0',
		'commit-oversized',
		[{ path: 'wiki/oversized.md', content: `# Oversized\n\n${manyLinks}\n` }],
		[]
	);
	check(
		'an oversized bundle skips write-through without mutations',
		oversized === false &&
			meta()?.indexed_commit_sha === 'commit-atomic-0' &&
			!storedTitles().has('wiki/oversized.md')
	);

	// An older Worker must not rewrite rows carrying a newer derivation version.
	sqlite
		.prepare(`UPDATE brain_index_meta SET schema_version = ? WHERE brain_id = ?`)
		.run(INDEX_SCHEMA_VERSION + 1, brainId);
	const futureSchema = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-atomic-0',
		'commit-future-schema',
		[replacement],
		[]
	);
	check(
		'a newer schema version refuses write-through',
		futureSchema === false && meta()?.indexed_commit_sha === 'commit-atomic-0'
	);
}

// ---------------------------------------------------------------- scenario 10
// The freshness marker also owns the partial-index warning. Crossing the scan
// threshold in either direction must update it in the same transaction.
{
	console.log('\nwrite-through truncation boundary');
	resetDb();
	sqlite
		.prepare(
			`INSERT INTO brain_index_meta
			 (brain_id, indexed_commit_sha, truncated, updated_at, schema_version, rebuild_cursor)
			 VALUES (?, ?, 0, 0, ?, NULL)`
		)
		.run(brainId, 'commit-limit-0', INDEX_SCHEMA_VERSION);
	const insert = sqlite.prepare(
		`INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)`
	);
	sqlite.exec('BEGIN');
	for (let i = 0; i < MAX_SCAN_PAGES; i++) {
		insert.run(brainId, `wiki/limit-${i}.md`, `Limit ${i}`, `sha-${i}`, `# Limit ${i}\n`);
	}
	sqlite.exec('COMMIT');
	const crossedUp = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-limit-0',
		'commit-limit-1',
		[{ path: 'wiki/over-limit.md', content: '# Over limit\n' }],
		[]
	);
	const truncatedUp = sqlite
		.prepare(`SELECT truncated FROM brain_index_meta WHERE brain_id = ?`)
		.get(brainId) as { truncated: number };
	check('a create crossing the limit sets truncated', crossedUp && truncatedUp.truncated === 1);
	const crossedDown = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-limit-1',
		'commit-limit-2',
		[],
		['wiki/over-limit.md']
	);
	const truncatedDown = sqlite
		.prepare(`SELECT truncated FROM brain_index_meta WHERE brain_id = ?`)
		.get(brainId) as { truncated: number };
	check(
		'a delete returning to the limit clears truncated',
		crossedDown && truncatedDown.truncated === 0
	);
}

// ---------------------------------------------------------------- scenario 11
// Deterministic latency proxy: GitHub round-trip count, not wall-clock time. The
// legacy stale path paid nine calls here (branch check; default-branch discovery;
// config + write-policy reload; tree + GraphQL fetch). The safe optimized path is
// six, and a verifying read after write-through is one ref lookup.
{
	console.log('\nGitHub request-count latency budget');
	resetDb();
	gh.pages = makePages(10);
	gh.head = 'commit-latency-0';
	const coldBefore = gh.callCount();
	await ensureFresh(db, store, repo, brainId, config);
	const coldCalls = gh.callCount() - coldBefore;
	check(
		'a stale read uses 6 GitHub calls instead of the legacy 9',
		coldCalls === 6,
		`calls=${coldCalls}`
	);
	const latencyPage = { path: 'wiki/latency.md', content: '# Latency\n' };
	gh.pages.push({ ...latencyPage, sha: 'sha-latency' });
	gh.head = 'commit-latency-1';
	const advanced = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-latency-0',
		'commit-latency-1',
		[latencyPage],
		[]
	);
	const verifyBefore = gh.callCount();
	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	const verifyCalls = gh.callCount() - verifyBefore;
	check(
		'write-through reduces the verifying read from 6 calls to 1',
		advanced && verifyCalls === 1 && batchCount === 0,
		`calls=${verifyCalls} batches=${batchCount}`
	);
}

// ---------- migrations against a database that OUTLIVES the process ----------
//
// The rest of this file, and every other battery, migrates a database that is empty
// or in memory, so re-running a migration is free and nothing here could see the
// bug this pins: `pnpm try` keeps its index in the brain's own `.isomorphic/`, and
// its SECOND launch on any folder died with `duplicate column name: schema_version`
// and stayed dead. `CREATE TABLE IF NOT EXISTS` repeats happily; the two
// `ALTER TABLE ... ADD COLUMN` migrations cannot, and SQLite has no
// `ADD COLUMN IF NOT EXISTS`.
{
	const dir = mkdtempSync(join(tmpdir(), 'iso-migrate-'));

	// A file-backed database, opened and migrated twice, which is exactly what two
	// launches of `pnpm try` on one folder do.
	const file = join(dir, 'index.sqlite');
	const first = new DatabaseSync(file);
	applyMigrations(first);
	first.close();

	let reopened = '';
	try {
		const second = new DatabaseSync(file);
		applyMigrations(second);
		// The schema has to still be USABLE, not merely un-thrown: a migration step
		// that silently did not run would leave a column the index writes to missing.
		second.prepare('SELECT schema_version, rebuild_cursor FROM brain_index_meta').all();
		second.close();
	} catch (e) {
		reopened = String(e);
	}
	check('migrations re-run on a persisted database', reopened === '', reopened);

	// A database written by the code that HAD no ledger: every migration applied, no
	// record of it. Those exist on disk in any checkout that ran `pnpm try` before,
	// and they must adopt themselves rather than force the user to delete the file.
	const legacyFile = join(dir, 'legacy.sqlite');
	const legacy = new DatabaseSync(legacyFile);
	replayMigrations(legacy);
	legacy.close();

	let adopted = '';
	try {
		const reopen = new DatabaseSync(legacyFile);
		applyMigrations(reopen);
		reopen.prepare('SELECT schema_version, rebuild_cursor FROM brain_index_meta').all();
		reopen.close();
	} catch (e) {
		adopted = String(e);
	}
	check('a pre-ledger database adopts itself', adopted === '', adopted);
}

console.log('\nDerived state keyed by brain_id: the 0011 re-key');
{
	// Production's shape before 0011: index, ledger and usage rows under "owner/repo".
	// Re-keyed in place, a brain keeps its index; missed, it silently reindexes from
	// GitHub and its usage history reads zero.
	const pre = new DatabaseSync(':memory:');
	replayMigrations(pre, { to: '0011' });
	pre.exec(`
	  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by) VALUES
	    ('c1', 'Acme', 'customer', 200, 'acme', 'u');
	  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name) VALUES
	    ('brain-acme-wiki', 'c1', 'acme', 'wiki');
	  INSERT INTO brain_index_meta (brain_id, indexed_commit_sha) VALUES
	    ('acme/wiki', 'abc'), ('gone/repo', 'def');
	  INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES
	    ('acme/wiki', 'wiki/a.md', 'A', 's1', 'x'), ('acme/wiki', 'wiki/b.md', 'B', 's2', 'y');
	  INSERT INTO brain_links (brain_id, source, raw_target, kind) VALUES
	    ('acme/wiki', 'wiki/a.md', 'b.md', 'md');
	  INSERT INTO brain_page_fields (brain_id, path, key, value) VALUES
	    ('acme/wiki', 'wiki/a.md', 'type', 'note');
	  INSERT INTO write_attempts (brain_id, fingerprint, state, started_at) VALUES
	    ('acme/wiki', 'f1', 'done', 1);
	  INSERT INTO usage_daily (day, org_id, brain_id, user_id, tool, calls) VALUES
	    ('2026-09-01', 'c1', 'acme/wiki', 'u', 'read_page', 3),
	    ('2026-09-01', 'c1', '', 'u', 'members', 1);
	`);
	replayMigrations(pre, { from: '0011', to: '0012' });
	const keys = (table: string) =>
		(
			pre.prepare(`SELECT DISTINCT brain_id FROM ${table} ORDER BY 1`).all() as {
				brain_id: string;
			}[]
		).map((r) => r.brain_id);
	for (const table of ['brain_pages', 'brain_links', 'brain_page_fields', 'write_attempts']) {
		check(
			`${table} is re-keyed to the brain's primary key`,
			JSON.stringify(keys(table)) === JSON.stringify(['brain-acme-wiki']),
			JSON.stringify(keys(table))
		);
	}
	check(
		'the index marker moves with its pages, so the brain does not reindex',
		(
			pre
				.prepare(`SELECT indexed_commit_sha AS sha FROM brain_index_meta WHERE brain_id = ?`)
				.get('brain-acme-wiki') as { sha: string } | undefined
		)?.sha === 'abc'
	);
	check(
		'rows for a repo no brain holds are left alone',
		keys('brain_index_meta').includes('gone/repo')
	);
	check(
		"usage keeps its counts under the brain's key, and org-scope rows stay ''",
		JSON.stringify(keys('usage_daily')) === JSON.stringify(['', 'brain-acme-wiki']),
		JSON.stringify(keys('usage_daily'))
	);
}

done();
