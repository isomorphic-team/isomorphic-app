// Golden test for the content index's freshness guard (ensureFresh) — PURE, no
// network. D1 is shimmed over node:sqlite and GitHub is a stub, so this runs in CI.
//
// What it exists to catch: a read that has to do UNBOUNDED work. That failure mode
// is not "slow", it is "this brain can never be read again" — the pass exceeds the
// host's 60s tool timeout, the meta row is therefore never written, and the next
// read starts the same doomed pass over. It happened in production on a ~3,000-page
// brain after INDEX_SCHEMA_VERSION moved. So every assertion below is some form of
// "one read does a bounded amount of work, and successive reads converge".
//
//   pnpm test:index

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	backlinksTo,
	ensureFresh,
	INDEX_SCHEMA_VERSION,
	listIndexedPages,
	loadResolvedGraph,
	writeThroughIndex
} from '../src/lib/brain-index.ts';
import { githubStore, MAX_SCAN_PAGES } from '../src/lib/brain-repo.ts';
import { applyMigrations } from '../src/local/d1-sqlite.ts';
import { DEFAULT_BRAIN_CONFIG, type BrainConfig } from '../src/lib/brain-policy.ts';
import { pageTitle } from '../src/lib/wiki.ts';

import { checker } from './check.ts';

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

interface FakePage {
	path: string;
	sha: string;
	content: string;
}

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

// GitHub stub. Only the surface the GitHub BrainStore adapter actually touches.
// Wrapped in the REAL githubStore below rather than stubbing BrainStore directly, so
// this still exercises fetchPages' GraphQL batching (which graphqlCalls asserts) and
// not just the index logic sitting on top of it.
let currentPages: FakePage[] = [];
let currentHead = 'commit-0';
let graphqlCalls = 0;
let reposGetCalls = 0;
let getBranchCalls = 0;
let getContentCalls = 0;
let getRefCalls = 0;
let getCommitCalls = 0;
let getTreeCalls = 0;
const configFilesByRef = new Map<string, string>();
const configReadRefs: string[] = [];

function githubCallCount(): number {
	return (
		graphqlCalls +
		reposGetCalls +
		getBranchCalls +
		getContentCalls +
		getRefCalls +
		getCommitCalls +
		getTreeCalls
	);
}

const octokit = {
	graphql: async (_query: string, variables: Record<string, string>) => {
		graphqlCalls++;
		const byOid = new Map(currentPages.map((p) => [p.sha, p]));
		const repository: Record<string, { text: string; isTruncated: boolean } | null> = {};
		for (const [k, v] of Object.entries(variables)) {
			if (!k.startsWith('o')) continue;
			const p = byOid.get(v);
			repository[`b${k.slice(1)}`] = p ? { text: p.content, isTruncated: false } : null;
		}
		return { repository };
	},
	rest: {
		repos: {
			get: async () => {
				reposGetCalls++;
				return {
					data: { default_branch: 'main', allow_squash_merge: true, allow_merge_commit: true }
				};
			},
			getBranch: async () => {
				getBranchCalls++;
				return { data: { protected: false } };
			},
			getContent: async ({ path, ref }: { path: string; ref?: string }) => {
				getContentCalls++;
				if (path === '.isomorphic.json') {
					configReadRefs.push(ref ?? currentHead);
					const content = configFilesByRef.get(ref ?? currentHead);
					if (content !== undefined) {
						return {
							data: {
								type: 'file',
								content: Buffer.from(content).toString('base64'),
								sha: `config-${ref ?? currentHead}`
							}
						};
					}
				}
				throw Object.assign(new Error('Not Found'), { status: 404 });
			}
		},
		git: {
			// `heads/missing` 404s so the getHead fallback has a real branch to try.
			getRef: async ({ ref }: { ref: string }) => {
				getRefCalls++;
				if (ref === 'heads/missing') {
					throw Object.assign(new Error('Not Found'), { status: 404 });
				}
				return { data: { object: { sha: currentHead } } };
			},
			getCommit: async () => {
				getCommitCalls++;
				return { data: { tree: { sha: `tree-${currentHead}` } } };
			},
			getTree: async () => {
				getTreeCalls++;
				return {
					data: {
						tree: currentPages.map((p) => ({ type: 'blob', path: p.path, sha: p.sha }))
					}
				};
			},
			getBlob: async () => {
				throw new Error('getBlob should not be needed (no oversized blobs in this fixture)');
			}
		}
	}
} as never;

const store = githubStore(octokit);

const repo = { owner: 'example-org', repo: 'brain' };
const brainId = 'example-org/brain';
const config: BrainConfig = { ...DEFAULT_BRAIN_CONFIG };

function resetDb() {
	sqlite = new DatabaseSync(':memory:');
	applyMigrations(sqlite);
	failBatchStatement = null;
	beforeBatch = null;
	configFilesByRef.clear();
	configReadRefs.length = 0;
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
			m.indexed_commit_sha === currentHead &&
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

console.log('\nContent index — bounded, resumable ensureFresh\n');

// ---------------------------------------------------------------- scenario 1
// A brain small enough to index in one pass still does so in one pass.
{
	console.log('small brain (50 pages), first build');
	resetDb();
	currentPages = makePages(50);
	currentHead = 'commit-small';
	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	const m = meta();
	check('indexed in a single read', m?.indexed_commit_sha === currentHead);
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
	currentPages = makePages(1500);
	currentHead = 'commit-large';

	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	const first = stmtCount;
	check('first read is bounded', first < PER_READ_STATEMENT_CEILING, `statements=${first}`);
	check('first read recorded progress (meta row exists)', !!meta());
	check(
		'first read did NOT claim to cover HEAD',
		meta()?.indexed_commit_sha !== currentHead,
		`sha=${meta()?.indexed_commit_sha}`
	);

	const { reads, peak } = await readUntilConverged(20);
	check(`converged over successive reads (${reads + 1} total)`, true);
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
	currentPages = makePages(2500);
	currentHead = 'commit-wedge';
	await readUntilConverged(30); // build it normally first

	// Roll the stored rows back to a pre-bump state: stale titles, no field rows.
	sqlite.prepare(`UPDATE brain_index_meta SET schema_version = 0 WHERE brain_id = ?`).run(brainId);
	sqlite.prepare(`UPDATE brain_pages SET title = 'stale' WHERE brain_id = ?`).run(brainId);
	sqlite.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?`).run(brainId);

	resetCounters();
	const graphqlBefore = graphqlCalls;
	await ensureFresh(db, store, repo, brainId, config);
	const first = stmtCount;
	check(
		'first read after the bump is bounded',
		first < PER_READ_STATEMENT_CEILING,
		`statements=${first}`
	);
	check('rebuild refetched nothing from GitHub', graphqlCalls === graphqlBefore);
	check('schema_version NOT yet advanced (work is unfinished)', meta()?.schema_version === 0);
	check('a resume cursor was recorded', !!meta()?.rebuild_cursor);
	check(
		'indexed_commit_sha untouched (content was already current)',
		meta()?.indexed_commit_sha === currentHead
	);

	const { reads, peak } = await readUntilConverged(30);
	check(`rebuild converged (${reads + 1} reads total)`, true);
	check('every rebuild read stayed bounded', peak < PER_READ_STATEMENT_CEILING, `peak=${peak}`);
	console.log(`    (peak statements in one read: ${peak})`);
	check('schema_version advanced only at the end', meta()?.schema_version === INDEX_SCHEMA_VERSION);
	check('cursor cleared', !meta()?.rebuild_cursor);

	// Equivalence: the incremental rebuild must produce exactly what a correct
	// whole-brain pass would have.
	const titles = storedTitles();
	const expected = new Map(currentPages.map((p) => [p.path, pageTitle(p.path, p.content)]));
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
	currentPages = makePages(900);
	currentHead = 'commit-a';
	await readUntilConverged(20);

	// Every page rewritten (new blob shas) AND the row shape rolled back.
	currentPages = makePages(900, 1);
	currentHead = 'commit-b';
	sqlite.prepare(`UPDATE brain_index_meta SET schema_version = 0 WHERE brain_id = ?`).run(brainId);

	const { reads, peak } = await readUntilConverged(25);
	check(`converged (${reads} reads)`, true);
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
	currentPages = makePages(700);
	currentHead = 'commit-c';
	await readUntilConverged(20);

	currentPages = currentPages.slice(0, 300);
	currentHead = 'commit-d';
	await readUntilConverged(20);
	check(
		'removed pages dropped from the index',
		(await listIndexedPages(db, brainId)).length === 300
	);
	check('index reflects the new HEAD', meta()?.indexed_commit_sha === 'commit-d');
}

// ---- attachments in the link graph ----
//
// The bug this pins: MD_LINK_RE always captured `![](…)`, so image links were in
// brain_links all along, but loadResolvedGraph dropped every non-.md target. That
// made backlinksTo report an attachment as referenced by nobody, which in turn made
// move_page repoint nothing and delete_page call a still-used image unreferenced.
//
// Note what is deliberately NOT set up here: the .png is never added to the tree
// stub. Assets are not inventoried by the index, and the asset edge has to come from
// the LINK alone, so this fixture is the design's actual shape.
{
	console.log('\nattachments in the link graph');
	resetDb();
	currentPages = [
		{
			path: 'wiki/vendors/acme.md',
			sha: 'sha-acme-1',
			content: [
				'# Acme',
				'',
				'![The logo](./assets/logo.png)',
				'A [real page](../index.md) and a [missing one](./nope.md).',
				'A [source doc](../../raw/notes.txt) too.',
				'And a [spreadsheet](./data/pricing.csv) the app cannot render.'
			].join('\n')
		},
		{
			path: 'wiki/index.md',
			sha: 'sha-index-1',
			content: '# Index\n\nAlso shows ![it](./vendors/assets/logo.png).'
		}
	];
	currentHead = 'commit-assets';
	await ensureFresh(db, store, repo, brainId, config);
	const g = await loadResolvedGraph(db, brainId, config);

	const asset = 'wiki/vendors/assets/logo.png';
	check(
		'image link is recorded as an asset edge',
		g.fileEdges.some((e) => e.source === 'wiki/vendors/acme.md' && e.target === asset),
		JSON.stringify(g.fileEdges)
	);
	check(
		'a second page referencing it is recorded too',
		g.fileEdges.filter((e) => e.target === asset).length === 2,
		JSON.stringify(g.fileEdges)
	);
	// The graph view builds nodes from `pages` and degree from `edges`; an asset in
	// that list would be a link to a node the renderer has no data for.
	check(
		'asset edges stay OUT of the page edge list',
		!g.edges.some((e) => e.target === asset),
		JSON.stringify(g.edges)
	);
	check(
		'page-to-page links still resolve',
		g.edges.some((e) => e.source === 'wiki/vendors/acme.md' && e.target === 'wiki/index.md')
	);
	// The whole reason assets are never "broken": the index has no inventory of which
	// ones exist, so it cannot tell a typo from a file it has not indexed.
	check(
		'a missing attachment is never reported broken',
		!g.broken.some((b) => b.target?.endsWith('.png')),
		JSON.stringify(g.broken)
	);
	check(
		'but a missing PAGE still is',
		g.broken.some((b) => b.target === 'wiki/vendors/nope.md'),
		JSON.stringify(g.broken)
	);
	// Regression guard on the pre-existing rule: source material is not indexed, so a
	// link into raw/ is not broken either, and must not have become a file edge.
	check(
		'a link into source material is neither broken nor a file edge',
		!g.broken.some((b) => b.target?.startsWith('raw/')) &&
			!g.fileEdges.some((e) => e.target.startsWith('raw/')),
		JSON.stringify({ broken: g.broken, fileEdges: g.fileEdges })
	);
	// A non-page file the APP cannot render is still a file the brain can lose. This
	// is the case that fell between the two implementations: the media allowlist said
	// "not an asset" and dropped it, while delete_page's separate query found it. One
	// rule now, so deleting a linked .csv warns exactly as deleting a .png does.
	const csv = 'wiki/vendors/data/pricing.csv';
	check(
		'a link to a non-media content file is a file edge too',
		g.fileEdges.some((e) => e.target === csv),
		JSON.stringify(g.fileEdges)
	);
	check(
		'and backlinksTo finds it',
		backlinksTo(g, csv).some((r) => r.path === 'wiki/vendors/acme.md'),
		JSON.stringify(backlinksTo(g, csv))
	);
	check(
		'while staying out of the page edge list',
		!g.edges.some((e) => e.target === csv),
		JSON.stringify(g.edges)
	);

	// The payoff: this is the call move_page and delete_page make.
	const refs = backlinksTo(g, asset);
	check(
		'backlinksTo finds both referrers of an attachment',
		refs.length === 2,
		JSON.stringify(refs)
	);
	check(
		'and counts them, so "still referenced" can say how many',
		refs.every((r) => r.count === 1),
		JSON.stringify(refs)
	);
	// Backlinks for pages must be unaffected by reading two lists instead of one.
	const pageRefs = backlinksTo(g, 'wiki/index.md');
	check(
		'page backlinks still work and do not pick up assets',
		pageRefs.length === 1 && pageRefs[0].path === 'wiki/vendors/acme.md',
		JSON.stringify(pageRefs)
	);
}

// ---------------------------------------------------------------- scenario 6
// getHead with a named branch: the write path's hottest call used to pay a
// repos.get just to learn the default branch that config already holds.
{
	console.log('\ngetHead with a named branch');
	const before = reposGetCalls;
	const h = await store.getHead(repo, 'main');
	check('named branch skips the repos.get discovery', reposGetCalls === before);
	check(
		'named branch resolves head',
		h.branch === 'main' && h.commitSha === currentHead && !!h.treeSha,
		JSON.stringify(h)
	);
	const h2 = await store.getHead(repo, 'missing');
	check(
		'a missing branch falls back to discovery',
		reposGetCalls === before + 1 && h2.branch === 'main',
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
	currentPages = makePages(20);
	currentHead = 'commit-wt-0';
	await ensureFresh(db, store, repo, brainId, config);
	check('precondition: index fresh at HEAD', meta()?.indexed_commit_sha === currentHead);

	// Simulate a write_page create landing on top: one new page + the changelog.
	const newPage = {
		path: 'wiki/new-page.md',
		content: '---\ntitle: New Page\n---\n\n# New Page\n\nBody text.\n'
	};
	currentPages = [
		...currentPages,
		{ path: newPage.path, sha: 'sha-new-1', content: newPage.content }
	];
	currentHead = 'commit-wt-1';
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
	const graphqlBefore = graphqlCalls;
	await ensureFresh(db, store, repo, brainId, config);
	check(
		'the verifying read is the cheap fresh path',
		graphqlCalls === graphqlBefore && batchCount === 0,
		`graphql=${graphqlCalls - graphqlBefore} batches=${batchCount}`
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
	currentHead = 'commit-wt-3';
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
	currentHead = 'commit-wt-4';
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

// ---------------------------------------------------------------- scenario 8
// The request context can predate a config commit. The stale path must read the
// index-shaping config from the exact HEAD it is about to record, otherwise the
// wrong page set is stamped permanently current.
{
	console.log('\nconfig changes at the captured revision');
	resetDb();
	currentHead = 'commit-config-1';
	currentPages = [
		{ path: 'wiki/old-root.md', sha: 'sha-old-root', content: '# Old root\n' },
		{ path: 'notes/new-root.md', sha: 'sha-new-root', content: '# New root\n' }
	];
	configFilesByRef.set(
		currentHead,
		JSON.stringify({ paths: { 'notes/': 'content' }, index: { fields: ['owner'] } })
	);
	await ensureFresh(db, store, repo, brainId, config); // caller still holds the old wiki/ config
	const paths = (await listIndexedPages(db, brainId)).map((p) => p.path);
	check(
		'the config blob was pinned to the indexed commit',
		configReadRefs.length === 1 && configReadRefs[0] === currentHead,
		JSON.stringify(configReadRefs)
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
	currentPages = [oldPage];
	currentHead = 'commit-atomic-0';
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
	currentPages = makePages(10);
	currentHead = 'commit-latency-0';
	const coldBefore = githubCallCount();
	await ensureFresh(db, store, repo, brainId, config);
	const coldCalls = githubCallCount() - coldBefore;
	check(
		'a stale read uses 6 GitHub calls instead of the legacy 9',
		coldCalls === 6,
		`calls=${coldCalls}`
	);
	const latencyPage = { path: 'wiki/latency.md', content: '# Latency\n' };
	currentPages.push({ ...latencyPage, sha: 'sha-latency' });
	currentHead = 'commit-latency-1';
	const advanced = await writeThroughIndex(
		db,
		brainId,
		config,
		'commit-latency-0',
		'commit-latency-1',
		[latencyPage],
		[]
	);
	const verifyBefore = githubCallCount();
	resetCounters();
	await ensureFresh(db, store, repo, brainId, config);
	const verifyCalls = githubCallCount() - verifyBefore;
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
	const migrations = new URL('../migrations/', import.meta.url);
	for (const f of readdirSync(migrations)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		legacy.exec(readFileSync(new URL(f, migrations), 'utf8'));
	}
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

done();
