// FTS5 search: the IO half. Runs in shadow beside searchIndex; search_pages does not
// answer from it (docs/design/brain-index-storage.md).
//
// The table, its source view and the triggers that keep it current are the index
// database's schema (migrations-index/0002_pages_fts.sql). They exist only there, so
// these functions must be handed that database: a virtual table blocks `d1 export` for
// the database it sits in, and the platform database has to stay exportable.

import type { D1Database } from '@cloudflare/workers-types';
import {
	DEFAULT_SEARCH_OPTIONS,
	tokenizeQuery,
	type SearchHit,
	type SearchResult
} from './search.ts';
import {
	HL_CLOSE,
	HL_OPEN,
	ftsQuote,
	ftsUsable,
	linesFromHighlight,
	rankFtsPages,
	type FtsSignal
} from './search-fts.ts';

export const FTS_TABLE = 'brain_pages_fts';

// Pages whose lines are extracted, as in searchIndex.
const MAX_FTS_CANDIDATES = 25;
// Column weights for bm25(), in table order: path_text, title, content.
const BM25_WEIGHTS = '2.0, 4.0, 1.0';
// highlight()'s column index for content.
const CONTENT_COLUMN = 2;

/** Rebuild the whole FTS index from brain_pages. */
export async function rebuildFtsIndex(db: D1Database): Promise<void> {
	await db.prepare(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('rebuild')`).run();
}

/**
 * Throws when the FTS index disagrees with brain_pages: a row missing, left behind, or
 * indexed with other text than it now holds.
 */
export async function checkFtsIndex(db: D1Database): Promise<void> {
	await db
		.prepare(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, rank) VALUES ('integrity-check', 1)`)
		.run();
}

const PAGES = `${FTS_TABLE} JOIN brain_pages p ON p.id = ${FTS_TABLE}.rowid`;

/** The same contract as searchIndex, answered by FTS5. */
export async function searchIndexFts(
	db: D1Database,
	brainId: string,
	query: string,
	prefix: string | undefined,
	max: number,
	perPage: number = DEFAULT_SEARCH_OPTIONS.perPage
): Promise<SearchResult> {
	const q = tokenizeQuery(query);
	const terms = q.terms.filter(ftsUsable);
	const empty: SearchResult = {
		hits: [],
		terms: q.terms,
		pagesMatched: 0,
		pagesShown: 0,
		linesElided: 0,
		budgetHit: false
	};
	if (terms.length === 0) return empty;

	const any = terms.map(ftsQuote).join(' OR ');
	const words = q.phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const paths = (match: string) =>
		db
			.prepare(`SELECT p.path FROM ${PAGES} WHERE ${FTS_TABLE} MATCH ?1 AND p.brain_id = ?2`)
			.bind(match, brainId);
	// One batch, so one round trip to the database: the pages holding any term with
	// their bm25, then, for coverage, the pages holding each term (at most six), then the
	// pages holding the whole phrase. Sent one by one these were up to eight round trips.
	const [scored, ...sets] = await db.batch<{ path: string; title: string | null; score: number }>([
		db
			.prepare(
				`SELECT p.path, p.title, bm25(${FTS_TABLE}, ${BM25_WEIGHTS}) AS score
					 FROM ${PAGES} WHERE ${FTS_TABLE} MATCH ?1 AND p.brain_id = ?2`
			)
			.bind(any, brainId),
		...terms.map((t) => paths(ftsQuote(t))),
		...(words.length > 1 ? [paths(ftsQuote(words.join(' ')))] : [])
	]);
	const inScope = scored.results.filter((r) => !prefix || r.path.startsWith(prefix));
	if (inScope.length === 0) return empty;
	const pathSets = sets.map((r) => new Set(r.results.map((row) => row.path)));
	const perTerm = pathSets.slice(0, terms.length);
	const phrase = pathSets[terms.length] ?? new Set<string>();

	const signals: FtsSignal[] = inScope.map((r) => ({
		path: r.path,
		title: r.title,
		covered: perTerm.filter((s) => s.has(r.path)).length,
		phrase: phrase.has(r.path),
		bm25: Number(r.score)
	}));
	const ranked = rankFtsPages(signals);
	const chosen = ranked.slice(0, MAX_FTS_CANDIDATES).map((s) => s.path);

	const lit = await db
		.prepare(
			`SELECT p.path, highlight(${FTS_TABLE}, ${CONTENT_COLUMN}, ?1, ?2) AS h FROM ${PAGES}
			 WHERE ${FTS_TABLE} MATCH ?3 AND p.brain_id = ?4
			 AND p.path IN (${chosen.map((_, i) => `?${i + 5}`).join(', ')})`
		)
		.bind(HL_OPEN, HL_CLOSE, any, brainId, ...chosen)
		.all<{ path: string; h: string }>();
	const highlighted = new Map(lit.results.map((r) => [r.path, r.h]));

	const hits: SearchHit[] = [];
	let linesElided = 0;
	let pagesShown = 0;
	let budgetHit = false;
	for (const path of chosen) {
		if (hits.length >= max) {
			budgetHit = true;
			break;
		}
		// A page can match on its title or path alone, with no line in the body.
		const lines = linesFromHighlight(highlighted.get(path) ?? '');
		const room = Math.min(perPage, max - hits.length);
		const taken = lines.length
			? lines.slice(0, room).sort((a, b) => a.line - b.line)
			: [{ line: 1, text: signals.find((s) => s.path === path)?.title ?? path, matched: 0 }];
		linesElided += Math.max(0, lines.length - taken.length);
		for (const t of taken) hits.push({ path, line: t.line, text: t.text });
		pagesShown++;
	}
	return {
		hits,
		terms,
		pagesMatched: signals.length,
		pagesShown,
		linesElided,
		budgetHit
	};
}
