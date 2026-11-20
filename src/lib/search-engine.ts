// Which engine answers a search, where the index has full-text search.
//
// FTS5 answers. searchIndex still answers a query FTS5 cannot express (no letter or digit
// in any term, which its tokenizer drops), and any search on which FTS5 fails. The log
// line carries counts and timings only: no query text, no path and no brain.
// Design: docs/design/brain-index-storage.md.

import { tokenizeQuery, type SearchResult } from './search.ts';
import { ftsUsable } from './search-fts.ts';

/** Whether FTS5 can match anything in this query. */
export const ftsCanAnswer = (query: string) => tokenizeQuery(query).terms.some(ftsUsable);

export interface SearchEngineLog {
	event: 'search';
	/** `fallback`: FTS5 threw and searchIndex answered. */
	engine: 'fts5' | 'like' | 'fallback';
	terms: number;
	pages: number;
	ms: number;
}

export async function ftsFirstSearch(
	query: string,
	engines: { fts: () => Promise<SearchResult>; like: () => Promise<SearchResult> },
	log: (line: SearchEngineLog) => void,
	now: () => number = () => Date.now()
): Promise<SearchResult> {
	const started = now();
	let engine: SearchEngineLog['engine'] = 'like';
	let result: SearchResult;
	if (ftsCanAnswer(query)) {
		try {
			result = await engines.fts();
			engine = 'fts5';
		} catch {
			result = await engines.like();
			engine = 'fallback';
		}
	} else {
		result = await engines.like();
	}
	try {
		log({
			event: 'search',
			engine,
			terms: result.terms.length,
			pages: result.pagesMatched,
			ms: now() - started
		});
	} catch {
		// A log that throws must not cost the caller their answer.
	}
	return result;
}
