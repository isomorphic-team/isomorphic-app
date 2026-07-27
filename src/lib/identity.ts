// Resolve a signed-in Auth.js user to a product identity — the user plus their
// org, role, and (eventually) the brain their tools target.
//
// Phase 1 (this file) is identity plumbing only: it passes the authenticated
// user through. Org/role/brain resolution against the orgs/memberships/brains
// tables lands in Phase 2. See docs/design/org-roles-permissions.md.
//
// Worker-safe (no node:* imports) — reachable from worker.ts.

// `D1Database` is a global ambient type in the Worker build, but the Node
// tsconfig (which also includes lib/) needs the explicit import.
import type { D1Database } from '@cloudflare/workers-types';
import { upsertAppUser } from './orgs.ts';

export interface ProductIdentity {
	user_id: string;
	email: string;
	org_id: string | null;
	role: string | null;
}

// Bind an authenticated Auth.js user to a product identity at OAuth-completion
// time. We persist the app-level user row here so it exists before first tool
// use; org + role are resolved lazily per-request in `tenantContext()` (which
// may auto-provision an org — a GitHub-touching step better deferred out of the
// auth redirect). So org_id/role stay null in the token props.
export async function resolveProductIdentity(
	db: D1Database,
	user: { userId: string; email: string; name: string | null }
): Promise<ProductIdentity> {
	if (user.userId) {
		await upsertAppUser(db, { user_id: user.userId, email: user.email, name: user.name });
	}
	return {
		user_id: user.userId || user.email,
		email: user.email,
		org_id: null,
		role: null
	};
}
