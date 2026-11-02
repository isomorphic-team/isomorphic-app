// Run the consolidation detector over a brain that lives in a folder on disk, with
// no accounts and no network. Offline twin of what a `consolidate` tool call would
// compute, and the way to see what the loop says about a real brain before wiring any
// of it into the Worker.
//
//   pnpm exec tsx scripts/consolidate-report.ts <folder> [--root <name>] [--json]
//
// With --models it also runs the enterprise consolidation pass (ee/review/consolidation.ts)
// over the folder, through the real gateway, and prints the conflicts it would queue. It
// calls Claude Haiku with ANTHROPIC_API_KEY (or Luna with OPENROUTER_API_KEY), from the
// environment or .dev.vars, and spends real credits, at most --cap dollars (default 1).
// The entitlement it needs is granted in its own throwaway database, so nothing deployed
// is touched and nothing is written to the folder.
//
//   pnpm consolidate:report <folder> --models [--cap 0.5]
import type { D1Database } from '@cloudflare/workers-types';
import { FEATURES, entitlementSql } from '../ee/entitlements.ts';
import { runConsolidationStep, type Proposal } from '../ee/review/consolidation.ts';
import { readFindings } from '../src/lib/review-queue.ts';
import { loadDevVarsIntoEnv } from '../src/persist.ts';
import { loadAllFields, loadResolvedGraph, loadPageContents } from '../src/lib/brain-index.ts';
import { computeTensions, MAX_DUP_PAGES, type Tension } from '../src/lib/consolidate.ts';
import { openFolderAsBrain } from './local-brain.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const withModels = args.includes('--models');
const rootFlag = args.indexOf('--root');
const rootArg = rootFlag === -1 ? null : args[rootFlag + 1];
const capFlag = args.indexOf('--cap');
const cap = capFlag === -1 ? 1 : Number(args[capFlag + 1]);
const positional = args.filter(
	(a, i) =>
		!a.startsWith('--') &&
		!(rootFlag !== -1 && i === rootFlag + 1) &&
		!(capFlag !== -1 && i === capFlag + 1)
);
if (!Number.isFinite(cap) || cap <= 0) {
	console.error('--cap takes a positive number of dollars.');
	process.exit(2);
}
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

	const tensions = computeTensions({
		pages: graph.pages,
		edges: graph.edges,
		contents,
		fields: await loadAllFields(brain.db, brain.brainId),
		identityFields: brain.config.identityFields
	});

	if (asJson) {
		console.log(
			JSON.stringify({ brainId: brain.brainId, pages: graph.pages.length, tensions }, null, 2)
		);
	} else {
		report(graph.pages.length, graph.edges.length, graph.broken.length, tensions);
	}
	if (withModels) await modelPass();
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

// The enterprise pass, run to the end or to the cap.
async function modelPass() {
	await loadDevVarsIntoEnv();
	const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
	const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() || undefined;
	if (!anthropicKey && !openRouterKey) {
		console.error(
			'--models needs ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) in the environment or .dev.vars.'
		);
		process.exitCode = 2;
		return;
	}
	const db = brain.db as unknown as D1Database;
	const orgId = 'local-report';
	await db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId,
				feature: FEATURES.enterprise,
				source: 'manual',
				now: Date.now(),
				monthlyCapUsd: cap
			})
		)
		.run();
	console.log(`\nModel consolidation pass, capped at $${cap}:`);
	for (let step = 0; step < 500; step++) {
		const { text, state } = await runConsolidationStep({
			db,
			brainId: brain.brainId,
			orgId,
			config: brain.config,
			store: brain.store,
			repo: brain.repoArgs,
			anthropicKey,
			openRouterKey
		});
		console.log(`  ${text}`);
		if (state?.status !== 'running') {
			if (state) console.log(`  Served by: ${JSON.stringify(state.served)}`);
			break;
		}
	}
	const conflicts = (await readFindings(db, brain.brainId)).filter((f) => f.kind === 'conflict');
	if (asJson) {
		console.log(JSON.stringify(conflicts, null, 2));
		return;
	}
	console.log(`\n${conflicts.length} conflict(s):\n`);
	for (const [i, f] of conflicts.entries()) {
		const p = f.proposal as Proposal;
		console.log(
			`${String(i + 1).padStart(2)}. [${p.tier}, misleading ${f.scores?.misleading ?? 'unscored'}] ${f.headline}`
		);
		for (const e of f.evidence) console.log(`      ${e}`);
		if (p.patch)
			console.log(`    → patch ${p.patch.path}: "${p.patch.find}" → "${p.patch.replace}"`);
		else console.log(`    → ${p.action}${p.patchRejected ? ` (${p.patchRejected})` : ''}`);
		console.log(`      key: ${f.key}\n`);
	}
}
