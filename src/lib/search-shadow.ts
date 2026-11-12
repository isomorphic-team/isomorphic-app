// Shadow search: answer from the current engine, run the FTS5 engine beside it, and log
// how the two compare. The log line carries counts, ranks and timings only: no query
// text, no path and no brain, so it says nothing about what anyone searched for or where.
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
	/** Where FTS5's first page sits in the current engine's results, from 1; 0 if absent. */
	ftsTopInCurrent: number;
	/** Where the current engine's first page sits in FTS5's results, from 1; 0 if absent. */
	currentTopInFts: number;
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
		pagesFts: fts.pagesMatched,
		ftsTopInCurrent: b.length ? a.indexOf(b[0]) + 1 : 0,
		currentTopInFts: a.length ? b.indexOf(a[0]) + 1 : 0
	};
}

export type ShadowLog = {
	event: 'search-shadow';
	terms: number;
	/** Which engine ran first. Each runs alone, so neither's time includes the other's. */
	first: 'current' | 'fts';
	/** Absent on a timeout with FTS5 first: FTS5 was still running beside it. */
	msCurrent?: number;
} & (
	({ outcome: 'compared'; msFts: number } & ShadowComparison) | { outcome: 'error' | 'timeout' }
);

type Shadow =
	{ outcome: 'compared'; result: SearchResult; ms: number } | { outcome: 'error' | 'timeout' };

/**
 * The current engine's result, always. The engines run one after the other, because
 * they share a database that runs one query at a time and would slow each other; which
 * goes first alternates (`ftsFirst`), so neither is always the one on a cold cache. The
 * shadow engine can fail or run out of time without changing the answer; a failure of
 * the current engine is the caller's to see.
 */
export async function shadowSearch(
	engines: { current: () => Promise<SearchResult>; fts: () => Promise<SearchResult> },
	log: (line: ShadowLog) => void,
	opts: { budgetMs?: number; now?: () => number; ftsFirst?: boolean } = {}
): Promise<SearchResult> {
	const now = opts.now ?? (() => Date.now());
	const ftsFirst = opts.ftsFirst ?? Math.random() < 0.5;

	const runShadow = async (): Promise<Shadow> => {
		const started = now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<Shadow>((resolve) => {
			timer = setTimeout(() => resolve({ outcome: 'timeout' }), opts.budgetMs ?? SHADOW_BUDGET_MS);
		});
		const run = Promise.resolve()
			.then(engines.fts)
			.then((result): Shadow => ({ outcome: 'compared', result, ms: now() - started }))
			.catch((): Shadow => ({ outcome: 'error' }));
		const settled = await Promise.race([run, timeout]);
		clearTimeout(timer);
		return settled;
	};
	const runCurrent = async () => {
		const started = now();
		const result = await engines.current();
		return { result, ms: now() - started };
	};

	let shadow: Shadow;
	let current: { result: SearchResult; ms: number };
	if (ftsFirst) {
		shadow = await runShadow();
		current = await runCurrent();
	} else {
		current = await runCurrent();
		shadow = await runShadow();
	}

	// After a timeout with FTS5 first, FTS5 is still running while the current engine
	// answers, so that time is not the current engine's alone.
	const clean = !(ftsFirst && shadow.outcome === 'timeout');
	const base = {
		event: 'search-shadow' as const,
		terms: current.result.terms.length,
		first: ftsFirst ? ('fts' as const) : ('current' as const),
		...(clean ? { msCurrent: current.ms } : {})
	};
	try {
		log(
			shadow.outcome === 'compared'
				? {
						...base,
						outcome: 'compared',
						msFts: shadow.ms,
						...compareSearch(current.result, shadow.result)
					}
				: { ...base, outcome: shadow.outcome }
		);
	} catch {
		// A log that throws must not cost the caller their answer.
	}
	return current.result;
}
