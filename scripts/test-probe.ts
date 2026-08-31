// Golden test for the retrieval probe scorer (src/lib/probe.ts). Pure — no D1, no
// GitHub. Run: pnpm test:probe
//
// The verdict split is the whole instrument. A probe the expected page loses means
// two completely different things: nothing in the brain answered (a content gap), or
// something else answered (competition). The first cut of this collapsed both into
// "missing" and reported "nothing matched" for a query that had in fact matched
// another page, which is worse than no measurement: it hides the finding that
// motivated building probes at all.
import {
	scoreProbe,
	summarizeProbes,
	stripDeclaredProbes,
	type ProbeHit
} from '../src/lib/probe.ts';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

const hit = (path: string, line = 1): ProbeHit => ({ path, line, text: 'x' });
const BUDGET = 50;

// ---------- the four verdicts ----------
{
	const owned = scoreProbe('q', 'wiki/a.md', [hit('wiki/a.md'), hit('wiki/b.md')], BUDGET);
	check('owned: the expected page matched', owned.verdict === 'owned');
	check('owned: position is 1-based', owned.position === 1);
	check('owned: competitors exclude the expected page', owned.competitors.length === 1);

	const elsewhere = scoreProbe('q', 'wiki/a.md', [hit('wiki/b.md'), hit('wiki/c.md')], BUDGET);
	check('elsewhere: answered, but not by the expected page', elsewhere.verdict === 'elsewhere');
	check('elsewhere: no position', elsewhere.position === null);
	check('elsewhere: the answering pages are reported', elsewhere.matched.length === 2);

	const absent = scoreProbe('q', 'wiki/a.md', [], BUDGET);
	check('absent: nothing in the brain matched', absent.verdict === 'absent');

	// A miss under a full budget proves nothing: the engine returns rows in path
	// order, so pages later in the alphabet may never have been reached.
	const truncated = scoreProbe(
		'q',
		'wiki/zzz.md',
		Array.from({ length: BUDGET }, (_, i) => hit(`wiki/a${i}.md`)),
		BUDGET
	);
	check(
		'inconclusive: a miss with the budget exhausted is not a miss',
		truncated.verdict === 'inconclusive'
	);
	check('inconclusive: truncation is flagged', truncated.truncated);

	const contested = scoreProbe(
		'q',
		'wiki/a.md',
		[hit('wiki/a.md'), hit('wiki/b.md'), hit('wiki/c.md'), hit('wiki/d.md'), hit('wiki/e.md')],
		BUDGET
	);
	check('contested: many pages answering the same query', contested.verdict === 'contested');
	check('contested: still records that the expected page matched', contested.position === 1);
}

// Lines, not pages: several hits on one page are one matched page.
{
	const r = scoreProbe(
		'q',
		'wiki/a.md',
		[hit('wiki/a.md', 3), hit('wiki/a.md', 9), hit('wiki/b.md', 1)],
		BUDGET
	);
	check('matched pages are distinct', r.matched.length === 2);
	check('linesOnExpected counts lines', r.linesOnExpected === 2);
}

// ---------- the summary ----------
{
	const results = [
		scoreProbe('q1', 'wiki/a.md', [hit('wiki/a.md'), hit('wiki/note.md')], BUDGET),
		scoreProbe('q2', 'wiki/b.md', [hit('wiki/b.md'), hit('wiki/note.md')], BUDGET),
		scoreProbe('q3', 'wiki/c.md', [hit('wiki/note.md')], BUDGET),
		scoreProbe('q4', 'wiki/d.md', [], BUDGET)
	];
	const s = summarizeProbes(results);
	check(
		'summary: counts every verdict',
		s.total === 4 && s.owned === 2 && s.elsewhere === 1 && s.absent === 1
	);
	check(
		'summary: the page answering other pages questions leads the intruder list',
		s.intruders[0]?.path === 'wiki/note.md' && s.intruders[0]?.count === 3,
		JSON.stringify(s.intruders)
	);
	check(
		'summary: a page is never an intruder on its own probe',
		!s.intruders.some((i) => i.path === 'wiki/a.md')
	);
}

// ---------- the self-fulfilling probe ----------
// If a page stores the questions it answers in its own frontmatter, that text is
// indexed like any other content and the page matches its own probe because the
// probe is printed on it. Then the number measures whether the question was written
// down, not whether the page is findable.
{
	const page = [
		'---',
		'title: Master Services Agreement',
		'answers:',
		'  - conversion fee',
		'  - who owns the deliverables',
		'type: contract',
		'---',
		'',
		'# MSA',
		'',
		'Section 14.2 sets the fee payable when a client hires a partner outright.'
	].join('\n');

	const stripped = stripDeclaredProbes(page);
	check(
		'strip: the declared questions are gone',
		!stripped.includes('conversion fee') && !stripped.includes('who owns the deliverables')
	);
	check('strip: other frontmatter survives', stripped.includes('title: Master Services Agreement'));
	check('strip: the key after the list survives', stripped.includes('type: contract'));
	check('strip: the body survives', stripped.includes('Section 14.2 sets the fee'));
	check(
		'strip: a page with no frontmatter is untouched',
		stripDeclaredProbes('# Plain\n\nBody.') === '# Plain\n\nBody.'
	);
	check(
		'strip: unterminated frontmatter is untouched',
		stripDeclaredProbes('---\ntitle: x\n\nbody') === '---\ntitle: x\n\nbody'
	);
}

console.log(failures === 0 ? '\nAll probe checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
