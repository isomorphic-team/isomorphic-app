// Run the consolidation detector over a brain that lives in a folder on disk, with
// no accounts and no network. Offline twin of what a `consolidate` tool call would
// compute, and the way to see what the loop says about a real brain before wiring
// any of it into the Worker.
//
//   pnpm exec tsx scripts/consolidate-report.ts <folder> [--root <name>] [--json]
//
// The folder is COPIED into a temp git repo (only .md files) and indexed there, so
// the source is never written to and never needs to be a git repo itself. The real
// content index runs on node:sqlite via the same shim the e2e batteries use, so
// ensureFresh / loadResolvedGraph behave exactly as they do in production.
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { loadBrainConfig } from '../src/lib/brain-config.ts';
import { ensureFresh, loadResolvedGraph, loadPageContents } from '../src/lib/brain-index.ts';
import { computeTensions, MAX_DUP_PAGES, type Tension } from '../src/lib/consolidate.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootFlag = args.indexOf('--root');
const rootArg = rootFlag === -1 ? null : args[rootFlag + 1];
const positional = args.filter(
	(a, i) => !a.startsWith('--') && !(rootFlag !== -1 && i === rootFlag + 1)
);
const source = positional[0];
if (!source) {
	console.error('usage: tsx scripts/consolidate-report.ts <folder> [--root <name>] [--json]');
	process.exit(2);
}
const root = rootArg ?? basename(source);

async function markdownUnder(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		out.push(relative(dir, join(entry.parentPath, entry.name)));
	}
	return out.sort();
}

const dir = await mkdtemp(join(tmpdir(), 'consolidate-'));
try {
	const files = await markdownUnder(source);
	if (!files.length) {
		console.error(`No markdown under ${source}`);
		process.exit(2);
	}
	for (const rel of files) {
		const dest = join(dir, root, rel);
		await mkdir(join(dest, '..'), { recursive: true });
		await cp(join(source, rel), dest);
	}
	// The content root is declared rather than defaulted to wiki/, so reported paths
	// match the brain's own layout.
	await writeFile(
		join(dir, '.isomorphic.json'),
		JSON.stringify({ paths: { [`${root}/`]: 'content' } }, null, 2)
	);
	await ensureGitRepo(dir, { name: 'Consolidate', email: 'consolidate@localhost' });

	const store = fsBrainStore({
		dir,
		author: { name: 'Consolidate', email: 'consolidate@localhost' }
	});
	const repoArgs = { owner: 'local', repo: basename(source) };
	const brainId = `${repoArgs.owner}/${repoArgs.repo}`;
	const { db } = localD1();
	const config = await loadBrainConfig(store, repoArgs);

	await ensureFresh(db, store, repoArgs, brainId, config);
	const graph = await loadResolvedGraph(db, brainId, config);
	const contents =
		graph.pages.length <= MAX_DUP_PAGES
			? await loadPageContents(
					db,
					brainId,
					graph.pages.map((p) => p.path)
				)
			: undefined;

	const tensions = computeTensions({
		pages: graph.pages,
		edges: graph.edges,
		contents
	});

	if (asJson) {
		console.log(JSON.stringify({ brainId, pages: graph.pages.length, tensions }, null, 2));
	} else {
		report(graph.pages.length, graph.edges.length, graph.broken.length, tensions);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}

function report(pages: number, edges: number, broken: number, tensions: Tension[]) {
	console.log(`\n${pages} pages, ${edges} resolved links, ${broken} broken.\n`);
	if (!tensions.length) {
		console.log('No tensions.');
		return;
	}
	const byKind = new Map<string, number>();
	for (const t of tensions) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
	console.log(
		`${tensions.length} tension(s): ${[...byKind].map(([k, n]) => `${k} x${n}`).join(', ')}\n`
	);
	for (const [i, t] of tensions.entries()) {
		console.log(`${String(i + 1).padStart(2)}. [${t.kind}] ${t.headline}`);
		for (const e of t.evidence) console.log(`      ${e}`);
		console.log(`    → ${t.move}`);
		console.log(`      key: ${t.key}\n`);
	}
}
