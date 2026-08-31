// Run retrieval probes against a brain that lives in a folder on disk, offline.
//
//   pnpm exec tsx scripts/probe-report.ts <folder> <probes.json> [--json]
//
// The probe file is a list of { expect, questions }: the page that should own each
// question, and the questions themselves. Writing those is the model's job and the
// point of the cost split — measuring where they land is one SQL statement each.
//
// Searching runs through the REAL searchIndex, so the numbers describe the retrieval
// path an agent actually gets, lexical limits included.
import { readFile } from 'node:fs/promises';
import { searchIndex } from '../src/lib/brain-index.ts';
import { scoreProbe, summarizeProbes, diffProbeRuns, type ProbeResult } from '../src/lib/probe.ts';
import { openFolderAsBrain } from './local-brain.ts';

// The cap search_pages itself uses, so a probe sees exactly what an agent sees.
const HIT_BUDGET = 50;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const baseFlag = args.indexOf('--baseline');
const baseFile = baseFlag === -1 ? null : args[baseFlag + 1];
const positional = args.filter(
	(a, i) => !a.startsWith('--') && !(baseFlag !== -1 && i === baseFlag + 1)
);
const [source, probeFile] = positional;
if (!source || !probeFile) {
	console.error(
		'usage: tsx scripts/probe-report.ts <folder> <probes.json> [--baseline <run.json>] [--json]'
	);
	process.exit(2);
}

// A baseline is a previous run's --json output. Compared by RANK, which means the
// same thing across runs even when the verdict labels have been redefined.
const baseline: ProbeResult[] | null = baseFile
	? (JSON.parse(await readFile(baseFile, 'utf8')).results as ProbeResult[])
	: null;

const spec = JSON.parse(await readFile(probeFile, 'utf8')) as {
	expect: string;
	questions: string[];
}[];

const brain = await openFolderAsBrain(source);
try {
	const results: ProbeResult[] = [];
	for (const { expect, questions } of spec) {
		for (const q of questions) {
			// searchIndex returns the hits plus what it left out (see
			// docs/design/search-relevance.md). scoreProbe wants the hits; the rest of
			// that result is a better truncation signal than inferring one from the hit
			// count, which is the thread PR #68 is already pulling on.
			const r = await searchIndex(brain.db, brain.brainId, q, undefined, HIT_BUDGET);
			results.push(scoreProbe(q, expect, r.hits, HIT_BUDGET));
		}
	}
	const summary = summarizeProbes(results);

	if (asJson) {
		console.log(JSON.stringify({ summary, results }, null, 2));
	} else {
		const mark = {
			owned: 'OWNED    ',
			outranked: 'OUTRANKED',
			buried: 'BURIED   ',
			elsewhere: 'ELSEWHERE',
			absent: 'ABSENT   ',
			inconclusive: 'TRUNCATED'
		};
		let current = '';
		for (const r of results) {
			if (r.expect !== current) {
				current = r.expect;
				console.log(`\n${current}`);
			}
			let extra: string;
			if (r.position !== null) {
				extra = `rank ${r.position} of ${r.matched.length}, ${r.linesOnExpected} line(s)`;
				if (r.outrankedBy.length) extra += `; behind ${r.outrankedBy.slice(0, 3).join(', ')}`;
			} else if (r.verdict === 'inconclusive') {
				extra = `${r.matched.length} pages matched and the hit budget ran out — cannot tell`;
			} else if (r.verdict === 'elsewhere') {
				extra = `answered by ${r.matched.length} other page(s): ${r.matched.slice(0, 3).join(', ')}`;
			} else {
				extra = 'no page in the brain matched';
			}
			console.log(`  [${mark[r.verdict]}] "${r.query}"`);
			console.log(`              ${extra}`);
		}
		console.log(
			`\n${summary.total} probes: ${summary.owned} first, ${summary.outranked} outranked, ` +
				`${summary.buried} buried, ${summary.elsewhere} answered elsewhere, ` +
				`${summary.absent} absent, ${summary.inconclusive} inconclusive.`
		);
		const ranked = summary.positions.filter((p) => p.position !== null);
		if (ranked.length) {
			console.log(
				`\nRank of the expected page: ${ranked.map((p) => `#${p.position} x${p.count}`).join(', ')}`
			);
		}
		if (summary.intruders.length) {
			console.log(`\nPages outranking the page a question belongs to:`);
			for (const i of summary.intruders.slice(0, 8)) console.log(`  ${i.count}x  ${i.path}`);
		}
		if (baseline) {
			const diff = diffProbeRuns(baseline, results);
			console.log(
				`\nvs baseline: ${diff.improved} improved, ${diff.regressed} regressed, ${diff.same} unchanged` +
					(diff.added || diff.dropped
						? `, ${diff.added} added, ${diff.dropped} dropped (the two runs asked different questions)`
						: '')
			);
			const moved = diff.deltas.filter((d) => d.change === 'improved' || d.change === 'regressed');
			for (const d of moved) {
				const at = (p: number | null) => (p === null ? 'not found' : `#${p}`);
				const arrow = d.change === 'improved' ? '↑' : '↓';
				console.log(`  ${arrow} "${d.query}": ${at(d.before)} → ${at(d.after)}`);
			}
		}
	}
} finally {
	await brain.cleanup();
}
