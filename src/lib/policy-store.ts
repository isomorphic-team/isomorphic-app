// The data-policy guard's D1 half: `policy_detections` (migration 0015). Kept
// apart from policy-guard.ts so that file stays free of storage.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import type { PolicyMode } from './brain-policy.ts';
import type { WriteDetection } from './policy-guard.ts';

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface DetectionScope {
	brainId: string;
	orgId?: string;
	actorUserId?: string;
	mode: PolicyMode;
}

// One batch: this write's rows, plus pruning the brain's expired ones.
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
			.prepare('DELETE FROM policy_detections WHERE brain_id = ?1 AND created_at < ?2')
			.bind(scope.brainId, now - RETENTION_MS),
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
}

export interface DetectionCount {
	path: string;
	kind: string;
	count: number;
}

// Detections per (path, kind) recorded since `since` (epoch ms), for the `validate`
// report. Grouped in SQL so the read stays one small result however noisy a brain is.
export async function readDetectionCounts(
	db: D1Database,
	brainId: string,
	since: number
): Promise<DetectionCount[]> {
	const { results } = await db
		.prepare(
			`SELECT path, kind, COUNT(*) AS count FROM policy_detections
			 WHERE brain_id = ?1 AND created_at >= ?2
			 GROUP BY path, kind`
		)
		.bind(brainId, since)
		.all<DetectionCount>();
	return results;
}
