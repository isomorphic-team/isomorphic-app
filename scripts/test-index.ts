// Golden test for the content index's freshness guard (ensureFresh) — PURE, no
// network. D1 is shimmed over node:sqlite (the same shim the e2e scripts use) and
// GitHub is a stub, so this runs in CI.
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
import { readFileSync } from 'node:fs';
import { ensureFresh, INDEX_SCHEMA_VERSION, listIndexedPages } from '../src/lib/brain-index.ts';
import { githubStore } from '../src/lib/brain-repo.ts';
import { DEFAULT_BRAIN_CONFIG, type BrainConfig } from '../src/lib/brain-policy.ts';
import { pageTitle } from '../src/lib/wiki.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

// ---- D1 shim over node:sqlite, instrumented to count the work each read does ----

const schema = readFileSync(new URL('../src/db/index-schema.sql', import.meta.url), 'utf8');
let sqlite = new DatabaseSync(':memory:');
sqlite.exec(schema);

let stmtCount = 0; // statements executed since the last resetCounters()
let batchCount = 0;
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
			sqlite.prepare(sql).run(...(params as []));
			return { success: true };
		}
	};
}
const db = {
	prepare: (sql: string) => shimStatement(sql),
	batch: async (stmts: { run: () => Promise<unknown> }[]) => {
		batchCount++;
		for (const s of stmts) await s.run();
		return [];
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
			`status: ${i % 2 === 0 ? 'draft' : 'published'}`,
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
			get: async () => ({
				data: { default_branch: 'main', allow_squash_merge: true, allow_merge_commit: true }
			}),
			getBranch: async () => ({ data: { protected: false } }),
			// No .isomorphic.json — the brain uses DEFAULT_BRAIN_CONFIG (wiki/ content).
			getContent: async () => {
				throw Object.assign(new Error('Not Found'), { status: 404 });
			}
		},
		git: {
			getRef: async () => ({ data: { object: { sha: currentHead } } }),
			getCommit: async () => ({ data: { tree: { sha: `tree-${currentHead}` } } }),
			getTree: async () => ({
				data: { tree: currentPages.map((p) => ({ type: 'blob', path: p.path, sha: p.sha })) }
			}),
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
	sqlite.exec(schema);
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

console.log(
	failures === 0 ? '\nAll content-index checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
