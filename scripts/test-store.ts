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
//      `writeMode: 'pull-request'` and writes nothing.

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	githubStore,
	gitBlobSha,
	refusePullRequestMode,
	UnsupportedWriteError,
	type BrainStore,
	type StoreCapabilities
} from '../src/lib/brain-repo.ts';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { checker } from './check.ts';
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
		open: async () => {
			return githubStore(fakeGithub().octokit);
		}
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

// ---- the pure refusal ----
{
	const none: StoreCapabilities = { atomicWrite: true, proposals: false, history: true };
	const all: StoreCapabilities = { ...none, proposals: true };
	const throws = (fn: () => void) => {
		try {
			fn();
			return false;
		} catch (err) {
			return err instanceof UnsupportedWriteError;
		}
	};
	check(
		'no proposals: pull-request mode is refused',
		throws(() => refusePullRequestMode(none, 'pull-request'))
	);
	check(
		'no proposals: direct mode is allowed',
		!throws(() => refusePullRequestMode(none, 'direct'))
	);
	check(
		'proposals: pull-request mode is allowed',
		!throws(() => refusePullRequestMode(all, 'pull-request'))
	);
	check(
		"gitBlobSha matches git's blob id",
		(await gitBlobSha('')) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' &&
			(await gitBlobSha(writes[1].content)) === realGitBlobSha(writes[1].content)
	);
}

for (const backend of BACKENDS) {
	console.log(`\n${backend.name}`);
	const store = await backend.open();
	{
		// 1. capabilities
		check(
			`${backend.name}: declares its capabilities`,
			JSON.stringify(store.capabilities) === JSON.stringify(backend.expected),
			JSON.stringify(store.capabilities)
		);

		// 2. version tags
		const head = await store.getHead(repo);
		const res = await store.commitFiles(repo, { message: 'Add pages', writes, head });
		const after = await store.getHead(repo);
		const listed = new Map(
			(await store.listTree(repo, after)).map((e) => [e.path, e.sha] as const)
		);
		for (const w of writes) {
			check(
				`${backend.name}: ${w.path} write tag equals its listed tag`,
				!!res.versions[w.path] && res.versions[w.path] === listed.get(w.path),
				`write=${res.versions[w.path]} listed=${listed.get(w.path)}`
			);
		}
		if (backend.name === 'github') {
			check(
				'github: write tags are git blob ids',
				writes.every((w) => res.versions[w.path] === realGitBlobSha(w.content))
			);
			const direct = await store.commitOrPR(repo, {
				message: 'Edit alpha',
				writeMode: 'direct',
				defaultBranch: 'main',
				writes: [{ path: 'wiki/alpha.md', content: '# Alpha\n\nEdited.\n' }]
			});
			check(
				'github: a direct commitOrPR reports the tags with the revision',
				!!direct.commitSha &&
					direct.versions?.['wiki/alpha.md'] === realGitBlobSha('# Alpha\n\nEdited.\n')
			);
		}

		// 3. pull-request mode without proposals
		if (!store.capabilities.proposals) {
			const before = await store.getHead(repo);
			let refused = false;
			try {
				await store.commitOrPR(repo, {
					message: 'Should not land',
					writeMode: 'pull-request',
					defaultBranch: before.branch,
					writes: [{ path: 'wiki/refused.md', content: '# Refused\n' }]
				});
			} catch (err) {
				refused = err instanceof UnsupportedWriteError;
			}
			const unchanged = (await store.getHead(repo)).commitSha === before.commitSha;
			check(`${backend.name}: pull-request mode is refused`, refused);
			check(`${backend.name}: and nothing was written`, unchanged);
		}
	}
}

for (const d of tmpDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
done();
