// Run state for budgeted, resumable whole-brain passes: one row per brain per kind in D1
// `brain_passes` (migration 0022). A pass advances one budgeted step per call from its
// cursor, and the status rules live here so every pass resumes the same way:
//
//   - a `running` or `stopped` pass is continued by the next call;
//   - a `done` pass, or none, is replaced by a new one.
//
// What a pass counts is its own: `counters` is stored as JSON and read back over the
// pass's defaults, so a counter added later reads as its default on an older row.
//
// Worker-safe: no node:* imports.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export type PassStatus = 'running' | 'stopped' | 'done';

export interface PassState<C> {
	runId: string;
	status: PassStatus;
	cursor: string | null;
	counters: C;
	stoppedReason: string | null;
	// When this run began, and finished (null until done). Read from the row; a save keeps
	// the stored start for the same run id.
	startedAt: number;
	finishedAt: number | null;
}

export interface PassScope {
	brainId: string;
	kind: string;
	orgId?: string;
	actorUserId?: string;
}

interface PassRow {
	run_id: string;
	status: string;
	cursor: string | null;
	counters: string;
	stopped_reason: string | null;
	started_at: number;
	finished_at: number | null;
}

export async function readPass<C extends object>(
	db: D1Database,
	brainId: string,
	kind: string,
	defaults: C
): Promise<PassState<C> | null> {
	const r = await db
		.prepare(
			`SELECT run_id, status, cursor, counters, stopped_reason, started_at, finished_at
			 FROM brain_passes WHERE brain_id = ?1 AND kind = ?2`
		)
		.bind(brainId, kind)
		.first<PassRow>();
	if (!r) return null;
	let counters: Partial<C> = {};
	try {
		counters = JSON.parse(r.counters) as Partial<C>;
	} catch {
		// Counters that cannot be read start again from the defaults; the cursor still holds.
	}
	return {
		runId: r.run_id,
		status: r.status as PassStatus,
		cursor: r.cursor,
		counters: { ...defaults, ...counters },
		stoppedReason: r.stopped_reason,
		startedAt: r.started_at,
		finishedAt: r.finished_at
	};
}

// The pass a step works on: the one in progress, or a fresh one. Pure.
export function continuePass<C>(
	existing: PassState<C> | null,
	defaults: C,
	newRunId: () => string,
	now: number
): PassState<C> {
	if (existing && existing.status !== 'done') {
		return { ...existing, status: 'running', stoppedReason: null };
	}
	return {
		runId: newRunId(),
		status: 'running',
		cursor: null,
		counters: defaults,
		stoppedReason: null,
		startedAt: now,
		finishedAt: null
	};
}

// The write that records a step, for a caller to run alone or inside its own batch, so a
// step's results and its cursor can land together. Who started a run and when are kept
// across its steps and replaced only with a new run id.
export function savePassStatement<C>(
	db: D1Database,
	scope: PassScope,
	s: PassState<C>,
	now: number
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO brain_passes
			   (brain_id, kind, org_id, run_id, status, cursor, counters, stopped_reason,
			    started_by, started_at, updated_at, finished_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
			 ON CONFLICT (brain_id, kind) DO UPDATE SET
			   org_id = ?3, status = ?5, cursor = ?6, counters = ?7, stopped_reason = ?8,
			   started_by = CASE WHEN run_id = ?4 THEN started_by ELSE ?9 END,
			   started_at = CASE WHEN run_id = ?4 THEN started_at ELSE ?10 END,
			   run_id = ?4, updated_at = ?10, finished_at = ?11`
		)
		.bind(
			scope.brainId,
			scope.kind,
			scope.orgId ?? null,
			s.runId,
			s.status,
			s.cursor,
			JSON.stringify(s.counters),
			s.stoppedReason,
			scope.actorUserId ?? null,
			now,
			s.status === 'done' ? now : null
		);
}

export async function savePass<C>(
	db: D1Database,
	scope: PassScope,
	s: PassState<C>,
	now: number
): Promise<void> {
	await savePassStatement(db, scope, s, now).run();
}

// ---------- what a pass last checked ----------

// Each item a kind of pass has checked in a brain, with the fingerprint of everything that
// check depended on. A pass skips an item whose fingerprint has not changed.
export async function readPassItems(
	db: D1Database,
	brainId: string,
	kind: string
): Promise<Map<string, string>> {
	const { results } = await db
		.prepare('SELECT item, fingerprint FROM brain_pass_items WHERE brain_id = ?1 AND kind = ?2')
		.bind(brainId, kind)
		.all<{ item: string; fingerprint: string }>();
	return new Map(results.map((r) => [r.item, r.fingerprint]));
}

// Rows per D1 batch when a step records what it checked.
const ITEM_BATCH = 40;

export async function savePassItems(
	db: D1Database,
	brainId: string,
	kind: string,
	items: readonly { item: string; fingerprint: string }[],
	now: number
): Promise<void> {
	const stmt = db.prepare(
		`INSERT INTO brain_pass_items (brain_id, kind, item, fingerprint, checked_at)
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT (brain_id, kind, item) DO UPDATE SET fingerprint = ?4, checked_at = ?5`
	);
	for (let i = 0; i < items.length; i += ITEM_BATCH) {
		await db.batch(
			items
				.slice(i, i + ITEM_BATCH)
				.map((x) => stmt.bind(brainId, kind, x.item, x.fingerprint, now))
		);
	}
}
