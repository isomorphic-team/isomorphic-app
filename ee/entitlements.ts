// Per-org entitlements: whether an org has an enterprise feature. Licensed under ee/LICENSE.
//
// Read-only here. Rows are written by the operator (`pnpm entitle`) or by billing outside this
// repository, never by the Worker. No row, or an expired one, means the org has the core
// product only.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';

export const FEATURES = {
	// The data-policy guard's model stages and brain consolidation, and the gateway they use.
	reviewModels: 'review-models'
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const ENTITLEMENT_SOURCES = ['plan', 'trial', 'manual'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

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

export async function hasFeature(
	db: D1Database,
	orgId: string,
	feature: Feature,
	now = Date.now()
): Promise<boolean> {
	return isActive(await getEntitlement(db, orgId, feature), now);
}

// The SQL `pnpm entitle` prints and applies. Pure, so the script and the tests share it.
// Values are validated, then quoted, because the statement runs through `wrangler d1 execute
// --command`, which takes no bound parameters.
export function entitlementSql(
	op:
		| {
				kind: 'grant';
				orgId: string;
				feature: Feature;
				source: EntitlementSource;
				now: number;
				expiresAt?: number;
				monthlyCapUsd?: number;
				note?: string;
		  }
		| { kind: 'revoke'; orgId: string; feature: Feature }
): string {
	if (!/^[A-Za-z0-9_-]+$/.test(op.orgId)) throw new Error(`Not an org id: ${op.orgId}`);
	if (!(Object.values(FEATURES) as string[]).includes(op.feature))
		throw new Error(`Unknown feature: ${op.feature}`);
	if (op.kind === 'revoke') {
		return `DELETE FROM org_entitlements WHERE org_id = '${op.orgId}' AND feature = '${op.feature}';`;
	}
	if (!ENTITLEMENT_SOURCES.includes(op.source)) throw new Error(`Unknown source: ${op.source}`);
	const num = (v: number | undefined) => {
		if (v === undefined) return 'NULL';
		if (!Number.isFinite(v) || v < 0) throw new Error(`Not a non-negative number: ${v}`);
		return String(v);
	};
	const note = op.note === undefined ? 'NULL' : `'${op.note.replace(/'/g, "''")}'`;
	return (
		`INSERT INTO org_entitlements (org_id, feature, source, granted_at, expires_at, monthly_cap_usd, note)` +
		` VALUES ('${op.orgId}', '${op.feature}', '${op.source}', ${num(op.now)}, ${num(op.expiresAt)},` +
		` ${num(op.monthlyCapUsd)}, ${note})` +
		` ON CONFLICT (org_id, feature) DO UPDATE SET source = excluded.source,` +
		` granted_at = excluded.granted_at, expires_at = excluded.expires_at,` +
		` monthly_cap_usd = excluded.monthly_cap_usd, note = excluded.note;`
	);
}
