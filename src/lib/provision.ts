// Brain provisioning — the platform-owned path.
//
// The whole point of this module: a reader/creator using the MCP never touches
// GitHub. They sign in via OAuth and, on their first authenticated request, the
// Worker provisions a brain for them automatically — created under a SINGLE
// platform org via a SINGLE platform App installation. No per-user App install,
// no org-vs-user gate, no repo picking.
//
// Contrast with the legacy bootstrap flow, where each user installed the App on
// their own org and the install-callback scaffolded one brain. Here the admin
// installs once (on the platform org); everything else is automatic.
//
// `provisionBrainForUser` is idempotent and safe to call on every request that
// finds no tenant row: an existing tenant short-circuits, and a name collision
// (e.g. a prior partial run) adopts the existing repo instead of failing.

import type { Octokit } from 'octokit';
import type { D1Database } from '@cloudflare/workers-types';
import { createAndScaffoldBrain, scaffoldExistingRepo } from './scaffold-core.ts';
import { getTenantByUserId, upsertTenant, type Tenant } from './tenants.ts';
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

export interface ProvisionInput {
	octokit: Octokit;
	db: D1Database;
	ghUserId: number;
	ghLogin?: string | null;
	// The platform org all brains are created under, and the installation of the
	// platform App on it. Both come from Worker config (PLATFORM_ORG /
	// PLATFORM_INSTALLATION_ID), captured once at admin setup time.
	org: string;
	installationId: number;
}

// Brains share one org, so names must be unique. GitHub logins are unique at a
// point in time, so `brain-<login>` reads well and rarely collides; we key the
// tenant row on the stable gh_user_id regardless, and fall back to the id when
// no login is available.
export function brainRepoName(ghUserId: number, ghLogin?: string | null): string {
	const slug = (ghLogin ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug ? `brain-${slug}` : `brain-${ghUserId}`;
}

function isAlreadyExists(err: unknown): boolean {
	// GitHub returns 422 when a repo with that name already exists on the org.
	return (
		typeof err === 'object' &&
		err !== null &&
		'status' in err &&
		(err as { status: number }).status === 422
	);
}

// Adopt a repo that already exists under the platform org (prior partial run, or
// a concurrent provisioning request that won the create race). Ensure it's
// scaffolded — a repo created with auto_init but not yet scaffolded would lack
// AGENTS.md — then return its coordinates.
async function adoptExistingRepo(
	octokit: Octokit,
	org: string,
	name: string
): Promise<{ owner: string; repo: string }> {
	const { data: repo } = await octokit.rest.repos.get({ owner: org, repo: name });

	let hasScaffold = true;
	try {
		await octokit.rest.repos.getContent({ owner: org, repo: name, path: 'AGENTS.md' });
	} catch (err) {
		if (
			typeof err === 'object' &&
			err !== null &&
			'status' in err &&
			(err as { status: number }).status === 404
		) {
			hasScaffold = false;
		} else {
			throw err;
		}
	}

	if (!hasScaffold) {
		await scaffoldExistingRepo(octokit, {
			owner: repo.owner.login,
			repo: repo.name,
			branch: repo.default_branch
		});
	}

	return { owner: repo.owner.login, repo: repo.name };
}

export async function provisionBrainForUser(input: ProvisionInput): Promise<Tenant> {
	const { octokit, db, ghUserId, ghLogin, org, installationId } = input;

	// Idempotent short-circuit: someone already provisioned this user.
	const existing = await getTenantByUserId(db, ghUserId);
	if (existing) return existing;

	const name = brainRepoName(ghUserId, ghLogin);

	let owner: string;
	let repo: string;
	try {
		const brain = await createAndScaffoldBrain(octokit, {
			org,
			name,
			description: `Brain for ${ghLogin ?? ghUserId} — LLM-maintained knowledge base`
		});
		owner = brain.owner;
		repo = brain.name;
	} catch (err) {
		if (!isAlreadyExists(err)) throw err;
		// Repo already there — adopt it rather than fail. Covers retries after a
		// crash between repo-create and tenant-upsert, and concurrent first calls.
		({ owner, repo } = await adoptExistingRepo(octokit, org, name));
	}

	await upsertTenant(db, {
		gh_user_id: ghUserId,
		installation_id: installationId,
		brain_owner: owner,
		brain_repo: repo,
		gh_login: ghLogin ?? null
	});

	// Re-read so callers get the full row (timestamps, suspended_at, etc.) exactly
	// as the MCP read path would resolve it.
	const tenant = await getTenantByUserId(db, ghUserId);
	if (!tenant) {
		// Should be impossible — we just upserted. Surface loudly if D1 lied.
		throw new Error(`Provisioned brain for gh_user_id=${ghUserId} but tenant row did not persist.`);
	}
	return tenant;
}

// The platform org and its App installation, which is what both provisioning
// paths need and the only configuration either of them reads. The two call sites
// in the Worker each did this inline and threw the same sentence, and the copies
// had already drifted on the one thing that matters: the GitHub path coerced the
// id with Number() unconditionally, so a non-numeric value arrived at
// provisionBrainForUser as NaN and surfaced later as a GitHub auth failure rather
// than as the config mistake it is. An id that is not a positive integer is
// refused here, where the message can name the variable.
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
// is created here: as of Phase 8 (brain-creation-and-init) brains are stood up
// EXPLICITLY (create_brain / the Add-a-brain flow). Idempotent, so it is safe on
// every request that finds no accessible brain.
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
	// and it applies whatever else this person already belongs to (issue #69).
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
