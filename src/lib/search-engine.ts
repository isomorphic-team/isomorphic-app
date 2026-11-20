// One log line per search: how long it took and how much it found. Counts and timings
// only: no query text, no path and no brain.

import type { SearchResult } from './search.ts';

export interface SearchLog {
	event: 'search';
	terms: number;
	pages: number;
	ms: number;
}

export async function timedSearch(
	run: () => Promise<SearchResult>,
	log: (line: SearchLog) => void,
	now: () => number = () => Date.now()
): Promise<SearchResult> {
	const started = now();
	const result = await run();
	try {
		log({
			event: 'search',
			terms: result.terms.length,
			pages: result.pagesMatched,
			ms: now() - started
		});
	} catch {
		// A log that throws must not cost the caller their answer.
	}
	return result;
}
