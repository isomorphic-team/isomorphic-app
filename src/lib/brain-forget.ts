// What happens to a brain's rows when the brain goes away.
//
// Every table with a `brain_id` column is listed in exactly one of BRAIN_PURGED_TABLES
// or BRAIN_KEPT_TABLES; `pnpm test:access` reads the schema and fails on a table in
// neither. Design: docs/design/brain-disconnect-retention.md.
//
// Purging matters beyond retention: `brain_id` is derived from the repository name,
// so a repository connected again gets the same id and would pick up whatever an
// earlier brain left behind, from whichever org that brain was in.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/**
 * Deleted with the brain: page text, anything quoting it, anything naming paths,
 * grants and pending brain invites. Grants and invites come before `brains` in the
 * delete order because both carry a foreign key to it.
 */
export const BRAIN_PURGED_TABLES = [
	'brain_pages',
	'brain_links',
	'brain_page_fields',
	'brain_index_meta',
	'review_findings',
	'policy_detections',
	'policy_dismissals',
	'policy_baseline',
	'brain_passes',
	'brain_pass_items',
	'write_attempts',
	'brain_memberships',
	'invitations'
] as const;

/**
 * Kept: `usage_daily` holds only counters and is the analytics history;
 * `feedback_reports` is a report about the product, not brain data.
 */
export const BRAIN_KEPT_TABLES = ['usage_daily', 'feedback_reports'] as const;

/**
 * Statements deleting the purged rows of every brain id `brainIds` selects. A
 * subquery, so a caller removing brains by some other condition (a static
 * deployment dropping a brain from earlier config) purges in the same batch.
 */
export function purgeBrainRowsStatements(
	db: D1Database,
	brainIds: string,
	...binds: unknown[]
): D1PreparedStatement[] {
	return BRAIN_PURGED_TABLES.map((t) =>
		db.prepare(`DELETE FROM ${t} WHERE brain_id IN (${brainIds})`).bind(...binds)
	);
}

/** The statements that delete a brain and everything purged with it, in order. */
export function forgetBrainStatements(db: D1Database, brainId: string): D1PreparedStatement[] {
	return [
		...purgeBrainRowsStatements(db, 'SELECT ?1', brainId),
		db.prepare(`DELETE FROM brains WHERE brain_id = ?1`).bind(brainId)
	];
}

/**
 * Delete a brain and its purged rows in one batch. One batch, so a failure part way
 * cannot remove the `brains` row and leave rows that nothing points at.
 */
export async function forgetBrain(db: D1Database, brainId: string): Promise<void> {
	await db.batch(forgetBrainStatements(db, brainId));
}

/**
 * Delete rows left under `brainId` when no brain holds that id. Call before creating
 * a brain, so it starts empty instead of inheriting an earlier brain's rows. A no-op
 * when a `brains` row exists, which keeps it safe if two repositories ever map to
 * the same id.
 */
export async function clearBrainResidue(db: D1Database, brainId: string): Promise<void> {
	await db.batch(
		purgeBrainRowsStatements(
			db,
			'SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM brains WHERE brain_id = ?1)',
			brainId
		)
	);
}
