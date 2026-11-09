// FTS5 search: the pure half. Runs in shadow beside searchIndex.
//
// Ordering keeps the coverage-first rule of search.ts (a page holding more of the query's
// terms ranks above one holding fewer) and replaces the hand-weighted tie-breaks inside a
// coverage band with SQLite's BM25, which adds what search.ts lacks: rare terms count for
// more than common ones, and stemming (porter) makes `fees` find `fee`. The IO half is
// src/lib/search-fts-index.ts; docs/design/brain-index-storage.md has the comparison.

/** Opens and closes a matched token in `highlight()` output. Control characters, never in text. */
export const HL_OPEN = '\u0002';
export const HL_CLOSE = '\u0003';

/** A term FTS5 can match: it has a letter or digit once the tokenizer drops punctuation. */
export const ftsUsable = (term: string) => /[\p{L}\p{N}]/u.test(term);

/** A term as an FTS5 string literal, so query text is never read as FTS5 syntax. */
export const ftsQuote = (term: string) => `"${term.replace(/"/g, '""')}"`;

export interface FtsSignal {
	path: string;
	title: string | null;
	/** How many of the query's terms the page holds (stemmed, any indexed column). */
	covered: number;
	/** Whether the page holds the query's words as one phrase. */
	phrase: boolean;
	/** SQLite's bm25(): lower is better. */
	bm25: number;
}

/** Best first: coverage, then the whole phrase, then BM25, then path (stable across reads). */
export function rankFtsPages(signals: FtsSignal[]): FtsSignal[] {
	return signals
		.slice()
		.sort(
			(a, b) =>
				b.covered - a.covered ||
				Number(b.phrase) - Number(a.phrase) ||
				a.bm25 - b.bm25 ||
				(a.path < b.path ? -1 : 1)
		);
}

export interface FtsLine {
	line: number;
	text: string;
	/** Distinct matched words on the line, as the tokenizer marked them. */
	matched: number;
}

/**
 * The matching lines of a page, from `highlight()` output over its content: best first
 * (more distinct matched words, then earlier). Matching is the tokenizer's own, so a line
 * is found exactly when FTS5 would match it, stemming included.
 */
export function linesFromHighlight(highlighted: string): FtsLine[] {
	const out: FtsLine[] = [];
	const marked = new RegExp(`${HL_OPEN}([^${HL_CLOSE}]*)${HL_CLOSE}`, 'g');
	const strip = new RegExp(`[${HL_OPEN}${HL_CLOSE}]`, 'g');
	highlighted.split('\n').forEach((raw, i) => {
		const words = new Set([...raw.matchAll(marked)].map((m) => m[1].toLowerCase()));
		if (words.size === 0) return;
		out.push({
			line: i + 1,
			text: raw.replace(strip, '').trim().slice(0, 200),
			matched: words.size
		});
	});
	return out.sort((a, b) => b.matched - a.matched || a.line - b.line);
}
