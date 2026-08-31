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
import { scoreProbe, summarizeProbes, type ProbeResult } from '../src/lib/probe.ts';
import { openFolderAsBrain } from './local-brain.ts';

// The cap search_pages itself uses, so a probe sees exactly what an agent sees.
const HIT_BUDGET = 50;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const [source, probeFile] = args.filter((a) => !a.startsWith('--'));
if (!source || !probeFile) {
	console.error('usage: tsx scripts/probe-report.ts <folder> <probes.json> [--json]');
	process.exit(2);
}

const spec = JSON.parse(await readFile(probeFile, 'utf8')) as {
	expect: string;
	questions: string[];
}[];

const brain = await openFolderAsBrain(source);
try {
	const results: ProbeResult[] = [];
	for (const { expect, questions } of spec) {
		for (const q of questions) {
			const hits = await searchIndex(brain.db, brain.brainId, q, undefined, HIT_BUDGET);
			results.push(scoreProbe(q, expect, hits, HIT_BUDGET));
		}
	}
	const summary = summarizeProbes(results);

	if (asJson) {
		console.log(JSON.stringify({ summary, results }, null, 2));
	} else {
		const mark = {
			owned: 'OWNED    ',
			contested: 'CONTESTED',
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
			if (r.verdict === 'owned' || r.verdict === 'contested') {
				extra =
					`${r.linesOnExpected} line(s) on the expected page, ${r.matched.length} page(s) matched` +
					(r.competitors.length ? `; also: ${r.competitors.slice(0, 3).join(', ')}` : '');
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
			`\n${summary.total} probes: ${summary.owned} owned, ${summary.contested} contested, ` +
				`${summary.elsewhere} answered elsewhere, ${summary.absent} absent, ` +
				`${summary.inconclusive} inconclusive.`
		);
		if (summary.intruders.length) {
			console.log(`\nPages answering to other pages' questions:`);
			for (const i of summary.intruders.slice(0, 8)) console.log(`  ${i.count}x  ${i.path}`);
		}
	}
} finally {
	await brain.cleanup();
}
