// Verified organization domains: an org proves it controls a domain with a DNS TXT record,
// and a verified domain decides how every address at it signs in
// (docs/design/enterprise-identity.md, D3).
//
// The TXT record is read over DNS over HTTPS. A verified domain is re-checked when it is
// read for a sign-in and the last conclusive lookup is older than DOMAIN_RECHECK_MS. Only a
// conclusive "the record is gone" unverifies a domain; a resolver failure changes nothing.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';

export const DOMAIN_TXT_PREFIX = 'isomorphic-domain-verification=';
export const DOMAIN_RECHECK_MS = 24 * 60 * 60 * 1000;
export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5000;

export interface OrgDomain {
	orgId: string;
	domain: string;
	challenge: string;
	createdAt: number;
	createdBy: string | null;
	verifiedAt: number | null;
	lastCheckedAt: number | null;
	ssoEnforced: boolean;
}

interface Row {
	org_id: string;
	domain: string;
	challenge: string;
	created_at: number;
	created_by: string | null;
	verified_at: number | null;
	last_checked_at: number | null;
	sso_enforced: number;
}

const COLUMNS =
	'org_id, domain, challenge, created_at, created_by, verified_at, last_checked_at, sso_enforced';

const fromRow = (r: Row): OrgDomain => ({
	orgId: r.org_id,
	domain: r.domain,
	challenge: r.challenge,
	createdAt: r.created_at,
	createdBy: r.created_by,
	verifiedAt: r.verified_at,
	lastCheckedAt: r.last_checked_at,
	ssoEnforced: r.sso_enforced === 1
});

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercased registrable-looking hostname, or null. Takes no scheme, path, port or `@`. */
export function normalizeDomain(input: string): string | null {
	const domain = input.trim().toLowerCase().replace(/\.$/, '');
	if (domain.length > 253) return null;
	const labels = domain.split('.');
	if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
	// A numeric last label is an IP address, not a domain.
	if (/^\d+$/.test(labels[labels.length - 1])) return null;
	return domain;
}

/** The domain of an address with exactly one `@`, or null. */
export function emailDomain(email: string): string | null {
	const parts = email.trim().split('@');
	if (parts.length !== 2 || !parts[0]) return null;
	return normalizeDomain(parts[1]);
}

/** The value the domain's TXT record must hold. */
export function txtRecordValue(challenge: string): string {
	return DOMAIN_TXT_PREFIX + challenge;
}

// A TXT answer arrives as one or more quoted strings ("abc" "def"), which DNS concatenates.
export function txtAnswerText(data: string): string {
	const quoted = data.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!quoted) return data.trim();
	return quoted.map((q) => q.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

// 'unknown' is a lookup that proved nothing: a resolver error, a timeout, an unreadable body.
export type TxtCheck = 'found' | 'missing' | 'unknown';

const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;
const DNS_TYPE_TXT = 16;

export async function checkDomainTxt(
	domain: string,
	challenge: string,
	fetchFn: typeof fetch = fetch
): Promise<TxtCheck> {
	try {
		const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=TXT`;
		const res = await fetchFn(url, {
			headers: { accept: 'application/dns-json' },
			signal: AbortSignal.timeout(DOH_TIMEOUT_MS)
		});
		if (!res.ok) return 'unknown';
		const body = (await res.json()) as {
			Status?: number;
			Answer?: { type?: number; data?: string }[];
		};
		if (body.Status === DNS_NXDOMAIN) return 'missing';
		if (body.Status !== DNS_NOERROR) return 'unknown';
		const want = txtRecordValue(challenge);
		const found = (body.Answer ?? []).some(
			(a) => a.type === DNS_TYPE_TXT && typeof a.data === 'string' && txtAnswerText(a.data) === want
		);
		return found ? 'found' : 'missing';
	} catch {
		return 'unknown';
	}
}

/** What a lookup does to a domain's verification. Pure. */
export function afterTxtCheck(
	domain: Pick<OrgDomain, 'verifiedAt' | 'lastCheckedAt'>,
	result: TxtCheck,
	now: number
): Pick<OrgDomain, 'verifiedAt' | 'lastCheckedAt'> {
	if (result === 'found') return { verifiedAt: domain.verifiedAt ?? now, lastCheckedAt: now };
	if (result === 'missing') return { verifiedAt: null, lastCheckedAt: now };
	return { verifiedAt: domain.verifiedAt, lastCheckedAt: domain.lastCheckedAt };
}

export function recheckDue(domain: Pick<OrgDomain, 'lastCheckedAt'>, now: number): boolean {
	return domain.lastCheckedAt === null || now - domain.lastCheckedAt >= DOMAIN_RECHECK_MS;
}

function newChallenge(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getOrgDomain(
	db: D1Database,
	orgId: string,
	domain: string
): Promise<OrgDomain | null> {
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM org_domains WHERE org_id = ?1 AND domain = ?2`)
		.bind(orgId, domain)
		.first<Row>();
	return row ? fromRow(row) : null;
}

export async function listOrgDomains(db: D1Database, orgId: string): Promise<OrgDomain[]> {
	const { results } = await db
		.prepare(`SELECT ${COLUMNS} FROM org_domains WHERE org_id = ?1 ORDER BY domain`)
		.bind(orgId)
		.all<Row>();
	return results.map(fromRow);
}

/** The one org holding this domain verified, as last recorded. No lookup. */
export async function verifiedDomain(db: D1Database, domain: string): Promise<OrgDomain | null> {
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM org_domains WHERE domain = ?1 AND verified_at IS NOT NULL`)
		.bind(domain)
		.first<Row>();
	return row ? fromRow(row) : null;
}

/** Claim a domain for an org. Claiming again returns the same row and the same challenge. */
export async function claimDomain(
	db: D1Database,
	claim: { orgId: string; domain: string; userId: string | null; now: number }
): Promise<OrgDomain | null> {
	const domain = normalizeDomain(claim.domain);
	if (!domain) return null;
	await db
		.prepare(
			`INSERT INTO org_domains (org_id, domain, challenge, created_at, created_by)
			 VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (org_id, domain) DO NOTHING`
		)
		.bind(claim.orgId, domain, newChallenge(), claim.now, claim.userId)
		.run();
	return getOrgDomain(db, claim.orgId, domain);
}

export async function removeDomain(db: D1Database, orgId: string, domain: string): Promise<void> {
	await db
		.prepare('DELETE FROM org_domains WHERE org_id = ?1 AND domain = ?2')
		.bind(orgId, domain)
		.run();
}

async function saveCheck(
	db: D1Database,
	domain: OrgDomain,
	next: Pick<OrgDomain, 'verifiedAt' | 'lastCheckedAt'>
): Promise<void> {
	await db
		.prepare(
			`UPDATE org_domains SET verified_at = ?3, last_checked_at = ?4
			 WHERE org_id = ?1 AND domain = ?2`
		)
		.bind(domain.orgId, domain.domain, next.verifiedAt, next.lastCheckedAt)
		.run();
}

export type VerifyResult =
	| { status: 'verified'; domain: OrgDomain }
	// The record is not there, or the lookup proved nothing.
	| { status: 'missing' | 'unknown'; domain: OrgDomain }
	// Another org holds the domain verified.
	| { status: 'taken' }
	| { status: 'not-claimed' };

/** Look the TXT record up now and record what it shows for this org's claim. */
export async function verifyOrgDomain(
	db: D1Database,
	orgId: string,
	domainName: string,
	now: number,
	fetchFn: typeof fetch = fetch
): Promise<VerifyResult> {
	const domain = await getOrgDomain(db, orgId, normalizeDomain(domainName) ?? '');
	if (!domain) return { status: 'not-claimed' };
	const holder = await verifiedDomain(db, domain.domain);
	if (holder && holder.orgId !== orgId) return { status: 'taken' };
	const result = await checkDomainTxt(domain.domain, domain.challenge, fetchFn);
	const next = afterTxtCheck(domain, result, now);
	try {
		await saveCheck(db, domain, next);
	} catch (e) {
		// Two orgs verifying at once: the unique index lets one through.
		if (/UNIQUE/i.test(String(e))) return { status: 'taken' };
		throw e;
	}
	const saved = { ...domain, ...next };
	return { status: result === 'found' ? 'verified' : result, domain: saved };
}

/**
 * The org holding this domain verified, for routing a sign-in. Re-checks the TXT record when
 * the last conclusive lookup is stale, and returns null if that shows the record is gone.
 */
export async function currentVerifiedDomain(
	db: D1Database,
	domainName: string,
	now: number,
	fetchFn: typeof fetch = fetch
): Promise<OrgDomain | null> {
	const domain = await verifiedDomain(db, domainName);
	if (!domain || !recheckDue(domain, now)) return domain;
	const result = await checkDomainTxt(domain.domain, domain.challenge, fetchFn);
	const next = afterTxtCheck(domain, result, now);
	if (result !== 'unknown') await saveCheck(db, domain, next);
	return next.verifiedAt === null ? null : { ...domain, ...next };
}
