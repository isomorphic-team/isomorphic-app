// Open a folder of markdown as a real, indexed brain, offline. Shared by the
// consolidate and probe reports.
//
// The folder is COPIED into a temp git repo (only .md files) and indexed there, so
// the source is never written to and need not be a git repo itself. The content index
// runs on node:sqlite via the same shim the e2e batteries use, so ensureFresh /
// loadResolvedGraph / searchIndex behave exactly as they do in production.
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { loadBrainConfig } from '../src/lib/brain-config.ts';
import { ensureFresh } from '../src/lib/brain-index.ts';
import type { BrainStore } from '../src/lib/brain-repo.ts';

export interface LocalBrain {
	db: ReturnType<typeof localD1>['db'];
	store: BrainStore;
	repoArgs: { owner: string; repo: string };
	brainId: string;
	config: Awaited<ReturnType<typeof loadBrainConfig>>;
	cleanup: () => Promise<void>;
}

async function markdownUnder(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		out.push(relative(dir, join(entry.parentPath, entry.name)));
	}
	return out.sort();
}

export async function openFolderAsBrain(source: string, rootName?: string): Promise<LocalBrain> {
	const root = rootName ?? basename(source);
	const dir = await mkdtemp(join(tmpdir(), 'brain-'));
	const cleanup = () => rm(dir, { recursive: true, force: true });
	try {
		const files = await markdownUnder(source);
		if (!files.length) throw new Error(`No markdown under ${source}`);
		for (const rel of files) {
			const dest = join(dir, root, rel);
			await mkdir(join(dest, '..'), { recursive: true });
			await cp(join(source, rel), dest);
		}
		// The content root is declared rather than defaulted to wiki/, so reported
		// paths match the brain's own layout.
		await writeFile(
			join(dir, '.isomorphic.json'),
			JSON.stringify({ paths: { [`${root}/`]: 'content' } }, null, 2)
		);
		await ensureGitRepo(dir, { name: 'Report', email: 'report@localhost' });

		const store = fsBrainStore({ dir, author: { name: 'Report', email: 'report@localhost' } });
		const repoArgs = { owner: 'local', repo: basename(source) };
		const brainId = `${repoArgs.owner}/${repoArgs.repo}`;
		const { db } = localD1();
		const config = await loadBrainConfig(store, repoArgs);
		await ensureFresh(db, store, repoArgs, brainId, config);
		return { db, store, repoArgs, brainId, config, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}
