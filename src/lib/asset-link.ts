// Signed download links for files stored in a brain: `/files/<token>/<filename>`.
//
// read_media hands one back as a `resource_link`, so an agent can fetch the file into
// its own workspace and a person can open it in a browser tab (where the browser's own
// PDF viewer does the rendering). Brain repos are usually private, so the link is the
// credential: an HMAC over (brain, path, issuing user, expiry), valid for
// ASSET_LINK_TTL_SECONDS. Each fetch re-checks that the issuing user can still reach
// the brain, so revoking access kills their live links. Anyone holding a live link
// can fetch that one file while the issuer keeps access; the expiry bounds that.
//
// No `node:*`: the Worker and the local runtime both serve it.

import { isContentPath } from './brain-policy.ts';
import type { PathPolicy } from './brain-policy.ts';
import type { BinaryContent, RepoRef } from './brain-repo.ts';
import { MAX_ATTACHMENT_BYTES, mediaTypeOf } from './media.ts';

export const ASSET_LINK_TTL_SECONDS = 15 * 60;
export const ASSET_ROUTE_PREFIX = '/files/';

// The signing key is derived from a deployment secret under its own label, so a
// token minted here can never verify as anything else that secret signs.
export async function assetLinkKey(secret: string): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const root = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const derived = await crypto.subtle.sign('HMAC', root, enc.encode('isomorphic/asset-link/v1'));
	return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

export interface AssetClaim {
	// brains.brain_id: the row, not the slug, so a rename does not break a live link.
	brainId: string;
	path: string;
	// The user the link was issued to (app_users.id), or undefined where the runtime
	// has no users (the local runtime). A server with users refuses a claim without one.
	userId?: string;
	// Unix seconds.
	exp: number;
}

function b64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

export async function mintAssetToken(key: CryptoKey, claim: AssetClaim): Promise<string> {
	const body = new TextEncoder().encode(
		JSON.stringify({ b: claim.brainId, p: claim.path, u: claim.userId, e: claim.exp })
	);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
	return `${b64url(body)}.${b64url(sig)}`;
}

export type TokenVerdict =
	{ ok: true; claim: AssetClaim } | { ok: false; reason: 'invalid' | 'expired' };

export async function verifyAssetToken(
	key: CryptoKey,
	token: string,
	nowSeconds: number
): Promise<TokenVerdict> {
	const [bodyPart, sigPart, extra] = token.split('.');
	if (!bodyPart || !sigPart || extra !== undefined) return { ok: false, reason: 'invalid' };
	const body = fromB64url(bodyPart);
	const sig = fromB64url(sigPart);
	if (!body || !sig) return { ok: false, reason: 'invalid' };
	if (!(await crypto.subtle.verify('HMAC', key, sig, body)))
		return { ok: false, reason: 'invalid' };
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	const { b, p, u, e } = (raw ?? {}) as { b?: unknown; p?: unknown; u?: unknown; e?: unknown };
	if (
		typeof b !== 'string' ||
		typeof p !== 'string' ||
		(u !== undefined && typeof u !== 'string') ||
		typeof e !== 'number'
	) {
		return { ok: false, reason: 'invalid' };
	}
	if (e <= nowSeconds) return { ok: false, reason: 'expired' };
	return { ok: true, claim: { brainId: b, path: p, ...(u ? { userId: u } : {}), exp: e } };
}

// The filename segment is for people and for whatever saves the download: the token
// alone decides what is served.
export function assetLinkUrl(base: string, token: string, path: string): string {
	const name = path.split('/').pop() || 'file';
	return `${base.replace(/\/+$/, '')}${ASSET_ROUTE_PREFIX}${token}/${encodeURIComponent(name)}`;
}

export interface AssetLinkIssuer {
	base: string;
	key: CryptoKey;
}

export async function issueAssetLink(
	issuer: AssetLinkIssuer,
	claim: Omit<AssetClaim, 'exp'>,
	nowSeconds: number
): Promise<{ url: string; expiresAt: string }> {
	const exp = nowSeconds + ASSET_LINK_TTL_SECONDS;
	const token = await mintAssetToken(issuer.key, { ...claim, exp });
	const { path } = claim;
	return {
		url: assetLinkUrl(issuer.base, token, path),
		expiresAt: new Date(exp * 1000).toISOString()
	};
}

// ---------- serving ----------

// Types a browser should show in the tab. Everything else downloads. SVG downloads
// too: opened inline on our origin it is a document that can run script.
const INLINE_TYPES: ReadonlySet<string> = new Set([
	'application/pdf',
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp'
]);

export function assetResponseHeaders(
	mimeType: string,
	path: string,
	size: number,
	maxAgeSeconds: number
): Record<string, string> {
	const name = path.split('/').pop() || 'file';
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const disposition = INLINE_TYPES.has(mimeType) ? 'inline' : 'attachment';
	const headers: Record<string, string> = {
		'content-type': mimeType,
		'content-length': String(size),
		'content-disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'cache-control': `private, max-age=${Math.max(0, maxAgeSeconds)}`
	};
	// A sandboxing CSP on everything but PDF. Chrome refuses to open its PDF viewer
	// under a `sandbox` policy, and a PDF there cannot script our origin anyway.
	if (mimeType !== 'application/pdf') {
		headers['content-security-policy'] =
			"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
	}
	return headers;
}

export interface OpenedBrain {
	read: (repo: RepoRef, path: string) => Promise<BinaryContent | null>;
	repoArgs: RepoRef;
	config: PathPolicy;
}

function plain(status: number, text: string): Response {
	return new Response(text, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}

// The brain a verified claim may read: the issuing user's own accessible brain, found
// in the list `listAccessibleBrains` returns for them, which admits through
// `effectiveBrainRole`. A claim with no user is refused here, so a server with users
// never serves a link it cannot attribute.
export function brainForClaim<T extends { brain_id: string }>(
	claim: AssetClaim,
	accessible: readonly T[]
): T | null {
	if (!claim.userId) return null;
	return accessible.find((b) => b.brain_id === claim.brainId) ?? null;
}

// Answers a GET on `/files/<token>/<name>`. `open` resolves a verified claim to
// something that can read its brain, or null when the brain is gone or the issuing
// user can no longer reach it.
export async function serveAssetLink(
	pathname: string,
	key: CryptoKey,
	nowSeconds: number,
	open: (claim: AssetClaim) => Promise<OpenedBrain | null>
): Promise<Response> {
	const notFound = () => plain(404, 'No file at this link.');
	if (!pathname.startsWith(ASSET_ROUTE_PREFIX)) return notFound();
	const token = pathname.slice(ASSET_ROUTE_PREFIX.length).split('/')[0];
	const verdict = await verifyAssetToken(key, token, nowSeconds);
	if (!verdict.ok) {
		return verdict.reason === 'expired'
			? plain(410, 'This link has expired. Ask Claude to read the file again for a fresh one.')
			: notFound();
	}
	const { path, exp } = verdict.claim;
	const mimeType = mediaTypeOf(path);
	if (!mimeType) return notFound();
	const brain = await open(verdict.claim);
	if (!brain || !isContentPath(path, brain.config)) return notFound();
	const file = await brain.read(brain.repoArgs, path);
	if (!file) return notFound();
	if (file.size > MAX_ATTACHMENT_BYTES)
		return plain(413, 'This file is over the size this brain serves.');
	const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
	return new Response(bytes, {
		status: 200,
		headers: assetResponseHeaders(mimeType, path, bytes.byteLength, exp - nowSeconds)
	});
}
