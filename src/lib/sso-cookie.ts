// The cookie that carries a provider sign-in's org and tenant from its start to its callback
// (docs/design/enterprise-identity.md, D4).
//
// Auth.js builds its config per request, and the callback request does not say which tenant
// the sign-in was started for. This cookie does. It is signed with the deployment's
// AUTH_SECRET, so a browser cannot name a tenant the server did not route it to, and it
// expires with the sign-in.
//
// Worker-safe: no node:* imports.

export const SSO_COOKIE = 'isomorphic.sso';
export const SSO_COOKIE_MAX_AGE_SECONDS = 15 * 60;

export interface SsoCookie {
	orgId: string;
	tenantId: string;
	// Epoch ms.
	expiresAt: number;
}

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

async function sign(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	// The label keeps this signature from being valid anywhere else AUTH_SECRET signs.
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`sso-cookie:${payload}`));
	return base64url(new Uint8Array(mac));
}

function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function signSsoCookie(cookie: SsoCookie, secret: string): Promise<string> {
	if (!secret) throw new Error('AUTH_SECRET is required to start a provider sign-in');
	const payload = base64url(encoder.encode(JSON.stringify(cookie)));
	return `${payload}.${await sign(payload, secret)}`;
}

/** The cookie's contents, or null if it is missing, altered, expired or signed with another secret. */
export async function readSsoCookie(
	value: string | null | undefined,
	secret: string,
	now: number
): Promise<SsoCookie | null> {
	if (!value || !secret) return null;
	const [payload, mac, extra] = value.split('.');
	if (!payload || !mac || extra !== undefined) return null;
	if (!sameString(mac, await sign(payload, secret))) return null;
	try {
		const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
		const data = JSON.parse(json) as Partial<SsoCookie>;
		if (
			typeof data.orgId !== 'string' ||
			typeof data.tenantId !== 'string' ||
			typeof data.expiresAt !== 'number' ||
			data.expiresAt <= now
		)
			return null;
		return { orgId: data.orgId, tenantId: data.tenantId, expiresAt: data.expiresAt };
	} catch {
		return null;
	}
}

/** One cookie's value from a Cookie header. */
export function cookieValue(header: string | null, name: string): string | null {
	for (const part of (header ?? '').split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

export function ssoSetCookie(value: string, secure: boolean): string {
	return (
		`${SSO_COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Lax; ` +
		`Max-Age=${value ? SSO_COOKIE_MAX_AGE_SECONDS : 0}${secure ? '; Secure' : ''}`
	);
}
