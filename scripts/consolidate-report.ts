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
//   pnpm consolidate:report <folder> --models [--cap 0.5] [--runs 2]
//
// --runs repeats the pass over the same database, so later runs show what the memory of
// checked pairs saves: with nothing edited between runs, they check nothing.
//
// --against <folder> compares the folder with a second brain, as review_brain's `against`
// does. Repeat it to compare with several, as `against: "all"` does. Without --models it lists the page pairs the pass would
// check, which costs nothing.
//
//   pnpm consolidate:report <folder> --against <other folder> [--models]
import type { D1Database } from '@cloudflare/workers-types';
import { d1Index } from '../src/lib/brain-index.ts';
import { entitlementSql } from '../ee/entitlements.ts';
import { FEATURES } from '../src/lib/entitlements.ts';
import {
	comparablePages,
	pagePath,
	pageTexts,
	planStep,
	runConsolidationStep,
	type PageText,
	type Proposal
} from '../ee/review/consolidation.ts';
import type { Comparison } from '../src/lib/review-checks.ts';
import { basename, dirname } from 'node:path';
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
const runsFlag = args.indexOf('--runs');
const runs = runsFlag === -1 ? 1 : Number(args[runsFlag + 1]);
const cap = capFlag === -1 ? 1 : Number(args[capFlag + 1]);
// Every --against names one more brain to compare with.
const againstAt = args.flatMap((a, i) => (a === '--against' ? [i + 1] : []));
const againstSources = againstAt.map((i) => args[i]).filter(Boolean);
const positional = args.filter(
	(a, i) =>
		!a.startsWith('--') &&
		!againstAt.includes(i) &&
		!(rootFlag !== -1 && i === rootFlag + 1) &&
		!(capFlag !== -1 && i === capFlag + 1) &&
		!(runsFlag !== -1 && i === runsFlag + 1)
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
// A folder named `wiki` is called by its parent, so two brains' `wiki` folders stay apart.
const nameOf = (folder: string) =>
	basename(folder) === 'wiki' ? basename(dirname(folder)) : basename(folder);
const otherBrains = [];
for (const folder of againstSources) {
	otherBrains.push({ name: nameOf(folder), brain: await openFolderAsBrain(folder) });
}
const against: Comparison | undefined = otherBrains.length
	? {
			all: otherBrains.length > 1,
			brains: otherBrains.map(({ name, brain: b }) => ({
				brainId: `local/${name}`,
				handle: name,
				index: d1Index(b.db as unknown as D1Database)(b.brainId),
				store: b.store,
				repo: b.locator,
				config: b.config
			}))
		}
	: undefined;
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
	if (against && !asJson) await pairPlan(against);
	if (withModels) await modelPass();
} finally {
	await brain.cleanup();
	for (const o of otherBrains) await o.brain.cleanup();
}

// The page pairs a pass against the other brains would check, for no spend.
async function pairPlan(others: Comparison) {
	const home = {
		index: d1Index(brain.db as unknown as D1Database)(brain.brainId),
		store: brain.store,
		repo: brain.locator,
		config: brain.config
	};
	const here = await pageTexts(home, (await comparablePages(home)).pages);
	const there: PageText[] = [];
	for (const b of others.brains) {
		there.push(...(await pageTexts(b, (await comparablePages(b)).pages, b.brainId)));
	}
	const plan = planStep([...here, ...there], new Map(), null, Infinity, () => true, true);
	const byId = new Map([...here, ...there].map((p) => [p.path, p]));
	const names = others.brains.map((b) => `"${b.handle}"`).join(', ');
	console.log(
		`\nAgainst ${names}: ${here.length} page(s) here, ${there.length} there, ${plan.pairs.length} pair(s) to check of ${here.length * there.length} possible.\n`
	);
	for (const { pair } of plan.pairs) {
		const [a, b] = pair.map((id) => byId.get(id)!).sort((x) => (x.other ? 1 : -1));
		console.log(
			`  ${a.path} ("${a.title}")  <->  ${b.other?.brainId}: ${pagePath(b)} ("${b.title}")`
		);
	}
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
	for (let run = 1; run <= runs; run++) {
		console.log(`\nModel consolidation pass ${run} of ${runs}, capped at $${cap}:`);
		for (let step = 0; step < 500; step++) {
			const { text, state } = await runConsolidationStep({
				db,
				index: d1Index(db)(brain.brainId),
				brainId: brain.brainId,
				orgId,
				config: brain.config,
				store: brain.store,
				repo: brain.locator,
				anthropicKey,
				openRouterKey,
				against
			});
			console.log(`  ${text}`);
			if (state?.status !== 'running') {
				if (state) console.log(`  Served by: ${JSON.stringify(state.served)}`);
				break;
			}
		}
	}
	const conflicts = (await readFindings(db, brain.brainId)).filter(
		(f) => f.kind === 'conflict' && !!f.other === !!against
	);
	if (asJson) {
		console.log(JSON.stringify(conflicts, null, 2));
		return;
	}
	const clusters = new Map<string, number>();
	for (const f of conflicts) {
		if (f.clusterId) clusters.set(f.clusterId, (clusters.get(f.clusterId) ?? 0) + 1);
	}
	const shared = [...clusters].filter(([, n]) => n > 1);
	console.log(
		`\n${conflicts.length} conflict(s), ${clusters.size} fact label(s), ${shared.length} shared: ${shared.map(([l, n]) => `"${l}" x${n}`).join(', ') || 'none'}\n`
	);
	for (const [i, f] of conflicts.entries()) {
		const p = f.proposal as Proposal;
		console.log(
			`${String(i + 1).padStart(2)}. [${p.tier}, misleading ${f.scores?.misleading ?? 'unscored'}, fact "${f.clusterId ?? '-'}"] ${f.headline}`
		);
		for (const e of f.evidence) console.log(`      ${e}`);
		if (p.patch)
			console.log(`    → patch ${p.patch.path}: "${p.patch.find}" → "${p.patch.replace}"`);
		else console.log(`    → ${p.action}${p.patchRejected ? ` (${p.patchRejected})` : ''}`);
		console.log(`      key: ${f.key}\n`);
	}
}
