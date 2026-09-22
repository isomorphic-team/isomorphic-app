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

// Who administers an org's installation. A customer org owns its own; the
// platform installation is shared by every personal and hosted org and owned by
// none of them.
export function connectionOwnerFor(org: Pick<Org, 'org_id' | 'model'>): string | null {
	return org.model === 'customer' ? org.org_id : null;
}

// The connection new brains in this org are created on, created if missing.
// INSERT OR IGNORE: an installation already recorded keeps its existing owner.
export async function ensureOrgConnection(
	db: D1Database,
	org: Pick<Org, 'org_id' | 'model' | 'installation_id' | 'brain_owner'>
): Promise<string> {
	const id = githubAppConnectionId(org.installation_id);
	await db
		.prepare(
			`INSERT OR IGNORE INTO storage_connections
			   (connection_id, provider, kind, external_id, account, owner_org_id)
			 VALUES (?1, 'github', ?2, ?3, ?4, ?5)`
		)
		.bind(
			id,
			GITHUB_APP_KIND,
			String(org.installation_id),
			org.brain_owner,
			connectionOwnerFor(org)
		)
		.run();
	return id;
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
export async function orgAdministersConnection(
	db: D1Database,
	org: Pick<Org, 'org_id' | 'model' | 'installation_id' | 'brain_owner'>
): Promise<boolean> {
	const conn = await getConnection(db, await ensureOrgConnection(db, org));
	return conn?.owner_org_id === org.org_id;
}
