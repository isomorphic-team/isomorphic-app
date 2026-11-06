// What happens to a brain's rows when the brain goes away.
//
// Every table with a `brain_id` column is listed in exactly one of BRAIN_PURGED_TABLES
// or BRAIN_KEPT_TABLES; `pnpm test:access` reads the schema and fails on a table in
// neither. Design: docs/design/brain-disconnect-retention.md.
//
// Purging matters beyond retention: `brain_id` is derived from the repository name
// (`brainIdFor`), so a repository connected again gets the same id and would pick up
// whatever an earlier brain left behind, from whichever org that brain was in.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/** The content index. `resetIndex` drops these to force a full rebuild. */
export const BRAIN_INDEX_TABLES = [
	'brain_index_meta',
	'brain_pages',
	'brain_links',
	'brain_page_fields'
] as const;

/**
 * Purged tables with no foreign key to `brains`, so their rows can outlive the
 * brains row. These are the only ones residue can sit in.
 */
export const BRAIN_UNLINKED_TABLES = [
	...BRAIN_INDEX_TABLES,
	'review_findings',
	'policy_detections',
	'policy_dismissals',
	'policy_baseline',
	'brain_passes',
	'brain_pass_items',
	'write_attempts'
] as const;

/**
 * Deleted with the brain: page text, anything quoting it, anything naming paths,
 * grants and pending brain invites. Grants and invites reference `brains`, so they
 * are deleted before the brains row.
 */
export const BRAIN_PURGED_TABLES = [
	...BRAIN_UNLINKED_TABLES,
	'brain_memberships',
	'invitations'
] as const;

/**
 * Kept: `usage_daily` holds only counters and is the analytics history;
 * `feedback_reports` is a report about the product, not brain data.
 */
export const BRAIN_KEPT_TABLES = ['usage_daily', 'feedback_reports'] as const;

/**
 * Statements deleting every brain `brainIds` selects (a subquery) with its purged
 * rows, purged rows first. One selector for both, so the rows purged and the brains
 * deleted cannot drift apart.
 */
export function forgetBrainsStatements(
	db: D1Database,
	brainIds: string,
	...binds: unknown[]
): D1PreparedStatement[] {
	return [...BRAIN_PURGED_TABLES, 'brains'].map((t) =>
		db.prepare(`DELETE FROM ${t} WHERE brain_id IN (${brainIds})`).bind(...binds)
	);
}

/**
 * Delete a brain and its purged rows in one batch. One batch, so a failure part way
 * cannot remove the `brains` row and leave rows that nothing points at.
 */
export async function forgetBrain(db: D1Database, brainId: string): Promise<void> {
	await db.batch(forgetBrainsStatements(db, 'SELECT ?1', brainId));
}

/**
 * Statements deleting rows left under `brainId` when no brain holds that id.
 * `createBrain` runs them in the batch that inserts the brain, so a new brain starts
 * empty instead of inheriting an earlier one's rows. A no-op when a brain holds the
 * id, which keeps it safe if two repository names ever map to the same id.
 */
export function clearBrainResidueStatements(
	db: D1Database,
	brainId: string
): D1PreparedStatement[] {
	return BRAIN_UNLINKED_TABLES.map((t) =>
		db
			.prepare(
				`DELETE FROM ${t}
				  WHERE brain_id = ?1
				    AND NOT EXISTS (SELECT 1 FROM brains WHERE brain_id = ?1)`
			)
			.bind(brainId)
	);
}
