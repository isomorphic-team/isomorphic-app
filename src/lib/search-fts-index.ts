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

async function matchingPaths(db: D1Database, brainId: string, match: string): Promise<Set<string>> {
	const rows = await db
		.prepare(`SELECT p.path FROM ${PAGES} WHERE ${FTS_TABLE} MATCH ?1 AND p.brain_id = ?2`)
		.bind(match, brainId)
		.all<{ path: string }>();
	return new Set(rows.results.map((r) => r.path));
}

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
	const rows = await db
		.prepare(
			`SELECT p.path, p.title, bm25(${FTS_TABLE}, ${BM25_WEIGHTS}) AS score
			 FROM ${PAGES} WHERE ${FTS_TABLE} MATCH ?1 AND p.brain_id = ?2`
		)
		.bind(any, brainId)
		.all<{ path: string; title: string | null; score: number }>();
	const inScope = rows.results.filter((r) => !prefix || r.path.startsWith(prefix));
	if (inScope.length === 0) return empty;

	// Coverage needs to know which terms each page holds: one MATCH per term (at most six).
	const perTerm = await Promise.all(terms.map((t) => matchingPaths(db, brainId, ftsQuote(t))));
	const words = q.phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const phrase =
		words.length > 1 ? await matchingPaths(db, brainId, ftsQuote(words.join(' '))) : new Set();

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
