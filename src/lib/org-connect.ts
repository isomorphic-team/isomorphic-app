// Model-B customer-org onboarding — the self-serve "connect your GitHub org" path.
//
// The runtime half of what `pnpm onboard-org` does by hand. Flow:
//   1. A signed-in product user runs the `connect_github_org` MCP tool, which
//      stashes them under `pending_org_connect:<state>` in KV and returns a
//      GitHub App install URL carrying that state.
//   2. They install the App on their GitHub org (picking the repos to expose).
//   3. GitHub redirects to the App's Setup URL (`/github/install-callback`) with
//      `installation_id` + our `state`. The Worker resolves the installation's
//      org (App JWT) and calls `connectCustomerOrg` to write the customer org +
//      owner membership — no SQL, no pre-invite.
//   4. The user runs `connect_brain` to adopt a repo as the org's first brain.
//
// Worker-safe (octokit + D1 only, no node:*). Identity rides through KV state,
// not a session cookie, so the install can happen in any browser — the same
// robustness rationale as the /oauth/complete and /link/start bridges.

import type { D1Database } from '@cloudflare/workers-types';
import { appOctokit, type AppCreds } from './github.ts';
import { createOrg, addMembership } from './orgs.ts';

export interface InstallationOrg {
	installationId: number;
	orgLogin: string;
	// 'Organization' | 'User'. A User install can't create repos (no
	// administration:write), so brains must already exist under it.
	accountType: string;
}

// Resolve which GitHub account an installation belongs to, via the App JWT.
export async function resolveInstallationOrg(
	creds: AppCreds,
	installationId: number
): Promise<InstallationOrg> {
	const app = appOctokit(creds);
	const { data } = await app.rest.apps.getInstallation({ installation_id: installationId });
	const account = data.account;
	const orgLogin = account && 'login' in account ? account.login : undefined;
	if (!orgLogin) {
		throw new Error(`Installation ${installationId} has no resolvable account login.`);
	}
	const accountType =
		data.target_type ?? (account && 'type' in account ? account.type : 'Organization');
	return { installationId, orgLogin, accountType };
}

export interface ConnectResult {
	orgId: string;
	orgLogin: string;
	// false = adopted an existing customer org for this installation instead of
	// creating a new one (idempotent re-install / re-run).
	created: boolean;
	// true if the App landed on a personal account, which can't create repos.
	installOnUser: boolean;
}

// Idempotently record a customer (Model-B) org for `userId` from a fresh
// installation, making them its owner. If a customer org already exists for this
// installation, adopt it (ensure the owner membership) rather than duplicate.
// Does NOT create a brain — the owner picks a repo with connect_brain afterward.
//
// Precondition: `userId` already has an app_users row (the caller is a signed-in
// product user). We deliberately don't upsert it here — that would clobber the
// user's real email/name with whatever the callback happens to carry.
export async function connectCustomerOrg(
	db: D1Database,
	input: { userId: string; installationId: number; orgLogin: string; accountType?: string }
): Promise<ConnectResult> {
	const installOnUser = input.accountType === 'User';

	const existing = await db
		.prepare(
			`SELECT org_id, github_org_login FROM orgs WHERE installation_id = ?1 AND model = 'customer' LIMIT 1`
		)
		.bind(input.installationId)
		.first<{ org_id: string; github_org_login: string | null }>();

	if (existing) {
		await addMembership(db, { org_id: existing.org_id, user_id: input.userId, role: 'owner' });
		return {
			orgId: existing.org_id,
			orgLogin: existing.github_org_login ?? input.orgLogin,
			created: false,
			installOnUser
		};
	}

	const orgId = crypto.randomUUID();
	await createOrg(db, {
		org_id: orgId,
		name: input.orgLogin,
		model: 'customer',
		installation_id: input.installationId,
		brain_owner: input.orgLogin,
		github_org_login: input.orgLogin,
		created_by: input.userId
	});
	await addMembership(db, { org_id: orgId, user_id: input.userId, role: 'owner' });
	return { orgId, orgLogin: input.orgLogin, created: true, installOnUser };
}
