// A single-user deployment (AUTH_MODE=static) runs on the same org model as every
// other deployment: one org, one member standing for the operator, one brain bound
// to one storage connection. Its rows are written here, from config, on first use.
//
// Before this, static mode had NO rows: tools resolved a brain straight from env
// vars, and every org-aware tool had to ask "is there an org model?" and refuse
// when there was not. With the rows present there is one resolution path, and the
// only thing that differs between deployments is whether anyone besides the
// operator can sign in (docs/design/storage-and-tenancy.md).
//
// CONFIG IS THE TRUTH. The brain row follows BRAIN_REPO_OWNER/NAME and the
// credential follows GITHUB_TOKEN / GITHUB_APP_INSTALLATION_ID on every call, so
// changing either in config and restarting is all it takes; a brain left over from
// earlier config is removed rather than shown beside the current one. Idempotent,
// one D1 batch.

import type { D1Database } from '@cloudflare/workers-types';
import {
	GITHUB_APP_KIND,
	GITHUB_TOKEN_KIND,
	githubAppConnectionId
} from './storage-connections.ts';

export const STATIC_ORG_ID = 'static';
export const STATIC_USER_ID = 'static-operator';
// Unique and NOT NULL in app_users, never a real mailbox: `.invalid` is reserved by
// RFC 2606, and this address is never used to attribute a commit (see worker.ts).
export const STATIC_USER_EMAIL = 'operator@static.invalid';
export const GITHUB_TOKEN_CONNECTION_ID = 'github-token:env';

export type StaticCredential = { kind: 'token' } | { kind: 'installation'; installationId: number };

// The brain's primary key, from the repo. The same slug create_brain and
// connect_brain derive, so a static brain looks like any other.
export function staticBrainId(owner: string, repo: string): string {
	return `brain-${`${owner}-${repo}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')}`;
}

// The connection row a static credential is recorded as. A token is referenced,
// never stored: `external_id` names where the secret lives ("env"), and
// resolution reads GITHUB_TOKEN from the environment.
export function staticConnection(
	credential: StaticCredential,
	owner: string
): { connection_id: string; kind: string; external_id: string; account: string } {
	return credential.kind === 'token'
		? {
				connection_id: GITHUB_TOKEN_CONNECTION_ID,
				kind: GITHUB_TOKEN_KIND,
				external_id: 'env',
				account: owner
			}
		: {
				connection_id: githubAppConnectionId(credential.installationId),
				kind: GITHUB_APP_KIND,
				external_id: String(credential.installationId),
				account: owner
			};
}

export async function ensureStaticTenant(
	db: D1Database,
	input: { owner: string; repo: string; credential: StaticCredential }
): Promise<{ userId: string }> {
	const { owner, repo } = input;
	const conn = staticConnection(input.credential, owner);
	const brainId = staticBrainId(owner, repo);
	const installationId =
		input.credential.kind === 'installation' ? input.credential.installationId : 0;
	await db.batch([
		db
			.prepare(`INSERT OR IGNORE INTO app_users (user_id, email, name) VALUES (?1, ?2, 'Operator')`)
			.bind(STATIC_USER_ID, STATIC_USER_EMAIL),
		// model 'platform' is what labels an org "Personal". installation_id and
		// brain_owner are the columns every org still carries until the contract step;
		// nothing reads them for a static brain, whose binding is set below.
		db
			.prepare(
				`INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by)
				 VALUES (?1, 'Personal', 'platform', ?2, ?3, ?4)
				 ON CONFLICT(org_id) DO UPDATE SET installation_id = excluded.installation_id,
				                                   brain_owner = excluded.brain_owner`
			)
			.bind(STATIC_ORG_ID, installationId, owner, STATIC_USER_ID),
		db
			.prepare(`INSERT OR IGNORE INTO memberships (org_id, user_id, role) VALUES (?1, ?2, 'owner')`)
			.bind(STATIC_ORG_ID, STATIC_USER_ID),
		db
			.prepare(
				`INSERT INTO storage_connections (connection_id, provider, kind, external_id, account, owner_org_id)
				 VALUES (?1, 'github', ?2, ?3, ?4, ?5)
				 ON CONFLICT(connection_id) DO UPDATE SET account = excluded.account`
			)
			.bind(conn.connection_id, conn.kind, conn.external_id, conn.account, STATIC_ORG_ID),
		db
			.prepare(
				`INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, created_by, visibility,
				                     storage_connection_id)
				 VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'org', ?6)
				 ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
				   org_id = excluded.org_id,
				   storage_connection_id = excluded.storage_connection_id,
				   archived_at = NULL`
			)
			.bind(brainId, STATIC_ORG_ID, owner, repo, STATIC_USER_ID, conn.connection_id),
		// Keyed on the REPO, as the upsert above is: a database that already held a row
		// for this repo (under another id, or another org) is adopted into the static
		// org rather than failing the unique constraint. Config is the truth: a brain
		// from earlier config would otherwise sit beside the current one and, being
		// older, become the default.
		db
			.prepare(`DELETE FROM brains WHERE org_id = ?1 AND NOT (repo_owner = ?2 AND repo_name = ?3)`)
			.bind(STATIC_ORG_ID, owner, repo)
	]);
	return { userId: STATIC_USER_ID };
}
