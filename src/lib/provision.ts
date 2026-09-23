// First-touch provisioning: what a signed-in person gets on their first request
// when nothing resolves for them yet (`provisionOrgForUser`): claim any pending
// invitation, else mint a personal org (platform-owned) with an owner membership.
// No brain is created here; brains are created explicitly with create_brain. Touches
// no GitHub. The platform org and installation (`platformInstall`) are configured
// once by the admin, so a reader never installs anything or sees GitHub. Idempotent
// and safe to call on every request that finds nothing.

import type { D1Database } from '@cloudflare/workers-types';
import {
	upsertAppUser,
	getMembershipWithOrg,
	getAnyBrainInOrg,
	getDefaultBrainForUser,
	createOrg,
	addMembership,
	roleAtLeast,
	type Role,
	type OrgContext
} from './orgs.ts';
import { claimPendingInvites } from './invites.ts';

// The platform org and its App installation, the only configuration provisioning
// (and create_org's hosted orgs) reads. An id that is not a positive integer is refused here,
// where the message can name the variable, rather than surfacing later as a GitHub
// auth failure.
export interface PlatformInstall {
	org: string;
	installationId: number;
}

export function platformInstall(env: {
	PLATFORM_ORG?: string;
	PLATFORM_INSTALLATION_ID?: string;
}): PlatformInstall {
	const org = (env.PLATFORM_ORG ?? '').trim();
	const raw = (env.PLATFORM_INSTALLATION_ID ?? '').trim();
	if (!org || !raw) {
		throw new Error(
			'AUTO_PROVISION is on but PLATFORM_ORG / PLATFORM_INSTALLATION_ID are not configured. ' +
				'Run admin setup (pnpm bootstrap) to install the platform App on an org.'
		);
	}
	const installationId = Number(raw);
	if (!Number.isInteger(installationId) || installationId <= 0) {
		throw new Error(
			`PLATFORM_INSTALLATION_ID must be a positive whole number (the App installation id), got "${raw}".`
		);
	}
	return { org, installationId };
}

// ---------- Product-identity (Auth.js) provisioning ----------

export interface ProvisionOrgInput {
	db: D1Database;
	// The Auth.js user this org is being provisioned for.
	user: { user_id: string; email: string; name?: string | null };
	// The platform org Model-A orgs are minted against, and its installation.
	// Only needed to MINT one: joining an org by invitation touches neither, which
	// is what lets an invite-only deployment accept invitations at all.
	org?: string;
	installationId?: number;
	// Whether this deployment mints a personal org for a person nobody invited
	// (AUTO_PROVISION). Off means an un-invited person is turned away; it has
	// never meant an invited one is.
	autoProvision?: boolean;
}

// What a member with no reachable brain gets. 'create' is the app's "create your
// first brain" state, which is the right answer for anyone who can actually
// create one: the owner of the personal org a first sign-in mints, and equally an
// editor whose org holds only brains nobody has shared with them.
//
// A VIEWER can create nothing, so that state strands them, and which of two very
// different problems they are looking at is invisible from their side because
// brains are private by default. An org holding no brain at all needs one
// created; an org whose brains are simply not shared with this person needs an
// admin to share one. Telling an admin to "finish setup" on an org that is
// already set up sends them looking in the wrong place.
export function noBrainOutcome(input: {
	role: Role;
	orgHasAnyBrain: boolean;
}): { kind: 'create' } | { kind: 'error'; message: string } {
	if (roleAtLeast(input.role, 'editor')) return { kind: 'create' };
	return {
		kind: 'error',
		message: input.orgHasAnyBrain
			? 'You are a member of an organization, but none of its brains have been shared with you yet. Ask your admin to share one (they can run share_brain, or use the Share panel on the brain).'
			: 'You are a member of an organization, but it has no brain configured yet. Ask your admin to finish setup.'
	};
}

// First-touch resolution for a product-identity user: claim any invitation
// addressed to them, and otherwise mint a personal Model-A org (platform-owned)
// with an owner membership. The authjs analog of provisionBrainForUser. No brain
// is created here: brains are stood up EXPLICITLY (create_brain / the Add-a-brain
// flow). Idempotent, so it is safe on every request that finds no accessible brain.
export async function provisionOrgForUser(input: ProvisionOrgInput): Promise<OrgContext> {
	const { db, user, org, installationId, autoProvision = true } = input;

	await upsertAppUser(db, {
		user_id: user.user_id,
		email: user.email,
		name: user.name ?? null
	});

	// An admin may have pre-invited this address to a specific org (e.g. a customer
	// Model-B org with its own adopted brain). Joining it is how a member with no
	// GitHub account lands in the right org. This runs BEFORE the membership
	// lookup and BEFORE the autoProvision gate: an invitation is not provisioning,
	// and it applies whatever else this person already belongs to.
	await claimPendingInvites(db, [user.user_id]);

	const existing = await getMembershipWithOrg(db, user.user_id);
	if (existing) {
		const brain = await getDefaultBrainForUser(
			db,
			existing.org.org_id,
			user.user_id,
			existing.role
		);
		if (brain) return { org: existing.org, brain, role: existing.role };
		// Minting a platform brain inside someone else's org would be wrong, so say
		// what is actually missing instead.
		const outcome = noBrainOutcome({
			role: existing.role,
			orgHasAnyBrain: !!(await getAnyBrainInOrg(db, existing.org.org_id))
		});
		if (outcome.kind === 'error') throw new Error(outcome.message);
		return { org: existing.org, brain: null, role: existing.role };
	}

	// Nobody invited them and they belong nowhere. Minting a personal org is the
	// only thing left, and it is what AUTO_PROVISION governs.
	if (!autoProvision || !org || installationId === undefined) {
		throw new Error(
			`No org configured for ${user.email} and AUTO_PROVISION is off. An admin must invite you.`
		);
	}

	const orgId = crypto.randomUUID();
	await createOrg(db, {
		org_id: orgId,
		name: user.email,
		model: 'platform',
		installation_id: installationId,
		brain_owner: org,
		github_org_login: null,
		created_by: user.user_id
	});
	await addMembership(db, { org_id: orgId, user_id: user.user_id, role: 'owner' });

	const membership = await getMembershipWithOrg(db, user.user_id);
	if (!membership) {
		throw new Error(`Provisioned org ${orgId} for ${user.email} but membership did not persist.`);
	}
	// null until a brain is created; callers render the "create your first brain" state.
	const brain = await getDefaultBrainForUser(db, orgId, user.user_id, membership.role);
	return { org: membership.org, brain, role: membership.role };
}
