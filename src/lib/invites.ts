// Claiming pending invitations: turning an `invitations` row into a membership,
// or, for an invite that names a brain, into a grant on that one brain (a guest;
// docs/design/guest-access.md).
//
// An invite names an EMAIL, and a person can hold several verified addresses
// (see linkedUserIds / mergePersons in orgs.ts). So claiming is keyed on the set
// of app_users rows a person owns, and the membership lands on the user_id whose
// address was actually invited.
//
// This runs wherever an address has just been proven, and on every request that
// resolves a person: the alternative is an invite that only ever applies to a
// brand-new signed-in user, which is what issue #69 reported.
//
// Worker-safe (no node:* imports).

import type { D1Database } from '@cloudflare/workers-types';
import { addMembership, acceptInvite, roleAtLeast, setBrainGrant, type Role } from './orgs.ts';

// A pending invite already matched to one of the person's verified addresses.
export interface MatchedInvite {
	invite_id: string;
	org_id: string;
	role: Role;
	// The app_user whose email the invitation names.
	user_id: string;
	// Set on a BRAIN invite: the claim is a grant on this brain, never a membership.
	brain_id?: string | null;
}

export interface InviteClaim {
	invite_id: string;
	org_id: string;
	user_id: string;
	role: Role;
	// False when the person already belongs to that org: the invite is still
	// marked accepted, but no membership row is written.
	joins: boolean;
	// A brain invite: the brain a grant is written on. `joins` is always false.
	brain_id?: string;
	// False when the person already holds a grant on that brain: the invite is
	// still marked accepted, but the grant is left as it is.
	grants: boolean;
}

// Decide what a set of matched invites does to a person who already belongs to
// `memberOrgIds`. Pure, so the rules below are pinned by pnpm test:invites.
//
//   - Every matched invite is accepted. An invite whose org the person is
//     already in has done its job, and leaving it pending shows the admin a
//     roster entry that looks like it was never opened.
//   - An existing membership is never rewritten. The invited role is what the
//     admin wanted at invite time; the membership row is what they want NOW, and
//     a stale invite must not silently demote someone.
//   - Several invites to one org collapse to a single join at the highest role
//     invited, so re-inviting at a higher role before the first is claimed does
//     not depend on which row is read last.
//   - A BRAIN invite never joins an org. It grants on its brain under the same
//     three rules, keyed on `grantedBrainIds` instead: an existing grant is never
//     rewritten, and several invites to one brain collapse to one grant.
export function planInviteClaims(
	invites: MatchedInvite[],
	memberOrgIds: Iterable<string>,
	grantedBrainIds: Iterable<string> = []
): InviteClaim[] {
	const alreadyIn = new Set(memberOrgIds);
	const alreadyGranted = new Set(grantedBrainIds);
	// org_id → the invite that will carry the join; brain_id → the one carrying the grant.
	const joinFor = new Map<string, MatchedInvite>();
	const grantFor = new Map<string, MatchedInvite>();
	for (const inv of invites) {
		if (inv.brain_id) {
			if (alreadyGranted.has(inv.brain_id)) continue;
			const best = grantFor.get(inv.brain_id);
			if (!best || !roleAtLeast(best.role, inv.role)) grantFor.set(inv.brain_id, inv);
			continue;
		}
		if (alreadyIn.has(inv.org_id)) continue;
		const best = joinFor.get(inv.org_id);
		// Strictly higher only, so a tie keeps the earlier row: input order decides.
		if (!best || !roleAtLeast(best.role, inv.role)) joinFor.set(inv.org_id, inv);
	}
	return invites.map((inv) => ({
		invite_id: inv.invite_id,
		org_id: inv.org_id,
		user_id: inv.user_id,
		role: inv.role,
		joins: !inv.brain_id && joinFor.get(inv.org_id) === inv,
		...(inv.brain_id ? { brain_id: inv.brain_id } : {}),
		grants: !!inv.brain_id && grantFor.get(inv.brain_id) === inv
	}));
}

function placeholders(n: number): string {
	return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ');
}

// Every pending, unexpired invitation addressed to any of this person's verified
// addresses. Case-insensitive, because an invite is typed by a human and the
// address is projected from the identity provider.
export async function findPendingInvites(
	db: D1Database,
	userIds: string[]
): Promise<MatchedInvite[]> {
	if (userIds.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT i.invite_id AS invite_id, i.org_id AS org_id, i.role AS role, u.user_id AS user_id,
              i.brain_id AS brain_id
         FROM invitations i
         JOIN app_users u ON lower(u.email) = lower(i.email)
        WHERE u.user_id IN (${placeholders(userIds.length)})
          AND i.accepted_at IS NULL
          AND i.expires_at > datetime('now')
        ORDER BY i.rowid ASC`
		)
		.bind(...userIds)
		.all<{
			invite_id: string;
			org_id: string;
			role: string;
			user_id: string;
			brain_id: string | null;
		}>();
	return (results ?? []).map((r) => ({
		invite_id: r.invite_id,
		org_id: r.org_id,
		role: r.role as Role,
		user_id: r.user_id,
		brain_id: r.brain_id
	}));
}

// Join every org this person has been invited to, take every brain grant they have
// been invited to, and mark those invites accepted. Idempotent: a second call
// finds nothing pending and writes nothing.
//
// The common case is no pending invite at all, which costs one indexed SELECT
// that returns no rows; the membership and grant lookups and the writes only
// happen when there is something to claim.
export async function claimPendingInvites(
	db: D1Database,
	userIds: string[]
): Promise<InviteClaim[]> {
	const invites = await findPendingInvites(db, userIds);
	if (invites.length === 0) return [];

	const { results } = await db
		.prepare(
			`SELECT DISTINCT org_id FROM memberships WHERE user_id IN (${placeholders(userIds.length)})`
		)
		.bind(...userIds)
		.all<{ org_id: string }>();
	const { results: grants } = await db
		.prepare(
			`SELECT DISTINCT brain_id FROM brain_memberships WHERE user_id IN (${placeholders(userIds.length)})`
		)
		.bind(...userIds)
		.all<{ brain_id: string }>();

	const claims = planInviteClaims(
		invites,
		(results ?? []).map((r) => r.org_id),
		(grants ?? []).map((r) => r.brain_id)
	);
	for (const c of claims) {
		if (c.joins) {
			await addMembership(db, { org_id: c.org_id, user_id: c.user_id, role: c.role });
		}
		if (c.grants && c.brain_id) {
			await setBrainGrant(db, { brain_id: c.brain_id, user_id: c.user_id, role: c.role });
		}
		await acceptInvite(db, c.invite_id);
	}
	return claims;
}
