// The legacy GitHub-identity routing table, backed by D1.
//
// One tenant row per GitHub user (keyed by `gh_user_id` surfaced via OAuth
// `props`), read per request on the IDENTITY_MODE=github path to find the one
// brain repo that user targets. The authjs path uses the org model in
// src/lib/orgs.ts instead, as does a GitHub id linked to a product identity.

// `D1Database` is a global ambient type via @cloudflare/workers-types in the
// Worker tsconfig, but not in the Node tsconfig (which also typechecks `lib/`
// for shared helpers). Importing as type-only makes this file portable across
// both tsconfigs without affecting runtime.
import type { D1Database } from '@cloudflare/workers-types';

export interface Tenant {
	gh_user_id: number;
	installation_id: number;
	brain_owner: string;
	brain_repo: string;
	gh_login: string | null;
	created_at: string;
	updated_at: string;
	last_seen_at: string | null;
	suspended_at: string | null;
}

export async function getTenantByUserId(db: D1Database, ghUserId: number): Promise<Tenant | null> {
	const row = await db
		.prepare('SELECT * FROM tenants WHERE gh_user_id = ?1')
		.bind(ghUserId)
		.first<Tenant>();
	return row ?? null;
}

// Insert-or-update on `gh_user_id`. Used by provisionBrainForUser.
export async function upsertTenant(
	db: D1Database,
	t: Pick<Tenant, 'gh_user_id' | 'installation_id' | 'brain_owner' | 'brain_repo'> & {
		gh_login?: string | null;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO tenants (gh_user_id, installation_id, brain_owner, brain_repo, gh_login)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(gh_user_id) DO UPDATE SET
         installation_id = excluded.installation_id,
         brain_owner = excluded.brain_owner,
         brain_repo = excluded.brain_repo,
         gh_login = COALESCE(excluded.gh_login, tenants.gh_login),
         updated_at = datetime('now')`
		)
		.bind(t.gh_user_id, t.installation_id, t.brain_owner, t.brain_repo, t.gh_login ?? null)
		.run();
}

// Thrown by `tenantContext()` when a GitHub-identity user has no tenant row and
// AUTO_PROVISION is off. It propagates to the MCP layer, which surfaces the message.
export class NoTenantError extends Error {
	constructor(public readonly ghUserId: number) {
		super(`No brain configured for gh_user_id=${ghUserId}.`);
		this.name = 'NoTenantError';
	}
}
