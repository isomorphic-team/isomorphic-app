// The BrainStore contract, run against every backend: the GitHub adapter over the
// in-memory fake (scripts/fake-github.ts) and the fs + git adapter over a temp repo.
// Offline. A new backend joins the BACKENDS list and must pass the same checks.
//
//   pnpm test:store
//
// What it exists to catch:
//   1. A BACKEND THAT DOES NOT SAY WHAT IT CAN DO. Every store declares
//      `capabilities`, and the declaration matches the backend.
//   2. A VERSION TAG THE INDEX CANNOT MATCH. The tag a write returns for a file must
//      equal the tag the next listTree reports for it, or write-through stores a tag
//      the next incremental reindex sees as changed. On GitHub it must be git's own
//      blob id.
//   4. A SQL STORE THAT LOSES OR TEARS A WRITE (sqlBrainStore, the store for a brain the
//      platform holds). A bundle that fails partway leaves nothing behind; a write onto a
//      revision the brain has moved past is refused; bytes round-trip; a read pinned to a
//      revision sees that revision; history is per brain and per path; the files outlive
//      the store object.
//   3. A REVIEW-REQUIRED WRITE THAT LANDS ANYWAY. A store without `proposals` refuses
//      `writeMode: 'pull-request'` and writes nothing, enforced by defineStore before
//      the store's own commitOrPR runs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineStore, type BrainStore, type StoreCapabilities } from '../src/lib/brain-repo.ts';
import { githubStore, gitBlobSha } from '../src/lib/brain-store-github.ts';
import { MAX_FILE_BYTES, sqlBrainStore, sqlFiles } from '../src/lib/brain-store-sql.ts';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { checker, errorOf, partialStore } from './check.ts';
import { fakeGithub, realGitBlobSha } from './fake-github.ts';
import { sqliteDatabase } from './sqlite-database.ts';

const { check, done } = checker('store checks');

const repo = { owner: 'example-org', repo: 'brain' };
const writes = [
	{ path: 'wiki/alpha.md', content: '# Alpha\n\nFirst page.\n' },
	{ path: 'wiki/deep/beta.md', content: '# Beta\n\nUnicode: café, 東京.\n' },
	{ path: 'wiki/empty.md', content: '' }
];

interface Backend {
	name: string;
	expected: StoreCapabilities;
	open(): Promise<BrainStore>;
}

const tmpDirs: string[] = [];

const BACKENDS: Backend[] = [
	{
		name: 'github',
		expected: { atomicWrite: true, proposals: true, history: true },
		open: async () => githubStore(fakeGithub().octokit)
	},
	{
		name: 'fs',
		expected: { atomicWrite: true, proposals: false, history: true },
		open: async () => {
			const dir = mkdtempSync(join(tmpdir(), 'iso-store-'));
			tmpDirs.push(dir);
			await ensureGitRepo(dir);
			return fsBrainStore({ dir });
		}
	},
	{
		name: 'sql',
		expected: { atomicWrite: true, proposals: false, history: true },
		open: async () => sqlBrainStore(sqlFiles(sqliteDatabase()))
	}
];

const PR_REFUSAL = /configured for pull-request writes/;

// ---- defineStore enforces what a store declares ----
{
	let reached = 0;
	const declared = (proposals: boolean) =>
		defineStore(
			partialStore({
				capabilities: { atomicWrite: true, proposals, history: true },
				commitOrPR: async () => {
					reached++;
					return {};
				}
			})
		);
	const pr = { message: 'm', writeMode: 'pull-request' as const, defaultBranch: 'main' };
	const refused = await errorOf(() => declared(false).commitOrPR(repo, pr));
	check(
		'no proposals: pull-request mode is refused before the store runs',
		!!refused && PR_REFUSAL.test(refused) && reached === 0,
		String(refused)
	);
	await declared(false).commitOrPR(repo, { ...pr, writeMode: 'direct' });
	await declared(true).commitOrPR(repo, pr);
	check('direct mode, and pull-request mode with proposals, reach the store', reached === 2);
	check(
		"gitBlobSha matches git's blob id",
		(await gitBlobSha('')) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' &&
			(await gitBlobSha(writes[1].content)) === realGitBlobSha(writes[1].content)
	);
}

for (const backend of BACKENDS) {
	console.log(`\n${backend.name}`);
	const store = await backend.open();

	// 1. capabilities
	check(
		`${backend.name}: declares its capabilities`,
		JSON.stringify(store.capabilities) === JSON.stringify(backend.expected),
		JSON.stringify(store.capabilities)
	);

	// 2. version tags
	const head = await store.getRevision(repo);
	const res = await store.write(repo, { message: 'Add pages', writes, base: head });
	const listed = new Map(
		(await store.listTree(repo, await store.getRevision(repo))).map(
			(e) => [e.path, e.version] as const
		)
	);
	for (const w of writes) {
		check(
			`${backend.name}: ${w.path} write tag equals its listed tag`,
			!!res.versions[w.path] && res.versions[w.path] === listed.get(w.path),
			`write=${res.versions[w.path]} listed=${listed.get(w.path)}`
		);
	}

	// 3. pull-request mode without proposals
	if (!store.capabilities.proposals) {
		const before = await store.getRevision(repo);
		const refused = await errorOf(() =>
			store.commitOrPR(repo, {
				message: 'Should not land',
				writeMode: 'pull-request',
				defaultBranch: before.branch,
				writes: [{ path: 'wiki/refused.md', content: '# Refused\n' }]
			})
		);
		check(`${backend.name}: pull-request mode is refused`, !!refused && PR_REFUSAL.test(refused));
		check(
			`${backend.name}: and nothing was written`,
			(await store.getRevision(repo)).id === before.id
		);
	}
}

// ---- GitHub only: tags are git's blob ids, and a direct commitOrPR reports them ----
{
	console.log('\ngithub tags');
	const store = githubStore(fakeGithub().octokit);
	const res = await store.write(repo, { message: 'Add pages', writes });
	check(
		'github: write tags are git blob ids',
		writes.every((w) => res.versions[w.path] === realGitBlobSha(w.content))
	);
	const edited = '# Alpha\n\nEdited.\n';
	const direct = await store.commitOrPR(repo, {
		message: 'Edit alpha',
		writeMode: 'direct',
		defaultBranch: 'main',
		writes: [{ path: 'wiki/alpha.md', content: edited }]
	});
	check(
		'github: a direct commitOrPR reports the tags with the revision',
		!!direct.landed?.revision.id &&
			direct.landed.versions['wiki/alpha.md'] === realGitBlobSha(edited)
	);
}

// ---- SQL only ----
{
	console.log('\nsql store');
	const db = sqliteDatabase();
	let tick = 0;
	const clock = () => `2026-01-01T00:00:0${tick++}.000Z`;
	const store = sqlBrainStore(sqlFiles(db), clock);
	const author = { name: 'Ada', email: 'ada@example.com' };

	const empty = await store.getRevision(repo);
	check('sql: an empty brain has a revision and no files', empty.id === '0');
	check('sql: and reads nothing', (await store.readFile(repo, 'wiki/alpha.md')) === null);

	const first = await store.write(repo, { message: 'Add pages', writes, author });
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]).toString('base64');
	const second = await store.write(repo, {
		message: 'Edit alpha, drop empty, add an image',
		writes: [
			{ path: 'wiki/alpha.md', content: '# Alpha\n\nEdited.\n' },
			{ path: 'assets/dot.png', content: png, encoding: 'base64' }
		],
		deletes: ['wiki/empty.md', 'wiki/never-existed.md'],
		base: first.revision
	});

	const md = (await store.listTree(repo, second.revision)).map((e) => e.path);
	const all = (await store.listTree(repo, second.revision, { extension: '*' })).map((e) => e.path);
	check(
		'sql: listTree defaults to pages, and a deleted file is gone',
		md.join() === 'wiki/alpha.md,wiki/deep/beta.md',
		md.join()
	);
	check('sql: every file is listed on request', all.includes('assets/dot.png'), all.join());

	const bin = await store.readBinary(repo, 'assets/dot.png');
	check('sql: bytes round-trip exactly', bin?.contentBase64 === png && bin.size === 7);
	const asBytes = await store.readBinary(repo, 'wiki/deep/beta.md');
	check(
		'sql: a text file reads as its UTF-8 bytes',
		Buffer.from(asBytes?.contentBase64 ?? '', 'base64').toString('utf-8') === writes[1].content &&
			asBytes?.size === Buffer.byteLength(writes[1].content)
	);

	const now = await store.readFile(repo, 'wiki/alpha.md');
	const then = await store.readFile(repo, 'wiki/alpha.md', first.revision.id);
	check(
		'sql: a read pinned to a revision sees that revision',
		now?.content === '# Alpha\n\nEdited.\n' && then?.content === writes[0].content
	);
	check(
		'sql: a file deleted since is still read at the revision that had it',
		(await store.readFile(repo, 'wiki/empty.md')) === null &&
			(await store.readFile(repo, 'wiki/empty.md', first.revision.id))?.content === '' &&
			(await store.readFile(repo, 'assets/dot.png', first.revision.id)) === null
	);
	check(
		'sql: a branch name reads what is there now',
		(await store.readFile(repo, 'wiki/alpha.md', 'main'))?.content === now?.content
	);

	const stale = await errorOf(() =>
		store.write(repo, {
			message: 'Planned against the first revision',
			writes: [{ path: 'wiki/stale.md', content: 'x' }],
			base: first.revision
		})
	);
	check(
		'sql: a write onto a revision the brain has moved past is refused',
		stale?.includes('changed since') === true &&
			(await store.branchRevision(repo, 'main')) === second.revision.id &&
			(await store.readFile(repo, 'wiki/stale.md')) === null,
		String(stale)
	);

	// The third statement that touches a file fails: the bundle's commit and its first
	// file are already written inside the transaction.
	let failAt = 0;
	const failing = sqlBrainStore(
		sqlFiles({
			...db,
			sql: {
				exec: (query, ...bindings) => {
					if (/INTO files/.test(query) && --failAt === 0) throw new Error('disk full');
					return db.sql.exec(query, ...bindings);
				}
			}
		})
	);
	failAt = 2;
	const torn = await errorOf(() =>
		failing.write(repo, {
			message: 'Fails on its second file',
			writes: [
				{ path: 'wiki/one.md', content: '1' },
				{ path: 'wiki/two.md', content: '2' }
			]
		})
	);
	check(
		'sql: a bundle that fails partway leaves nothing behind',
		torn === 'disk full' &&
			(await store.branchRevision(repo, 'main')) === second.revision.id &&
			(await store.readFile(repo, 'wiki/one.md')) === null &&
			(await store.listCommits(repo, { limit: 10 })).length === 2,
		String(torn)
	);

	const log = await store.listCommits(repo, { limit: 10 });
	check(
		'sql: history is newest first, with the author and the time',
		log.map((c) => c.message).join('|') === 'Edit alpha, drop empty, add an image|Add pages' &&
			log[1].authorName === 'Ada' &&
			log[1].date === '2026-01-01T00:00:00.000Z' &&
			log[0].authorName === 'Isomorphic',
		JSON.stringify(log)
	);
	const one = await store.listCommits(repo, { limit: 10, path: 'wiki/deep/beta.md' });
	const dropped = await store.listCommits(repo, { limit: 10, path: 'wiki/empty.md' });
	check(
		'sql: history for a path is the commits that touched it, a delete included',
		one.length === 1 && one[0].message === 'Add pages' && dropped.length === 2
	);
	check(
		'sql: history honours its limit',
		(await store.listCommits(repo, { limit: 1 })).length === 1
	);

	const tooBig = await errorOf(() =>
		store.write(repo, {
			message: 'Too big',
			writes: [
				{ path: 'wiki/ok.md', content: 'ok' },
				{ path: 'big.bin', content: 'A'.repeat(MAX_FILE_BYTES + 1), encoding: 'base64' }
			]
		})
	);
	check(
		'sql: a file over the size limit is refused with the whole bundle',
		tooBig?.includes('big.bin') === true && (await store.readFile(repo, 'wiki/ok.md')) === null,
		String(tooBig).slice(0, 120)
	);
	for (const bad of ['', '/abs.md', 'wiki/../x.md', 'wiki//x.md', 'wiki\\x.md']) {
		const err = await errorOf(() =>
			store.write(repo, { message: 'Bad path', writes: [{ path: bad, content: 'x' }] })
		);
		check(`sql: ${JSON.stringify(bad)} is not a path`, err?.includes('Not a path') === true);
	}

	const direct = await store.commitOrPR(repo, {
		message: 'Direct',
		writeMode: 'direct',
		defaultBranch: 'main',
		writes: [{ path: 'wiki/direct.md', content: 'd' }]
	});
	check(
		'sql: a direct commitOrPR reports what it landed, at the revision the brain is now at',
		direct.landed?.revision.id === (await store.branchRevision(repo, 'main')) &&
			direct.landed?.versions['wiki/direct.md'] === direct.landed?.revision.id
	);

	// 2,000 pages of 6 KB is 12 MB: more than one readMany reply holds.
	const many = Array.from({ length: 2000 }, (_, i) => ({
		path: `bulk/p${String(i).padStart(4, '0')}.md`,
		content: `${i}\n` + 'x'.repeat(6000)
	}));
	await store.write(repo, { message: 'Bulk', writes: many });
	const tree = (await store.listTree(repo, await store.getRevision(repo))).filter((e) =>
		e.path.startsWith('bulk/')
	);
	const fetched = await store.fetchPages(repo, tree);
	check(
		'sql: fetchPages returns every page across batches, in order',
		fetched.pages.length === 2000 &&
			!fetched.truncated &&
			fetched.pages.every((p, i) => p.path === many[i].path && p.content === many[i].content)
	);

	const reopened = sqlBrainStore(sqlFiles(db));
	check(
		'sql: a store opened over the same database sees the same brain',
		(await reopened.branchRevision(repo, 'main')) === (await store.branchRevision(repo, 'main')) &&
			(await reopened.readFile(repo, 'wiki/direct.md'))?.content === 'd'
	);
}

// git's background gc can still be writing into .git; a plain rm then hits ENOTEMPTY.
for (const d of tmpDirs)
	rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
done();
