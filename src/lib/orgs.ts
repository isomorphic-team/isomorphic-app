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
	requires?: Role;
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

// The org's default brain — the oldest one, until multi-brain selection lands.
export async function getDefaultBrain(db: D1Database, orgId: string): Promise<Brain | null> {
	return await db
		.prepare(`SELECT * FROM brains WHERE org_id = ?1 ORDER BY created_at ASC, brain_id ASC LIMIT 1`)
		.bind(orgId)
		.first<Brain>();
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
	role: Role;
}

// A human label for a brain — what the switcher shows and what fuzzy `brain` matches
// against. Personal (platform-model) orgs are auto-named with the owner's email, which
// reads badly, so those fall back to "Personal"; when an org holds more than one brain
// the repo name is appended to disambiguate.
export function brainLabel(b: AccessibleBrain, multipleInOrg = false): string {
	// A user-given name wins outright — it's the whole point of naming a brain.
	const named = b.name?.trim();
	if (named) return named;
	const humanRepo = b.repo_name
		.replace(/^brain-/, '')
		.replace(/[-_]+/g, ' ')
		.trim();
	let base = b.org_name?.trim();
	if (!base || base.includes('@')) base = b.org_model === 'platform' ? 'Personal' : humanRepo;
	return multipleInOrg ? `${base} — ${humanRepo}` : base;
}

// All brains the given users can reach, deduped by canonical id (keeping the highest
// role when the same brain is reachable via multiple memberships), suspended orgs
// excluded, oldest-brain-first so [0] is the natural default (matches getDefaultBrain).
export async function listAccessibleBrains(
	db: D1Database,
	userIds: string[]
): Promise<AccessibleBrain[]> {
	if (userIds.length === 0) return [];
	const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT b.brain_id AS brain_id, b.repo_owner AS repo_owner, b.repo_name AS repo_name,
			        b.name AS name, b.org_id AS org_id, o.name AS org_name, o.model AS org_model,
			        o.installation_id AS installation_id, m.role AS role, b.created_at AS created_at
			   FROM memberships m
			   JOIN orgs o   ON o.org_id = m.org_id
			   JOIN brains b ON b.org_id = o.org_id
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
			org_id: string;
			org_name: string;
			org_model: string;
			installation_id: number;
			role: string;
		}>();

	const byId = new Map<string, AccessibleBrain>();
	for (const r of results ?? []) {
		const id = `${r.repo_owner}/${r.repo_name}`;
		const role = r.role as Role;
		const existing = byId.get(id);
		if (existing) {
			// Same brain via two memberships — keep the more privileged role.
			if (roleAtLeast(role, existing.role)) existing.role = role;
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
			role
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
	const multi = countByOrg(brains);
	const subs = brains.filter((b) => {
		const label = brainLabel(b, (multi.get(b.org_id) ?? 0) > 1).toLowerCase();
		return (
			b.id.toLowerCase().includes(q) || b.repo_name.toLowerCase().includes(q) || label.includes(q)
		);
	});
	if (subs.length === 1) return { brain: subs[0] };
	if (subs.length > 1) return { candidates: subs };
	return {};
}

// How many brains each org contributes — lets label rendering disambiguate.
export function countByOrg(brains: AccessibleBrain[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const b of brains) m.set(b.org_id, (m.get(b.org_id) ?? 0) + 1);
	return m;
}
