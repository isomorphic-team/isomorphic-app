// Org / membership / brain model — the product-identity tenant layer.
//
// Auth.js owns *identity* (who is this email/person). This module owns the
// *authorization* projection on top: which org a user belongs to, at what role,
// and which brain repo that org's tools target. It supersedes the flat,
// GitHub-keyed `tenants` table (src/lib/tenants.ts) for the authjs identity path.
//
// Resolution shape used by `tenantContext()`:
//   app_users.user_id (Auth.js id) → membership → org (+ role) → default brain
//     → { repo_owner, repo_name } + org.installation_id
//
// Worker-safe (no node:* imports) — reachable from worker.ts. See
// docs/design/org-roles-permissions.md and src/db/auth-schema.sql.

import type { D1Database } from '@cloudflare/workers-types';
import type { Octokit } from 'octokit';
import type { CommitAuthor } from './brain-repo.ts';

// Four roles, ordered least → most privileged. Writes require `editor`+;
// `viewer` is read-only. `admin`/`owner` add member-management powers. `owner`
// is a special anchor role: it's never offered in the role picker and can't be
// removed or demoted by an admin, so an org always has one recoverable super-user.
//
// Vocabulary note: a person is always a *member* of an org (see the `memberships`
// table); their *role* is one of these four. "member" the noun ≠ a role name.
export type Role = 'viewer' | 'editor' | 'admin' | 'owner';

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

// The three roles an admin can assign through the member-management surface.
// `owner` is deliberately excluded — ownership transfer is a separate action.
export const ASSIGNABLE_ROLES: Role[] = ['viewer', 'editor', 'admin'];

// Human labels for the UI / tool responses. The DB stores the lowercase token.
const ROLE_LABELS: Record<Role, string> = {
	viewer: 'Viewer',
	editor: 'Editor',
	admin: 'Admin',
	owner: 'Owner'
};

export function roleLabel(role: Role): string {
	return ROLE_LABELS[role] ?? role;
}

// Parse a caller-supplied role string (case-insensitive, accepts the label or the
// token). Returns null for anything unrecognized so tools can error cleanly.
export function parseRole(input: string): Role | null {
	const t = input.trim().toLowerCase();
	return (['viewer', 'editor', 'admin', 'owner'] as Role[]).find((r) => r === t) ?? null;
}

export function roleAtLeast(actual: Role, required: Role): boolean {
	return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// The higher of two roles. Access resolution is additive: a grant may only ever
// RAISE what another rule already gave you (see effectiveBrainRole).
function maxRole(a: Role, b: Role): Role {
	return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

// ---------- brain-scope access (the per-brain permission rule) ----------
//
// Two roles, two scopes, deliberately separate:
//   • ORG role:   invite/remove members, set roles, connect the GitHub org,
//                create brains, connect/disconnect brains. (`memberships`)
//   • BRAIN role: read, write, move/delete pages, configure, share.
//                  (`brain_memberships` + the brain's own `visibility`)
//
// THIS is the single rule deciding whether a caller can reach a brain at all and
// at what role. It is pure so `pnpm test:access` can pin every case; every query
// below resolves rows in SQL and then runs them through here, rather than
// spreading the policy across a WHERE clause.
//
// Three independent sources of access, and the effective role is the HIGHEST any
// of them grants (never the lowest: a share must not be able to demote you):
//
//   1. visibility='org'          → your org role, for every member of the org.
//   2. an explicit grant         → that grant's role, whatever the visibility.
//   3. org admin/owner           → your org role, floored at admin, ALWAYS.
//
// (3) is the deliberate admin override. It is honest rather than generous: an org
// owner controls the GitHub org that physically holds the repo and can read it
// directly, so hiding a brain from them in our UI would be theater. It also stops
// a brain orphaning when the only person granted access leaves.
//
// Returns null when none of the three applies: the caller cannot see this brain
// and it must not appear in any listing.
export function effectiveBrainRole(input: {
	visibility: string;
	orgRole: Role;
	grant?: Role | null;
}): Role | null {
	const { visibility, orgRole, grant } = input;
	let role: Role | null = null;
	// (1) An 'org'-visible brain is reachable by every member at their org role.
	// Anything other than 'private' is treated as org-visible, so an unrecognized
	// future value fails OPEN to today's behavior rather than locking a brain out.
	if (visibility !== 'private') role = orgRole;
	// (2) An explicit per-brain grant.
	if (grant) role = role ? maxRole(role, grant) : grant;
	// (3) Org admin/owner floor.
	if (roleAtLeast(orgRole, 'admin')) role = role ? maxRole(role, orgRole) : orgRole;
	return role;
}

// The roles assignable through the brain-sharing surface. 'owner' is excluded on
// purpose (see the note on brain_memberships): ownership is an org concept.
export const ASSIGNABLE_BRAIN_ROLES: Role[] = ['viewer', 'editor', 'admin'];

// Options threaded from a tool handler into context resolution. `requires` is the
// minimum role the tool needs; resolution throws if the caller ranks below it.
// `brain` selects WHICH brain to act on (a fuzzy handle/label/id) — when omitted,
// resolution uses the connection's active brain, else the caller's default.
// `sticky` persists the RESOLVED brain as the connection's active brain (see
// tenantContext) — set by the in-client view tools so that opening/browsing a brain
// in the widget makes it active, keeping the widget and the model's bare calls on
// the same brain. Left off for pure data tools, so a one-shot `brain:` read stays
// one-shot and doesn't move the working brain.
export interface TenantOpts {
	// Minimum BRAIN role: content actions (read, write, move/delete, configure,
	// share). Resolved by effectiveBrainRole against the target brain.
	requires?: Role;
	// Minimum ORG role: org-scope actions reached through a brain-scoped call
	// (member management, connect/disconnect a brain). Kept separate from
	// `requires` because the two scopes genuinely diverge: an org Admin may hold
	// only viewer on a brain shared with them, and an org Editor may hold admin on
	// a brain they created. Gating org actions on the brain role (which is what
	// happened before per-brain access existed, when they were the same number)
	// would let a brain admin manage the whole org roster.
	requiresOrg?: Role;
	brain?: string;
	sticky?: boolean;
}

// Throw a caller-facing authorization error when `actual` outranks below `required`.
export function assertRole(actual: Role, required?: Role): void {
	if (required && !roleAtLeast(actual, required)) {
		throw new Error(
			`This action requires ${required} access or higher, but your role is ${actual}.`
		);
	}
}

export interface Org {
	org_id: string;
	name: string;
	model: string; // 'platform' (Model A) | 'customer' (Model B)
	installation_id: number;
	brain_owner: string;
	github_org_login: string | null;
	created_by: string;
	created_at: string;
	suspended_at: string | null;
}

export interface AppUser {
	user_id: string;
	email: string;
	name: string | null;
	github_login: string | null;
	// Identity-linking equivalence class. NULL = solo (person == self). Users
	// sharing a person_id are the same human; see linkedUserIds / mergePersons.
	person_id: string | null;
	created_at: string;
}

export interface Brain {
	brain_id: string;
	org_id: string;
	repo_owner: string;
	repo_name: string;
	name?: string | null; // user-given display name; NULL = derive from repo_name
	created_by?: string | null;
	visibility: string;
	created_at: string;
}

export interface MembershipWithOrg {
	role: Role;
	org: Org;
}

// Org-scope context: the installation token + org + role, resolved WITHOUT a brain.
// Backs create_brain and any org-level action that must work before the user has a
// brain (Phase 8). Distinct from BrainContext, which always carries a resolved brain.
export interface OrgScope {
	octokit: Octokit;
	org: Org;
	role: Role;
	db: D1Database;
	actorUserId: string;
	author?: CommitAuthor;
}

// The fully resolved product-identity context: which org, which brain, what role.
// `brain` is null when the user has an org but no brain yet (post-Phase-8: brains are
// created explicitly, not auto-provisioned) — callers surface a "create a brain" state.
export interface OrgContext {
	org: Org;
	brain: Brain | null;
	role: Role;
}

// Upsert the app-level projection of an Auth.js user. Called at sign-in so the
// row exists before org resolution. github_login is preserved when a later
// upsert omits it (COALESCE) so we never clobber a GitHub-connected owner.
export async function upsertAppUser(
	db: D1Database,
	u: { user_id: string; email: string; name?: string | null; github_login?: string | null }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_users (user_id, email, name, github_login)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         github_login = COALESCE(excluded.github_login, app_users.github_login)`
		)
		.bind(u.user_id, u.email, u.name ?? null, u.github_login ?? null)
		.run();
}

// The app-level user projection (name/email) for a user id. Used for commit
// attribution — the human's name+email stamped onto their edits' git author.
export async function getAppUser(db: D1Database, userId: string): Promise<AppUser | null> {
	return await db
		.prepare(`SELECT * FROM app_users WHERE user_id = ?1`)
		.bind(userId)
		.first<AppUser>();
}

// The full set of user ids that make up `userId` AS A PERSON: itself plus every
// app_user sharing its (non-null) person_id. This is the identity-linking seam —
// listAccessibleBrains(db, linkedUserIds(...)) unions a person's brains across all
// their linked emails. NULL-safe by construction: a solo user (person_id NULL)
// returns just [self]; peers are matched ONLY when this user has a non-null
// person_id, so distinct solo users never merge into one giant person.
export async function linkedUserIds(db: D1Database, userId: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT user_id FROM app_users
			  WHERE user_id = ?1
			     OR (person_id IS NOT NULL
			         AND person_id = (SELECT person_id FROM app_users WHERE user_id = ?1))`
		)
		.bind(userId)
		.all<{ user_id: string }>();
	const ids = new Set<string>([userId]); // always include self, even if the row is missing
	for (const r of results ?? []) ids.add(r.user_id);
	return [...ids];
}

// Resolve a legacy GitHub identity (numeric gh_user_id) to its owning app_user via
// the github_links bridge. Returns null when the GitHub id isn't linked (the caller
// then falls back to the flat tenants path). See src/tools/connected-accounts.ts.
export async function getAppUserByGithubUserId(
	db: D1Database,
	ghUserId: number
): Promise<AppUser | null> {
	return await db
		.prepare(
			`SELECT u.* FROM github_links g
			   JOIN app_users u ON u.user_id = g.user_id
			  WHERE g.github_user_id = ?1`
		)
		.bind(ghUserId)
		.first<AppUser>();
}

// One entry in a person's "Connected accounts" roster: either an email identity
// (an app_users row) or a linked GitHub account (a github_links row).
export interface ConnectedAccount {
	kind: 'email' | 'github';
	is_self: boolean;
	// email identities
	user_id?: string;
	email?: string;
	name?: string | null;
	// github identities
	github_user_id?: number;
	github_login?: string | null;
}

// The full roster for a person: every linked email identity (is_self flags the
// signed-in one) plus every linked GitHub account. Drives view/list_connected_accounts.
export async function listConnectedAccounts(
	db: D1Database,
	userId: string
): Promise<ConnectedAccount[]> {
	const ids = await linkedUserIds(db, userId);
	const ph = ids.map((_, i) => `?${i + 1}`).join(', ');
	const [emails, githubs] = await Promise.all([
		db
			.prepare(`SELECT user_id, email, name FROM app_users WHERE user_id IN (${ph})`)
			.bind(...ids)
			.all<{ user_id: string; email: string; name: string | null }>(),
		db
			.prepare(`SELECT github_user_id, github_login FROM github_links WHERE user_id IN (${ph})`)
			.bind(...ids)
			.all<{ github_user_id: number; github_login: string | null }>()
	]);
	const out: ConnectedAccount[] = [];
	for (const e of emails.results ?? [])
		out.push({
			kind: 'email',
			is_self: e.user_id === userId,
			user_id: e.user_id,
			email: e.email,
			name: e.name
		});
	for (const g of githubs.results ?? [])
		out.push({
			kind: 'github',
			is_self: false,
			github_user_id: g.github_user_id,
			github_login: g.github_login
		});
	return out;
}

// Merge two identities into one person. Picks a surviving person_id label
// (preferring an existing class to minimize churn), then folds BOTH users' whole
// classes onto it in a single batch (D1 has no interactive transactions).
// Idempotent: person_id is a flat label (no pointer graph), so re-running when
// already merged is a no-op, and no cycles are possible.
export async function mergePersons(
	db: D1Database,
	aUserId: string,
	bUserId: string
): Promise<void> {
	const [a, b] = await Promise.all([getAppUser(db, aUserId), getAppUser(db, bUserId)]);
	if (!a || !b) throw new Error('Cannot link: one of the accounts does not exist.');
	const pa = a.person_id ?? b.person_id ?? crypto.randomUUID();
	const relabel = (u: AppUser) =>
		u.person_id
			? db.prepare(`UPDATE app_users SET person_id = ?1 WHERE person_id = ?2`).bind(pa, u.person_id)
			: db.prepare(`UPDATE app_users SET person_id = ?1 WHERE user_id = ?2`).bind(pa, u.user_id);
	await db.batch([relabel(a), relabel(b)]);
}

// Detach one email identity from the caller's person (back to solo). Guards that
// the target actually shares the caller's person before touching it.
export async function unlinkIdentity(
	db: D1Database,
	actorUserId: string,
	targetUserId: string
): Promise<void> {
	const [actor, target] = await Promise.all([
		getAppUser(db, actorUserId),
		getAppUser(db, targetUserId)
	]);
	if (!target) throw new Error('No such account.');
	if (!actor?.person_id || actor.person_id !== target.person_id) {
		throw new Error('That account is not linked to yours.');
	}
	await db
		.prepare(`UPDATE app_users SET person_id = NULL WHERE user_id = ?1`)
		.bind(targetUserId)
		.run();
}

// Detach a linked GitHub account from the caller's person. Guards that the link
// belongs to one of the caller's linked identities before deleting.
export async function unlinkGithubLink(
	db: D1Database,
	actorUserId: string,
	githubUserId: number
): Promise<void> {
	const ids = await linkedUserIds(db, actorUserId);
	const link = await db
		.prepare(`SELECT user_id FROM github_links WHERE github_user_id = ?1`)
		.bind(githubUserId)
		.first<{ user_id: string }>();
	if (!link || !ids.includes(link.user_id)) {
		throw new Error('That GitHub account is not linked to yours.');
	}
	await db.prepare(`DELETE FROM github_links WHERE github_user_id = ?1`).bind(githubUserId).run();
}

// Resolve a user's single membership plus its org. One org per user today
// (multi-org membership is a later concern), so LIMIT 1.
export async function getMembershipWithOrg(
	db: D1Database,
	userId: string
): Promise<MembershipWithOrg | null> {
	const row = await db
		.prepare(
			`SELECT m.role AS role, o.*
         FROM memberships m
         JOIN orgs o ON o.org_id = m.org_id
        WHERE m.user_id = ?1
        LIMIT 1`
		)
		.bind(userId)
		.first<Record<string, unknown>>();
	if (!row) return null;
	const { role, ...org } = row;
	return { role: role as Role, org: org as unknown as Org };
}

// The org's oldest brain, IGNORING access. Only safe where the caller has already
// established that the viewer may see it: today that is nowhere in the request
// path. Kept for org-level bookkeeping ("does this org hold any brain at all?"),
// which is how the provisioning error messages tell "no brain yet" apart from
// "brains exist but none are shared with you". Use getDefaultBrainForUser to pick
// a brain to PUT SOMEONE IN.
export async function getAnyBrainInOrg(db: D1Database, orgId: string): Promise<Brain | null> {
	return await db
		.prepare(`SELECT * FROM brains WHERE org_id = ?1 ORDER BY created_at ASC, brain_id ASC LIMIT 1`)
		.bind(orgId)
		.first<Brain>();
}

// The oldest brain in an org that THIS user can actually reach: the brain a
// freshly provisioned or freshly invited member lands on. Access runs through the
// same pure rule as listAccessibleBrains, so a private brain nobody shared can
// never be handed to someone as their default. Returns null when the org holds no
// brain, or holds only brains this user cannot see.
export async function getDefaultBrainForUser(
	db: D1Database,
	orgId: string,
	userId: string,
	orgRole: Role
): Promise<Brain | null> {
	const { results } = await db
		.prepare(
			`SELECT b.*, bm.role AS grant_role
			   FROM brains b
			   LEFT JOIN brain_memberships bm
			          ON bm.brain_id = b.brain_id AND bm.user_id = ?2
			  WHERE b.org_id = ?1
			  ORDER BY b.created_at ASC, b.brain_id ASC`
		)
		.bind(orgId, userId)
		.all<Brain & { grant_role: string | null }>();
	for (const row of results ?? []) {
		const role = effectiveBrainRole({
			visibility: row.visibility,
			orgRole,
			grant: row.grant_role as Role | null
		});
		if (role) {
			const { grant_role: _drop, ...brain } = row;
			return brain as Brain;
		}
	}
	return null;
}

export async function createOrg(
	db: D1Database,
	o: {
		org_id: string;
		name: string;
		model: string;
		installation_id: number;
		brain_owner: string;
		github_org_login?: string | null;
		created_by: string;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, github_org_login, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
		)
		.bind(
			o.org_id,
			o.name,
			o.model,
			o.installation_id,
			o.brain_owner,
			o.github_org_login ?? null,
			o.created_by
		)
		.run();
}

export async function addMembership(
	db: D1Database,
	m: { org_id: string; user_id: string; role: Role }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO memberships (org_id, user_id, role) VALUES (?1, ?2, ?3)
       ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role`
		)
		.bind(m.org_id, m.user_id, m.role)
		.run();
}

export async function createBrain(
	db: D1Database,
	b: {
		brain_id: string;
		org_id: string;
		repo_owner: string;
		repo_name: string;
		name?: string | null;
		created_by?: string | null;
		visibility?: string;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, created_by, visibility)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(repo_owner, repo_name) DO NOTHING`
		)
		.bind(
			b.brain_id,
			b.org_id,
			b.repo_owner,
			b.repo_name,
			b.name ?? null,
			b.created_by ?? null,
			b.visibility ?? 'org'
		)
		.run();
}

// The brain for a given repo, or null. Used by connect_brain to detect a repo that's
// already adopted (possibly by another org) before inserting.
export async function getBrainByRepo(
	db: D1Database,
	repoOwner: string,
	repoName: string
): Promise<Brain | null> {
	return await db
		.prepare(`SELECT * FROM brains WHERE repo_owner = ?1 AND repo_name = ?2`)
		.bind(repoOwner, repoName)
		.first<Brain>();
}

// Detach a brain from its org (disconnect). The GitHub repo and its content are
// untouched — this only removes the brains row so the repo stops being a brain.
export async function deleteBrain(db: D1Database, brainId: string): Promise<void> {
	await db.prepare(`DELETE FROM brains WHERE brain_id = ?1`).bind(brainId).run();
}

// ---------- email invitations (pre-membership) ----------
//
// An `invitations` row is how an admin puts a user into an org BEFORE that user
// has ever signed in — the only way a member with no GitHub account joins a
// specific org (otherwise first sign-in would auto-provision them a personal
// Model-A brain). Matching is by email: magic-link/SSO already proves the user
// owns the address, so no separate invite token is required for this path (the
// token_hash column stays for a future link-based flow).

export interface PendingInvite {
	invite_id: string;
	org_id: string;
	role: Role;
}

// The most recent unexpired, unaccepted invite for an email (case-insensitive),
// or null. Callers consume it at first sign-in to place the user in that org.
export async function getPendingInviteByEmail(
	db: D1Database,
	email: string
): Promise<PendingInvite | null> {
	const row = await db
		.prepare(
			`SELECT invite_id, org_id, role
         FROM invitations
        WHERE lower(email) = lower(?1)
          AND accepted_at IS NULL
          AND expires_at > datetime('now')
        ORDER BY rowid DESC
        LIMIT 1`
		)
		.bind(email)
		.first<{ invite_id: string; org_id: string; role: string }>();
	if (!row) return null;
	return { invite_id: row.invite_id, org_id: row.org_id, role: row.role as Role };
}

export async function acceptInvite(db: D1Database, inviteId: string): Promise<void> {
	await db
		.prepare(`UPDATE invitations SET accepted_at = datetime('now') WHERE invite_id = ?1`)
		.bind(inviteId)
		.run();
}

// ---------- member management (list / invite / set role / remove) ----------
//
// The org-admin surface: everything an admin does to the roster. Read (list) is
// open to any member; the mutations are gated on `admin`+ by the caller
// (src/tools/members.ts), which also enforces the anti-lockout guardrails. These
// functions are pure data access — they trust the caller to have authorized.

// A person on the roster: their app-user projection joined to their org role.
export interface Member {
	user_id: string;
	email: string;
	name: string | null;
	github_login: string | null;
	role: Role;
	added_at: string;
}

// A not-yet-accepted invitation (the person hasn't signed in / been added yet).
export interface Invite {
	invite_id: string;
	email: string;
	role: Role;
	invited_at: string;
	expires_at: string;
}

// The whole roster for an org, ordered by rank (owner first) then join time.
export async function listMembers(db: D1Database, orgId: string): Promise<Member[]> {
	const { results } = await db
		.prepare(
			`SELECT u.user_id AS user_id, u.email AS email, u.name AS name,
			        u.github_login AS github_login, m.role AS role, m.added_at AS added_at
			   FROM memberships m
			   JOIN app_users u ON u.user_id = m.user_id
			  WHERE m.org_id = ?1
			  ORDER BY
			    CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
			                WHEN 'editor' THEN 2 ELSE 3 END,
			    m.added_at ASC`
		)
		.bind(orgId)
		.all<Member>();
	return results ?? [];
}

// Pending (unaccepted, unexpired) invitations for an org, newest first.
export async function listPendingInvites(db: D1Database, orgId: string): Promise<Invite[]> {
	const { results } = await db
		.prepare(
			`SELECT invite_id, email, role, invited_at, expires_at
			   FROM invitations
			  WHERE org_id = ?1
			    AND accepted_at IS NULL
			    AND expires_at > datetime('now')
			  ORDER BY invited_at DESC`
		)
		.bind(orgId)
		.all<Invite>();
	return results ?? [];
}

// The role of one user in one org, or null if they aren't a member.
export async function getMemberRole(
	db: D1Database,
	orgId: string,
	userId: string
): Promise<Role | null> {
	const row = await db
		.prepare(`SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2`)
		.bind(orgId, userId)
		.first<{ role: string }>();
	return row ? (row.role as Role) : null;
}

// Look up an app-user by email (case-insensitive). Used by invite_member to add an
// already-signed-in person directly rather than routing through the email hop.
export async function getAppUserByEmail(db: D1Database, email: string): Promise<AppUser | null> {
	return await db
		.prepare(`SELECT * FROM app_users WHERE lower(email) = lower(?1)`)
		.bind(email)
		.first<AppUser>();
}

export async function setMemberRole(
	db: D1Database,
	orgId: string,
	userId: string,
	role: Role
): Promise<void> {
	await db
		.prepare(`UPDATE memberships SET role = ?3 WHERE org_id = ?1 AND user_id = ?2`)
		.bind(orgId, userId, role)
		.run();
}

export async function removeMembership(
	db: D1Database,
	orgId: string,
	userId: string
): Promise<void> {
	await db
		.prepare(`DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2`)
		.bind(orgId, userId)
		.run();
}

// Record an email invitation. Matched by email and consumed at the invitee's first
// sign-in (provisionOrgForUser → getPendingInviteByEmail → acceptInvite). token_hash
// stays empty: email possession is proven by magic-link/SSO, so no link token is
// needed for this path (the column is reserved for a future link-based flow).
export async function createInvitation(
	db: D1Database,
	inv: { invite_id: string; org_id: string; email: string; role: Role; invited_by: string }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO invitations
			   (invite_id, org_id, email, role, invited_by, token_hash, invited_at, expires_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, '', datetime('now'), datetime('now', '+30 days'))`
		)
		.bind(inv.invite_id, inv.org_id, inv.email, inv.role, inv.invited_by)
		.run();
}

// Revoke a pending invitation (admin changed their mind before it was accepted).
export async function revokeInvite(db: D1Database, orgId: string, inviteId: string): Promise<void> {
	await db
		.prepare(`DELETE FROM invitations WHERE org_id = ?1 AND invite_id = ?2 AND accepted_at IS NULL`)
		.bind(orgId, inviteId)
		.run();
}

// ---------- brain access grants (the per-brain sharing surface) ----------
//
// Data access only: src/tools/brain-access.ts authorizes (brain admin+) and
// enforces the guardrails. Mirrors the member-management block above, one scope
// down: those functions move `memberships` (the ORG role), these move
// `brain_memberships` (the BRAIN role).

// One row on a brain's access list: the person, plus how they get in. `via`
// distinguishes an explicit grant from access inherited via org visibility or the
// org-admin floor, so the UI can show "everyone in the org" without pretending
// those people were individually shared with, and so it can hide a Remove button
// that would do nothing.
export interface BrainAccessEntry {
	user_id: string;
	email: string;
	name: string | null;
	role: Role;
	via: 'grant' | 'org' | 'org-admin';
	granted_at?: string;
}

// Everyone who can reach a brain, and at what role. Walks every org member (that
// is the candidate pool: a brain can only be shared inside its own org) plus
// their grant, and admits them through the same pure rule the read path uses.
export async function listBrainAccess(
	db: D1Database,
	brainId: string,
	orgId: string,
	visibility: string
): Promise<BrainAccessEntry[]> {
	const { results } = await db
		.prepare(
			`SELECT u.user_id AS user_id, u.email AS email, u.name AS name,
			        m.role AS org_role, bm.role AS grant_role, bm.granted_at AS granted_at
			   FROM memberships m
			   JOIN app_users u ON u.user_id = m.user_id
			   LEFT JOIN brain_memberships bm
			          ON bm.brain_id = ?1 AND bm.user_id = m.user_id
			  WHERE m.org_id = ?2
			  ORDER BY
			    CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
			                WHEN 'editor' THEN 2 ELSE 3 END,
			    m.added_at ASC`
		)
		.bind(brainId, orgId)
		.all<{
			user_id: string;
			email: string;
			name: string | null;
			org_role: string;
			grant_role: string | null;
			granted_at: string | null;
		}>();
	const out: BrainAccessEntry[] = [];
	for (const r of results ?? []) {
		const orgRole = r.org_role as Role;
		const grant = r.grant_role as Role | null;
		const role = effectiveBrainRole({ visibility, orgRole, grant });
		if (!role) continue;
		const via: BrainAccessEntry['via'] = grant
			? 'grant'
			: visibility !== 'private'
				? 'org'
				: 'org-admin';
		out.push({
			user_id: r.user_id,
			email: r.email,
			name: r.name,
			role,
			via,
			granted_at: r.granted_at ?? undefined
		});
	}
	return out;
}

// The explicit grant a user holds on a brain, or null. Used to tell "already
// shared, change the role" apart from "not shared yet".
export async function getBrainGrant(
	db: D1Database,
	brainId: string,
	userId: string
): Promise<Role | null> {
	const row = await db
		.prepare(`SELECT role FROM brain_memberships WHERE brain_id = ?1 AND user_id = ?2`)
		.bind(brainId, userId)
		.first<{ role: string }>();
	return row ? (row.role as Role) : null;
}

// Grant or re-grant one user access to one brain (upsert, so re-sharing at a new
// role is the same call).
export async function setBrainGrant(
	db: D1Database,
	g: { brain_id: string; user_id: string; role: Role; granted_by?: string | null }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO brain_memberships (brain_id, user_id, role, granted_by)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(brain_id, user_id) DO UPDATE SET
			   role = excluded.role,
			   granted_by = excluded.granted_by,
			   granted_at = datetime('now')`
		)
		.bind(g.brain_id, g.user_id, g.role, g.granted_by ?? null)
		.run();
}

export async function removeBrainGrant(
	db: D1Database,
	brainId: string,
	userId: string
): Promise<void> {
	await db
		.prepare(`DELETE FROM brain_memberships WHERE brain_id = ?1 AND user_id = ?2`)
		.bind(brainId, userId)
		.run();
}

// Flip a brain between 'private' (grants + org admins only) and 'org' (every
// member of the owning org). Existing grants are LEFT IN PLACE: going org-visible
// and back must not silently drop who you had shared it with.
export async function setBrainVisibility(
	db: D1Database,
	brainId: string,
	visibility: 'org' | 'private'
): Promise<void> {
	await db
		.prepare(`UPDATE brains SET visibility = ?2 WHERE brain_id = ?1`)
		.bind(brainId, visibility)
		.run();
}

// Drop every grant on a brain: called when the brain is disconnected, so its
// rows don't outlive it and re-attach if the same repo is adopted again later.
export async function deleteBrainGrants(db: D1Database, brainId: string): Promise<void> {
	await db.prepare(`DELETE FROM brain_memberships WHERE brain_id = ?1`).bind(brainId).run();
}

// Drop every grant a user holds on brains belonging to one org: called when they
// are removed from that org, so revoking membership actually revokes access
// rather than leaving per-brain grants that would still let them in.
export async function deleteUserBrainGrantsInOrg(
	db: D1Database,
	orgId: string,
	userId: string
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM brain_memberships
			  WHERE user_id = ?2
			    AND brain_id IN (SELECT brain_id FROM brains WHERE org_id = ?1)`
		)
		.bind(orgId, userId)
		.run();
}

// ---------- accessible brains (multi-brain selection) ----------
//
// The set of brains one PERSON can reach. Deliberately takes a SET of user_ids so
// that when identity-linking lands (P2), passing all of a person's linked ids yields
// the union of their brains across every email — no re-architecting. In P1 the set is
// just [current user]. Each brain carries the caller's role IN THAT brain's org (you
// can be owner of one and viewer of another) and the org's installation, so the caller
// can mint a per-brain token. `id` is the canonical "owner/repo" key — the same id the
// content index uses (brainId) and what the tools/app pass as the `brain` handle.

export interface AccessibleBrain {
	id: string; // "owner/repo" — canonical brainId, tool/app-facing handle
	brain_id: string; // brains PK
	org_id: string;
	org_name: string;
	org_model: string; // 'platform' | 'customer'
	installation_id: number;
	repo_owner: string;
	repo_name: string;
	name?: string | null; // user-given display name (brains.name); NULL = derive from repo
	// The caller's role ON THIS BRAIN (effectiveBrainRole): what read/write/
	// configure/share gate on. NOT the same as `org_role`.
	role: Role;
	// The caller's role in this brain's ORG: what member management, brain
	// creation, and connect/disconnect gate on. Carried alongside `role` because
	// the two scopes diverge: you can be an org Admin holding only viewer on a
	// brain someone shared with you read-only, or an org Editor holding admin on
	// a brain you created.
	org_role: Role;
	visibility: string; // 'org' | 'private'
}

// A human label for a brain — what the switcher shows and what fuzzy `brain` matches
// against. Personal (platform-model) orgs are auto-named with the owner's email, which
// reads badly, so those fall back to "Personal"; when an org holds more than one brain
// the repo name is appended to disambiguate.
export function brainLabel(b: AccessibleBrain): string {
	// ONE RULE: a brain is called what it is named, and an unnamed one is called after
	// its repo. Nothing else — no org prefix when an org holds several, no borrowing the
	// org's name when it holds one, no "Personal" for a platform org.
	//
	// Those three special cases all compensated for the same missing capability rather
	// than for anything about brains: three of the four ways a brain is created cannot
	// set a name at all (connect_brain, the operator seed, scripts/onboard-org), so the
	// label had to invent one. Inventing it here made the name depend on how many
	// siblings a brain had, which meant adopting a second brain silently RENAMED the
	// first. Surfaces that show brains side by side group them under an org heading
	// (app/core/util groupBrainsByOrg), which is where org belongs.
	const named = b.name?.trim();
	if (named) return named;
	return (
		b.repo_name
			.replace(/^brain-/, '')
			.replace(/[-_]+/g, ' ')
			.trim() || b.repo_name
	);
}

// How an org is named to a human. Lived in tools/brains.ts, where only the switcher
// rows could reach it; both consumers of a qualified label need it.
export function orgDisplay(b: AccessibleBrain): string {
	if (b.org_model === 'platform') return 'Personal';
	return b.org_name?.trim() || b.repo_owner;
}

// A label with its org named. For the one place brains are listed side by side with no
// heading to group them: the "which of these did you mean" error. Labels are now the
// brain's own name, so two orgs can hold a "wiki" — and a disambiguation list reading
// "wiki, wiki" is worse than no list at all. Everywhere else the org is a heading
// (groupBrainsByOrg) or context the user already has.
export function brainLabelQualified(b: AccessibleBrain): string {
	return `${brainLabel(b)} (${orgDisplay(b)})`;
}

// All brains the given users can reach, deduped by canonical id (keeping the highest
// role when the same brain is reachable via multiple memberships), suspended orgs
// excluded, oldest-brain-first so [0] is the natural default (matches getDefaultBrain).
//
// Access is decided by effectiveBrainRole, NOT by this query: the SQL widens to
// "every brain in every org you belong to, plus whatever grant you hold", and each
// row is then admitted or dropped by the pure rule. Keeping the policy out of the
// WHERE clause is what lets `pnpm test:access` pin it exhaustively: a filter
// expressed twice (here and in getAccessibleBrain) is a filter that will disagree.
export async function listAccessibleBrains(
	db: D1Database,
	userIds: string[]
): Promise<AccessibleBrain[]> {
	if (userIds.length === 0) return [];
	const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT b.brain_id AS brain_id, b.repo_owner AS repo_owner, b.repo_name AS repo_name,
			        b.name AS name, b.visibility AS visibility, b.org_id AS org_id,
			        o.name AS org_name, o.model AS org_model,
			        o.installation_id AS installation_id, m.role AS org_role,
			        bm.role AS grant_role, b.created_at AS created_at
			   FROM memberships m
			   JOIN orgs o   ON o.org_id = m.org_id
			   JOIN brains b ON b.org_id = o.org_id
			   LEFT JOIN brain_memberships bm
			          ON bm.brain_id = b.brain_id AND bm.user_id = m.user_id
			  WHERE m.user_id IN (${placeholders})
			    AND o.suspended_at IS NULL
			  ORDER BY b.created_at ASC, b.brain_id ASC`
		)
		.bind(...userIds)
		.all<{
			brain_id: string;
			repo_owner: string;
			repo_name: string;
			name: string | null;
			visibility: string;
			org_id: string;
			org_name: string;
			org_model: string;
			installation_id: number;
			org_role: string;
			grant_role: string | null;
		}>();

	const byId = new Map<string, AccessibleBrain>();
	for (const r of results ?? []) {
		const id = `${r.repo_owner}/${r.repo_name}`;
		const orgRole = r.org_role as Role;
		const role = effectiveBrainRole({
			visibility: r.visibility,
			orgRole,
			grant: r.grant_role as Role | null
		});
		if (!role) continue; // private brain, no grant, not an org admin: invisible.
		const existing = byId.get(id);
		if (existing) {
			// Same brain reached via two linked identities: keep the higher of each.
			if (roleAtLeast(role, existing.role)) existing.role = role;
			if (roleAtLeast(orgRole, existing.org_role)) existing.org_role = orgRole;
			continue;
		}
		byId.set(id, {
			id,
			brain_id: r.brain_id,
			org_id: r.org_id,
			org_name: r.org_name,
			org_model: r.org_model,
			installation_id: r.installation_id,
			repo_owner: r.repo_owner,
			repo_name: r.repo_name,
			name: r.name,
			role,
			org_role: orgRole,
			visibility: r.visibility
		});
	}
	return [...byId.values()];
}

// Resolve a caller-supplied `brain` handle against what they can access. Matches (in
// priority order) exact canonical id, exact repo name, then a case-insensitive
// substring of id / repo / label. Returns { brain } on a unique hit, { candidates }
// when ambiguous (so the tool can ask), or {} when nothing matches.
export function matchBrain(
	brains: AccessibleBrain[],
	query: string
): { brain?: AccessibleBrain; candidates?: AccessibleBrain[] } {
	const q = query.trim().toLowerCase();
	if (!q) return {};
	const exact = brains.find((b) => b.id.toLowerCase() === q || b.repo_name.toLowerCase() === q);
	if (exact) return { brain: exact };
	const subs = brains.filter((b) => {
		const label = brainLabel(b).toLowerCase();
		// org_name is matched EXPLICITLY rather than incidentally. It used to ride along
		// inside the label of any brain in a multi-brain org ("Beckers Healthcare — ed
		// brain"), so `brain: "beckers"` resolved by accident of formatting; dropping the
		// prefix would have silently broken every org-qualified handle an agent had
		// learned. How a brain is DISPLAYED and what a human can call it are two
		// questions, and only the first one changed.
		return (
			b.id.toLowerCase().includes(q) ||
			b.repo_name.toLowerCase().includes(q) ||
			(b.org_name ?? '').toLowerCase().includes(q) ||
			label.includes(q)
		);
	});
	if (subs.length === 1) return { brain: subs[0] };
	if (subs.length > 1) return { candidates: subs };
	return {};
}
