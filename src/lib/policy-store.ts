// The data-policy guard's D1 half: `policy_detections` (migration 0015) and the baseline
// scan's run state, in `brain_passes` (kind 'policy-baseline', through brain-pass.ts).
// Kept apart from policy-guard.ts so that file stays free of storage.
//
// The scan's state moved from `policy_baseline` (0018) in 0023. Until a later migration
// drops that table, every save also writes it, so a rolled-back version reads its own
// table current, and a read falls back to it for a row only that version wrote.
//
// Worker-safe: no node:* imports.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { readPass, savePassStatement, type PassState } from './brain-pass.ts';
import type { PolicyMode } from './brain-policy.ts';
import { guardCoverage, type GuardCoverage, type WriteDetection } from './policy-guard.ts';
import { policyFindings, upsertFindings } from './review-queue.ts';

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// Detections a baseline scan recorded. They are exempt from the retention prune, which
// measures writes; the next scan replaces them.
const BASELINE_MODE = 'baseline';

// Rows per D1 batch when a scan records its detections.
const BASELINE_BATCH = 40;

export interface DetectionScope {
	brainId: string;
	orgId?: string;
	actorUserId?: string;
	mode: PolicyMode;
}

// This write's rows, plus pruning the brain's expired ones, as one batch; then its
// findings, which is what the reports read. `policy_detections` stays the raw log.
export async function recordDetections(
	db: D1Database,
	scope: DetectionScope,
	detections: readonly WriteDetection[],
	now = Date.now()
): Promise<void> {
	const insert = db.prepare(
		`INSERT INTO policy_detections
		   (brain_id, org_id, actor_user_id, path, kind, severity, start_offset, end_offset, mode, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
	);
	await db.batch([
		db
			.prepare(
				'DELETE FROM policy_detections WHERE brain_id = ?1 AND created_at < ?2 AND mode != ?3'
			)
			.bind(scope.brainId, now - RETENTION_MS, BASELINE_MODE),
		...detections.map((d) =>
			insert.bind(
				scope.brainId,
				scope.orgId ?? null,
				scope.actorUserId ?? null,
				d.path,
				d.kind,
				d.severity,
				d.start,
				d.end,
				scope.mode,
				now
			)
		)
	]);
	await upsertFindings(
		db,
		scope.brainId,
		policyFindings(detections, scope.actorUserId ?? null, 'write'),
		now
	);
}

export interface BaselineScope {
	brainId: string;
	orgId?: string;
	actorUserId?: string;
}

export interface BaselineState {
	status: 'running' | 'done';
	cursor: string | null;
	filesScanned: number;
	filesSkipped: number;
	detections: number;
	startedAt: number;
	finishedAt: number | null;
}

const BASELINE_KIND = 'policy-baseline';

type BaselineCounts = Pick<BaselineState, 'filesScanned' | 'filesSkipped' | 'detections'>;
const noBaselineCounts = (): BaselineCounts => ({
	filesScanned: 0,
	filesSkipped: 0,
	detections: 0
});

const baselineRunId = (startedAt: number) => `baseline-${startedAt}`;

function toPass({ status, cursor, startedAt, finishedAt, ...counters }: BaselineState) {
	return {
		runId: baselineRunId(startedAt),
		status,
		cursor,
		counters,
		stoppedReason: null,
		startedAt,
		finishedAt
	} satisfies PassState<BaselineCounts>;
}

// The step's state in both tables, as statements for the caller's batch.
function saveBaselineState(
	db: D1Database,
	scope: BaselineScope,
	s: BaselineState,
	now: number
): D1PreparedStatement[] {
	return [
		savePassStatement(db, { ...scope, kind: BASELINE_KIND }, toPass(s), now),
		db
			.prepare(
				`INSERT INTO policy_baseline
				   (brain_id, status, cursor, files_scanned, files_skipped, detections, started_by,
				    started_at, finished_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
				 ON CONFLICT (brain_id) DO UPDATE SET
				   status = ?2, cursor = ?3, files_scanned = ?4, files_skipped = ?5, detections = ?6,
				   started_by = CASE WHEN started_at = ?8 THEN started_by ELSE ?7 END,
				   started_at = ?8, finished_at = ?9`
			)
			.bind(
				scope.brainId,
				s.status,
				s.cursor,
				s.filesScanned,
				s.filesSkipped,
				s.detections,
				scope.actorUserId ?? null,
				s.startedAt,
				s.finishedAt
			)
	];
}

interface LegacyBaselineRow {
	status: string;
	cursor: string | null;
	files_scanned: number;
	files_skipped: number;
	detections: number;
	started_at: number;
	finished_at: number | null;
}

export async function readBaseline(db: D1Database, brainId: string): Promise<BaselineState | null> {
	const pass = await readPass(db, brainId, BASELINE_KIND, noBaselineCounts());
	if (pass) {
		return {
			status: pass.status === 'done' ? 'done' : 'running',
			cursor: pass.cursor,
			...pass.counters,
			startedAt: pass.startedAt,
			finishedAt: pass.finishedAt
		};
	}
	const r = await db
		.prepare(
			`SELECT status, cursor, files_scanned, files_skipped, detections, started_at, finished_at
			 FROM policy_baseline WHERE brain_id = ?1`
		)
		.bind(brainId)
		.first<LegacyBaselineRow>();
	if (!r) return null;
	return {
		status: r.status === 'done' ? 'done' : 'running',
		cursor: r.cursor,
		filesScanned: r.files_scanned,
		filesSkipped: r.files_skipped,
		detections: r.detections,
		startedAt: r.started_at,
		finishedAt: r.finished_at
	};
}

// A fresh scan replaces the last one: its row and everything it found.
export async function beginBaseline(
	db: D1Database,
	scope: BaselineScope,
	now: number
): Promise<BaselineState> {
	const state: BaselineState = {
		status: 'running',
		cursor: null,
		...noBaselineCounts(),
		startedAt: now,
		finishedAt: null
	};
	await db.batch([
		db
			.prepare('DELETE FROM policy_detections WHERE brain_id = ?1 AND mode = ?2')
			.bind(scope.brainId, BASELINE_MODE),
		...saveBaselineState(db, scope, state, now)
	]);
	return state;
}

// One step's rows, then its progress. The range delete makes a repeated step harmless:
// a call whose reply was lost, or a second call racing the first, cannot double-count
// rows, and the cursor moves only in the last statement.
export async function saveBaselineStep(
	db: D1Database,
	scope: BaselineScope,
	from: string | null,
	next: BaselineState,
	detections: readonly WriteDetection[],
	now: number
): Promise<void> {
	const insert = db.prepare(
		`INSERT INTO policy_detections
		   (brain_id, org_id, actor_user_id, path, kind, severity, start_offset, end_offset, mode, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
	);
	await db
		.prepare(
			`DELETE FROM policy_detections
			 WHERE brain_id = ?1 AND mode = ?2 AND path > ?3 AND path <= ?4`
		)
		.bind(scope.brainId, BASELINE_MODE, from ?? '', next.cursor ?? '')
		.run();
	for (let i = 0; i < detections.length; i += BASELINE_BATCH) {
		await db.batch(
			detections
				.slice(i, i + BASELINE_BATCH)
				.map((d) =>
					insert.bind(
						scope.brainId,
						scope.orgId ?? null,
						scope.actorUserId ?? null,
						d.path,
						d.kind,
						d.severity,
						d.start,
						d.end,
						BASELINE_MODE,
						now
					)
				)
		);
	}
	await upsertFindings(
		db,
		scope.brainId,
		policyFindings(detections, null, `baseline-${next.startedAt}`),
		now
	);
	await db.batch(saveBaselineState(db, scope, next, now));
}

// Everything the coverage statement needs for one brain.
export async function readCoverage(
	db: D1Database,
	brainId: string,
	mode: PolicyMode
): Promise<GuardCoverage> {
	const brain = await db
		.prepare('SELECT created_at FROM brains WHERE brain_id = ?1')
		.bind(brainId)
		.first<{ created_at: string }>();
	return guardCoverage(mode, brain?.created_at ?? null, await readBaseline(db, brainId));
}
