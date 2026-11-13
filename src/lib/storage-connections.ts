// Storage connections: the credential a brain is read and written through.
//
// A brain is bound to one connection (brains.storage_connection_id), so the
// credential follows the BRAIN rather than the org holding it, and moving a brain
// between orgs leaves its storage where it was. docs/design/storage-and-tenancy.md
// is the model; migrations/0010_storage_connections.sql is the schema.
//
// A GitHub App installation's connection id is deterministic
// (`github-app:<installation id>`) so the backfill, create_brain and connect_brain
// all name the same row without a lookup. A brain the platform holds itself is bound
// to the one `platform-files` connection, which carries no credential: its files are
// in a Durable Object named by the brain's id (src/lib/brain-store-sql.ts).

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Org } from './orgs.ts';

export const GITHUB_APP_KIND = 'github-app-installation';
// A GitHub access token held in the environment (GITHUB_TOKEN), for a single-user
// deployment. The row references the secret and never stores it.
export const GITHUB_TOKEN_KIND = 'github-token';

// Files the platform holds itself, one Durable Object per brain. One connection row
// serves every such brain, written when the first brain moves onto it.
export const PLATFORM_FILES_KIND = 'platform-files';
export const PLATFORM_FILES_CONNECTION_ID = 'platform-files';

// A folder in a Google Drive someone connected for the org (src/lib/drive-connection.ts).
// One connection per org and Google account; its refresh token is in storage_credentials.
export const GOOGLE_DRIVE_KIND = 'google-drive';

// How to reach a brain's storage, from its binding. Pure, so the choice between a
// token, an installation and the platform's own files is pinned by a test rather than
// buried in the Worker.
export type GithubCredential = { kind: 'token' } | { kind: 'installation'; installationId: number };
export type BrainCredential =
	| GithubCredential
	| { kind: 'platform-files' }
	// `folderId` is absent on a connection read without a brain, and on a brain row that
	// lost its folder.
	| { kind: 'google-drive'; connectionId?: string; folderId?: string };

// Narrows to a credential a GitHub client is built from.
export function isGithubCredential(c: BrainCredential): c is GithubCredential {
	return c.kind === 'token' || c.kind === 'installation';
}

export function credentialFor(brain: {
	storage_kind?: string | null;
	installation_id: number;
	storage_connection_id?: string | null;
	storage_root?: string | null;
}): BrainCredential {
	if (brain.storage_kind === GITHUB_TOKEN_KIND) return { kind: 'token' };
	if (platformHoldsFiles(brain)) return { kind: 'platform-files' };
	if (brain.storage_kind === GOOGLE_DRIVE_KIND) {
		return {
			kind: 'google-drive',
			connectionId: brain.storage_connection_id ?? undefined,
			folderId: brain.storage_root ?? undefined
		};
	}
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

// Whether a brain's files are in the platform's own storage, with no repository behind
// them.
export function platformHoldsFiles(brain: { storage_kind?: string | null }): boolean {
	return brain.storage_kind === PLATFORM_FILES_KIND;
}

// Bind a brain to a connection: it is read and written through that from now on. `root`
// is where in that storage it sits (a Drive folder), null for storage that needs none.
export function bindingStatement(
	db: D1Database,
	brainId: string,
	connectionId: string,
	root: string | null = null
): D1PreparedStatement {
	return db
		.prepare(`UPDATE brains SET storage_connection_id = ?1, storage_root = ?3 WHERE brain_id = ?2`)
		.bind(connectionId, brainId, root);
}

// Which storage a brain is on, in the words a tool takes.
export function storageOf(brain: Parameters<typeof credentialFor>[0]): BrainStorageChoice {
	const kind = credentialFor(brain).kind;
	switch (kind) {
		case 'platform-files':
			return 'isomorphic';
		case 'google-drive':
			return 'google-drive';
		case 'token':
		case 'installation':
			return 'github';
	}
}

// The statements that serve a brain from the platform's own files from now on, for one
// batch: the connection row exists before the brain names it. The caller has already
// copied the files (src/lib/brain-relocate.ts).
export function platformFilesBinding(db: D1Database, brainId: string): D1PreparedStatement[] {
	return [
		platformFilesConnectionStatement(db),
		bindingStatement(db, brainId, PLATFORM_FILES_CONNECTION_ID)
	];
}

// Writes the one platform-files connection row if it is not there yet.
export function platformFilesConnectionStatement(db: D1Database): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO storage_connections
			   (connection_id, provider, kind, external_id, account, owner_org_id)
			 VALUES (?1, 'platform', ?2, 'files', 'Isomorphic', NULL)`
		)
		.bind(PLATFORM_FILES_CONNECTION_ID, PLATFORM_FILES_KIND);
}

// Where a new brain's files go.
export type BrainStorageChoice = 'github' | 'isomorphic' | 'google-drive';

// Each as the end of "the brain is ...".
export const STORAGE_PLACE: Record<BrainStorageChoice, string> = {
	isomorphic: 'held by Isomorphic',
	github: 'in a GitHub repository',
	'google-drive': 'kept in Google Drive'
};

// Where create_brain puts a new brain, or why it cannot go where it was asked to. Pure.
// What the caller asked for wins. Otherwise an org on platform-owned storage gets a brain
// the deployment holds, when it has files objects to hold one in; an org that connected
// its own GitHub account chose GitHub. A Drive is one person's, so it is only ever asked
// for, never a default.
export function chooseBrainStorage(o: {
	requested?: BrainStorageChoice;
	// The org's connection is platform-owned (owner_org_id NULL).
	platformOwned: boolean;
	// This deployment has files objects to hold a brain in.
	canHold: boolean;
	// This deployment has a Google OAuth client to reach a Drive with.
	canDrive?: boolean;
}): { storage: BrainStorageChoice } | { problem: string } {
	if (o.requested === 'google-drive' && !o.canDrive) {
		return {
			problem:
				'This deployment is not set up to keep a brain in Google Drive, so no brain was created.'
		};
	}
	if (o.requested === 'isomorphic' && !o.canHold) {
		return { problem: 'This deployment cannot hold a brain itself, so no brain was created.' };
	}
	if (o.requested) return { storage: o.requested };
	return { storage: o.platformOwned && o.canHold ? 'isomorphic' : 'github' };
}

// The GitHub connection that reaches an account's repositories, or null. A brain that
// left its repository for the platform's own files goes back through this.
export async function githubConnectionForAccount(
	db: D1Database,
	account: string
): Promise<StorageConnection | null> {
	return await db
		.prepare(
			`SELECT * FROM storage_connections
			  WHERE provider = 'github' AND account = ?1 COLLATE NOCASE
			  ORDER BY created_at ASC, connection_id ASC LIMIT 1`
		)
		.bind(account)
		.first<StorageConnection>();
}
