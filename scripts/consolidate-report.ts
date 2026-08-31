// Run the consolidation detector over a brain that lives in a folder on disk, with
// no accounts and no network. Offline twin of what a `consolidate` tool call would
// compute, and the way to see what the loop says about a real brain before wiring any
// of it into the Worker.
//
//   pnpm exec tsx scripts/consolidate-report.ts <folder> [--root <name>] [--json]
import { loadResolvedGraph, loadPageContents } from '../src/lib/brain-index.ts';
import { computeTensions, MAX_DUP_PAGES, type Tension } from '../src/lib/consolidate.ts';
import { openFolderAsBrain } from './local-brain.ts';

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

const brain = await openFolderAsBrain(source, rootArg ?? undefined);
try {
	const graph = await loadResolvedGraph(brain.db, brain.brainId, brain.config);
	const contents =
		graph.pages.length <= MAX_DUP_PAGES
			? await loadPageContents(
					brain.db,
					brain.brainId,
					graph.pages.map((p) => p.path)
				)
			: undefined;

	const tensions = computeTensions({ pages: graph.pages, edges: graph.edges, contents });

	if (asJson) {
		console.log(
			JSON.stringify({ brainId: brain.brainId, pages: graph.pages.length, tensions }, null, 2)
		);
	} else {
		report(graph.pages.length, graph.edges.length, graph.broken.length, tensions);
	}
} finally {
	await brain.cleanup();
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
