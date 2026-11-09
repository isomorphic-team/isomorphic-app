// Compare the current search engine with the FTS5 prototype on a brain folder, offline.
//
//   pnpm search:compare <folder> <probes.json> [--json]
//
// The probe file is probe-report's format: a list of { expect, questions }. Each question
// runs through searchIndex and searchIndexFts with the search_pages budget, and the
// expected page's rank among the returned pages is scored: found in the top 1 and top 3,
// mean reciprocal rank (0 when absent), and latency.
import { readFile } from 'node:fs/promises';
import { searchIndex } from '../src/lib/brain-index.ts';
import { rebuildFtsIndex, searchIndexFts } from '../src/lib/search-fts-index.ts';
import type { SearchResult } from '../src/lib/search.ts';
import { openFolderAsBrain } from './local-brain.ts';

const HIT_BUDGET = 50;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const [source, probeFile] = args.filter((a) => !a.startsWith('--'));
if (!source || !probeFile) {
	console.error('usage: tsx scripts/search-compare.ts <folder> <probes.json> [--json]');
	process.exit(2);
}
const spec = JSON.parse(await readFile(probeFile, 'utf8')) as {
	expect: string;
	questions: string[];
}[];

type Engine = 'current' | 'fts5';
interface Row {
	query: string;
	expect: string;
	rank: Record<Engine, number | null>;
	ms: Record<Engine, number>;
}

const pagesOf = (r: SearchResult) => [...new Set(r.hits.map((h) => h.path))];
const brain = await openFolderAsBrain(source, undefined, { indexOnly: true });
try {
	const t0 = performance.now();
	await rebuildFtsIndex(brain.db);
	const buildMs = performance.now() - t0;

	const run: Record<Engine, (q: string) => Promise<SearchResult>> = {
		current: (q) => searchIndex(brain.db, brain.brainId, q, undefined, HIT_BUDGET),
		fts5: (q) => searchIndexFts(brain.db, brain.brainId, q, undefined, HIT_BUDGET)
	};
	const rows: Row[] = [];
	for (const { expect, questions } of spec) {
		for (const query of questions) {
			const row: Row = {
				query,
				expect,
				rank: { current: null, fts5: null },
				ms: { current: 0, fts5: 0 }
			};
			for (const engine of ['current', 'fts5'] as Engine[]) {
				const t = performance.now();
				const r = await run[engine](query);
				row.ms[engine] = performance.now() - t;
				const at = pagesOf(r).indexOf(expect);
				row.rank[engine] = at === -1 ? null : at + 1;
			}
			rows.push(row);
		}
	}

	const summary = (engine: Engine) => {
		const ranks = rows.map((r) => r.rank[engine]);
		const ms = rows.map((r) => r.ms[engine]).sort((a, b) => a - b);
		const n = rows.length || 1;
		return {
			top1: ranks.filter((r) => r === 1).length,
			top3: ranks.filter((r) => r !== null && r <= 3).length,
			found: ranks.filter((r) => r !== null).length,
			mrr: ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n,
			meanMs: ms.reduce((s, x) => s + x, 0) / n,
			p95Ms: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] ?? 0
		};
	};
	const result = {
		probes: rows.length,
		ftsBuildMs: buildMs,
		current: summary('current'),
		fts5: summary('fts5'),
		rows
	};

	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const fmt = (s: ReturnType<typeof summary>) =>
			`top1 ${s.top1}/${rows.length}  top3 ${s.top3}  found ${s.found}  MRR ${s.mrr.toFixed(3)}  ` +
			`${s.meanMs.toFixed(1)} ms mean, ${s.p95Ms.toFixed(1)} ms p95`;
		console.log(`${rows.length} probes, FTS index built in ${buildMs.toFixed(0)} ms`);
		console.log(`  current  ${fmt(result.current)}`);
		console.log(`  fts5     ${fmt(result.fts5)}`);
		const at = (r: number | null) => (r === null ? '-' : `#${r}`);
		const moved = rows.filter((r) => r.rank.current !== r.rank.fts5);
		if (moved.length) console.log(`\nRank changed (current → fts5):`);
		for (const r of moved)
			console.log(`  ${at(r.rank.current)} → ${at(r.rank.fts5)}  "${r.query}"  (${r.expect})`);
	}
} finally {
	await brain.cleanup();
}
