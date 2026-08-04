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
	getPendingInviteByEmail,
	acceptInvite,
	type OrgContext
} from './orgs.ts';

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

// ---------- Product-identity (Auth.js) provisioning ----------

export interface ProvisionOrgInput {
	octokit: Octokit;
	db: D1Database;
	// The Auth.js user this org is being provisioned for.
	user: { user_id: string; email: string; name?: string | null };
	// The platform org all Model-A brains are created under, and its installation.
	org: string;
	installationId: number;
}

// Brain repo name for a product-identity user. GitHub logins aren't available
// (these users may have no GitHub account), so derive a slug from the email
// local-part; fall back to the user id if that empties out.
export function brainRepoNameForEmail(email: string, userId: string): string {
	const local = email.split('@')[0] ?? '';
	const slug = local
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug ? `brain-${slug}` : `brain-${userId.slice(0, 8)}`;
}

// First-touch provisioning for a product-identity user: create a Model-A org
// (platform-owned) with an owner membership and one scaffolded brain under the
// platform org. The authjs analog of provisionBrainForUser. Idempotent: an
// existing membership short-circuits, and a repo-name collision adopts the
// existing repo (mirrors the GitHub-path race handling above).
export async function provisionOrgForUser(input: ProvisionOrgInput): Promise<OrgContext> {
	const { db, user, org, installationId } = input;

	// Idempotent short-circuit: user already has an org with a brain.
	const existing = await getMembershipWithOrg(db, user.user_id);
	if (existing) {
		const brain = await getDefaultBrainForUser(
			db,
			existing.org.org_id,
			user.user_id,
			existing.role
		);
		if (brain) return { org: existing.org, brain, role: existing.role };
	}

	await upsertAppUser(db, {
		user_id: user.user_id,
		email: user.email,
		name: user.name ?? null
	});

	// An admin may have pre-invited this email to a specific org (e.g. a customer
	// Model-B org with its own adopted brain). If so, join THAT org at the invited
	// role rather than minting a personal Model-A brain — this is how members with
	// no GitHub account land in the right org on their very first sign-in.
	if (!existing) {
		const invite = await getPendingInviteByEmail(db, user.email);
		if (invite) {
			await addMembership(db, {
				org_id: invite.org_id,
				user_id: user.user_id,
				role: invite.role
			});
			await acceptInvite(db, invite.invite_id);
			const membership = await getMembershipWithOrg(db, user.user_id);
			const brain = membership
				? await getDefaultBrainForUser(db, membership.org.org_id, user.user_id, membership.role)
				: null;
			if (membership && brain) return { org: membership.org, brain, role: membership.role };
			// No brain to land in. Minting a platform brain under a customer org would
			// be wrong, so surface a clear error, but say WHICH problem it is. Since
			// brains are private by default, "the org has no brain at all" and "the org
			// has brains and none are shared with you" need different fixes from the
			// admin, and telling an admin to "finish setup" on an org that is already
			// set up sends them looking in the wrong place.
			const orgHasAnyBrain = membership ? await getAnyBrainInOrg(db, membership.org.org_id) : null;
			throw new Error(
				orgHasAnyBrain
					? 'You were invited to an organization, but none of its brains have been shared with you yet. Ask your admin to share one (they can run share_brain, or use the Share panel on the brain).'
					: 'You were invited to an organization, but it has no brain configured yet. Ask your admin to finish setup.'
			);
		}
	}

	// Reuse the existing org if the user already had a membership (brain missing);
	// otherwise mint a fresh platform-model org with the user as owner. NO brain is
	// created here — as of Phase 8 (brain-creation-and-init) brains are stood up
	// EXPLICITLY (create_brain / the Add-a-brain flow), never auto-provisioned. First
	// touch lands the user in their empty personal org; getDefaultBrainForUser returns null
	// until they create one, and callers render the "create your first brain" state.
	const orgId = existing?.org.org_id ?? crypto.randomUUID();
	if (!existing) {
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
	}

	const membership = await getMembershipWithOrg(db, user.user_id);
	if (!membership) {
		throw new Error(`Provisioned org ${orgId} for ${user.email} but membership did not persist.`);
	}
	// null until a brain is created: and, for a pre-existing org, null also when
	// every brain in it is private and none has been shared with this user.
	const brain = await getDefaultBrainForUser(db, orgId, user.user_id, membership.role);
	return { org: membership.org, brain, role: membership.role };
}
