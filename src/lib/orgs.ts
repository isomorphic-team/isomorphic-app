// Org / membership / brain model — the product-identity tenant layer.
//
// Auth.js owns *identity* (who is this email/person). This module owns the
// *authorization* projection on top: which org a user belongs to, at what role,
// and which brain repo that org's tools target. It supersedes the flat,
// GitHub-keyed `tenants` table (src/lib/tenants.ts) for the authjs identity path.
//
// Resolution shape used by `tenantContext()`:
//   app_users.user_id (Auth.js id) + linked ids → memberships and brain grants
//     → accessible brains (each admitted by effectiveBrainRole) → the chosen brain
//     → { repo_owner, repo_name } + the brain's storage connection (or, for a brain
//       with no binding, org.installation_id)
//
// Worker-safe (no node:* imports), reachable from worker.ts. See
// docs/design/org-roles-permissions.md; the schema is migrations/.

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

// The one thing that LOWERS a role, and it is a ceiling rather than a demotion: a
// read-only brain is capped at viewer.
function minRole(a: Role, b: Role): Role {
	return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
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
// `orgRole` is NULLABLE, and a null means "not a member of the organization holding
// this brain". Sources (1) and (3) are both about membership, so for a non-member they
// are skipped and only an explicit grant can admit them. That is the shape any access
// from outside an organization takes, and it lets the gates downstream tell "not a
// member" from "a member with few powers".
//
// `readOnly` is the one thing that lowers the result rather than raising it. It is a
// CEILING on the whole computation, applied last, because a read-only brain has to be
// inert to everyone including the admins of the organization holding it: source (3)
// would otherwise hand them their own role straight back, and an org-visible brain
// would hand every member theirs. This is why a viewer grant cannot make a brain
// read-only and a column on the brain can.
//
// A non-member is a GUEST of the brain, and a guest is capped at editor. Deciding who
// reaches a brain is the organization's decision, and `admin` on a brain is exactly that
// power, so it stays with people the org can see on its roster. share_brain refuses to
// write an admin grant for a non-member; this cap is what makes the refusal an
// invariant rather than a courtesy, since a row can be written by more than one path.
//
// Returns null when none of the sources applies: the caller cannot see this brain and
// it must not appear in any listing.
export const GUEST_ROLE_CAP: Role = 'editor';

export function effectiveBrainRole(input: {
	visibility: string;
	orgRole: Role | null;
	grant?: Role | null;
	readOnly?: boolean;
}): Role | null {
	const { visibility, orgRole, grant, readOnly } = input;
	let role: Role | null = null;
	// (1) An 'org'-visible brain is reachable by every MEMBER at their org role.
	// Anything other than 'private' is treated as org-visible, so an unrecognized
	// future value fails OPEN to today's behavior rather than locking a brain out.
	if (orgRole && visibility !== 'private') role = orgRole;
	// (2) An explicit per-brain grant.
	if (grant) role = role ? maxRole(role, grant) : grant;
	// (3) Org admin/owner floor. Also needs a membership to be a member of.
	if (orgRole && roleAtLeast(orgRole, 'admin')) role = role ? maxRole(role, orgRole) : orgRole;
	// A guest (no membership) never exceeds the guest cap.
	if (role && !orgRole) role = minRole(role, GUEST_ROLE_CAP);
	// A read-only brain caps whatever the sources produced.
	if (role && readOnly) role = minRole(role, 'viewer');
	return role;
}

// Which of effectiveBrainRole's sources admits someone, for the surfaces that tell a
// human WHY a person reaches a brain (the sharing panel, a move's preview). Only
// meaningful when effectiveBrainRole returned a role for the same input.
export function accessVia(input: {
	visibility: string;
	orgRole: Role | null;
	grant?: Role | null;
}): 'grant' | 'org' | 'org-admin' | 'guest' {
	if (!input.orgRole) return 'guest';
	if (input.grant) return 'grant';
	return input.visibility !== 'private' ? 'org' : 'org-admin';
}

// The roles assignable through the brain-sharing surface. 'owner' is excluded on
// purpose (see the note on brain_memberships): ownership is an org concept.
export const ASSIGNABLE_BRAIN_ROLES: Role[] = ['viewer', 'editor', 'admin'];

// Options threaded from a tool handler into context resolution. `requires` is the
// minimum role the tool needs; resolution throws if the caller ranks below it.
// `brain` selects WHICH brain to act on (a fuzzy handle/label/id) — when omitted,
// resolution uses the caller's active brain, else their default. Resolving never
// moves the active brain: only switch_brain, create_brain and disconnect_brain
// write that pointer (see setActiveBrain in worker.ts).
export interface TenantOpts {
	// Minimum BRAIN role: content actions (read, write, move/delete, configure,
	// share). Resolved by effectiveBrainRole against the target brain.
	requires?: Role;
	// Minimum ORG role: org-scope actions reached through a brain-scoped call
	// (member management, connect/disconnect a brain). Kept separate from
	// `requires` because the two scopes genuinely diverge: an org Admin may hold
	// only viewer on a brain shared with them, and an org Editor may hold admin on
	// a brain they created. Gating org actions on the brain role would let a brain
	// admin manage the whole org roster.
	requiresOrg?: Role;
	brain?: string;
}

// Throw a caller-facing authorization error when `actual` ranks below `required`.
//
// `actual` is nullable because a caller can reach a brain without holding any role in
// the organization that owns it. A null has to read as "you are not a member", never
// as "your role is undefined" or as "no gate".
export function assertRole(actual: Role | null, required?: Role): void {
	if (!required) return;
	if (!actual) {
		throw new Error(
			`This action requires ${required} access in the organization, and you are not a member of it.`
		);
	}
	if (!roleAtLeast(actual, required)) {
		throw new Error(
			`This action requires ${required} access or higher, but your role is ${actual}.`
		);
	}
}

export interface Org {
	org_id: string;
	name: string;
	// 'platform' (Model A, a personal org) | 'customer' (Model B, the customer's own
	// installation) | 'hosted' (a named team org on the platform's installation).
	model: string;
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
	archived_at?: string | null;
	read_only?: number | null;
	// The connection its storage is read through. NULL on rows written before
	// migration 0010 or by code that predates it: resolution falls back to the org's.
	storage_connection_id?: string | null;
}

export interface MembershipWithOrg {
	role: Role;
	org: Org;
}

// Org-scope context: the installation token + org + role, resolved WITHOUT a brain.
// Backs create_brain and any org-level action that must work before the user has a
// brain. Distinct from BrainContext, which always carries a resolved brain.
export interface OrgScope {
	octokit: Octokit;
	org: Org;
	role: Role;
	db: D1Database;
	actorUserId: string;
	author?: CommitAuthor;
}

// The fully resolved product-identity context: which org, which brain, what role.
// `brain` is null when the user has an org but no brain yet (brains are created
// explicitly, not auto-provisioned): callers surface a "create a brain" state.
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
// signed-in one) plus every linked GitHub account. Drives connected_accounts.
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

// One membership of this user id, oldest first, plus its org.
//
// A person CAN belong to several orgs: `memberships` is keyed (org_id, user_id),
// invitations put someone in a second one, and every resolution path that picks
// where to act unions across them (listAccessibleBrains, listAccessibleOrgs,
// resolveOrgForPerson, chooseOrg). This is not one of those paths. It answers
// "does this user id belong anywhere yet", for first-touch provisioning, so the
// LIMIT 1 is deliberate; it is ordered so the answer is the same on every call
// rather than whichever row the query plan reached first.
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
        ORDER BY m.added_at ASC, m.org_id ASC
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

export async function getOrgById(db: D1Database, orgId: string): Promise<Org | null> {
	return await db.prepare(`SELECT * FROM orgs WHERE org_id = ?1`).bind(orgId).first<Org>();
}

// Every brain an org holds, ignoring who can reach it. Deliberately NOT an access
// query: the one caller is the org Analytics tab, which counts activity per brain
// for an org admin and must therefore show a brain that exists but is private to
// someone else (as a row with numbers, never with content). Anything that decides
// what a user may OPEN goes through listAccessibleBrains and effectiveBrainRole
// instead. Do not reuse this to populate a switcher.
export async function listBrainsInOrg(db: D1Database, orgId: string): Promise<Brain[]> {
	const { results } = await db
		.prepare(`SELECT * FROM brains WHERE org_id = ?1 ORDER BY created_at ASC, brain_id ASC`)
		.bind(orgId)
		.all<Brain>();
	return results ?? [];
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
			  WHERE b.org_id = ?1 AND b.archived_at IS NULL
			  ORDER BY b.created_at ASC, b.brain_id ASC`
		)
		.bind(orgId, userId)
		.all<Brain & { grant_role: string | null }>();
	for (const row of results ?? []) {
		const role = effectiveBrainRole({
			visibility: row.visibility,
			orgRole,
			grant: row.grant_role as Role | null,
			readOnly: !!row.read_only
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
		storage_connection_id?: string | null;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, created_by, visibility,
			                     storage_connection_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(repo_owner, repo_name) DO NOTHING`
		)
		.bind(
			b.brain_id,
			b.org_id,
			b.repo_owner,
			b.repo_name,
			b.name ?? null,
			b.created_by ?? null,
			b.visibility ?? 'org',
			b.storage_connection_id ?? null
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

// ---------- email invitations ----------
//
// An `invitations` row is how an admin puts someone in an org without touching
// GitHub: it is the only way a member with no GitHub account joins a SPECIFIC
// org (a first sign-in otherwise mints them a personal Model-A one). A row with
// `brain_id` set is a brain invite instead: it becomes a grant on that one brain,
// never a membership (see lib/invites.ts). Matching is
// by email, because magic-link/SSO already proves the person owns the address,
// so no separate invite token is required for this path (the token_hash column
// stays for a future link-based flow).
//
// Claiming lives in lib/invites.ts, and is not restricted to a first sign-in:
// an existing account can be invited to a second org, and an address linked to
// an existing account carries its invitation with it.

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

// Pending (unaccepted, unexpired) invitations for an org, newest first. ORG
// invites only: a brain invite carries the brain's org_id too, and listing it here
// would show the roster a member who was never invited to join.
export async function listPendingInvites(db: D1Database, orgId: string): Promise<Invite[]> {
	const { results } = await db
		.prepare(
			`SELECT invite_id, email, role, invited_at, expires_at
			   FROM invitations
			  WHERE org_id = ?1
			    AND brain_id IS NULL
			    AND accepted_at IS NULL
			    AND expires_at > datetime('now')
			  ORDER BY invited_at DESC`
		)
		.bind(orgId)
		.all<Invite>();
	return results ?? [];
}

// Pending brain invites for one brain, newest first: the sharing panel's evidence
// that a share to an address with no account happened, until they sign in.
export async function listPendingBrainInvites(db: D1Database, brainId: string): Promise<Invite[]> {
	const { results } = await db
		.prepare(
			`SELECT invite_id, email, role, invited_at, expires_at
			   FROM invitations
			  WHERE brain_id = ?1
			    AND accepted_at IS NULL
			    AND expires_at > datetime('now')
			  ORDER BY invited_at DESC`
		)
		.bind(brainId)
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
// sign-in or on the invitee's next request (claimPendingInvites). token_hash
// stays empty: email possession is proven by magic-link/SSO, so no link token is
// needed for this path (the column is reserved for a future link-based flow).
//
// With `brain_id` it is a BRAIN invite: claimed as a grant on that one brain, not
// as a membership in `org_id`, which is the brain's own org.
export async function createInvitation(
	db: D1Database,
	inv: {
		invite_id: string;
		org_id: string;
		email: string;
		role: Role;
		invited_by: string;
		brain_id?: string;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO invitations
			   (invite_id, org_id, email, role, invited_by, token_hash, invited_at, expires_at, brain_id)
			 VALUES (?1, ?2, ?3, ?4, ?5, '', datetime('now'), datetime('now', '+30 days'), ?6)`
		)
		.bind(inv.invite_id, inv.org_id, inv.email, inv.role, inv.invited_by, inv.brain_id ?? null)
		.run();
}

// The pending brain invite for an address, if any. What share_brain reports as
// "invited, not yet signed in", and what `access: 'none'` cancels.
export async function getPendingBrainInvite(
	db: D1Database,
	brainId: string,
	email: string
): Promise<{ invite_id: string; role: Role } | null> {
	const row = await db
		.prepare(
			`SELECT invite_id, role FROM invitations
			  WHERE brain_id = ?1 AND lower(email) = lower(?2)
			    AND accepted_at IS NULL AND expires_at > datetime('now')
			  ORDER BY rowid DESC LIMIT 1`
		)
		.bind(brainId, email)
		.first<{ invite_id: string; role: string }>();
	return row ? { invite_id: row.invite_id, role: row.role as Role } : null;
}

// Cancel every pending brain invite for an address. A revoke that only deleted the
// grant would leave the invite to be claimed on the guest's first sign-in.
export async function cancelBrainInvites(
	db: D1Database,
	brainId: string,
	email: string
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM invitations
			  WHERE brain_id = ?1 AND lower(email) = lower(?2) AND accepted_at IS NULL`
		)
		.bind(brainId, email)
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
	via: 'grant' | 'org' | 'org-admin' | 'guest';
	granted_at?: string;
}

// Everyone who can reach a brain, and at what role. Two candidate pools, each
// admitted through the same pure rule the read path uses: every org member plus
// their grant, then every grant holder who is NOT a member (a guest). `guest` is
// derived here rather than stored on the row: the same grant reads `grant` the
// day its holder joins the organization, and a stored flag would say otherwise.
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
			org_role: string | null;
			grant_role: string | null;
			granted_at: string | null;
		}>();
	const { results: guests } = await db
		.prepare(
			`SELECT u.user_id AS user_id, u.email AS email, u.name AS name,
			        NULL AS org_role, bm.role AS grant_role, bm.granted_at AS granted_at
			   FROM brain_memberships bm
			   JOIN app_users u ON u.user_id = bm.user_id
			   LEFT JOIN memberships m ON m.org_id = ?2 AND m.user_id = bm.user_id
			  WHERE bm.brain_id = ?1 AND m.user_id IS NULL
			  ORDER BY bm.granted_at ASC, u.email ASC`
		)
		.bind(brainId, orgId)
		.all<{
			user_id: string;
			email: string;
			name: string | null;
			org_role: null;
			grant_role: string;
			granted_at: string | null;
		}>();
	const out: BrainAccessEntry[] = [];
	for (const r of [...(results ?? []), ...(guests ?? [])]) {
		const orgRole = r.org_role as Role | null;
		const grant = r.grant_role as Role | null;
		const role = effectiveBrainRole({ visibility, orgRole, grant });
		if (!role) continue;
		const via = accessVia({ visibility, orgRole, grant });
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
// A brain's display name. NULL clears it, so the label falls back to the repo.
export async function setBrainName(
	db: D1Database,
	brainId: string,
	name: string | null
): Promise<void> {
	await db.prepare(`UPDATE brains SET name = ?2 WHERE brain_id = ?1`).bind(brainId, name).run();
}

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
// The set of brains one PERSON can reach. Takes a SET of user_ids (a person's linked
// identities, from linkedUserIds), so the result is the union of their brains across
// every email. Each brain carries the caller's role on it and in its org (you can be
// owner of one and viewer of another) and the installation that reaches its storage,
// so the caller can mint a per-brain token. `id` is the canonical "owner/repo" key:
// the same id the content index uses (brainId) and what the tools/app pass as the
// `brain` handle.

export interface AccessibleBrain {
	id: string; // "owner/repo" — canonical brainId, tool/app-facing handle
	brain_id: string; // brains PK
	org_id: string;
	org_name: string;
	org_model: string; // 'platform' | 'customer' | 'hosted'
	// The installation that reads and writes THIS brain: its storage binding's, or,
	// for a brain with no binding yet, its org's. A brain moved between orgs keeps
	// the credential its storage is reachable by, so this is not the org's.
	installation_id: number;
	// The provider account holding the brain (its connection's), for saying where a
	// brain is stored without implying that the org it belongs to holds it.
	storage_account: string;
	// Its storage binding; null for a brain written before bindings existed.
	storage_connection_id: string | null;
	// The binding's connection kind (storage-connections.ts), which decides whether a
	// token or an installation reads it: see credentialFor. Null with no binding.
	storage_kind?: string | null;
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
	// NULL when the caller holds no membership in the organization that owns this
	// brain. Every consumer that gates on this has to read a null as "not a member",
	// never as "no gate".
	org_role: Role | null;
	visibility: string; // 'org' | 'private'
	// Readable, never writable, by anyone including the admins of the org holding it.
	// The cap lives in effectiveBrainRole; this is only the flag.
	read_only?: boolean;
}

// A human label for a brain: what the switcher shows and what fuzzy `brain` matches
// against. ONE RULE: a brain is called what it is named (brains.name), and an unnamed
// one is called after its repo (minus a `brain-` prefix). No org prefix and no
// org-derived name: a label that depended on a brain's siblings would silently rename
// the first brain when a second was added. Surfaces that show brains side by side
// group them under an org heading (app/core/util groupBrainsByOrg), which is where the
// org belongs.
// Structurally typed rather than taking AccessibleBrain, so the plain `brains` row
// (Brain) gets the same label as the resolved one; this is the single place a brain's
// display name is decided.
export function brainLabel(b: { name?: string | null; repo_name: string }): string {
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

// The same rule as orgDisplay over an `Org` row rather than a brain's flattened copy
// of it, for the surfaces that name an org with no brain in hand: the `org` argument's
// "which of these did you mean" list, chiefly, where a brainless org is the whole point.
export function orgLabel(org: Org): string {
	if (org.model === 'platform') return 'Personal';
	return org.name?.trim() || org.brain_owner;
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
//
// Two legs, one per way in. The first walks memberships (every brain in every org
// you belong to, with whatever grant you hold under that same identity). The
// second walks GRANTS, which is how a guest reaches a brain in an organization they
// are not a member of (a memberships-only walk produces no row for them). Each leg is driven by its
// own user index; the dedupe below folds a brain reached by both, or by two linked
// identities, to the highest of each role. A guest's org_role is null, and the rule
// caps them.
export async function listAccessibleBrains(
	db: D1Database,
	userIds: string[]
): Promise<AccessibleBrain[]> {
	if (userIds.length === 0) return [];
	const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
	const columns = `b.brain_id AS brain_id, b.repo_owner AS repo_owner, b.repo_name AS repo_name,
			        b.name AS name, b.visibility AS visibility, b.org_id AS org_id,
			        o.name AS org_name, o.model AS org_model,
			        COALESCE(CAST(c.external_id AS INTEGER), o.installation_id) AS installation_id,
			        c.account AS storage_account, b.storage_connection_id AS storage_connection_id,
			        c.kind AS storage_kind,
			        m.role AS org_role,
			        bm.role AS grant_role, b.created_at AS created_at,
			        b.read_only AS read_only`;
	const { results } = await db
		.prepare(
			`SELECT ${columns}
			   FROM memberships m
			   JOIN orgs o   ON o.org_id = m.org_id
			   JOIN brains b ON b.org_id = o.org_id
			   LEFT JOIN storage_connections c ON c.connection_id = b.storage_connection_id
			   LEFT JOIN brain_memberships bm
			          ON bm.brain_id = b.brain_id AND bm.user_id = m.user_id
			  WHERE m.user_id IN (${placeholders})
			    AND o.suspended_at IS NULL
			    AND b.archived_at IS NULL
			 UNION ALL
			 SELECT ${columns}
			   FROM brain_memberships bm
			   JOIN brains b ON b.brain_id = bm.brain_id
			   JOIN orgs o   ON o.org_id = b.org_id
			   LEFT JOIN storage_connections c ON c.connection_id = b.storage_connection_id
			   LEFT JOIN memberships m
			          ON m.org_id = b.org_id AND m.user_id IN (${placeholders})
			  WHERE bm.user_id IN (${placeholders})
			    AND o.suspended_at IS NULL
			    AND b.archived_at IS NULL
			  ORDER BY created_at ASC, brain_id ASC`
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
			storage_account: string | null;
			storage_connection_id: string | null;
			storage_kind: string | null;
			org_role: string | null;
			grant_role: string | null;
			read_only: number | null;
		}>();

	const byId = new Map<string, AccessibleBrain>();
	for (const r of results ?? []) {
		const id = `${r.repo_owner}/${r.repo_name}`;
		const orgRole = r.org_role as Role | null;
		const role = effectiveBrainRole({
			visibility: r.visibility,
			orgRole,
			grant: r.grant_role as Role | null,
			readOnly: !!r.read_only
		});
		if (!role) continue; // private brain, no grant, not an org admin: invisible.
		const existing = byId.get(id);
		if (existing) {
			// Same brain reached via two legs or two linked identities: keep the higher
			// of each. A null org role never overwrites a membership found by the other.
			if (roleAtLeast(role, existing.role)) existing.role = role;
			if (orgRole && (!existing.org_role || roleAtLeast(orgRole, existing.org_role)))
				existing.org_role = orgRole;
			continue;
		}
		byId.set(id, {
			id,
			brain_id: r.brain_id,
			org_id: r.org_id,
			org_name: r.org_name,
			org_model: r.org_model,
			installation_id: r.installation_id,
			storage_account: r.storage_account ?? r.repo_owner,
			storage_connection_id: r.storage_connection_id,
			storage_kind: r.storage_kind,
			repo_owner: r.repo_owner,
			repo_name: r.repo_name,
			name: r.name,
			role,
			org_role: orgRole,
			visibility: r.visibility,
			read_only: !!r.read_only
		});
	}
	return [...byId.values()];
}

// Every org a PERSON belongs to, with their role in it, INCLUDING orgs that hold no
// brain yet. listAccessibleBrains inner-joins `brains`, so an org whose first repo has
// not been adopted yet produces no row there and is invisible to brain-scope
// resolution. That is right for choosing a brain to act on and wrong for choosing a
// place to PUT one, which is the question create_brain and connect_brain ask: the
// first brain in a newly connected org has to be placeable.
//
// Takes the person's whole id set for the same reason every brain query does: a
// membership that hangs off one linked email has to be reachable from the others.
// Deduped to the HIGHEST role, since two linked identities can be members at different
// roles and the person is one human.
export interface AccessibleOrg {
	org: Org;
	role: Role;
}

export async function listAccessibleOrgs(
	db: D1Database,
	userIds: string[]
): Promise<AccessibleOrg[]> {
	if (userIds.length === 0) return [];
	const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT m.role AS role, o.*
			   FROM memberships m
			   JOIN orgs o ON o.org_id = m.org_id
			  WHERE m.user_id IN (${placeholders})
			    AND o.suspended_at IS NULL
			  ORDER BY o.created_at ASC, o.org_id ASC`
		)
		.bind(...userIds)
		.all<Record<string, unknown>>();
	const byId = new Map<string, AccessibleOrg>();
	for (const row of results ?? []) {
		const { role, ...rest } = row;
		const org = rest as unknown as Org;
		const seen = byId.get(org.org_id);
		if (!seen) byId.set(org.org_id, { org, role: role as Role });
		else if (roleAtLeast(role as Role, seen.role)) seen.role = role as Role;
	}
	return [...byId.values()];
}

// Resolve a caller-supplied `org` handle against the orgs they belong to. Same shape
// and same priority order as matchBrain: exact handle first, then a case-insensitive
// substring, returning { candidates } when ambiguous so the tool can ask rather than
// guess which organization to write into. The GitHub owner is a handle too, because
// that is the name a user reading github.com has in front of them.
export function matchOrg(
	orgs: AccessibleOrg[],
	query: string
): { org?: AccessibleOrg; candidates?: AccessibleOrg[] } {
	const q = query.trim().toLowerCase();
	if (!q) return {};
	const handles = (o: AccessibleOrg) =>
		[o.org.org_id, o.org.name, o.org.github_org_login ?? '', o.org.brain_owner]
			.filter(Boolean)
			.map((s) => s.toLowerCase());
	const exact = orgs.find((o) => handles(o).includes(q));
	if (exact) return { org: exact };
	const subs = orgs.filter((o) => handles(o).some((h) => h.includes(q)));
	if (subs.length === 1) return { org: subs[0] };
	if (subs.length > 1) return { candidates: subs };
	return {};
}

// A suspended org the person belongs to. Exists only to tell "you have no org yet"
// apart from "your org is suspended", which listAccessibleOrgs cannot answer because
// it drops suspended rows. That filter is right for choosing an org to act in and
// dangerous at the empty case: without this, a member of one suspended org looks
// brand new and gets auto-provisioned a fresh personal org instead of being told why
// theirs stopped working.
export async function firstSuspendedOrg(db: D1Database, userIds: string[]): Promise<Org | null> {
	if (userIds.length === 0) return null;
	const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
	return await db
		.prepare(
			`SELECT o.*
			   FROM memberships m
			   JOIN orgs o ON o.org_id = m.org_id
			  WHERE m.user_id IN (${placeholders})
			    AND o.suspended_at IS NOT NULL
			  ORDER BY o.created_at ASC, o.org_id ASC
			  LIMIT 1`
		)
		.bind(...userIds)
		.first<Org>();
}

// Which org an org-scope action lands in. Pure, and split out of the Worker's
// orgContext so the rule can be tested: it decides where a new brain gets WRITTEN, so
// the pick must be deterministic for a person in several orgs.
//
// A named handle wins; failing that the org the caller is already working in; failing
// that the oldest. Throws rather than guessing when a handle matches nothing or several
// things, because the cost of guessing is a brain created in the wrong organization.
export function chooseOrg(
	orgs: AccessibleOrg[],
	opts: { org?: string; activeOrgId?: string } = {}
): AccessibleOrg {
	if (orgs.length === 0) throw new Error('You do not belong to any organization yet.');
	if (opts.org) {
		const m = matchOrg(orgs, opts.org);
		if (m.org) return m.org;
		const names = (m.candidates ?? orgs).map((o) => orgLabel(o.org));
		throw new Error(
			m.candidates
				? `"${opts.org}" matches several organizations: ${names.join(', ')}. Be more specific.`
				: `No organization matching "${opts.org}". You belong to: ${names.join(', ')}.`
		);
	}
	return orgs.find((o) => o.org.org_id === opts.activeOrgId) ?? orgs[0];
}

// Which brain a brain-scope call acts on. The twin of chooseOrg above, with the same
// ladder (named handle, then the brain the caller is working in, then the oldest),
// pure so the decision routing every read and write is testable.
//
// Throws rather than guessing for the same reason chooseOrg does: a handle matching
// several brains that silently picked one would act on a brain the caller did not
// name. A BLANK handle throws too: a caller who passed `brain` asked for a specific
// one, and falling back to a different brain is the same failure. Callers resolve the empty-list case before reaching here (it means
// provision, not fail), but throwing is still the right answer if one does not.
export function chooseBrain(
	brains: AccessibleBrain[],
	opts: { brain?: string; activeBrainId?: string } = {}
): AccessibleBrain {
	if (brains.length === 0) throw new Error('You do not have access to any brain yet.');
	if (opts.brain) {
		const m = matchBrain(brains, opts.brain);
		if (m.brain) return m.brain;
		const names = (m.candidates ?? brains).map(brainLabelQualified);
		throw new Error(
			m.candidates
				? `"${opts.brain}" matches multiple brains: ${names.join(', ')}. Be more specific.`
				: `No brain matching "${opts.brain}". You have access to: ${names.join(', ')}.`
		);
	}
	return brains.find((b) => b.id === opts.activeBrainId) ?? brains[0];
}

// The whole org-selection decision for a person, in one function a test can drive
// against a real database. The Worker's orgContext wraps this with token minting and
// first-touch provisioning; keeping the decision here is what makes the empty case
// testable, and the empty case is where the subtle bug lives (see firstSuspendedOrg).
//
// Returns null ONLY for a person with no membership anywhere, which is the caller's
// signal to provision. Every other failure throws with a caller-facing message.
//
// `activeOrgId` is a THUNK, not a value: resolving where the caller is working costs a
// query, and it is pointless when a handle was named or there is only one org. The
// caller should not have to know that, so the skipping decision lives here.
export async function resolveOrgForPerson(
	db: D1Database,
	userIds: string[],
	opts: { org?: string; activeOrgId?: () => Promise<string | undefined> } = {}
): Promise<AccessibleOrg | null> {
	const orgs = await listAccessibleOrgs(db, userIds);
	if (orgs.length === 0) {
		const suspended = await firstSuspendedOrg(db, userIds);
		if (suspended) throw new Error(`Org ${suspended.org_id} is suspended. Contact your admin.`);
		return null;
	}
	const activeOrgId = !opts.org && orgs.length > 1 ? await opts.activeOrgId?.() : undefined;
	return chooseOrg(orgs, { org: opts.org, activeOrgId });
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
		// org_name is matched EXPLICITLY, so an org-qualified handle (`brain: "acme"`
		// for a brain in the Acme org) resolves even though the label carries no org.
		// How a brain is DISPLAYED and what a human can call it are separate questions.
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
