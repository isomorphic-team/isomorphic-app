// Per-org single sign-on: which provider an org signs in through, how an address is routed
// to it, and whether a completed provider sign-in is accepted
// (docs/design/enterprise-identity.md, D4, D5 and D9).
//
// An identity connection is a provider and a tenant id, never a credential: the deployment
// registers one multi-tenant application and each org's directory consents to it.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import { FEATURES, hasFeature } from './entitlements.ts';
import {
	currentVerifiedDomain,
	emailDomain,
	listOrgDomains,
	type OrgDomain
} from './org-domains.ts';

export const ENTRA_PROVIDER = 'microsoft-entra-id';
export type IdentityProvider = typeof ENTRA_PROVIDER;

// No `User.Read`: the address and name come from the ID token, and nothing calls Graph.
export const ENTRA_SCOPE = 'openid profile email';

export interface IdentityConnection {
	orgId: string;
	provider: IdentityProvider;
	tenantId: string;
	createdAt: number;
	createdBy: string | null;
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A directory's tenant id, lowercased, or null. `common` and `organizations` are not one. */
export function normalizeTenantId(input: string): string | null {
	const id = input.trim().toLowerCase();
	return TENANT_ID.test(id) ? id : null;
}

/** The issuer of one tenant's tokens. Throws rather than fall back to a shared endpoint. */
export function entraIssuer(tenantId: string): string {
	const id = normalizeTenantId(tenantId);
	if (!id) throw new Error(`Not a tenant id: ${tenantId}`);
	return `https://login.microsoftonline.com/${id}/v2.0`;
}

interface Row {
	org_id: string;
	provider: string;
	tenant_id: string;
	created_at: number;
	created_by: string | null;
}

export async function getIdentityConnection(
	db: D1Database,
	orgId: string
): Promise<IdentityConnection | null> {
	const row = await db
		.prepare(
			`SELECT org_id, provider, tenant_id, created_at, created_by
			 FROM identity_connections WHERE org_id = ?1`
		)
		.bind(orgId)
		.first<Row>();
	if (!row || row.provider !== ENTRA_PROVIDER) return null;
	return {
		orgId: row.org_id,
		provider: ENTRA_PROVIDER,
		tenantId: row.tenant_id,
		createdAt: row.created_at,
		createdBy: row.created_by
	};
}

/** Connect an org to a directory, replacing any connection it had. Null for a bad tenant id. */
export async function setIdentityConnection(
	db: D1Database,
	conn: { orgId: string; tenantId: string; userId: string | null; now: number }
): Promise<IdentityConnection | null> {
	const tenantId = normalizeTenantId(conn.tenantId);
	if (!tenantId) return null;
	await db
		.prepare(
			`INSERT INTO identity_connections (org_id, provider, tenant_id, created_at, created_by)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT (org_id) DO UPDATE SET provider = excluded.provider,
			   tenant_id = excluded.tenant_id, created_at = excluded.created_at,
			   created_by = excluded.created_by`
		)
		.bind(conn.orgId, ENTRA_PROVIDER, tenantId, conn.now, conn.userId)
		.run();
	return getIdentityConnection(db, conn.orgId);
}

export async function removeIdentityConnection(db: D1Database, orgId: string): Promise<void> {
	await db.prepare('DELETE FROM identity_connections WHERE org_id = ?1').bind(orgId).run();
}

export type SignInRoute =
	| { kind: 'magic-link' }
	| { kind: 'sso'; connection: IdentityConnection }
	// The domain requires the provider and the org has none connected.
	| { kind: 'refused'; reason: 'sso-not-connected' };

/**
 * How an address signs in, from the verified domain it is at. Pure.
 *
 * Without the entitlement the org has the core product, so its domains route nothing and
 * enforce nothing.
 */
export function chooseSignInRoute(at: {
	domain: Pick<OrgDomain, 'ssoEnforced'> | null;
	entitled: boolean;
	connection: IdentityConnection | null;
}): SignInRoute {
	if (!at.domain || !at.entitled) return { kind: 'magic-link' };
	if (at.connection) return { kind: 'sso', connection: at.connection };
	if (at.domain.ssoEnforced) return { kind: 'refused', reason: 'sso-not-connected' };
	return { kind: 'magic-link' };
}

/** Home-realm discovery: the route for the address typed on the sign-in page. */
export async function resolveSignInRoute(
	db: D1Database,
	email: string,
	now: number,
	fetchFn: typeof fetch = fetch
): Promise<SignInRoute> {
	const name = emailDomain(email);
	const domain = name ? await currentVerifiedDomain(db, name, now, fetchFn) : null;
	if (!domain) return { kind: 'magic-link' };
	const entitled = await hasFeature(db, domain.orgId, FEATURES.enterprise, now);
	const connection = entitled ? await getIdentityConnection(db, domain.orgId) : null;
	return chooseSignInRoute({ domain, entitled, connection });
}

/** The ID token claims this module reads. */
export interface EntraClaims {
	sub?: unknown;
	tid?: unknown;
	name?: unknown;
	email?: unknown;
	preferred_username?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The person's address: `email`, else `preferred_username`, lowercased. Null if neither is one. */
export function entraAddress(claims: EntraClaims): string | null {
	for (const claim of [claims.email, claims.preferred_username]) {
		const address = str(claim)?.toLowerCase();
		if (address && emailDomain(address)) return address;
	}
	return null;
}

/** The Auth.js user for a set of claims. The account is keyed on `sub`. */
export function entraProfile(claims: EntraClaims): {
	id: string;
	name: string | null;
	email: string | null;
	image: null;
} {
	const id = str(claims.sub);
	if (!id) throw new Error('The ID token has no sub claim');
	return { id, name: str(claims.name), email: entraAddress(claims), image: null };
}

export type SsoDecision =
	| { ok: true; email: string }
	| { ok: false; reason: 'wrong-tenant' | 'no-address' | 'domain-not-verified' };

/**
 * Whether a completed provider sign-in is accepted for the org it was started for. Pure.
 *
 * Both checks are required before the address is trusted or linked to an existing account.
 * The tenant is compared here because Auth.js re-reads the provider's metadata for whatever
 * tenant the token names, so its issuer validation does not hold the token to this one. The
 * domain is compared because a tenant admin can put any address in either claim.
 */
export function allowSsoSignIn(input: {
	claims: EntraClaims;
	connection: Pick<IdentityConnection, 'tenantId'>;
	verifiedDomains: string[];
}): SsoDecision {
	const tid = str(input.claims.tid)?.toLowerCase();
	if (!tid || tid !== input.connection.tenantId) return { ok: false, reason: 'wrong-tenant' };
	const email = entraAddress(input.claims);
	if (!email) return { ok: false, reason: 'no-address' };
	const domain = emailDomain(email);
	if (!domain || !input.verifiedDomains.includes(domain))
		return { ok: false, reason: 'domain-not-verified' };
	return { ok: true, email };
}

/** `allowSsoSignIn` against the org's verified domains as recorded. */
export async function checkSsoSignIn(
	db: D1Database,
	claims: EntraClaims,
	connection: IdentityConnection
): Promise<SsoDecision> {
	const domains = await listOrgDomains(db, connection.orgId);
	return allowSsoSignIn({
		claims,
		connection,
		verifiedDomains: domains.filter((d) => d.verifiedAt !== null).map((d) => d.domain)
	});
}
