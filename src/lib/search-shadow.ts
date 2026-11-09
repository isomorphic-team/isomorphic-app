// Shadow search: answer from the current engine, run the FTS5 engine beside it, and log
// how the two compare. The log line carries counts and timings only: no query text, no
// path and no brain, so it says nothing about what anyone searched for or where.
// Design: docs/design/brain-index-storage.md.

import type { SearchResult } from './search.ts';

/** How long the shadow engine may hold up an answer before it is abandoned. */
export const SHADOW_BUDGET_MS = 1000;

export interface ShadowComparison {
	/** Both engines put the same page first (or both found nothing). */
	top1Same: boolean;
	/** Pages in both engines' first three, out of `top3Of`. */
	top3Shared: number;
	top3Of: number;
	pagesCurrent: number;
	pagesFts: number;
}

const pagesInOrder = (r: SearchResult) => [...new Set(r.hits.map((h) => h.path))];

export function compareSearch(current: SearchResult, fts: SearchResult): ShadowComparison {
	const a = pagesInOrder(current);
	const b = pagesInOrder(fts);
	const top = a.slice(0, 3);
	return {
		top1Same: a[0] === b[0],
		top3Shared: top.filter((p) => b.slice(0, 3).includes(p)).length,
		top3Of: top.length,
		pagesCurrent: current.pagesMatched,
		pagesFts: fts.pagesMatched
	};
}

export type ShadowLog = { event: 'search-shadow'; terms: number; msCurrent: number } & (
	({ outcome: 'compared'; msFts: number } & ShadowComparison) | { outcome: 'error' | 'timeout' }
);

/**
 * The current engine's result, always. The shadow engine can fail or run out of time
 * without changing it; a failure of the current engine is the caller's to see.
 */
export async function shadowSearch(
	engines: { current: () => Promise<SearchResult>; fts: () => Promise<SearchResult> },
	log: (line: ShadowLog) => void,
	opts: { budgetMs?: number; now?: () => number } = {}
): Promise<SearchResult> {
	const now = opts.now ?? (() => Date.now());
	const started = now();
	const shadow = engines
		.fts()
		.then((result) => ({ outcome: 'compared' as const, result, ms: now() - started }))
		.catch(() => ({ outcome: 'error' as const }));
	const current = await engines.current();
	const msCurrent = now() - started;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ outcome: 'timeout' }>((resolve) => {
		timer = setTimeout(() => resolve({ outcome: 'timeout' }), opts.budgetMs ?? SHADOW_BUDGET_MS);
	});
	const other = await Promise.race([shadow, timeout]);
	clearTimeout(timer);
	const base = { event: 'search-shadow' as const, terms: current.terms.length, msCurrent };
	try {
		log(
			other.outcome === 'compared'
				? { ...base, outcome: 'compared', msFts: other.ms, ...compareSearch(current, other.result) }
				: { ...base, outcome: other.outcome }
		);
	} catch {
		// A log that throws must not cost the caller their answer.
	}
	return current;
}
