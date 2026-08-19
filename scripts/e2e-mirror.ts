// End-to-end test for the mirror copier, over REAL git repositories in temp
// directories. No network, no credentials, nothing to clean up.
//
// A stub store would prove nothing here. The two failure modes are both invisible to a
// fake: an attachment that is silently dropped because the text read returned nothing
// for it, and a copy that cannot resume because the cursor does not correspond to a
// stable order. Both need real blobs and a real tree.
//
//   pnpm test:e2e-mirror

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { copyMirrorPass, mirrorReadme } from '../src/lib/mirror.ts';
import type { BrainStore, FileWrite, RepoRef } from '../src/lib/brain-repo.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

const AUTHOR = { name: 'E2E', email: 'e2e@localhost' };

async function scratch(prefix: string): Promise<{
	dir: string;
	store: BrainStore;
	repo: RepoRef;
}> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await ensureGitRepo(dir, AUTHOR);
	return {
		dir,
		store: fsBrainStore({ dir, author: AUTHOR }),
		repo: { owner: 'local', repo: basename(dir) }
	};
}

// A tiny but REAL png. The bytes matter: this is the file that a text-only read drops,
// and the whole point is that it arrives on the other side byte for byte.
const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const src = await scratch('mirror-src-');
const dst = await scratch('mirror-dst-');
const dst2 = await scratch('mirror-dst2-');

try {
	// ---- a connection brain with prose, config, and an attachment ----
	const seed: FileWrite[] = [
		{ path: '.isomorphic.json', content: '{\n  "paths": { "content": ["wiki/"] }\n}\n' },
		{ path: 'wiki/index.md', content: '# Northwind engagement\n\nSee [[kickoff]].\n' },
		{ path: 'wiki/kickoff.md', content: '# Kickoff\n\nAgreed scope. ![plan](plan.png)\n' },
		{ path: 'wiki/notes/weekly.md', content: '# Weekly\n\nNotes.\n' },
		{ path: 'wiki/plan.png', content: PNG_BASE64, encoding: 'base64' }
	];
	await src.store.commitFiles(src.repo, { message: 'Seed the connection', writes: seed });

	// What the source repository actually holds, counted rather than assumed: the local
	// backend keeps a .gitignore of its own for the derived index, so the file count is the
	// seed plus whatever the backend brought with it.
	const srcHead = await src.store.getHead(src.repo, 'main');
	const srcFiles = (await src.store.listTree(src.repo, srcHead, { extension: '*' })).map(
		(t) => t.path
	);

	console.log('\none pass, whole brain');
	{
		const res = await copyMirrorPass(src, dst, {
			branch: 'main',
			cursor: null,
			label: 'Northwind engagement'
		});
		check('reports itself done', res.done === true);
		check('with no cursor left', res.cursor === null, String(res.cursor));
		check(
			'copied every file the source holds',
			res.copied === srcFiles.length,
			`copied ${res.copied} of ${srcFiles.length}`
		);
		// THE regression this file exists for. A copier that reads everything as text
		// produces a mirror with every page and no images, and reports complete success
		// doing it: nobody finds out until they go looking for a file that is gone. The
		// png and the backend's own .gitignore both take the bytes path.
		check('and read the non-text files as bytes', res.binaries >= 1, `${res.binaries}`);
	}

	console.log('\nwhat arrived');
	{
		const head = await dst.store.getHead(dst.repo, 'main');
		const tree = await dst.store.listTree(dst.repo, head, { extension: '*' });
		const paths = tree.map((t) => t.path).sort();
		check(
			'every path is present',
			seed.every((w) => paths.includes(w.path)),
			JSON.stringify(paths)
		);
		const page = await dst.store.readFile(dst.repo, 'wiki/kickoff.md');
		check(
			'prose arrives verbatim',
			page?.content === seed[2].content,
			JSON.stringify(page?.content)
		);
		// The config is not incidental. Without it the mirror falls back to the default
		// content roots, and a brain whose pages lived somewhere else shows zero pages:
		// the exact "connected but empty" state configure_brain exists to fix.
		const cfg = await dst.store.readFile(dst.repo, '.isomorphic.json');
		check('the brain config comes with it', cfg?.content === seed[0].content);
		const bin = await dst.store.readBinary(dst.repo, 'wiki/plan.png');
		check(
			'the attachment survives, byte for byte',
			bin?.contentBase64 === PNG_BASE64,
			String(bin?.contentBase64)
		);
	}

	console.log('\nresuming a paged copy');
	{
		// A budget of two forces four passes over five files. Each pass has to leave a
		// valid repository holding a subset, never a broken one, because an interrupted
		// end is the normal case rather than the exceptional one: there is no cron here,
		// so the copy resumes whenever someone next touches the connection.
		let cursor: string | null = null;
		let passes = 0;
		let copied = 0;
		for (;;) {
			const res: Awaited<ReturnType<typeof copyMirrorPass>> = await copyMirrorPass(src, dst2, {
				branch: 'main',
				cursor,
				budget: 2,
				label: 'Northwind engagement'
			});
			passes++;
			copied += res.copied;
			cursor = res.cursor;
			if (res.done) break;
			if (passes > 20) break; // a stuck copy must fail the test, not hang it
		}
		check('it took several passes', passes > 1, `${passes} pass(es)`);
		check('and converged', cursor === null);
		check('copying everything exactly once', copied === srcFiles.length, `${copied}`);

		const head = await dst2.store.getHead(dst2.repo, 'main');
		const paths = (await dst2.store.listTree(dst2.repo, head, { extension: '*' })).map(
			(t) => t.path
		);
		check(
			'the resumed copy holds the same files',
			seed.every((w) => paths.includes(w.path)),
			JSON.stringify(paths.sort())
		);
		const bin = await dst2.store.readBinary(dst2.repo, 'wiki/plan.png');
		check('including the attachment', bin?.contentBase64 === PNG_BASE64);
	}

	console.log('\nre-running a pass');
	{
		// Whether a pass landed is not always knowable after a failure, so re-running one
		// has to be safe rather than merely unlikely to happen.
		const before = await dst.store.readFile(dst.repo, 'wiki/kickoff.md');
		const res = await copyMirrorPass(src, dst, {
			branch: 'main',
			cursor: null,
			label: 'Northwind engagement'
		});
		const after = await dst.store.readFile(dst.repo, 'wiki/kickoff.md');
		check('is safe', res.done === true && after?.content === before?.content);
	}

	console.log('\nan empty connection');
	{
		const bare = await scratch('mirror-bare-');
		try {
			const res = await copyMirrorPass(bare, dst, {
				branch: 'main',
				cursor: null,
				label: 'Nothing'
			});
			// A connection ended before anyone wrote in it still has to END. Returning
			// "not done" here would leave it in the retry queue forever. (It is not
			// literally empty: the local backend leaves its own .gitignore behind.)
			check('finishes rather than stalling', res.done === true, JSON.stringify(res));
		} finally {
			await rm(bare.dir, { recursive: true, force: true });
		}
	}

	console.log('\nthe note left behind');
	{
		const readme = mirrorReadme({
			connectionName: 'Northwind engagement',
			parties: ['Acme', 'Northwind'],
			endedAt: '2026-08-19'
		});
		check('names both parties', readme.includes('Acme') && readme.includes('Northwind'));
		check('says it is read-only', /read-only/.test(readme));
		// A reader a year later needs to know why some links go nowhere, or they will
		// read it as damage rather than as the boundary of what was shared.
		check('and explains why outward links do not resolve', /never part of it/.test(readme));
	}
} finally {
	await rm(src.dir, { recursive: true, force: true });
	await rm(dst.dir, { recursive: true, force: true });
	await rm(dst2.dir, { recursive: true, force: true });
}

console.log(
	failures === 0 ? '\nAll mirror E2E checks passed.' : `\n${failures} mirror check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
