// Search ranking — the part of `search_pages` that decides what a query matches and
// which matches come back first. Pure: no D1, no network, no Worker globals, so the
// rule can be pinned over a constructed corpus (`pnpm test:search`).
//
// It exists because the previous engine had no notion of a better match. It took the
// whole query as one opaque substring, returned rows `ORDER BY path`, and capped only
// the total hit count — so a question-shaped query matched nothing whatever the brain
// contained, alphabetical position stood in for relevance, and one page could consume
// the entire budget. See docs/design/search-relevance.md.
//
// The seam with brain-index.ts is deliberate: SQL narrows candidates (which pages
// contain a term at all) and everything that ORDERS or DROPS a result happens here.

// A query is split on every character that is not a letter, a digit, `%` or `_`.
//
// Those two are held inside the token deliberately, and the reason is the contract
// rather than taste: a query carrying a LIKE wildcard has always matched it
// literally, and dropping `_` on the floor at the tokenizer would make `source_key`
// and `source key` the same search while SQL was still carefully escaping the
// character nobody was looking for any more. Keeping them also makes an identifier
// (`write_page`, `50%`) one term instead of two, which is the precise reading on a
// technical wiki.
//
// `-` is NOT held: a brain that writes "fine grained" should answer `fine-grained`,
// and hyphenation is a spelling choice in a way an underscore in an identifier is not.
const TOKEN_SPLIT = /[^\p{L}\p{N}%_]+/u;

// Single letters are noise. A lone `%` or `_` is not — it is the literal character the
// caller typed, and it is the whole reason the escaping below exists.
const MIN_TERM_LEN = 2;
const isUsableTerm = (t: string) => t.length >= MIN_TERM_LEN || /[%_]/.test(t);

// Bounds the SQL built from a query: each term costs two LIKE evaluations per row.
const MAX_TERMS = 6;

// Question words and the grammar around them. This list is what makes a
// sentence-shaped query work at all: "who owns the referral program" is three
// stopwords away from being the term query that finds the page. It is deliberately
// small and closed — a long list starts eating domain words (an "owner" page, a
// brain about "access"), and every word removed here is recall that cannot be
// recovered downstream.
const STOPWORDS = new Set([
	'a',
	'about',
	'all',
	'am',
	'an',
	'and',
	'any',
	'are',
	'as',
	'at',
	'be',
	'been',
	'being',
	'but',
	'by',
	'can',
	'could',
	'did',
	'do',
	'does',
	'each',
	'for',
	'from',
	'get',
	'got',
	'had',
	'has',
	'have',
	'he',
	'her',
	'here',
	'him',
	'his',
	'how',
	'i',
	'if',
	'in',
	'into',
	'is',
	'it',
	'its',
	'may',
	'me',
	'might',
	'must',
	'my',
	'no',
	'not',
	'of',
	'on',
	'or',
	'our',
	'out',
	'over',
	'per',
	'she',
	'should',
	'so',
	'some',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'these',
	'they',
	'this',
	'those',
	'to',
	'too',
	'up',
	'us',
	'very',
	'via',
	'was',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'who',
	'whom',
	'why',
	'will',
	'with',
	'would',
	'you',
	'your'
]);

// Words that carry no collocational meaning, so a pair containing one is not a phrase
// worth scoring: determiners, question words, auxiliaries and pronouns. Every one is
// also a stopword. Prepositions and light verbs are deliberately NOT here — "get paid",
// "paid by" and "reports to" are exactly the sub-phrases a question-shaped query is
// built out of, and dropping them would leave the proximity signal with nothing to see
// on the queries it exists to serve.
const NON_COLLOCATING = new Set([
	'a',
	'am',
	'an',
	'are',
	'be',
	'been',
	'being',
	'can',
	'could',
	'did',
	'do',
	'does',
	'had',
	'has',
	'have',
	'he',
	'her',
	'him',
	'his',
	'how',
	'i',
	'if',
	'is',
	'it',
	'its',
	'may',
	'me',
	'might',
	'must',
	'my',
	'our',
	'shall',
	'she',
	'should',
	'that',
	'the',
	'their',
	'these',
	'they',
	'this',
	'those',
	'us',
	'was',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'who',
	'whom',
	'why',
	'will',
	'would',
	'you',
	'your'
]);

export interface QueryTerms {
	/** The terms actually matched on, lowercased, deduped, in query order. */
	terms: string[];
	/** The whole query lowercased — the exactness signal, and the fallback needle. */
	phrase: string;
	/**
	 * Adjacent word pairs from the query AS WRITTEN that are worth looking for verbatim.
	 *
	 * This is the proximity signal for questions, and it exists because `phrase` cannot
	 * be one. `phrase` is the entire query, so for "what is the day rate" it asks whether
	 * a page contains that whole sentence — which no page ever does. That made W_PHRASE,
	 * the third-largest weight, dead on precisely the input tokenization was added to
	 * serve, while "day rate" sat verbatim on the page the query wanted.
	 *
	 * Pairs are taken from the raw sequence rather than the retained terms, because
	 * stopword removal destroys adjacency: "how do partners get paid" retains
	 * [partners, paid], whose pairing is "partners paid", a string the target page does
	 * not contain. The pairs it does contain are "partners get" and "get paid".
	 */
	bigrams: string[];
	/** True when stopword removal changed what is searched (worth telling the caller). */
	narrowed: boolean;
}

/**
 * Split a query into the terms a page has to contain.
 *
 * Stopwords are dropped only when something survives: "how to" is a real query on a
 * brain full of runbooks, and answering it with "no terms" would be worse than
 * answering it literally.
 */
export function tokenizeQuery(query: string): QueryTerms {
	const phrase = query.trim().toLowerCase();
	const raw = phrase.split(TOKEN_SPLIT).filter(isUsableTerm);
	const kept = raw.filter((t) => !STOPWORDS.has(t));
	const chosen = kept.length > 0 ? kept : raw;
	const terms = [...new Set(chosen)].slice(0, MAX_TERMS);
	// A query that tokenizes to nothing (punctuation, a single character, CJK text
	// that this splitter cannot segment) still has to search for something, and the
	// literal phrase is what the old engine would have used.
	if (terms.length === 0 && phrase)
		return { terms: [phrase], phrase, bigrams: [], narrowed: false };
	return {
		terms,
		phrase,
		bigrams: buildBigrams(raw, new Set(terms)),
		narrowed: terms.length !== raw.length
	};
}

/**
 * Adjacent pairs worth looking for verbatim: neither word may be a function word, and
 * at least one must be a term the page is being asked to contain anyway. The second
 * condition keeps a pair of two incidental words from scoring; the first keeps "the
 * day" out while letting "get paid" through.
 */
function buildBigrams(raw: string[], terms: Set<string>): string[] {
	const out: string[] = [];
	for (let i = 0; i + 1 < raw.length; i++) {
		const [a, b] = [raw[i], raw[i + 1]];
		if (NON_COLLOCATING.has(a) || NON_COLLOCATING.has(b)) continue;
		if (!terms.has(a) && !terms.has(b)) continue;
		out.push(`${a} ${b}`);
	}
	return [...new Set(out)].slice(0, MAX_TERMS);
}

/**
 * What SQL can cheaply learn about a page without shipping its content to the Worker:
 * which terms it holds, and whether its title or path holds them.
 *
 * `counts` is absent in the candidate phase and present once content is in hand. The
 * scorer treats absence as zero for every page, so both phases order by the same
 * function and the second only refines the first.
 */
export interface PageSignal {
	path: string;
	title: string | null;
	/** Per term, whether the page body contains it (index-aligned with `terms`). */
	has: boolean[];
	/** Whether the whole query appears verbatim in the body. */
	phrase: boolean;
	/** Per term, occurrences in the body. Absent until content is fetched. */
	counts?: number[];
	/**
	 * How many of the query's bigrams appear verbatim. Absent until content is fetched.
	 *
	 * Phase 1 deliberately does not ask SQL for this. A page containing "day rate"
	 * necessarily contains both "day" and "rate", so it already has full coverage and is
	 * in the candidate set on that alone; paying for extra LIKEs to reorder pages that
	 * all survive the cut anyway would buy nothing.
	 */
	bigramHits?: number;
}

// Weights. Coverage dominates by construction: a page holding every term outranks any
// page missing one, whatever else it has going for it. That ordering is the point of
// the whole file, so the other signals are only allowed to break ties within a
// coverage band.
//
// The two failure modes worth naming (both pinned by pnpm test:search):
//   - Title weight above coverage would reward a keyword-stuffed title over the page
//     that actually discusses the subject.
//   - Unbounded frequency would bury a short authoritative page under a long rambling
//     one, so frequency saturates and can never contribute more than W_FREQ in total.
const W_COVERAGE = 10;
const W_TITLE = 3;
const W_PATH = 1.5;
const W_PHRASE = 2.5;
const W_FREQ = 2;

// Occurrences at which the frequency signal is worth half its weight. Low on purpose:
// the difference between one mention and four says something, the difference between
// forty and eighty does not.
const FREQ_HALF = 4;

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/**
 * A page's score. Deterministic, bounded, and reproducible from the row data alone —
 * a caller handed the same signals gets the same number, which is what makes the
 * ordering explainable rather than a black box.
 */
export function scorePage(sig: PageSignal, terms: string[], bigrams: string[] = []): number {
	if (terms.length === 0) return 0;
	const covered = sig.has.filter(Boolean).length;
	const title = lower(sig.title);
	// Substring, not token equality: a page titled "Referral fees" should win the
	// query "referral fee". The reverse (querying "fees" against a "fee" page) does
	// not hold — there is no stemming here, only forward prefix tolerance.
	const inTitle = title ? terms.filter((t) => title.includes(t)).length : 0;
	const path = lower(sig.path);
	const inPath = terms.filter((t) => path.includes(t)).length;
	const total = sig.counts ? sig.counts.reduce((a, b) => a + b, 0) : 0;
	// ONE proximity signal with two lanes, so the two can never stack. The whole query
	// verbatim is worth all of W_PHRASE; failing that, the fraction of its bigrams
	// present is. For a two-word query the lanes are the same string, which is why term-
	// shaped queries score exactly as they did before bigrams existed.
	const proximity = sig.phrase
		? 1
		: bigrams.length > 0 && sig.bigramHits
			? sig.bigramHits / bigrams.length
			: 0;
	return (
		(covered / terms.length) * W_COVERAGE +
		(inTitle / terms.length) * W_TITLE +
		(inPath / terms.length) * W_PATH +
		proximity * W_PHRASE +
		(total > 0 ? (total / (total + FREQ_HALF)) * W_FREQ : 0)
	);
}

/**
 * Order pages best-first. Ties break on path so a result set is stable across reads —
 * the same property wikilink resolution relies on, and the reason two identical
 * queries never disagree about which page came first.
 */
export function rankPages(
	signals: PageSignal[],
	terms: string[],
	bigrams: string[] = []
): PageSignal[] {
	return signals
		.map((sig) => ({ sig, score: scorePage(sig, terms, bigrams) }))
		.sort((a, b) => b.score - a.score || (a.sig.path < b.sig.path ? -1 : 1))
		.map((s) => s.sig);
}

/** Build a page's signals from its content. The SQL path derives the same shape. */
export function signalsFromContent(
	page: { path: string; title?: string | null; content: string },
	q: QueryTerms
): PageSignal {
	const body = page.content.toLowerCase();
	const counts = q.terms.map((t) => countOccurrences(body, t));
	return {
		path: page.path,
		title: page.title ?? null,
		has: counts.map((c) => c > 0),
		phrase: q.phrase.length > 0 && body.includes(q.phrase),
		counts,
		bigramHits: q.bigrams.filter((b) => body.includes(b)).length
	};
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let n = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
		n++;
	return n;
}

export interface SearchHit {
	path: string;
	line: number;
	text: string;
}

interface ScoredLine {
	line: number;
	text: string;
	matched: number;
	proximity: number;
}

/**
 * The matching lines of one page, best first, before the per-page cap is applied.
 * A line matching more of the query beats one matching less; proximity breaks the tie;
 * earliest wins after that, so the choice never depends on scan order.
 *
 * Proximity here is the same two-lane signal the page scorer uses, and for the same
 * reason: keying the tie-break on the whole query meant that on a question-shaped query
 * it never fired, so the line literally reading "the day rate is 1200" was picked no
 * more often than any other line holding both words apart.
 */
export function scoreLines(content: string, q: QueryTerms): ScoredLine[] {
	const lines = content.split('\n');
	const out: ScoredLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const lc = lines[i].toLowerCase();
		const matched = q.terms.filter((t) => lc.includes(t)).length;
		if (matched === 0) continue;
		const whole = q.phrase.length > 0 && lc.includes(q.phrase);
		const bigramHits = q.bigrams.filter((b) => lc.includes(b)).length;
		out.push({
			line: i + 1,
			text: lines[i].trim().slice(0, 200),
			matched,
			proximity: whole ? 1 : q.bigrams.length > 0 ? bigramHits / q.bigrams.length : 0
		});
	}
	return out.sort((a, b) => b.matched - a.matched || b.proximity - a.proximity || a.line - b.line);
}

export interface SearchOptions {
	/** Total hits returned across all pages. */
	max: number;
	/** Hits returned from any one page, so breadth survives the total budget. */
	perPage: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { max: 50, perPage: 3 };

export interface SearchResult {
	hits: SearchHit[];
	/** The terms searched for, after stopword removal. */
	terms: string[];
	/** Distinct pages containing at least one term. */
	pagesMatched: number;
	/** Distinct pages represented in `hits`. */
	pagesShown: number;
	/** Matching lines on the shown pages that the per-page cap left out. */
	linesElided: number;
	/** True when the total budget stopped the result set short of the matches. */
	budgetHit: boolean;
}

/**
 * Rank a corpus and collect its hits. This is the whole engine: `searchIndex` calls
 * it with the pages SQL selected, and the golden test calls it with a corpus written
 * by hand. Both exercise the same ordering.
 *
 * Lines come back in page order within a page. The per-page cap picks the BEST lines
 * and then restores reading order, so the three shown are the three that matched most
 * of the query rather than the first three encountered.
 */
export function searchCorpus(
	pages: { path: string; title?: string | null; content: string }[],
	query: string,
	opts: SearchOptions = DEFAULT_SEARCH_OPTIONS,
	/** Pages that matched but whose content was never fetched (SQL narrowed them out). */
	unfetchedMatches = 0
): SearchResult {
	const q = tokenizeQuery(query);
	const signals = pages.map((p) => signalsFromContent(p, q)).filter((s) => s.has.some(Boolean));
	const byPath = new Map(pages.map((p) => [p.path, p]));

	const hits: SearchHit[] = [];
	let linesElided = 0;
	let pagesShown = 0;
	let budgetHit = false;

	for (const sig of rankPages(signals, q.terms, q.bigrams)) {
		if (hits.length >= opts.max) {
			budgetHit = true;
			break;
		}
		const page = byPath.get(sig.path);
		if (!page) continue;
		const scored = scoreLines(page.content, q);
		if (scored.length === 0) continue;
		// Room left in the global budget can be smaller than the per-page cap, in
		// which case the best lines are still the ones that fit.
		const room = Math.min(opts.perPage, opts.max - hits.length);
		const taken = scored.slice(0, room).sort((a, b) => a.line - b.line);
		linesElided += scored.length - taken.length;
		for (const t of taken) hits.push({ path: sig.path, line: t.line, text: t.text });
		pagesShown++;
	}

	return {
		hits,
		terms: q.terms,
		pagesMatched: signals.length + unfetchedMatches,
		pagesShown,
		linesElided,
		budgetHit
	};
}

/**
 * The one-line account of what was left out. Returns '' when nothing was — the old
 * response said nothing at all, so a caller could not tell "these are all the
 * matches" from "these are the first 50".
 */
export function elisionNote(r: SearchResult, opts: SearchOptions): string {
	const parts: string[] = [];
	if (r.linesElided > 0)
		parts.push(
			`showing the best ${opts.perPage} line(s) per page, ${r.linesElided} more on these pages`
		);
	const otherPages = r.pagesMatched - r.pagesShown;
	if (otherPages > 0) parts.push(`${otherPages} other page(s) also matched`);
	return parts.length ? `\n\n(${parts.join('; ')}.)` : '';
}
