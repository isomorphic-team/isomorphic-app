// Storage connections: the credential a brain is read and written through.
//
// A brain is bound to one connection (brains.storage_connection_id), so the
// credential follows the BRAIN rather than the org holding it, and moving a brain
// between orgs leaves its storage where it was. docs/design/storage-and-tenancy.md
// is the model; migrations/0010_storage_connections.sql is the schema.
//
// Only GitHub App installations exist today. Their connection id is deterministic
// (`github-app:<installation id>`) so the backfill, create_brain and connect_brain
// all name the same row without a lookup.

import type { D1Database } from '@cloudflare/workers-types';
import type { Org } from './orgs.ts';

export const GITHUB_APP_KIND = 'github-app-installation';
// A GitHub access token held in the environment (GITHUB_TOKEN), for a single-user
// deployment. The row references the secret and never stores it.
export const GITHUB_TOKEN_KIND = 'github-token';

// How to reach a brain's storage, from its binding. Pure, so the choice between a
// token and an installation is pinned by a test rather than buried in the Worker.
export type BrainCredential = { kind: 'token' } | { kind: 'installation'; installationId: number };

export function credentialFor(brain: {
	storage_kind?: string | null;
	installation_id: number;
}): BrainCredential {
	if (brain.storage_kind === GITHUB_TOKEN_KIND) return { kind: 'token' };
	return { kind: 'installation', installationId: brain.installation_id };
}

export interface StorageConnection {
	connection_id: string;
	provider: string;
	kind: string;
	external_id: string;
	account: string;
	// The org that administers it (lists and adopts through it). NULL is
	// platform-owned: hosted storage, which no org may list or adopt through.
	owner_org_id: string | null;
}

export function githubAppConnectionId(installationId: number): string {
	return `github-app:${installationId}`;
}

// The credential for a connection itself, for org-scope work (creating or listing
// repositories) that has no brain to read it off.
export function credentialForConnection(conn: {
	kind: string;
	external_id: string;
}): BrainCredential {
	return credentialFor({ storage_kind: conn.kind, installation_id: Number(conn.external_id) });
}

// Who administers an org's installation. A customer org owns its own; the
// platform installation is shared by every personal and hosted org and owned by
// none of them.
export function connectionOwnerFor(org: Pick<Org, 'org_id' | 'model'>): string | null {
	return org.model === 'customer' ? org.org_id : null;
}

// The connection new brains in this org are created on: its account is where they
// live and its credential what reads them. createOrg records it; an org without one
// predates migration 0013's backfill and is an operator problem, not a fallback.
export async function orgStorage(
	db: D1Database,
	org: Pick<Org, 'org_id' | 'default_connection_id'>
): Promise<StorageConnection> {
	const conn = org.default_connection_id
		? await getConnection(db, org.default_connection_id)
		: null;
	if (!conn) throw new Error(`Org ${org.org_id} has no storage connection.`);
	return conn;
}

export async function getConnection(
	db: D1Database,
	connectionId: string
): Promise<StorageConnection | null> {
	return await db
		.prepare(`SELECT * FROM storage_connections WHERE connection_id = ?1`)
		.bind(connectionId)
		.first<StorageConnection>();
}

// Whether an org may list and adopt repositories through its own connection.
// Hosted storage is platform-owned: adopting through it would let any org claim a
// repository in the shared platform account that some other org's brain left behind.
export function orgAdministersConnection(
	org: Pick<Org, 'org_id'>,
	conn: Pick<StorageConnection, 'owner_org_id'>
): boolean {
	return conn.owner_org_id === org.org_id;
}
