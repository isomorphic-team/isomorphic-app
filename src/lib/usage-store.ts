// Usage analytics: the D1 half. Kept apart from src/lib/usage.ts so that file
// stays pure and fully testable; everything here is one statement against
// `usage_daily` (migration 0006).
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import type { UsageRow } from './usage.ts';

/**
 * Bump today's counter for one tool call.
 *
 * ONE STATEMENT, AND IT MUST NEVER BLOCK THE CALL. Callers run this through
 * ctx.waitUntil after the handler has already returned its result, and swallow
 * failures: analytics is the least important thing this Worker does, and a D1
 * hiccup turning into a failed read_page would be an absurd trade. The counter
 * is allowed to under-count.
 *
 * `brainId` is '' when the call resolved no brain. See migration 0006 for why
 * that is an empty string rather than NULL (SQLite treats PK NULLs as distinct,
 * so a nullable column would defeat the upsert and grow a row per call).
 */
export async function recordUsage(
	db: D1Database,
	entry: {
		day: string;
		orgId: string;
		brainId: string;
		userId: string;
		tool: string;
		ok: boolean;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO usage_daily (day, org_id, brain_id, user_id, tool, calls, errors)
			 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
			 ON CONFLICT (day, org_id, brain_id, user_id, tool)
			 DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors`
		)
		.bind(entry.day, entry.orgId, entry.brainId, entry.userId, entry.tool, entry.ok ? 0 : 1)
		.run();
}

/**
 * A read is capped rather than unbounded, following the same rule as the content
 * index's catch-up passes: bound the work, and SAY SO when the bound bit, so a
 * truncated answer never renders as a complete one.
 *
 * The grain is already small (one row per person, brain, tool, day), so a 30-day
 * window on a real org lands in the hundreds. If an org ever reaches this cap,
 * the fix is to pre-aggregate in SQL (GROUP BY day, then by user, then by brain)
 * rather than to raise the number.
 */
export const MAX_USAGE_ROWS = 50_000;

/** Every counter row for one org in [from, to], capped at MAX_USAGE_ROWS. */
export async function readUsage(
	db: D1Database,
	orgId: string,
	from: string,
	to: string
): Promise<{ rows: UsageRow[]; truncated: boolean }> {
	const res = await db
		.prepare(
			`SELECT day, user_id, brain_id, tool, calls, errors
			   FROM usage_daily
			  WHERE org_id = ?1 AND day >= ?2 AND day <= ?3
			  ORDER BY day DESC
			  LIMIT ?4`
		)
		.bind(orgId, from, to, MAX_USAGE_ROWS + 1)
		.all<UsageRow>();
	const rows = res.results ?? [];
	return { rows: rows.slice(0, MAX_USAGE_ROWS), truncated: rows.length > MAX_USAGE_ROWS };
}
