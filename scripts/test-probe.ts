// Golden test for the retrieval probe scorer (src/lib/probe.ts). Pure — no D1, no
// GitHub. Run: pnpm test:probe
//
// The verdicts are the instrument, and both times they have been wrong it was because
// they measured something that stopped being the question:
//
//   - The first cut collapsed "nothing answered" and "the wrong page answered" into
//     one "missing" verdict, and printed "nothing matched" for queries that had in
//     fact matched another page. That hid the competition finding probes exist to
//     produce.
//   - The second keyed on how many pages co-matched, which was the right signal while
//     search took the whole query as one substring and had no order to read. Once
//     search tokenized, co-matching became ordinary: on a real brain those thresholds
//     called 30 of 34 probes "contested" on a run that put the right page first 21
//     times.
//
// So the cases below assert on RANK, and the silent ones matter as much as the loud:
// a crowded result set where the owner still wins is a success, not a warning.
import {
	scoreProbe,
	summarizeProbes,
	diffProbeRuns,
	stripDeclaredProbes,
	TOP_BAND,
	type ProbeHit
} from '../src/lib/probe.ts';

import { checker } from './check.ts';

const { check, done } = checker('probe checks');

const hit = (path: string, line = 1): ProbeHit => ({ path, line, text: 'x' });
const BUDGET = 50;

// ---------- the verdicts ----------
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

	// Ranking first is the whole point, so a crowded result set where the expected page
	// still wins is a SUCCESS. The previous version called this "contested" purely
	// because four other pages also matched, which under tokenized search is ordinary.
	const crowdedButFirst = scoreProbe(
		'q',
		'wiki/a.md',
		[hit('wiki/a.md'), hit('wiki/b.md'), hit('wiki/c.md'), hit('wiki/d.md'), hit('wiki/e.md')],
		BUDGET
	);
	check(
		'owned: many co-matching pages do not demote a first-place result',
		crowdedButFirst.verdict === 'owned'
	);
	check('owned: nothing outranked it', crowdedButFirst.outrankedBy.length === 0);

	const outranked = scoreProbe('q', 'wiki/b.md', [hit('wiki/a.md'), hit('wiki/b.md')], BUDGET);
	check('outranked: present, but beaten', outranked.verdict === 'outranked');
	check('outranked: names exactly who beat it', outranked.outrankedBy.join() === 'wiki/a.md');

	// The boundary of the top band, asserted on both sides so widening TOP_BAND is a
	// deliberate edit rather than a silent one.
	const atBand = scoreProbe(
		'q',
		'wiki/z.md',
		[...Array.from({ length: TOP_BAND - 1 }, (_, i) => hit(`wiki/${i}.md`)), hit('wiki/z.md')],
		BUDGET
	);
	check(`outranked: position ${TOP_BAND} is still in the band`, atBand.verdict === 'outranked');

	const buried = scoreProbe(
		'q',
		'wiki/z.md',
		[...Array.from({ length: TOP_BAND }, (_, i) => hit(`wiki/${i}.md`)), hit('wiki/z.md')],
		BUDGET
	);
	check(`buried: position ${TOP_BAND + 1} falls out of the band`, buried.verdict === 'buried');
	check('buried: still records the position', buried.position === TOP_BAND + 1);
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
		'summary: the rank histogram is the headline number',
		s.positions.find((p) => p.position === 1)?.count === 2 &&
			s.positions.find((p) => p.position === null)?.count === 2,
		JSON.stringify(s.positions)
	);
	// Co-occurrence while the owner still wins is NOT intrusion. Counting it is what
	// made this list useless once search tokenized: the busiest page on a real brain
	// co-occurred with 30 of 34 probes, which says only that it is long.
	const ownerWins = summarizeProbes([
		scoreProbe('q1', 'wiki/a.md', [hit('wiki/a.md'), hit('wiki/note.md')], BUDGET),
		scoreProbe('q2', 'wiki/b.md', [hit('wiki/b.md'), hit('wiki/note.md')], BUDGET)
	]);
	check(
		'summary: co-occurrence behind a winning owner is not intrusion',
		ownerWins.intruders.length === 0,
		JSON.stringify(ownerWins.intruders)
	);

	// Answering a question whose owner did not answer at all is the strongest form of
	// intrusion, not an exempt case, so it counts.
	const stoleIt = summarizeProbes([scoreProbe('q3', 'wiki/c.md', [hit('wiki/note.md')], BUDGET)]);
	check(
		'summary: answering instead of the owner counts as intrusion',
		stoleIt.intruders[0]?.path === 'wiki/note.md' && stoleIt.intruders[0]?.count === 1,
		JSON.stringify(stoleIt.intruders)
	);

	const beaten = summarizeProbes([
		scoreProbe('q1', 'wiki/a.md', [hit('wiki/note.md'), hit('wiki/a.md')], BUDGET),
		scoreProbe('q2', 'wiki/b.md', [hit('wiki/note.md'), hit('wiki/b.md')], BUDGET)
	]);
	check(
		'summary: a page that outranks its neighbours leads the intruder list',
		beaten.intruders[0]?.path === 'wiki/note.md' && beaten.intruders[0]?.count === 2,
		JSON.stringify(beaten.intruders)
	);
	check(
		'summary: a page is never an intruder on its own probe',
		!beaten.intruders.some((i) => i.path === 'wiki/a.md')
	);
}

// ---------- comparing two runs ----------
{
	const before = [
		scoreProbe('q1', 'wiki/a.md', [hit('wiki/x.md'), hit('wiki/a.md')], BUDGET), // #2
		scoreProbe('q2', 'wiki/b.md', [hit('wiki/b.md')], BUDGET), // #1
		scoreProbe('q3', 'wiki/c.md', [], BUDGET), // absent
		scoreProbe('q4', 'wiki/d.md', [hit('wiki/d.md')], BUDGET) // only in before
	];
	const after = [
		scoreProbe('q1', 'wiki/a.md', [hit('wiki/a.md')], BUDGET), // #2 → #1
		scoreProbe('q2', 'wiki/b.md', [hit('wiki/x.md'), hit('wiki/b.md')], BUDGET), // #1 → #2
		scoreProbe('q3', 'wiki/c.md', [hit('wiki/c.md')], BUDGET), // absent → #1
		scoreProbe('q5', 'wiki/e.md', [hit('wiki/e.md')], BUDGET) // only in after
	];
	const d = diffProbeRuns(before, after);
	check('diff: a better rank is an improvement', d.improved === 2, JSON.stringify(d));
	check('diff: a worse rank is a regression', d.regressed === 1);
	check(
		'diff: probes on one side only are reported, not averaged in',
		d.added === 1 && d.dropped === 1
	);
	check(
		'diff: finding a previously absent page counts as improved',
		d.deltas.find((x) => x.query === 'q3')?.change === 'improved'
	);
	check(
		'diff: worst results sort first so a regression cannot hide',
		d.deltas[0].change === 'dropped' || rankLast(d),
		JSON.stringify(d.deltas.map((x) => [x.query, x.after]))
	);
}

function rankLast(d: ReturnType<typeof diffProbeRuns>): boolean {
	const positions = d.deltas.map((x) => x.after ?? Number.POSITIVE_INFINITY);
	return positions.every((p, i) => i === 0 || positions[i - 1] >= p);
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

done();
