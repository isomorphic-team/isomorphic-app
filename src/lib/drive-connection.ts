// Connecting a Google Drive: the OAuth exchange with Google, and the storage connection
// it leaves in the platform database. Runtime-portable (Worker-safe, no node:*).
// pnpm test:drive.
//
// A connection is one Google account connected by one person for one org. Its refresh
// token is stored sealed (AES-256-GCM) under a key derived from the deployment's secret,
// so the database alone does not open anyone's Drive. The scope is `drive.file`: the
// files this deployment created, and nothing else in the account.

import type { D1Database } from '@cloudflare/workers-types';
import { GOOGLE_DRIVE_KIND, type StorageConnection } from './storage-connections.ts';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ABOUT_ENDPOINT =
	'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)';

// The OAuth client this deployment registered with Google.
export interface GoogleClient {
	clientId: string;
	clientSecret: string;
	// Exactly as registered on the client: Google compares it character for character.
	redirectUri: string;
}

export const DRIVE_CALLBACK_PATH = '/google/callback';

// The client from a deployment's settings, or undefined when it has not registered one.
export function googleClient(env: {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	PUBLIC_BASE_URL?: string;
}): GoogleClient | undefined {
	const clientId = env.GOOGLE_CLIENT_ID?.trim();
	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
	const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
	if (!clientId || !clientSecret || !base) return undefined;
	return { clientId, clientSecret, redirectUri: `${base}${DRIVE_CALLBACK_PATH}` };
}

// Where a person grants access. `offline` with `consent` makes Google return a refresh
// token every time, including for an account that granted before.
export function driveAuthUrl(client: GoogleClient, state: string): string {
	const params = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: client.redirectUri,
		response_type: 'code',
		scope: DRIVE_SCOPE,
		access_type: 'offline',
		prompt: 'consent',
		state
	});
	return `${AUTH_ENDPOINT}?${params}`;
}

// Google no longer honours the stored grant: the person revoked it, or it expired. Only
// connecting again fixes it.
export class DriveReconnectError extends Error {
	override readonly name = 'DriveReconnectError';
	constructor() {
		super(
			'Google no longer accepts this Drive connection (access was removed, or it expired). Connect the Google Drive again.'
		);
	}
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
}

async function tokenRequest(
	fetcher: typeof fetch,
	client: GoogleClient,
	grant: Record<string, string>
): Promise<TokenResponse> {
	const res = await fetcher(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: client.clientId,
			client_secret: client.clientSecret,
			...grant
		}).toString()
	});
	const body = (await res.json().catch(() => ({}))) as TokenResponse;
	if (body.error === 'invalid_grant') throw new DriveReconnectError();
	if (!res.ok || !body.access_token) {
		// Google's error code only: the body can echo the request.
		throw new Error(`Google refused the token request (${body.error ?? res.status}).`);
	}
	return body;
}

export interface DriveGrant {
	refreshToken: string;
	accessToken: string;
	expiresIn: number;
}

// Trades the code Google sent to the callback for tokens.
export async function exchangeCode(
	fetcher: typeof fetch,
	client: GoogleClient,
	code: string
): Promise<DriveGrant> {
	const body = await tokenRequest(fetcher, client, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: client.redirectUri
	});
	// The person can untick the permission on Google's screen and still be sent back.
	if (!body.scope?.split(' ').includes(DRIVE_SCOPE)) {
		throw new Error('Google Drive access was not granted, so nothing was connected.');
	}
	if (!body.refresh_token) throw new Error('Google returned no refresh token.');
	return {
		refreshToken: body.refresh_token,
		accessToken: body.access_token!,
		expiresIn: body.expires_in ?? 0
	};
}

export async function refreshAccessToken(
	fetcher: typeof fetch,
	client: GoogleClient,
	refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
	const body = await tokenRequest(fetcher, client, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken
	});
	return { accessToken: body.access_token!, expiresIn: body.expires_in ?? 0 };
}

// Which Google account a token belongs to: Drive's own stable id for it, and its address.
export async function driveAccount(
	fetcher: typeof fetch,
	accessToken: string
): Promise<{ id: string; email: string }> {
	const res = await fetcher(ABOUT_ENDPOINT, {
		headers: { authorization: `Bearer ${accessToken}` }
	});
	const body = (await res.json().catch(() => ({}))) as {
		user?: { permissionId?: string; emailAddress?: string };
	};
	const id = body.user?.permissionId;
	if (!res.ok || !id)
		throw new Error(`Google Drive did not say whose account this is (${res.status}).`);
	return { id, email: body.user?.emailAddress ?? id };
}

// ---- sealing ----

const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string): Uint8Array<ArrayBuffer> => {
	const binary = atob(s);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
};

// The key storage credentials are sealed under, derived from the deployment's secret.
// Changing that secret orphans every stored credential: each Drive is connected again.
export async function credentialKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error('A deployment secret is required to store a storage credential.');
	const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(32),
			// The label keeps this key apart from everything else the secret signs.
			info: encoder.encode('isomorphic storage credentials v1')
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

// `bound` ties the ciphertext to its row: a sealed value moved to another connection
// does not open.
export async function sealCredential(
	key: CryptoKey,
	secret: string,
	bound: string
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(bound) },
		key,
		encoder.encode(secret)
	);
	return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

export async function openCredential(
	key: CryptoKey,
	sealed: string,
	bound: string
): Promise<string> {
	const [version, iv, body] = sealed.split('.');
	if (version !== 'v1' || !iv || !body) throw new Error('Unreadable storage credential.');
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(bound) },
		key,
		fromBase64(body)
	);
	return new TextDecoder().decode(plain);
}

// ---- the connection ----

// One per org and Google account, so two orgs that connect the same account never share
// a row, an owner, or a credential.
export function driveConnectionId(orgId: string, accountId: string): string {
	return `${GOOGLE_DRIVE_KIND}:${orgId}:${accountId}`;
}

// Records a granted Drive as a connection the org owns, with its refresh token sealed.
// Connecting the same account again replaces the token.
export async function saveDriveConnection(
	db: D1Database,
	key: CryptoKey,
	c: { orgId: string; userId: string; account: { id: string; email: string }; refreshToken: string }
): Promise<string> {
	const connectionId = driveConnectionId(c.orgId, c.account.id);
	const sealed = await sealCredential(key, c.refreshToken, connectionId);
	await db.batch([
		db
			.prepare(
				`INSERT INTO storage_connections
				   (connection_id, provider, kind, external_id, account, owner_org_id)
				 VALUES (?1, 'google', ?2, ?3, ?4, ?5)
				 ON CONFLICT (connection_id) DO UPDATE SET account = excluded.account`
			)
			.bind(
				connectionId,
				GOOGLE_DRIVE_KIND,
				`${c.orgId}:${c.account.id}`,
				c.account.email,
				c.orgId
			),
		db
			.prepare(
				`INSERT INTO storage_credentials (connection_id, sealed, connected_by)
				 VALUES (?1, ?2, ?3)
				 ON CONFLICT (connection_id) DO UPDATE
				   SET sealed = excluded.sealed, connected_by = excluded.connected_by,
				       updated_at = datetime('now')`
			)
			.bind(connectionId, sealed, c.userId)
	]);
	return connectionId;
}

// The Drive this person connected for this org, newest first, or null. A new brain goes
// only into a Drive its creator connected: never into a colleague's.
export async function driveConnectionFor(
	db: D1Database,
	orgId: string,
	userIds: string[]
): Promise<StorageConnection | null> {
	if (userIds.length === 0) return null;
	const marks = userIds.map((_, i) => `?${i + 3}`).join(', ');
	return await db
		.prepare(
			`SELECT c.* FROM storage_connections c
			   JOIN storage_credentials k ON k.connection_id = c.connection_id
			  WHERE c.kind = ?1 AND c.owner_org_id = ?2 AND k.connected_by IN (${marks})
			  ORDER BY k.updated_at DESC, c.connection_id ASC LIMIT 1`
		)
		.bind(GOOGLE_DRIVE_KIND, orgId, ...userIds)
		.first<StorageConnection>();
}

// Where a fresh access token is kept between requests. A KV namespace fits.
export interface TokenCache {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

// Access tokens last an hour; one is reused until shortly before that.
const EXPIRY_MARGIN_SECONDS = 300;
// The shortest time a KV entry may live.
const MIN_TTL_SECONDS = 60;

// A function that yields an access token for a connection: the cached one while it
// lasts, else one minted from the stored refresh token. The cached token is sealed too.
export function driveTokenSource(o: {
	db: D1Database;
	cache: TokenCache;
	key: CryptoKey;
	client: GoogleClient;
	connectionId: string;
	fetcher: typeof fetch;
}): () => Promise<string> {
	const cacheKey = `drive_access:${o.connectionId}`;
	let held: string | undefined;
	return async () => {
		if (held) return held;
		const cached = await o.cache.get(cacheKey);
		if (cached) {
			try {
				return (held = await openCredential(o.key, cached, cacheKey));
			} catch {
				// Sealed under an earlier secret: mint another.
			}
		}
		const row = await o.db
			.prepare(`SELECT sealed FROM storage_credentials WHERE connection_id = ?1`)
			.bind(o.connectionId)
			.first<{ sealed: string }>();
		if (!row) throw new DriveReconnectError();
		const refreshToken = await openCredential(o.key, row.sealed, o.connectionId).catch(() => {
			throw new DriveReconnectError();
		});
		const minted = await refreshAccessToken(o.fetcher, o.client, refreshToken);
		const ttl = minted.expiresIn - EXPIRY_MARGIN_SECONDS;
		if (ttl >= MIN_TTL_SECONDS) {
			await o.cache
				.put(cacheKey, await sealCredential(o.key, minted.accessToken, cacheKey), {
					expirationTtl: ttl
				})
				.catch(() => {});
		}
		return (held = minted.accessToken);
	};
}

// ---- the connect flow ----
//
// create_brain hands the person a link to this deployment (DRIVE_CONNECT_PATH) carrying
// a state it stashed. That route sends a signed-in browser on to Google, and Google
// sends it back to DRIVE_CALLBACK_PATH. Both ends require the browser to be signed in as
// the person the link was made for, so a link passed to someone else connects nothing.

export const DRIVE_CONNECT_PATH = '/google/connect';
const PENDING_TTL_SECONDS = 3600;
const pendingKey = (state: string): string => `pending_drive_connect:${state}`;

export interface PendingDriveConnect {
	userId: string;
	orgId: string;
}

// The part of a KV namespace the flow uses.
export interface PendingStore extends TokenCache {
	delete(key: string): Promise<void>;
}

// Stashes who is connecting a Drive for which org, and returns the link to give them.
export async function startDriveConnect(
	kv: PendingStore,
	base: string,
	pending: PendingDriveConnect
): Promise<string> {
	const state = crypto.randomUUID();
	await kv.put(pendingKey(state), JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });
	return `${base.replace(/\/+$/, '')}${DRIVE_CONNECT_PATH}?state=${state}`;
}

// The stashed request a state names, when the signed-in person is the one it was made
// for. `sessionUserIds` is every account of the person the browser is signed in as.
export async function pendingDriveConnect(
	kv: PendingStore,
	state: string | null,
	sessionUserIds: string[]
): Promise<PendingDriveConnect | { problem: string }> {
	const raw = state ? await kv.get(pendingKey(state)) : null;
	let pending: PendingDriveConnect | undefined;
	try {
		pending = raw ? (JSON.parse(raw) as PendingDriveConnect) : undefined;
	} catch {
		pending = undefined;
	}
	if (!pending?.userId || !pending.orgId) {
		return {
			problem: 'This link has expired or was already used. Ask your AI assistant for a new one.'
		};
	}
	if (!sessionUserIds.includes(pending.userId)) {
		return {
			problem:
				'This link was made for a different account. Sign in as that account, or ask your AI assistant for a link of your own.'
		};
	}
	return pending;
}

// Google's redirect back: trades the code for tokens and records the connection. The
// state is spent first, so a callback replayed connects nothing.
export async function completeDriveConnect(o: {
	db: D1Database;
	kv: PendingStore;
	key: CryptoKey;
	client: GoogleClient;
	fetcher: typeof fetch;
	state: string | null;
	code: string | null;
	sessionUserIds: string[];
}): Promise<{ connectionId: string; email: string } | { problem: string }> {
	const pending = await pendingDriveConnect(o.kv, o.state, o.sessionUserIds);
	if ('problem' in pending) return pending;
	await o.kv.delete(pendingKey(o.state!));
	if (!o.code) return { problem: 'Google Drive access was not granted, so nothing was connected.' };
	try {
		const grant = await exchangeCode(o.fetcher, o.client, o.code);
		const account = await driveAccount(o.fetcher, grant.accessToken);
		const connectionId = await saveDriveConnection(o.db, o.key, {
			orgId: pending.orgId,
			userId: pending.userId,
			account,
			refreshToken: grant.refreshToken
		});
		return { connectionId, email: account.email };
	} catch (e) {
		return { problem: e instanceof Error ? e.message : String(e) };
	}
}
