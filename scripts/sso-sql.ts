// The SQL `pnpm sso` prints and applies. Pure, so the script and `pnpm test:sso` share it.
// Values are validated, then quoted, because the statement runs through `wrangler d1 execute
// --command`, which takes no bound parameters.

import { normalizeDomain } from '../src/lib/org-domains.ts';
import { ENTRA_PROVIDER, normalizeTenantId } from '../src/lib/sso.ts';

export type SsoOp =
	// Claiming again issues a new challenge and unverifies the domain.
	| { kind: 'claim'; orgId: string; domain: string; challenge: string; now: number }
	// `published` are the challenges found in the domain's TXT records. The row is verified
	// only if its own challenge is among them and no other org holds the domain.
	| { kind: 'verify'; orgId: string; domain: string; published: string[]; now: number }
	| { kind: 'remove-domain'; orgId: string; domain: string }
	| { kind: 'connect'; orgId: string; tenantId: string; now: number }
	| { kind: 'disconnect'; orgId: string };

const CHALLENGE = /^[0-9a-f]{40}$/;

export function isChallenge(value: string): boolean {
	return CHALLENGE.test(value);
}

export function ssoSql(op: SsoOp): string {
	if (!/^[A-Za-z0-9_-]+$/.test(op.orgId)) throw new Error(`Not an org id: ${op.orgId}`);
	const time = (v: number) => {
		if (!Number.isFinite(v) || v < 0) throw new Error(`Not a time: ${v}`);
		return String(Math.floor(v));
	};
	const domainOf = (input: string) => {
		const domain = normalizeDomain(input);
		if (!domain) throw new Error(`Not a domain: ${input}`);
		return domain;
	};
	switch (op.kind) {
		case 'claim': {
			if (!isChallenge(op.challenge)) throw new Error('Not a challenge');
			return (
				`INSERT INTO org_domains (org_id, domain, challenge, created_at)` +
				` VALUES ('${op.orgId}', '${domainOf(op.domain)}', '${op.challenge}', ${time(op.now)})` +
				` ON CONFLICT (org_id, domain) DO UPDATE SET challenge = excluded.challenge,` +
				` verified_at = NULL, last_checked_at = NULL;`
			);
		}
		case 'verify': {
			const published = op.published.filter(isChallenge);
			if (!published.length) throw new Error('No challenge is published for this domain');
			const domain = domainOf(op.domain);
			return (
				`UPDATE org_domains SET verified_at = COALESCE(verified_at, ${time(op.now)}),` +
				` last_checked_at = ${time(op.now)}` +
				` WHERE org_id = '${op.orgId}' AND domain = '${domain}'` +
				` AND challenge IN (${published.map((c) => `'${c}'`).join(', ')})` +
				` AND NOT EXISTS (SELECT 1 FROM org_domains held WHERE held.domain = '${domain}'` +
				` AND held.org_id <> '${op.orgId}' AND held.verified_at IS NOT NULL);`
			);
		}
		case 'remove-domain':
			return `DELETE FROM org_domains WHERE org_id = '${op.orgId}' AND domain = '${domainOf(op.domain)}';`;
		case 'connect': {
			const tenantId = normalizeTenantId(op.tenantId);
			if (!tenantId) throw new Error(`Not a tenant id: ${op.tenantId}`);
			return (
				`INSERT INTO identity_connections (org_id, provider, tenant_id, created_at)` +
				` VALUES ('${op.orgId}', '${ENTRA_PROVIDER}', '${tenantId}', ${time(op.now)})` +
				` ON CONFLICT (org_id) DO UPDATE SET provider = excluded.provider,` +
				` tenant_id = excluded.tenant_id, created_at = excluded.created_at;`
			);
		}
		case 'disconnect':
			return `DELETE FROM identity_connections WHERE org_id = '${op.orgId}';`;
	}
}
