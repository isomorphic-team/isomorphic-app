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
//   5. A COPY THAT SERVES A BRAIN IT DID NOT FINISH (copyStep, relocateToPlatformFiles).
//      A step copies within its budget and resumes where it stopped; the copy is done
//      only when the destination holds exactly the source's files at a revision the
//      source is still at; bytes and text arrive as they were; the brain is bound to the
//      new storage only then.
//   6. A BACKUP THAT CANNOT BE RESTORED, OR CAN BE READ (backupStep, readBackup, pnpm
//      backup:restore). A backup is the files of one revision, in parts, and reads back
//      byte for byte with the private key and not without it; a step that fails resumes;
//      a brain is due only after it changes, at most once an interval; old backups are
//      pruned; the bucket holds no path and no content in the clear.
//   7. A DRIVE STORE THAT MISPLACES A FILE OR WRITES OVER SOMEONE'S EDIT (driveBrainStore,
//      over a fake Google Drive). A path resolves to one file though Drive allows two of
//      a name; folders are made once; the revision moves when a file under the folder
//      does, and only then; a write planned before someone else's edit to the same file
//      is a conflict and writes nothing; a bundle that fails partway is rolled back; a
//      throttled request is retried.
//   3. A REVIEW-REQUIRED WRITE THAT LANDS ANYWAY. A store without `proposals` refuses
//      `writeMode: 'pull-request'` and writes nothing, enforced by defineStore before
//      the store's own commitOrPR runs.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineStore, type BrainStore, type StoreCapabilities } from '../src/lib/brain-repo.ts';
import { githubStore, gitBlobSha } from '../src/lib/brain-store-github.ts';
import {
	createBrainFolder,
	driveApi,
	driveBrainStore,
	driveStorageName,
	listDrive
} from '../src/lib/brain-store-drive.ts';
import { inMemoryWriteCoordinator } from '../src/lib/write-coordinator.ts';
import {
	BACKUPS_KEPT,
	backupDue,
	backupIntervalMs,
	backupPrefix,
	backupStep,
	generateBackupKeys,
	importBackupPrivateKey,
	importBackupPublicKey,
	openPart,
	readBackup,
	type BackupBucket
} from '../src/lib/brain-backup.ts';
import {
	MAX_FILE_BYTES,
	filesObjectName,
	sqlBrainStore,
	sqlFiles
} from '../src/lib/brain-store-sql.ts';
import {
	RELOCATION_KIND,
	copyStep,
	cameFromRepository,
	fileWriteFor,
	relocateBrain,
	type MoveTarget
} from '../src/lib/brain-relocate.ts';
import {
	PLATFORM_FILES_KIND,
	bindingStatement,
	credentialFor,
	githubConnectionForAccount,
	platformFilesBinding
} from '../src/lib/storage-connections.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { bindFixtureStorage } from './fixture-storage.ts';
import { listAccessibleBrains } from '../src/lib/orgs.ts';
import { d1Index, indexRefs } from '../src/lib/brain-index.ts';
import { DEFAULT_BRAIN_CONFIG } from '../src/lib/brain-policy.ts';
import { MAX_ATTACHMENT_BYTES } from '../src/lib/media.ts';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { checker, errorOf, partialStore } from './check.ts';
import { fakeGithub, realGitBlobSha } from './fake-github.ts';
import { fakeGoogleDrive, md5 } from './fake-google-drive.ts';
import { folderReader, restoreInto } from './backup-restore.ts';
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

// The Drive store over a fake Drive. A new store on the same fake reads what an earlier
// one wrote, as a later request would.
function driveFixture(opts: { pageSize?: number } = {}) {
	const drive = fakeGoogleDrive(opts);
	const api = driveApi(
		drive.fetch,
		async () => 'test-token',
		async () => {}
	);
	const root = { folderId: drive.rootId };
	const coordinator = inMemoryWriteCoordinator();
	const at = (folderId: string) => driveBrainStore(api, { folderId }, coordinator, 'brain-1');
	return { drive, api, root, at, open: () => at(root.folderId) };
}

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
	},
	{
		name: 'drive',
		expected: { atomicWrite: false, proposals: false, history: false },
		open: async () => driveFixture().open()
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

	// Every store takes "*" for all files: folder moves and relocation list that way.
	await store.write(repo, {
		message: 'Add a non-page file',
		writes: [{ path: 'wiki/assets/data.csv', content: 'a,b\n' }],
		base: await store.getRevision(repo)
	});
	const everything = (
		await store.listTree(repo, await store.getRevision(repo), { extension: '*' })
	).map((e) => e.path);
	check(
		`${backend.name}: listTree with "*" lists pages and other files`,
		everything.includes('wiki/assets/data.csv') && writes.every((w) => everything.includes(w.path)),
		everything.join()
	);
	await store.write(repo, {
		message: 'Remove it',
		writes: [],
		deletes: ['wiki/assets/data.csv'],
		base: await store.getRevision(repo)
	});

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

	check(
		'sql: a files object is named for its brain, within a scope when there is one',
		filesObjectName('brain-a') === 'brain-a' &&
			filesObjectName('brain-a', '') === 'brain-a' &&
			filesObjectName('brain-a', 'pr-12') === 'pr-12:brain-a' &&
			filesObjectName('brain-a', 'pr-12') !== filesObjectName('brain-a', 'pr-13')
	);

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

	// The bundle's second file fails: its commit and its first file are already written
	// inside the transaction.
	let failAt = 2;
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
	const newest = await store.listCommits(repo, { limit: 1, path: 'wiki/empty.md' });
	check(
		'sql: newest first, and within its limit',
		dropped[0].message.startsWith('Edit alpha') &&
			newest.length === 1 &&
			newest[0].sha === dropped[0].sha
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
	check(
		'sql: a full-size attachment fits in one file as base64',
		Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 <= MAX_FILE_BYTES
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

// ---- Drive only ----
{
	console.log('\ndrive store');
	const { drive, api, root, open } = driveFixture({ pageSize: 2 });
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a]);
	const store = open();
	const first = await store.write(repo, {
		message: 'Add pages',
		writes: [
			...writes,
			{ path: 'wiki/deep/pic.png', content: png.toString('base64'), encoding: 'base64' }
		]
	});
	check(
		'drive: files land at their paths, bytes as written',
		drive.tree()['wiki/deep/beta.md'] === writes[1].content &&
			drive.find('wiki/deep/pic.png')?.bytes?.equals(png) === true &&
			drive.tree()['wiki/empty.md'] === ''
	);
	check(
		'drive: a version tag is the md5 of the bytes',
		first.versions['wiki/deep/beta.md'] === md5(writes[1].content) &&
			first.versions['wiki/deep/pic.png'] === md5(png)
	);
	await store.write(repo, {
		message: 'Add gamma',
		writes: [{ path: 'wiki/deep/gamma.md', content: '# Gamma\n' }]
	});
	check(
		'drive: a folder is made once',
		JSON.stringify(drive.folders().sort()) === JSON.stringify(['wiki', 'wiki/deep'])
	);

	// A later request: a new store, a new listing (three pages of two at the deepest level).
	const later = open();
	const head = await later.getRevision(repo);
	check(
		'drive: a new store reports the revision the last write returned',
		head.id === (await store.getRevision(repo)).id && head.id !== first.revision.id
	);
	const listed = await later.listTree(repo, head);
	check(
		'drive: listTree lists pages across result pages, with the tags written',
		listed.map((e) => e.path).join() ===
			'wiki/alpha.md,wiki/deep/beta.md,wiki/deep/gamma.md,wiki/empty.md' &&
			listed[1].version === first.versions['wiki/deep/beta.md']
	);
	check(
		'drive: listTree takes another extension',
		(await later.listTree(repo, head, { extension: '.png' })).map((e) => e.path).join() ===
			'wiki/deep/pic.png'
	);
	{
		// The head is asked of Drive each time: a copy out of a Drive ends by checking that
		// nothing changed while it ran.
		const watcher = open();
		const seenAt = (await watcher.getRevision(repo)).id;
		const steady = await watcher.branchRevision(repo, 'main');
		drive.edit('wiki/alpha.md', '# Alpha\n\nChanged in Drive.\n');
		const moved = await watcher.branchRevision(repo, 'main');
		drive.edit('wiki/alpha.md', writes[0].content);
		check(
			'drive: branchRevision reports a change made in Drive after the store listed it',
			steady === seenAt && moved !== seenAt,
			JSON.stringify([seenAt, steady, moved])
		);
	}
	const pages = await later.fetchPages(repo, listed);
	check(
		'drive: fetchPages reads every page',
		pages.pages.length === 4 &&
			pages.pages.find((p) => p.path === 'wiki/deep/beta.md')?.content === writes[1].content
	);
	const bin = await later.readBinary(repo, 'wiki/deep/pic.png');
	check(
		'drive: bytes read back exactly',
		bin?.contentBase64 === png.toString('base64') && bin.size === png.length
	);
	check(
		'drive: a missing file reads as null',
		(await later.readFile(repo, 'wiki/nope.md')) === null &&
			(await later.readBinary(repo, 'wiki/nope.png')) === null
	);

	// Someone else's edits.
	drive.edit('wiki/alpha.md', '# Alpha\n\nEdited in Drive.\n');
	const moved = await open().getRevision(repo);
	check('drive: an edit from outside moves the revision', moved.id !== head.id);
	check(
		'drive: and the same store keeps answering from its one listing',
		(await later.getRevision(repo)).id === head.id
	);
	const conflict = await errorOf(() =>
		later.write(repo, {
			message: 'Edit alpha',
			base: head,
			writes: [
				{ path: 'wiki/empty.md', content: 'no longer empty\n' },
				{ path: 'wiki/alpha.md', content: '# Alpha\n\nMine.\n' }
			]
		})
	);
	check(
		'drive: a write over an edit made since it was planned is a conflict',
		!!conflict && /wiki\/alpha\.md changed since it was read/.test(conflict),
		String(conflict)
	);
	check(
		'drive: and the bundle wrote nothing',
		drive.tree()['wiki/alpha.md'] === '# Alpha\n\nEdited in Drive.\n' &&
			drive.tree()['wiki/empty.md'] === ''
	);
	const fresh = open();
	const base = await fresh.getRevision(repo);
	drive.edit('wiki/deep/gamma.md', '# Gamma\n\nEdited in Drive.\n');
	const landed = await fresh.commitOrPR(repo, {
		message: 'Edit alpha',
		writeMode: 'direct',
		defaultBranch: 'main',
		base,
		writes: [{ path: 'wiki/alpha.md', content: '# Alpha\n\nMine.\n' }]
	});
	check(
		"drive: someone else's edit to another file does not block a write",
		drive.tree()['wiki/alpha.md'] === '# Alpha\n\nMine.\n' &&
			landed.landed?.versions['wiki/alpha.md'] === md5('# Alpha\n\nMine.\n')
	);
	const unknown = await errorOf(() =>
		open().write(repo, {
			message: 'Stale',
			base: head,
			writes: [{ path: 'wiki/stale.md', content: 'x' }]
		})
	);
	check(
		'drive: a write planned on a revision this store never read is refused',
		!!unknown &&
			/changed since this write was planned/.test(unknown) &&
			!drive.find('wiki/stale.md')
	);

	// Deletes go to the trash, and the path is free again.
	const deleting = open();
	const afterDelete = await deleting.write(repo, {
		message: 'Move gamma',
		writes: [{ path: 'wiki/moved/gamma.md', content: '# Gamma\n' }],
		deletes: ['wiki/deep/gamma.md']
	});
	check(
		'drive: a delete trashes the file',
		!drive.find('wiki/deep/gamma.md') &&
			drive.trashed().includes('wiki/deep/gamma.md') &&
			drive.tree()['wiki/moved/gamma.md'] === '# Gamma\n'
	);
	check(
		'drive: the revision a write returns is the one a new store lists',
		afterDelete.revision.id === (await open().getRevision(repo)).id
	);

	// Two of a name, Drive's own document types, and a name no path can hold.
	drive.put('wiki/alpha.md', '# A second alpha\n');
	drive.put('wiki/Meeting notes', '', 'application/vnd.google-apps.document');
	drive.named('wiki', 'a/b.md', 'unreachable\n');
	const dup = await listDrive(api, root);
	check(
		'drive: the oldest of two files with one name holds the path, and the other is reported',
		dup.duplicates.join() === 'wiki/alpha.md' &&
			dup.files.get('wiki/alpha.md')?.version === md5('# Alpha\n\nMine.\n')
	);
	check(
		"drive: Drive's own document types, and a name holding a slash, are not files",
		!dup.files.has('wiki/Meeting notes') && !dup.files.has('wiki/a/b.md') && dup.files.size === 5,
		[...dup.files.keys()].join()
	);
	check(
		'drive: the storage is named by its folder',
		driveStorageName(root) === `google-drive:${root.folderId}`
	);

	// A level wider than one query holds.
	const wide = driveFixture();
	for (let i = 0; i < 45; i++) wide.drive.put(`wiki/f${i}/page.md`, `# ${i}\n`);
	wide.drive.calls.length = 0;
	const wideListing = await listDrive(wide.api, wide.root);
	check(
		'drive: a wide level is listed in batches of folders, not one query each',
		wideListing.files.size === 45 && wide.drive.calls.length === 4,
		`${wideListing.files.size} files, ${wide.drive.calls.length} calls`
	);
}

// ---- Drive: failures ----
{
	console.log('\ndrive failures');
	const { drive, open } = driveFixture();
	await open().write(repo, {
		message: 'Seed',
		writes: [{ path: 'wiki/alpha.md', content: 'one\n' }]
	});

	// Throttled twice, then served.
	drive.failures.push({ match: /^PATCH \/upload/, status: 429, times: 2 });
	await open().write(repo, {
		message: 'Edit',
		writes: [{ path: 'wiki/alpha.md', content: 'two\n' }]
	});
	check('drive: a throttled request is retried', drive.tree()['wiki/alpha.md'] === 'two\n');
	drive.failures.push({
		match: /^PATCH \/upload/,
		status: 403,
		body: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}',
		times: 1
	});
	await open().write(repo, {
		message: 'Edit',
		writes: [{ path: 'wiki/alpha.md', content: 'three\n' }]
	});
	check('drive: a rate-limit 403 is retried too', drive.tree()['wiki/alpha.md'] === 'three\n');
	drive.failures.push({ match: /^PATCH \/upload/, status: 403, body: 'forbidden', times: 1 });
	const forbidden = await errorOf(() =>
		open().write(repo, { message: 'Edit', writes: [{ path: 'wiki/alpha.md', content: 'four\n' }] })
	);
	check(
		'drive: any other 403 is an error, not retried',
		!!forbidden && /answered 403/.test(forbidden) && drive.tree()['wiki/alpha.md'] === 'three\n',
		String(forbidden)
	);

	// The second file of a bundle fails for good: the first is put back.
	const store = open();
	drive.failures.push({ match: /^POST \/upload/, status: 500, times: 99 });
	const failed = await errorOf(() =>
		store.write(repo, {
			message: 'Half',
			writes: [
				{ path: 'wiki/alpha.md', content: 'half\n' },
				{ path: 'wiki/new.md', content: 'new\n' }
			]
		})
	);
	drive.failures.length = 0;
	check(
		'drive: a bundle that fails partway is rolled back',
		!!failed &&
			/answered 500/.test(failed) &&
			drive.tree()['wiki/alpha.md'] === 'three\n' &&
			!drive.find('wiki/new.md'),
		JSON.stringify(drive.tree())
	);
	await store.write(repo, {
		message: 'After',
		writes: [{ path: 'wiki/new.md', content: 'new\n' }]
	});
	check(
		'drive: and the store lists again before its next write',
		drive.tree()['wiki/new.md'] === 'new\n' &&
			(await store.getRevision(repo)).id === (await open().getRevision(repo)).id
	);

	// Edited by someone else after the bundle read it and before its upload.
	const racing = open();
	await racing.getRevision(repo);
	drive.before = async (call) => {
		if (call.startsWith('PATCH /upload')) return;
		if (call.startsWith('GET') && call.endsWith('media')) {
			drive.before = async () => {};
			await Promise.resolve();
			drive.edit('wiki/alpha.md', 'theirs\n');
		}
	};
	const raced = await errorOf(() =>
		racing.write(repo, { message: 'Race', writes: [{ path: 'wiki/alpha.md', content: 'mine\n' }] })
	);
	check(
		'drive: an edit between the read and the upload is a conflict, and is kept',
		!!raced &&
			/changed since it was read/.test(raced) &&
			drive.tree()['wiki/alpha.md'] === 'theirs\n',
		`${raced} / ${drive.tree()['wiki/alpha.md']}`
	);

	check(
		'drive: after a conflict the store lists again, so a retry plans on what is there',
		(await racing.getRevision(repo)).id === (await open().getRevision(repo)).id
	);

	// A wrong token is an error with Drive's status.
	const denied = fakeGoogleDrive();
	const bad = driveBrainStore(
		driveApi(denied.fetch, async () => 'wrong'),
		{ folderId: denied.rootId },
		inMemoryWriteCoordinator(),
		'brain-1'
	);
	const authError = await errorOf(() => bad.getRevision(repo));
	check('drive: a refused token is an error', !!authError && /answered 401/.test(authError));
}

// ---- copying a brain from one store into another ----
{
	console.log('\ncopy');
	const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
	const png = b64([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
	const bom = '\ufeff# With a byte order mark\n';
	const text = fileWriteFor('a.md', Buffer.from(bom).toString('base64'));
	check(
		'copy: UTF-8 is carried as text, byte order mark included',
		text.content === bom && text.encoding === undefined
	);
	const nul = fileWriteFor('a.bin', b64([0x61, 0x00, 0x62]));
	check(
		'copy: bytes that are not UTF-8, or hold a NUL, are carried as bytes',
		fileWriteFor('a.png', png).encoding === 'base64' &&
			nul.encoding === 'base64' &&
			nul.content === b64([0x61, 0x00, 0x62])
	);

	const dir = mkdtempSync(join(tmpdir(), 'iso-copy-'));
	tmpDirs.push(dir);
	await ensureGitRepo(dir);
	const source = fsBrainStore({ dir });
	const from = { store: source, locator: repo };
	await source.write(repo, {
		message: 'Seed',
		writes: [
			...writes,
			{ path: 'assets/dot.png', content: png, encoding: 'base64' },
			{ path: '.isomorphic.json', content: '{}\n' }
		]
	});
	const dest = sqlBrainStore(sqlFiles(sqliteDatabase()));
	const to = { store: dest, locator: repo };
	// Left by an earlier, abandoned copy of a file the source has since deleted.
	await dest.write(repo, { message: 'Stale', writes: [{ path: 'wiki/gone.md', content: 'x' }] });
	const listed = async (s: BrainStore) =>
		(await s.listTree(repo, await s.getRevision(repo), { extension: '*' })).map((e) => e.path);

	const total = (await listed(source)).length;
	const budget = Math.ceil(total / 3);
	const one = await copyStep(from, to, null, { budget });
	check(
		'copy: a step stops at its budget and says where',
		!one.done &&
			one.copied === budget &&
			one.total === total &&
			one.progress.after === (await listed(source)).sort()[budget - 1],
		JSON.stringify(one)
	);
	const two = await copyStep(from, to, one.progress, { budget });
	const three = await copyStep(from, to, two.progress, { budget });
	check(
		'copy: later steps resume after it and finish',
		!two.done && three.done && three.copied === total,
		JSON.stringify([two, three])
	);
	check(
		'copy: the destination then holds exactly the source’s files',
		(await listed(dest)).join() === (await listed(source)).sort().join(),
		(await listed(dest)).join()
	);
	check(
		'copy: text and bytes arrive as they were',
		(await dest.readFile(repo, 'wiki/deep/beta.md'))?.content === writes[1].content &&
			(await dest.readFile(repo, 'wiki/empty.md'))?.content === '' &&
			(await dest.readBinary(repo, 'assets/dot.png'))?.contentBase64 === png
	);

	// The source moves between two steps of a copy.
	const dest2 = sqlBrainStore(sqlFiles(sqliteDatabase()));
	const to2 = { store: dest2, locator: repo };
	const started = await copyStep(from, to2, null, { budget: 3 });
	await source.write(repo, {
		message: 'Edit during the copy',
		writes: [{ path: '.isomorphic.json', content: '{"edited":true}\n' }],
		deletes: ['wiki/empty.md']
	});
	const again = await copyStep(from, to2, started.progress, { budget: 3 });
	check(
		'copy: a source that moved starts the copy again from its new revision',
		again.restarted && !again.done && again.copied === 3,
		JSON.stringify(again)
	);
	const finished = await copyStep(from, to2, again.progress, { budget: 3 });
	check(
		'copy: and finishes with the edit and without the deleted file',
		finished.done &&
			(await dest2.readFile(repo, '.isomorphic.json'))?.content === '{"edited":true}\n' &&
			(await listed(dest2)).join() === (await listed(source)).sort().join(),
		(await listed(dest2)).join()
	);

	// A source that moves during the last step is not done.
	const racing: BrainStore = {
		...source,
		branchRevision: async () => 'moved-on'
	};
	const raced = await copyStep({ store: racing, locator: repo }, to2, null);
	check(
		'copy: a source that moved during the final step is not done',
		!raced.done && raced.restarted && raced.progress.revision === 'moved-on',
		JSON.stringify(raced)
	);

	// The brain's binding moves only when the copy is complete.
	const { db, sqlite } = localD1();
	sqlite.exec(`
		INSERT INTO app_users (user_id, email) VALUES ('ann', 'ann@example.com');
		INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at)
			VALUES ('o1', 'Acme', 'hosted', 7, 'example-org', 'ann', '2026-01-01');
		INSERT INTO memberships (org_id, user_id, role) VALUES ('o1', 'ann', 'owner');
		INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at)
			VALUES ('b1', 'o1', 'example-org', 'brain', 'Brain', 'org', '2026-01-01');
	`);
	bindFixtureStorage(sqlite);
	// What the Worker chooses a store by: the brain as its member reaches it.
	const reached = async () => (await listAccessibleBrains(db, ['ann']))[0];
	const binding = async () => (await reached()).storage_kind;
	const pass = () =>
		sqlite
			.prepare(`SELECT status, cursor FROM brain_passes WHERE brain_id = 'b1' AND kind = ?`)
			.get(RELOCATION_KIND) as { status: string; cursor: string | null } | undefined;
	const dest3 = sqlBrainStore(sqlFiles(sqliteDatabase()));
	const to3 = { store: dest3, locator: repo };
	const scope = { brainId: 'b1', orgId: 'o1', actorUserId: 'ann' };
	// The page index, built while the brain was in its repository.
	const { index } = indexRefs(d1Index(db), 'b1');
	await index.ensureFresh(source, repo, DEFAULT_BRAIN_CONFIG);
	const indexed = async () => (await index.listPages()).map((p) => p.path).sort();
	const before = await indexed();
	const held3: MoveTarget = {
		key: 'isomorphic',
		open: async () => ({ end: to3, binding: platformFilesBinding(db, 'b1') })
	};
	const part = await relocateBrain(db, scope, from, held3, { budget: 3, fromRepository: true });
	check(
		'relocate: an unfinished copy leaves the brain where it was, and keeps its place',
		!part.done &&
			(await binding()) === 'github-app-installation' &&
			pass()?.status === 'running' &&
			pass()?.cursor === part.progress.after,
		JSON.stringify([part, await binding(), pass()])
	);
	const rest = await relocateBrain(db, scope, from, held3, { budget: 3, fromRepository: true });
	check(
		'relocate: the next call resumes, and the finished copy binds the brain to its new storage',
		rest.done &&
			rest.copied === rest.total &&
			(await binding()) === PLATFORM_FILES_KIND &&
			pass()?.status === 'done' &&
			credentialFor(await reached()).kind === 'platform-files' &&
			(await reached()).brain_id === 'b1',
		JSON.stringify([rest, await binding(), pass()])
	);
	// What configure_brain does next: the index starts again against the new store.
	await index.reset();
	for (let i = 0; i < 5; i++) await index.ensureFresh(dest3, repo, DEFAULT_BRAIN_CONFIG);
	check(
		'relocate: the index rebuilt from the new storage lists the same pages',
		before.length > 0 && (await indexed()).join() === before.join(),
		(await indexed()).join()
	);
	await dest3.write(repo, {
		message: 'Add a page',
		writes: [{ path: 'wiki/after-move.md', content: '# After\n' }]
	});
	await index.ensureFresh(dest3, repo, DEFAULT_BRAIN_CONFIG);
	check(
		'relocate: and follows a write made there',
		(await indexed()).includes('wiki/after-move.md'),
		(await indexed()).join()
	);

	// And back: into a repository that has moved on since the brain left it.
	const conn = await githubConnectionForAccount(db, 'Example-Org');
	check(
		'relocate: the connection for the brain’s account is found, whatever its case',
		conn?.connection_id === 'github-app:7' &&
			(await githubConnectionForAccount(db, 'nobody')) === null,
		JSON.stringify(conn)
	);
	const repository: MoveTarget = {
		key: conn!.connection_id,
		open: async () => ({ end: from, binding: [bindingStatement(db, 'b1', conn!.connection_id)] })
	};
	const back = await relocateBrain(db, scope, { store: dest3, locator: repo }, repository);
	check(
		'relocate: moving back binds the brain to its GitHub connection again',
		back.done &&
			(await binding()) === 'github-app-installation' &&
			credentialFor(await reached()).kind === 'installation',
		JSON.stringify([back, await binding()])
	);
	check(
		'relocate: and the repository holds what the brain held, the page written since included',
		(await listed(source)).sort().join() === (await listed(dest3)).join() &&
			(await source.readFile(repo, 'wiki/after-move.md'))?.content === '# After\n',
		(await listed(source)).sort().join()
	);
	// Into a Google Drive and out again: the same move with a third storage.
	const DRIVE_CONN = 'google-drive:o1:perm-1';
	sqlite
		.prepare(
			`INSERT INTO storage_connections (connection_id, provider, kind, external_id, account, owner_org_id)
			 VALUES (?, 'google', 'google-drive', 'perm-1', 'person@drive.example', 'o1')`
		)
		.run(DRIVE_CONN);
	const g = driveFixture();
	const folders: string[] = [];
	const driveTarget: MoveTarget = {
		key: DRIVE_CONN,
		open: async (token) => {
			const folderId = token ?? (await createBrainFolder(g.api, 'Brain'));
			if (!token) folders.push(folderId);
			return {
				end: { store: g.at(folderId), locator: repo },
				binding: [bindingStatement(db, 'b1', DRIVE_CONN, folderId)],
				token: folderId
			};
		}
	};
	const root = async () => (await reached()).storage_root ?? null;
	const first = await relocateBrain(db, scope, from, driveTarget, {
		budget: 3,
		fromRepository: true
	});
	check(
		'relocate: an unfinished copy into a Drive leaves the brain in its repository',
		!first.done && (await binding()) === 'github-app-installation' && (await root()) === null,
		JSON.stringify([first, await binding(), await root()])
	);
	let inDrive = first;
	for (let i = 0; i < 20 && !inDrive.done; i++) {
		inDrive = await relocateBrain(db, scope, from, driveTarget, {
			budget: 3,
			fromRepository: true
		});
	}
	const driveStore = () => g.at(folders[0]);
	check(
		'relocate: later steps fill the folder the first one made, and the brain is bound to it',
		inDrive.done &&
			folders.length === 1 &&
			(await binding()) === 'google-drive' &&
			(await root()) === folders[0] &&
			credentialFor(await reached()).kind === 'google-drive' &&
			(await listed(driveStore())).sort().join() === (await listed(source)).sort().join(),
		JSON.stringify([inDrive, folders, await binding(), await root()])
	);

	// A copy begun toward one storage is not continued toward another.
	const dest4 = sqlBrainStore(sqlFiles(sqliteDatabase()));
	const dest5 = sqlBrainStore(sqlFiles(sqliteDatabase()));
	const heldAt = (key: string, store: BrainStore): MoveTarget => ({
		key,
		open: async () => ({
			end: { store, locator: repo },
			binding: platformFilesBinding(db, 'b1')
		})
	});
	const fromDrive = () => ({ store: driveStore(), locator: repo });
	const begun = await relocateBrain(db, scope, fromDrive(), heldAt('one', dest4), { budget: 3 });
	const elsewhere = await relocateBrain(db, scope, fromDrive(), heldAt('other', dest5));
	check(
		'relocate: a move toward a different destination starts its copy from the beginning',
		!begun.done &&
			elsewhere.done &&
			(await listed(dest5)).join() === (await listed(driveStore())).sort().join(),
		(await listed(dest5)).join()
	);
	check(
		'relocate: out of a Drive, the brain is held by the platform and names no folder',
		(await binding()) === PLATFORM_FILES_KIND && (await root()) === null,
		JSON.stringify([await binding(), await root()])
	);

	// Whether a repository under the brain's name is its own.
	sqlite.exec(`
		INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at)
			VALUES ('b2', 'o1', 'example-org', 'made-elsewhere', 'Elsewhere', 'org', '2026-01-02'),
			       ('b3', 'o1', 'example-org', 'older', 'Older', 'org', '2026-01-03');
		INSERT INTO brain_passes (brain_id, kind, run_id, status, counters, started_at, updated_at)
			VALUES ('b3', '${RELOCATION_KIND}', 'r', 'done', '{"revision":"abc"}', 1, 1);
	`);
	await relocateBrain(
		db,
		{ ...scope, brainId: 'b2' },
		fromDrive(),
		heldAt('isomorphic', sqlBrainStore(sqlFiles(sqliteDatabase())))
	);
	check(
		'relocate: a brain that left a repository is known to have, through later moves and in rows written before moves named their target',
		(await cameFromRepository(db, 'b1')) && (await cameFromRepository(db, 'b3')),
		JSON.stringify([await cameFromRepository(db, 'b1'), await cameFromRepository(db, 'b3')])
	);
	check(
		'relocate: a brain that only moved between other storages never had one',
		!(await cameFromRepository(db, 'b2')) && !(await cameFromRepository(db, 'never-moved'))
	);
}

// ---- backing a held brain up, and reading the backup back ----
{
	console.log('\nbackup');
	const HOUR = 60 * 60 * 1000;
	const db = sqliteDatabase();
	const files = sqlFiles(db);
	const store = sqlBrainStore(files);
	// An R2 bucket, as much of one as a backup uses.
	const held = new Map<string, Uint8Array>();
	const bucket: BackupBucket & { failOn?: string } = {
		async put(key, value) {
			if (bucket.failOn && key.includes(bucket.failOn)) throw new Error('bucket down');
			held.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
		},
		async list({ prefix }) {
			const keys = [...held.keys()].filter((k) => k.startsWith(prefix)).sort();
			return { objects: keys.map((key) => ({ key })), truncated: false };
		},
		async delete(keys) {
			for (const k of keys) held.delete(k);
		}
	};
	const keys = await generateBackupKeys();
	const publicKey = await importBackupPublicKey(keys.publicKey);
	const get = async (key: string) => held.get(key) ?? null;
	const privateKey = await importBackupPrivateKey(keys.privateKey);
	const restored = async (id?: string) => {
		const backup = await readBackup(get, privateKey, 'b1', id);
		const out = new Map<string, string>();
		for await (const f of backup.files()) out.set(f.path, Buffer.from(f.bytes).toString('base64'));
		return { manifest: backup.manifest, out };
	};

	check(
		'backup: an empty brain is never due',
		backupDue(db, files.revision(), 0, 24 * HOUR) === null
	);

	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]).toString('base64');
	// Three files of 3 MiB each, so the brain spans more than one 4 MiB part.
	const big = 'x'.repeat(3 * 1024 * 1024);
	await store.write(repo, {
		message: 'Seed',
		writes: [
			{ path: 'wiki/a.md', content: '# A\n' },
			{ path: 'wiki/gone.md', content: 'x' },
			{ path: 'assets/dot.png', content: png, encoding: 'base64' },
			...[1, 2, 3].map((n) => ({ path: `big/${n}.md`, content: big }))
		]
	});
	await store.write(repo, { message: 'Delete', deletes: ['wiki/gone.md'] });
	const rev = files.revision();

	const t0 = 1_000_000_000_000;
	check(
		'backup: a changed brain is due once its writes have settled',
		backupDue(db, rev, t0, 24 * HOUR) === t0 + 10 * 60 * 1000 && backupDue(db, rev, t0, 0) === t0
	);

	// The second part fails: the run keeps its place.
	bucket.failOn = 'part-00002';
	const failed = await errorOf(() => backupStep(db, files, bucket, publicKey, 'b1', rev, t0));
	check(
		'backup: a step that fails leaves no manifest, and the brain due at once',
		failed !== undefined &&
			![...held.keys()].some((k) => k.endsWith('.json')) &&
			backupDue(db, rev, t0 + 5, 24 * HOUR) === t0 + 5
	);
	// A write lands before the retry. The backup is of the revision it began on.
	await store.write(repo, {
		message: 'Later',
		writes: [{ path: 'wiki/later.md', content: 'later' }]
	});
	bucket.failOn = undefined;
	const step = await backupStep(db, files, bucket, publicKey, 'b1', files.revision(), t0 + 10);
	const first = await restored();
	check(
		'backup: the retry finishes the same backup, in more than one part',
		step !== null && step.parts > 1 && step.revision === rev,
		JSON.stringify(step)
	);
	check(
		'backup: read back, it is the files of that revision, byte for byte',
		[...first.out.keys()].sort().join() === 'assets/dot.png,big/1.md,big/2.md,big/3.md,wiki/a.md' &&
			first.out.get('assets/dot.png') === png &&
			Buffer.from(first.out.get('wiki/a.md')!, 'base64').toString() === '# A\n' &&
			first.out.get('big/3.md') === Buffer.from(big).toString('base64') &&
			first.manifest.files === 5,
		[...first.out.keys()].sort().join()
	);
	const stored = [...held.entries()].filter(([k]) => k.includes('/part-'));
	check(
		'backup: nothing a file holds, and no path, is readable in the bucket',
		stored.length > 1 &&
			[...held.entries()].every(([k, v]) => {
				const text = Buffer.from(v).toString('latin1');
				return !k.includes('wiki') && !text.includes('wiki/a.md') && !text.includes('xxxxxxxx');
			})
	);
	const [partName, partBytes] = stored[0];
	check(
		'backup: a part does not open under another name, or with a byte changed',
		(await errorOf(() => openPart(privateKey, stored[1][0], partBytes))) !== undefined &&
			(await errorOf(() =>
				openPart(
					privateKey,
					partName,
					partBytes.map((b, i) => (i === partBytes.length - 1 ? b ^ 1 : b))
				)
			)) !== undefined &&
			(await openPart(privateKey, partName, partBytes)).length > 0
	);

	const t1 = t0 + 10;
	check(
		'backup: the write that landed meanwhile is due a day after the last backup',
		backupDue(db, files.revision(), t1 + 1, 24 * HOUR) === t1 + 24 * HOUR
	);
	const second = await backupStep(
		db,
		files,
		bucket,
		publicKey,
		'b1',
		files.revision(),
		t1 + 24 * HOUR
	);
	check(
		'backup: the next backup has it, and the brain is not due again until it changes',
		second !== null &&
			(await restored()).out.has('wiki/later.md') &&
			!(await restored(first.manifest.id)).out.has('wiki/later.md') &&
			backupDue(db, files.revision(), t1 + 72 * HOUR, 24 * HOUR) === null
	);

	// Sixteen more backups: only the newest BACKUPS_KEPT stay, another brain's untouched.
	held.set('brains/b10/x/manifest.json', new Uint8Array());
	for (let i = 1; i <= 16; i++) {
		await store.write(repo, {
			message: `Edit ${i}`,
			writes: [{ path: 'wiki/a.md', content: `${i}` }]
		});
		await backupStep(
			db,
			files,
			bucket,
			publicKey,
			'b1',
			files.revision(),
			t1 + (24 + i) * HOUR * 24
		);
	}
	const kept = [...held.keys()].filter(
		(k) => k.startsWith(backupPrefix('b1')) && k.endsWith('/manifest.json')
	);
	check(
		'backup: old backups are pruned to the newest few, whole',
		kept.length === BACKUPS_KEPT &&
			(await errorOf(() => restored(first.manifest.id))) !== undefined &&
			Buffer.from((await restored()).out.get('wiki/a.md')!, 'base64').toString() === '16' &&
			held.has('brains/b10/x/manifest.json'),
		String(kept.length)
	);

	// The restore script, over a folder that holds the bucket's objects.
	const bucketDir = mkdtempSync(join(tmpdir(), 'iso-backup-'));
	const outDir = join(mkdtempSync(join(tmpdir(), 'iso-restore-')), 'brain');
	tmpDirs.push(bucketDir, dirname(outDir));
	for (const [k, v] of held) {
		mkdirSync(dirname(join(bucketDir, k)), { recursive: true });
		writeFileSync(join(bucketDir, k), v);
	}
	const done = await restoreInto(folderReader(bucketDir), keys.privateKey, 'b1', outDir);
	check(
		'restore: the folder holds the brain, bytes included',
		done.files === 6 &&
			readFileSync(join(outDir, 'wiki/a.md'), 'utf8') === '16' &&
			readFileSync(join(outDir, 'assets/dot.png')).toString('base64') === png
	);
	check(
		'restore: it will not write into a folder that holds something, or without the right key',
		(await errorOf(() => restoreInto(folderReader(bucketDir), keys.privateKey, 'b1', outDir))) !==
			undefined &&
			(await errorOf(async () =>
				restoreInto(
					folderReader(bucketDir),
					(await generateBackupKeys()).privateKey,
					'b1',
					join(dirname(outDir), 'other')
				)
			)) !== undefined
	);
	check(
		'backup: BACKUP_INTERVAL_HOURS is hours, and anything else the default',
		backupIntervalMs('6') === 6 * HOUR &&
			backupIntervalMs('0') === 0 &&
			backupIntervalMs('') === 24 * HOUR &&
			backupIntervalMs('-1') === 24 * HOUR &&
			backupIntervalMs('soon') === 24 * HOUR
	);
}

// git's background gc can still be writing into .git; a plain rm then hits ENOTEMPTY.
for (const d of tmpDirs)
	rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
done();
