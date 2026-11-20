// Per-org entitlements: whether an org has an enterprise feature.
//
// Read-only. Rows are written by the operator (`pnpm entitle`) or by billing outside this
// repository, never by the Worker. No row, or an expired one, means the org has the core
// product only. The SQL that writes rows is in ee/entitlements.ts.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';

export const FEATURES = {
	// Every enterprise feature, in `ee/` or in the core.
	enterprise: 'enterprise'
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export interface Entitlement {
	orgId: string;
	feature: string;
	source: string;
	grantedAt: number;
	expiresAt: number | null;
	monthlyCapUsd: number | null;
}

export function isActive(e: Entitlement | null, now: number): e is Entitlement {
	return !!e && (e.expiresAt === null || e.expiresAt > now);
}

export async function getEntitlement(
	db: D1Database,
	orgId: string,
	feature: Feature
): Promise<Entitlement | null> {
	const row = await db
		.prepare(
			`SELECT org_id, feature, source, granted_at, expires_at, monthly_cap_usd
			 FROM org_entitlements WHERE org_id = ?1 AND feature = ?2`
		)
		.bind(orgId, feature)
		.first<{
			org_id: string;
			feature: string;
			source: string;
			granted_at: number;
			expires_at: number | null;
			monthly_cap_usd: number | null;
		}>();
	if (!row) return null;
	return {
		orgId: row.org_id,
		feature: row.feature,
		source: row.source,
		grantedAt: row.granted_at,
		expiresAt: row.expires_at,
		monthlyCapUsd: row.monthly_cap_usd
	};
}

// The organizations holding a feature now, in a stable order.
export async function listEntitledOrgs(
	db: D1Database,
	feature: Feature,
	now = Date.now()
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT org_id FROM org_entitlements
			  WHERE feature = ?1 AND (expires_at IS NULL OR expires_at > ?2)
			  ORDER BY org_id`
		)
		.bind(feature, now)
		.all<{ org_id: string }>();
	return (results ?? []).map((r) => r.org_id);
}

export async function hasFeature(
	db: D1Database,
	orgId: string,
	feature: Feature,
	now = Date.now()
): Promise<boolean> {
	return isActive(await getEntitlement(db, orgId, feature), now);
}
