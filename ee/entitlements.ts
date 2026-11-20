// The operator's grant tooling for per-org entitlements. Licensed under ee/LICENSE.
//
// The read (`hasFeature`, `getEntitlement`) is in src/lib/entitlements.ts, so core code can
// check an entitlement without calling into ee/.
//
// Worker-safe: no node:* imports.

import { FEATURES, type Feature } from '../src/lib/entitlements.ts';

export const ENTITLEMENT_SOURCES = ['plan', 'trial', 'manual'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

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
