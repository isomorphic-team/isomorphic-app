// Creating an organization, in product. Two kinds (docs/design/storage-and-tenancy.md):
//
// HOSTED: `createHostedOrg`. A named team org whose brains live on the platform's
// own installation, for a team with no GitHub. Written directly: nothing to install.
//
// CUSTOMER (Model B): the "connect your GitHub org" path, the runtime half of what
// `pnpm onboard-org` does by hand. Flow:
//   1. A signed-in product user runs `create_org` with `github: true`, which
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
import { type AccessibleOrg, type Org, createOrg, addMembership, getOrgById } from './orgs.ts';
import { ensureOrgConnection } from './storage-connections.ts';

export const MAX_ORG_NAME = 80;

// Why a name cannot be used for a new org, or null when it can. Pure. A duplicate
// among the caller's OWN orgs is refused because every `org` argument (create_brain,
// connect_brain) is resolved by name: two orgs one person belongs to
// under one name would make the second unreachable by the name they chose.
export function orgNameProblem(name: string, mine: AccessibleOrg[]): string | null {
	const n = name.trim();
	if (!n) return 'Please give the organization a name.';
	if (n.length > MAX_ORG_NAME) return `Organization names are at most ${MAX_ORG_NAME} characters.`;
	if (mine.some((o) => o.org.name.trim().toLowerCase() === n.toLowerCase()))
		return `You already belong to an organization called "${n}".`;
	return null;
}

// A hosted org, with its creator as owner. The connection is the platform's, which
// no org owns, so it can create brains there and never list or adopt through it.
export async function createHostedOrg(
	db: D1Database,
	input: { userId: string; name: string; platform: { org: string; installationId: number } }
): Promise<Org> {
	const orgId = crypto.randomUUID();
	await createOrg(db, {
		org_id: orgId,
		name: input.name.trim(),
		model: 'hosted',
		installation_id: input.platform.installationId,
		brain_owner: input.platform.org,
		github_org_login: null,
		created_by: input.userId
	});
	await addMembership(db, { org_id: orgId, user_id: input.userId, role: 'owner' });
	const org = (await getOrgById(db, orgId))!;
	await ensureOrgConnection(db, org);
	return org;
}

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
	input: {
		userId: string;
		installationId: number;
		orgLogin: string;
		accountType?: string;
		// What the user called it in create_org. Defaults to the GitHub login.
		name?: string | null;
	}
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
		name: input.name?.trim() || input.orgLogin,
		model: 'customer',
		installation_id: input.installationId,
		brain_owner: input.orgLogin,
		github_org_login: input.orgLogin,
		created_by: input.userId
	});
	await addMembership(db, { org_id: orgId, user_id: input.userId, role: 'owner' });
	const org = await getOrgById(db, orgId);
	if (org) await ensureOrgConnection(db, org);
	return { orgId, orgLogin: input.orgLogin, created: true, installOnUser };
}
