// Golden test for search relevance — what a query matches, and what comes back
// first. Pure and offline: the ranking half runs on a corpus written by hand, the
// SQL half on D1 shimmed over node:sqlite. No network, no GitHub.
//
//   pnpm test:search
//
// Why this file exists (docs/design/search-relevance.md): search took the whole query
// as one opaque substring, ordered rows by path, and capped only the total hit count.
// So a question-shaped query matched nothing whatever the brain contained,
// alphabetical position stood in for relevance, and one page could eat the entire
// budget. Each section below pins one of those three, and asserts the FAILING
// direction as well — a check that passes against the old engine too is testing
// neither engine.

import {
	elisionNote,
	mergeBrainResults,
	rankPages,
	scorePage,
	searchCorpus,
	signalsFromContent,
	tokenizeQuery,
	type PageSignal,
	type SearchResult
} from '../src/lib/search.ts';
import { escapeLike, searchBrains, searchIndex } from '../src/lib/brain-index.ts';
import { searchTargets, type BrainContext } from '../src/tools/librarian.ts';
import type { AccessibleBrain } from '../src/lib/orgs.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';

import { checker } from './check.ts';

const { check, done } = checker('search checks');

// ---------------------------------------------------------------- the corpus ----
//
// Small, but shaped like the brain the evidence in the design doc came from: one page
// that OWNS a subject, one that merely mentions it, and one long page that is about
// something else entirely while using one of the same words constantly.

const REFERRALS = {
	path: 'wiki/finance/referral-fees.md',
	title: 'Referral fees',
	content: [
		'---',
		'type: policy',
		'---',
		'# Referral fees',
		'',
		'Dana owns the referral programme end to end.',
		'The referral fee is 10 percent of first-year revenue.',
		'A referral fee is paid within 30 days of the invoice clearing.',
		'Partners are paid monthly.'
	].join('\n')
};

const STANDUP = {
	path: 'wiki/meetings/2026-01-05-standup.md',
	title: 'Standup 2026-01-05',
	content: ['# Standup', '', 'Dana mentioned a referral came in from the conference.'].join('\n')
};

// About parking, not referrals, and much longer. Under a frequency-led scheme this
// would outrank the page that owns the subject.
const PARKING = {
	path: 'wiki/office/parking.md',
	title: 'Parking',
	content: [
		'# Parking',
		'',
		...Array.from({ length: 40 }, () => 'The parking fee is waived.')
	].join('\n')
};

const CORPUS = [REFERRALS, STANDUP, PARKING];

// ------------------------------------------------------ D1: a question matches ----

{
	const query = 'what is our referral fee';
	const q = tokenizeQuery(query);

	// The failing direction. If any page held this string, the old substring engine
	// would have found it and the section below would prove nothing.
	check(
		'the sentence appears verbatim on no page (so substring search found nothing)',
		CORPUS.every((p) => !p.content.toLowerCase().includes(query)),
		'a page contains the literal query — rewrite the corpus or this test is vacuous'
	);

	check(
		'stopwords are dropped, leaving the terms that carry the question',
		JSON.stringify(q.terms) === JSON.stringify(['referral', 'fee']),
		`got ${JSON.stringify(q.terms)}`
	);

	const r = searchCorpus(CORPUS, query);
	check('the sentence-shaped query now matches', r.hits.length > 0);
	check(
		'and the page that owns the answer is first',
		r.hits[0]?.path === REFERRALS.path,
		`got ${r.hits[0]?.path}`
	);

	// The other shapes from the evidence section, which all failed for the same reason.
	for (const [shape, want] of [
		['who owns the referral programme', REFERRALS.path],
		['how are partners paid', REFERRALS.path],
		['where do we park', PARKING.path]
	] as const) {
		const hit = searchCorpus(CORPUS, shape).hits[0];
		check(`"${shape}" reaches ${want}`, hit?.path === want, `got ${hit?.path}`);
	}

	// A query that is nothing BUT stopwords still searches for something rather than
	// collapsing to zero terms and matching the whole brain.
	const bare = tokenizeQuery('how to');
	check('an all-stopword query keeps its words', bare.terms.length > 0, JSON.stringify(bare.terms));
}

// ------------------------------------------------------------ D2: ranking ----

{
	const r = searchCorpus(CORPUS, 'referral fee');
	const order = [...new Set(r.hits.map((h) => h.path))];
	check(
		'the page that owns the subject outranks the one that mentions it',
		order.indexOf(REFERRALS.path) < order.indexOf(STANDUP.path),
		JSON.stringify(order)
	);
	check(
		'and outranks a long page that merely repeats one of the terms',
		order.indexOf(REFERRALS.path) < order.indexOf(PARKING.path),
		JSON.stringify(order)
	);

	// Alphabetically PARKING < REFERRALS < STANDUP, so the old ORDER BY path would have
	// put the parking page first. This is the check that separates ranking from sorting.
	const alphabetical = [...order].sort();
	check(
		'the order is not the alphabetical one the old engine produced',
		JSON.stringify(order) !== JSON.stringify(alphabetical),
		`ranked ${JSON.stringify(order)} — same as path order`
	);
}

{
	// Coverage must dominate the title signal, or a keyword-stuffed title outranks the
	// page that actually discusses the subject.
	const stuffed = {
		path: 'wiki/a.md',
		title: 'Referral fee payout schedule terms',
		content: '# Referral fee payout schedule terms\n\nSee the finance folder.'
	};
	const real = {
		path: 'wiki/b.md',
		title: 'Notes',
		content: '# Notes\n\nThe referral fee is paid on a monthly schedule from the payout account.'
	};
	const order = [
		...new Set(searchCorpus([stuffed, real], 'referral fee payout').hits.map((h) => h.path))
	];
	// Both cover all three terms here, so the title legitimately breaks the tie.
	check(
		'with equal coverage the title breaks the tie',
		order[0] === stuffed.path,
		JSON.stringify(order)
	);

	// Now make the stuffed page cover LESS. Coverage has to win.
	const thin = { ...stuffed, content: '# Referral fee payout schedule terms\n\nNothing here yet.' };
	const wide = {
		path: 'wiki/b.md',
		title: 'Notes',
		content: 'The referral fee payout is monthly.'
	};
	const order2 = [
		...new Set(searchCorpus([thin, wide], 'referral fee payout monthly').hits.map((h) => h.path))
	];
	check(
		'a page covering more terms beats a better title covering fewer',
		order2[0] === wide.path,
		JSON.stringify(order2)
	);
}

{
	// Frequency saturates, so a long rambling page cannot bury a short authoritative
	// one. Both cover every term; only the weight of repetition differs.
	const short = {
		path: 'wiki/x.md',
		title: 'Refund policy',
		content: 'The refund policy is 30 days.'
	};
	const rambling = {
		path: 'wiki/y.md',
		title: 'Meeting notes',
		content: Array.from({ length: 60 }, () => 'We talked about the refund policy again.').join('\n')
	};
	const order = [
		...new Set(searchCorpus([short, rambling], 'refund policy').hits.map((h) => h.path))
	];
	check(
		'a short authoritative page is not buried by a repetitive one',
		order[0] === short.path,
		JSON.stringify(order)
	);

	// The failing direction: frequency does still count when nothing else separates
	// two pages, so the signal is present rather than merely switched off.
	const terms = ['refund', 'policy'];
	const base: PageSignal = { path: 'wiki/z.md', title: null, has: [true, true], phrase: true };
	const once = scorePage({ ...base, counts: [1, 1] }, terms);
	const often = scorePage({ ...base, counts: [9, 9] }, terms);
	check('frequency still separates otherwise identical pages', often > once, `${often} vs ${once}`);
	check('but is bounded', often - once < 1.5, `${often - once}`);
}

{
	// Determinism: two pages that score identically come back in a fixed order, so the
	// same query never disagrees with itself between reads.
	const terms = ['alpha'];
	const sigs: PageSignal[] = [
		{ path: 'wiki/b.md', title: null, has: [true], phrase: false },
		{ path: 'wiki/a.md', title: null, has: [true], phrase: false }
	];
	check(
		'ties break on path, so ordering is stable',
		rankPages(sigs, terms)[0].path === 'wiki/a.md' &&
			rankPages([...sigs].reverse(), terms)[0].path === 'wiki/a.md'
	);
}

// ------------------------------- proximity: the phrase signal on a question ----
//
// Found by running retrieval probes against a real brain after the first version
// merged, not by writing this file. `phrase` is the WHOLE query, so on a sentence it
// asks whether a page contains "what is the day rate" — which no page does. W_PHRASE,
// the third-largest weight, was dead on exactly the input tokenization exists to serve,
// while the two words that matter sat verbatim on the page the query wanted.

{
	const q = tokenizeQuery('what is the day rate');
	check(
		'the whole-query phrase is unusable on a sentence',
		!'Our standard day rate is 1200.'.toLowerCase().includes(q.phrase),
		'the corpus line contains the whole query — this section would be vacuous'
	);
	check(
		'the meaningful pair is extracted instead',
		JSON.stringify(q.bigrams) === JSON.stringify(['day rate']),
		JSON.stringify(q.bigrams)
	);
	// A determiner carries no collocation, so "the day" must not become a bigram — it
	// would dilute the signal and score a page that merely says "the day".
	check('a determiner pair is not a bigram', !q.bigrams.includes('the day'));

	// Stopword removal destroys adjacency, which is why pairs come from the RAW
	// sequence: the retained terms here are [partners, paid], and "partners paid" is a
	// string the target page does not contain.
	const q2 = tokenizeQuery('how do partners get paid');
	check(
		'a light verb between two terms is kept, not paired around',
		q2.bigrams.includes('get paid') && !q2.bigrams.includes('partners paid'),
		JSON.stringify(q2.bigrams)
	);
	check('and an auxiliary pair is dropped', !q2.bigrams.includes('do partners'));
}

{
	// The case the probe run asked for: a sentence-shaped query whose meaningful
	// sub-phrase is verbatim on one page and scattered on another.
	// Paths and titles are deliberately free of both query terms, and both pages hold
	// each term exactly once, so coverage, title, path and frequency are all identical
	// and proximity is the ONLY thing that can separate them. The scattered page also
	// sorts first alphabetically, so a tie hands the query to the wrong page.
	const together = {
		path: 'wiki/omega.md',
		title: 'Commercials',
		content: 'Our standard day rate is 1200.'
	};
	const scattered = {
		path: 'wiki/alpha.md',
		title: 'Commercials',
		content: 'The rate was agreed. It took a day.'
	};
	const order = [
		...new Set(searchCorpus([scattered, together], 'what is the day rate').hits.map((h) => h.path))
	];
	check(
		'a verbatim sub-phrase outranks the same terms scattered',
		order[0] === together.path,
		JSON.stringify(order)
	);

	// The failing direction, and the reason this needed fixing rather than tuning: with
	// no bigram lane the two tie exactly, and the tie breaks on path — handing the query
	// to the page that only happens to sort first.
	const q = tokenizeQuery('what is the day rate');
	const sigs = [together, scattered].map((p) => signalsFromContent(p, q));
	check(
		'without the bigram lane the two are indistinguishable',
		scorePage(sigs[0], q.terms, []) === scorePage(sigs[1], q.terms, []),
		`${scorePage(sigs[0], q.terms, [])} vs ${scorePage(sigs[1], q.terms, [])}`
	);
	check(
		'so the old tie-break would have answered with the wrong page',
		rankPages(sigs, q.terms, [])[0].path === scattered.path
	);
	check(
		'and with it the verbatim page scores higher',
		scorePage(sigs[0], q.terms, q.bigrams) > scorePage(sigs[1], q.terms, q.bigrams)
	);
}

{
	// The two lanes are ONE signal and must not stack, or a term-shaped query would be
	// worth twice a sentence-shaped one on the same evidence.
	const q = tokenizeQuery('referral fee');
	check(
		'a two-word query has the phrase and the bigram as the same string',
		q.bigrams.length === 1 && q.bigrams[0] === q.phrase
	);
	const sig = signalsFromContent(
		{ path: 'wiki/a.md', title: null, content: 'The referral fee is 10 percent.' },
		q
	);
	const withBoth = scorePage(sig, q.terms, q.bigrams);
	const phraseOnly = scorePage({ ...sig, bigramHits: 0 }, q.terms, []);
	check(
		'so they contribute once, not twice',
		withBoth === phraseOnly,
		`${withBoth} vs ${phraseOnly}`
	);
}

{
	// The same defect lived in line selection, whose tie-break was keyed on the same
	// unusable whole-query phrase: the line that actually answers the question was
	// picked no more often than any other line holding both words apart.
	const page = {
		path: 'wiki/p.md',
		title: 'Commercials',
		content: [
			'The rate was agreed in March.', // 1: one term
			'It took a day to close.', // 2: one term
			'Every day we review the rate.', // 3: both terms, no phrase
			'Our standard day rate is 1200.' // 4: both terms AND the bigram
		].join('\n')
	};
	const r = searchCorpus([page], 'what is the day rate', { max: 50, perPage: 1 });
	check(
		'the one line kept is the one carrying the sub-phrase',
		r.hits.length === 1 && r.hits[0].line === 4,
		JSON.stringify(r.hits)
	);
}

// --------------------------------------------------- D3: the per-page hit cap ----

{
	// One page with more matching lines than the whole budget, plus four pages with one
	// each. Under the old engine the first page consumed all 50 and the other four were
	// invisible, with nothing in the response saying so.
	const hog = {
		path: 'wiki/a-hog.md',
		title: 'Hog',
		content: Array.from({ length: 60 }, (_, i) => `line ${i} mentions onboarding`).join('\n')
	};
	const others = ['b', 'c', 'd', 'e'].map((n) => ({
		path: `wiki/${n}.md`,
		title: n,
		content: `# ${n}\n\nA note about onboarding.`
	}));
	const corpus = [hog, ...others];

	const capped = searchCorpus(corpus, 'onboarding', { max: 50, perPage: 3 });
	const pages = new Set(capped.hits.map((h) => h.path));
	check(
		'every page is represented once hits are capped per page',
		pages.size === 5,
		`${pages.size} page(s)`
	);
	check(
		'and no page contributes more than the cap',
		capped.hits.filter((h) => h.path === hog.path).length === 3
	);
	check('the elided lines are counted', capped.linesElided === 57, `${capped.linesElided}`);

	// The failing direction: without the cap, this corpus collapses to one page. If
	// this ever stops holding, the cap is no longer what produces the breadth above.
	const uncapped = searchCorpus(corpus, 'onboarding', { max: 50, perPage: 50 });
	check(
		'without the cap one page starves the rest',
		new Set(uncapped.hits.map((h) => h.path)).size === 1,
		`${new Set(uncapped.hits.map((h) => h.path)).size} page(s)`
	);

	// Silence was the other half of the defect: a caller could not tell "these are all
	// the matches" from "these are the first 50".
	const note = elisionNote(capped, { max: 50, perPage: 3 });
	check('the response says lines were elided', note.includes('57 more'), note);
	check(
		'a complete result set says nothing',
		elisionNote(searchCorpus(others, 'onboarding', { max: 50, perPage: 3 }), {
			max: 50,
			perPage: 3
		}) === ''
	);

	// The global budget still governs when it is smaller than pages x cap.
	const tight = searchCorpus(corpus, 'onboarding', { max: 4, perPage: 3 });
	check('the total budget is never exceeded', tight.hits.length === 4, `${tight.hits.length}`);
	check('and exhausting it is reported', tight.budgetHit);
}

{
	// The cap picks the BEST lines, not the first three. A page's opening lines usually
	// mention one term; the line that answers the query usually mentions all of them.
	const page = {
		path: 'wiki/p.md',
		title: 'P',
		content: [
			'The referral scheme.', // 1: one term
			'Fee schedule below.', // 2: one term
			'Another referral note.', // 3: one term
			'Another fee note.', // 4: one term
			'The referral fee is 10 percent.' // 5: both terms + the phrase
		].join('\n')
	};
	const r = searchCorpus([page], 'referral fee', { max: 50, perPage: 2 });
	check(
		'the best line survives the cap even when it is last',
		r.hits.some((h) => h.line === 5),
		JSON.stringify(r.hits)
	);
	check(
		'and the kept lines are returned in reading order',
		r.hits.every((h, i) => i === 0 || r.hits[i - 1].line < h.line),
		JSON.stringify(r.hits)
	);
}

// ------------------------------------------------------------ the output shape ----

{
	const r = searchCorpus(CORPUS, 'referral fee');
	check(
		'every hit carries a path, a 1-based line and text',
		r.hits.every((h) => !!h.path && h.line >= 1 && h.text.length > 0)
	);

	// The text block is the source of truth for chat and agent consumers, and its line
	// format is what they parse. Round-trip it the way a consumer would.
	const block = r.hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
	const parsed = block.split('\n').map((l) => /^(.+\.md):(\d+): (.*)$/.exec(l));
	check(
		'the text block still parses as path:line: text',
		parsed.every((m) => m !== null)
	);
	check(
		'and the line numbers point at the real lines',
		r.hits.every((h) => {
			const page = CORPUS.find((p) => p.path === h.path)!;
			return page.content.split('\n')[h.line - 1].trim().slice(0, 200) === h.text;
		})
	);

	check(
		'a query with no matches anywhere returns nothing',
		searchCorpus(CORPUS, 'zygote').hits.length === 0
	);
	check(
		'the terms searched are reported back',
		JSON.stringify(searchCorpus(CORPUS, 'what is our referral fee').terms) ===
			JSON.stringify(['referral', 'fee'])
	);
}

// ------------------------------------ the SQL half: D1 over node:sqlite ----------
//
// searchIndex is what production calls. The section above pins the ranking; this pins
// that SQL narrowing agrees with it, and that a query's own % or _ never becomes a
// wildcard.

const { db, sqlite } = localD1();

const BRAIN = 'example-org/brain';
function seed(pages: { path: string; title: string | null; content: string }[]) {
	sqlite.prepare('DELETE FROM brain_pages').run();
	for (const p of pages) {
		sqlite
			.prepare(
				'INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)'
			)
			.run(BRAIN, p.path, p.title, 'sha-' + p.path, p.content);
	}
}

{
	seed(CORPUS.map((p) => ({ path: p.path, title: p.title, content: p.content })));

	const r = await searchIndex(db, BRAIN, 'what is our referral fee', undefined, 50);
	check('searchIndex answers a sentence-shaped query', r.hits.length > 0);
	check(
		'and ranks the owning page first through the real SQL path',
		r.hits[0]?.path === REFERRALS.path,
		`got ${r.hits[0]?.path}`
	);
	check('it reports how many pages matched', r.pagesMatched >= 2, `${r.pagesMatched}`);
	check(
		'and how many it showed',
		r.pagesShown === r.pagesMatched,
		`${r.pagesShown}/${r.pagesMatched}`
	);

	// The SQL is an OR over terms, so a page holding only some of them is a weaker
	// match rather than a non-match. ANDing would reintroduce the empty result.
	const partial = await searchIndex(db, BRAIN, 'referral parking', undefined, 50);
	check('a page holding only one term is still a match', partial.hits.length > 0);

	const scoped = await searchIndex(db, BRAIN, 'referral fee', 'wiki/meetings/', 50);
	check(
		'the prefix filter still restricts to a subtree',
		scoped.hits.length > 0 && scoped.hits.every((h) => h.path.startsWith('wiki/meetings/')),
		JSON.stringify(scoped.hits.map((h) => h.path))
	);

	check(
		'a term nothing holds returns no hits',
		(await searchIndex(db, BRAIN, 'zygote', undefined, 50)).hits.length === 0
	);
}

{
	// LIKE wildcards in the query itself. escapeLike keeps them literal at the SQL
	// layer; the phrase signal keeps the literal page ranked first at the scoring
	// layer. Tokenization does widen what matches — "50%" also finds "50 percent" —
	// which is the same widening every query gets, and the exact page still wins.
	seed([
		{ path: 'wiki/literal.md', title: 'Discount', content: 'The discount is 50% for partners.' },
		{
			path: 'wiki/other.md',
			title: 'Discount notes',
			content: 'The discount is 50 percent for partners.'
		},
		{ path: 'wiki/under.md', title: 'Fields', content: 'The source_key field binds a page.' },
		{ path: 'wiki/spaced.md', title: 'Fields notes', content: 'The source key field binds a page.' }
	]);

	// `%` is held inside the token, so "50%" is one literal term: the page that writes
	// "50 percent" is not a match for it at all.
	const pct = await searchIndex(db, BRAIN, '50%', undefined, 50);
	check(
		'a % in the query stays part of the term and matches only the literal page',
		pct.hits.length > 0 && pct.hits.every((h) => h.path === 'wiki/literal.md'),
		JSON.stringify(pct.hits.map((h) => h.path))
	);
	// The failing direction: if % were passed through as a LIKE wildcard, "%" alone
	// would match every page. It must match only the page that contains one.
	const bare = await searchIndex(db, BRAIN, '%', undefined, 50);
	check(
		'a bare % is matched literally, not as a wildcard',
		bare.hits.length > 0 && bare.hits.every((h) => h.path === 'wiki/literal.md'),
		JSON.stringify(bare.hits.map((h) => h.path))
	);

	const under = await searchIndex(db, BRAIN, 'source_key', undefined, 50);
	check(
		'an _ in the query stays part of the term and matches only the literal page',
		under.hits.length > 0 && under.hits.every((h) => h.path === 'wiki/under.md'),
		JSON.stringify(under.hits.map((h) => h.path))
	);
	// A lone _ survives the minimum term length, so it is still a term the page has to
	// carry. If it were treated as LIKE's single-character wildcard it would match
	// every page; if it were dropped as noise, only "field" would decide the query and
	// the spaced page would tie with the literal one.
	const bareUnder = await searchIndex(db, BRAIN, '_ field', undefined, 50);
	check(
		'a lone _ is a literal term, not a single-character wildcard',
		bareUnder.hits[0]?.path === 'wiki/under.md' &&
			bareUnder.hits.some((h) => h.path === 'wiki/spaced.md'),
		JSON.stringify(bareUnder.hits.map((h) => h.path))
	);

	// escapeLike has to be pinned DIRECTLY, because the checks above cannot see it.
	// searchCorpus re-verifies every candidate against the content it fetched, so an
	// unescaped `%` that made phase 1 match every page in the brain would still yield
	// the right hits — after scanning and fetching far more than it needed to. Deleting
	// the escaping is a performance regression that no result-shaped assertion catches.
	check('escapeLike escapes the LIKE wildcards', escapeLike('50%_x') === '50\\%\\_x');
	check('and its own escape character', escapeLike('a\\b') === 'a\\\\b');
	check('and leaves ordinary text alone', escapeLike('referral fee') === 'referral fee');

	// The other half of that pair: over-matching in SQL can never become a wrong hit,
	// because the content check runs again in the Worker.
	const verified = await searchIndex(db, BRAIN, '50%', undefined, 50);
	check(
		'a candidate that does not really contain the term is dropped, not returned',
		!verified.hits.some((h) => h.path === 'wiki/other.md'),
		JSON.stringify(verified.hits.map((h) => h.path))
	);
}

{
	// The per-page cap through the real SQL path, which is where it actually protects
	// breadth: 60 matching lines on one page, one line on each of four others.
	seed([
		{
			path: 'wiki/a-hog.md',
			title: 'Hog',
			content: Array.from({ length: 60 }, (_, i) => `line ${i} mentions onboarding`).join('\n')
		},
		...['b', 'c', 'd', 'e'].map((n) => ({
			path: `wiki/${n}.md`,
			title: n,
			content: `# ${n}\n\nA note about onboarding.`
		}))
	]);
	const r = await searchIndex(db, BRAIN, 'onboarding', undefined, 50);
	check(
		'searchIndex represents every matching page, not just the first',
		new Set(r.hits.map((h) => h.path)).size === 5,
		JSON.stringify(r.hits.map((h) => h.path))
	);
	check('and reports the lines it left out', r.linesElided === 57, `${r.linesElided}`);
}

{
	// Signals derived from SQL and signals derived from content have to agree, or the
	// candidate cut drops pages the scorer would have ranked highly.
	const q = tokenizeQuery('referral fee');
	const fromContent = signalsFromContent(REFERRALS, q);
	seed([{ path: REFERRALS.path, title: REFERRALS.title, content: REFERRALS.content }]);
	const r = await searchIndex(db, BRAIN, 'referral fee', undefined, 50);
	check(
		'the two ways of deriving a page signal agree',
		fromContent.has.every(Boolean) && fromContent.phrase && r.hits.length > 0
	);
}

// ------------------------------------------------------------ across brains ----
//
// Two decisions, both of which fail SILENTLY rather than loudly, which is why each has
// its failing direction asserted:
//
//   searchTargets      WHICH brains a search reaches. Wrong, and one client's material
//                      appears in another client's conversation, or a search claims to
//                      span brains while quietly answering for one.
//   mergeBrainResults  HOW the global ceiling is spent across those brains. The failure
//                      is a fan-out where the first brain fills the cap and every later
//                      brain reports nothing, which reads as "the others have no
//                      matches" rather than "we stopped looking".

function result(paths: string[], budgetHit = false): SearchResult {
	return {
		hits: paths.map((path, i) => ({ path, line: i + 1, text: path })),
		terms: ['x'],
		pagesMatched: paths.length,
		pagesShown: paths.length,
		linesElided: 0,
		budgetHit
	};
}

{
	// The loud brain has 40 hits of its own; the quiet one has 3. A ceiling of 20 taken
	// in order would be spent entirely on the loud one.
	const loud = result(Array.from({ length: 40 }, (_, i) => `wiki/loud-${i}.md`));
	const quiet = result(['wiki/q1.md', 'wiki/q2.md', 'wiki/q3.md']);
	const m = mergeBrainResults(
		[
			{ brainId: 'acme/wiki', result: loud },
			{ brainId: 'northwind/wiki', result: quiet }
		],
		20
	);
	const nw = m.hits.filter((h) => h.brainId === 'northwind/wiki');
	check('the quiet brain keeps every one of its hits under the ceiling', nw.length === 3);
	check('the ceiling holds', m.hits.length === 20, `${m.hits.length}`);
	check('and hitting it is reported', m.budgetHit);
	// Grouped for reading, in the caller's order, even though selection interleaved.
	const ids = m.hits.map((h) => h.brainId);
	check(
		'hits are grouped by brain, caller order',
		ids.lastIndexOf('acme/wiki') < ids.indexOf('northwind/wiki'),
		JSON.stringify(ids)
	);
	const loudOut = m.hits.filter((h) => h.brainId === 'acme/wiki').map((h) => h.path);
	check(
		'within a brain the engine\'s rank order survives',
		loudOut.every((p, i) => p === `wiki/loud-${i}.md`),
		JSON.stringify(loudOut)
	);
	check('pagesMatched sums across brains', m.pagesMatched === 43, `${m.pagesMatched}`);
}

{
	// One brain: the identity. This is what keeps the single-brain search byte-identical
	// to what it was before fan-out existed.
	const one = result(['wiki/b.md', 'wiki/a.md', 'wiki/c.md']);
	const m = mergeBrainResults([{ brainId: 'acme/wiki', result: one }], 50);
	check(
		'one brain comes back exactly as ranked',
		JSON.stringify(m.hits.map((h) => h.path)) === JSON.stringify(['wiki/b.md', 'wiki/a.md', 'wiki/c.md'])
	);
	check('and no budget is reported hit', !m.budgetHit);
	check("a brain's own budgetHit is carried through", mergeBrainResults([{ brainId: 'x', result: result(['a'], true) }], 50).budgetHit);
	check('no brains, no hits', mergeBrainResults([], 50).hits.length === 0);
}

{
	// Through the real SQL path, three brains in one D1, deliberately lopsided. The
	// third brain matches the needle and is in nobody's list, which is what makes
	// isolation an assertion rather than a tautology.
	sqlite.prepare('DELETE FROM brain_pages').run();
	const ins = sqlite.prepare(
		'INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)'
	);
	for (let i = 0; i < 60; i++) {
		const path = `wiki/acme-${String(i).padStart(2, '0')}.md`;
		ins.run('acme/wiki', path, `Page ${i}`, 'sha-' + path, '# Page\nthe kickoff plan\n');
	}
	ins.run('northwind/wiki', 'wiki/kickoff.md', 'Kickoff', 's1', '# Kickoff\nthe kickoff agenda\n');
	ins.run('northwind/wiki', 'wiki/notes/later.md', 'Later', 's2', 'nothing here\nkickoff follow-up\n');
	ins.run('private/wiki', 'wiki/secret.md', 'Secret', 's3', '# Secret\nthe kickoff nobody may see\n');

	const wide = await searchBrains(db, ['acme/wiki', 'northwind/wiki'], 'kickoff', undefined, {
		perBrain: 15,
		total: 50
	});
	check(
		'a brain absent from the list contributes nothing',
		!wide.hits.some((h) => h.brainId === 'private/wiki')
	);
	const nw = wide.hits.filter((h) => h.brainId === 'northwind/wiki');
	const acme = wide.hits.filter((h) => h.brainId === 'acme/wiki');
	check('the quiet brain still reports its hits', nw.length >= 2, `got ${nw.length}`);
	check('the loud brain is held to its own budget', acme.length === 15, `got ${acme.length}`);
	check('every hit names its brain', wide.hits.every((h) => h.brainId));
	check(
		'per-brain results ride along for per-brain notes',
		wide.perBrain.get('northwind/wiki')?.pagesMatched === 2,
		`${wide.perBrain.get('northwind/wiki')?.pagesMatched}`
	);
	check('the terms are reported once', wide.terms.includes('kickoff'), JSON.stringify(wide.terms));

	const scoped = await searchBrains(db, ['northwind/wiki'], 'kickoff', 'wiki/notes/', {
		perBrain: 50,
		total: 50
	});
	check(
		'prefix restricts to a subtree, per brain',
		scoped.hits.length === 1 && scoped.hits[0].path === 'wiki/notes/later.md',
		JSON.stringify(scoped.hits)
	);
	const none = await searchBrains(db, [], 'kickoff', undefined, { perBrain: 50, total: 50 });
	check('no brains means no hits', none.hits.length === 0);
}

// searchTargets: which brains a fan-out is allowed to reach.
function ctxFor(id: string, label: string): BrainContext {
	return { brainId: id, activeBrain: { id, label } } as BrainContext;
}
function brain(id: string, name: string): AccessibleBrain {
	const [repo_owner, repo_name] = id.split('/');
	return { id, repo_owner, repo_name, name } as AccessibleBrain;
}

{
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), undefined);
	check('with no wiring, a search reaches exactly the brain you are in', t.length === 1);
	check('and it is labelled', t[0].id === 'acme/wiki' && t[0].label === 'Acme', JSON.stringify(t));
}

{
	const deps = {
		listBrains: async () => [
			brain('northwind/wiki', 'Northwind'),
			brain('acme/wiki', 'Acme'),
			brain('personal/brain', 'Personal')
		]
	};
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), deps);
	check('fanning out reaches every accessible brain', t.length === 3, JSON.stringify(t.map((x) => x.id)));
	// Leading matters twice over: the active brain wins the round-robin under the global
	// cap, and it reads first in the output.
	check('the active brain leads', t[0].id === 'acme/wiki', JSON.stringify(t.map((x) => x.id)));
	check(
		'and is not listed twice',
		t.filter((x) => x.id === 'acme/wiki').length === 1,
		JSON.stringify(t.map((x) => x.id))
	);
	check(
		'the others carry their display names',
		t.some((x) => x.id === 'northwind/wiki' && x.label === 'Northwind'),
		JSON.stringify(t)
	);
}

{
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), {
		listBrains: async () => {
			throw new Error('D1 unavailable');
		}
	});
	// A search that can still answer for the brain you are IN must not fail because the
	// wider set could not be resolved.
	check(
		'a broken brain list falls back to the active brain',
		t.length === 1 && t[0].id === 'acme/wiki'
	);
}

done();
