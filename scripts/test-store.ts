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
//   3. A REVIEW-REQUIRED WRITE THAT LANDS ANYWAY. A store without `proposals` refuses
//      `writeMode: 'pull-request'` and writes nothing, enforced by defineStore before
//      the store's own commitOrPR runs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	defineStore,
	gitBlobSha,
	type BrainStore,
	type StoreCapabilities
} from '../src/lib/brain-repo.ts';
import { githubStore } from '../src/lib/brain-store-github.ts';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { checker, errorOf } from './check.ts';
import { fakeGithub, realGitBlobSha } from './fake-github.ts';

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
	}
];

const PR_REFUSAL = /configured for pull-request writes/;

// ---- defineStore enforces what a store declares ----
{
	let reached = 0;
	const declared = (proposals: boolean) =>
		defineStore({
			capabilities: { atomicWrite: true, proposals, history: true },
			commitOrPR: async () => {
				reached++;
				return {};
			}
		} as unknown as BrainStore);
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

// git's background gc can still be writing into .git; a plain rm then hits ENOTEMPTY.
for (const d of tmpDirs)
	rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
done();
