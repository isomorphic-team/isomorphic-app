// create_org: starting an organization, in product.
//
// Two kinds, one verb (docs/design/storage-and-tenancy.md):
//
// - HOSTED (the default). A named team org whose brains live on the platform's own
//   storage, for a team that does not use GitHub. Created on the spot, with the
//   caller as owner. Gated on AUTO_PROVISION, the flag that already lets anyone who
//   signs in get a personal org on that storage: an invite-only deployment must not
//   let any signed-in user mint orgs on it.
//
// - CUSTOMER (`github: true`). The caller's own GitHub organization. Nothing is
//   created here: the tool stashes the caller (and the name they chose) under
//   `pending_org_connect:<state>` and returns a GitHub App install URL carrying the
//   state. Installing redirects to `/github/install-callback`, which resolves the
//   installation and writes the org + owner membership (src/lib/org-connect.ts).
//   Ownership is proven by the install, the same "the redirect carries verified
//   state" trust chain as link_identity.
//
// This replaced `connect_github_org`, which could only do the second. Kept in its
// own module (not brains.ts) so it composes with, but does not tangle into, the
// multi-brain tool surface.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AccessibleOrg, OrgScope, Role } from '../lib/orgs.ts';
import { createHostedOrg, orgNameProblem } from '../lib/org-connect.ts';
import { platformInstall } from '../lib/provision.ts';
import { fail } from './shared.ts';

// The Worker Env bits this tool needs. A tool handler has no request context, so the
// App slug for the install URL and the platform installation come from here.
export interface OrgOnboardingEnv {
	// Structural rather than KVNamespace, which is a Workers ambient type the test
	// tsconfig does not load; the one call made is a put.
	OAUTH_KV: {
		put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	};
	GITHUB_APP_SLUG?: string;
	AUTO_PROVISION?: string;
	PLATFORM_ORG?: string;
	PLATFORM_INSTALLATION_ID?: string;
}

export function registerOrgOnboardingTools(
	server: McpServer,
	// Org-scoped (brain-less) context, like create_brain: starting an org must work
	// for a first-touch user who has no brain yet, where tenantContext would throw
	// NoBrainError before the tool could run.
	orgContext: (opts?: { requires?: Role }) => Promise<OrgScope>,
	// The orgs the caller already belongs to, for the duplicate-name rule.
	listOrgs: () => Promise<AccessibleOrg[]>,
	env: OrgOnboardingEnv
) {
	// The description names "connect GitHub" in its own words: this used to be
	// connect_github_org, and a model that learned that name will search for it.
	server.registerTool(
		'create_org',
		{
			title: 'Create an organization',
			description:
				"Create a new organization (a team, company or client) on Isomorphic, with the user as its owner. By default its brains are stored on Isomorphic, so nobody needs GitHub: use this for a new team or client org, then create_brain to start a brain in it, or update_brain to move an existing brain in. Pass `github: true` to connect the user's own GitHub organization instead (formerly connect_github_org): that returns a link to install the Isomorphic app on their GitHub org, installing creates the org, and connect_brain then adopts a repo as a brain. Product (email/SSO) sign-ins only.",
			inputSchema: z.object({
				name: z.string().describe('What to call the organization, e.g. "Acme Corp".'),
				github: z
					.boolean()
					.optional()
					.describe(
						"Connect the user's own GitHub organization rather than storing brains on Isomorphic."
					)
			})
		},
		async ({ name, github }) => {
			// orgContext() rejects non-product (single-tenant) connections with a clear
			// message, and guarantees actorUserId for everyone else.
			let ctx: OrgScope;
			try {
				ctx = await orgContext();
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
			if (!ctx.actorUserId) return fail('Creating an organization needs a signed-in account.');
			const problem = orgNameProblem(name, await listOrgs());
			if (problem) return fail(problem);
			const display = name.trim();

			if (github) {
				const slug = env.GITHUB_APP_SLUG;
				if (!slug) {
					return fail(
						'Connecting a GitHub organization is not configured on this server (missing GITHUB_APP_SLUG).'
					);
				}
				const state = crypto.randomUUID();
				await env.OAUTH_KV.put(
					`pending_org_connect:${state}`,
					JSON.stringify({
						user_id: ctx.actorUserId,
						email: ctx.author?.email ?? null,
						name: display
					}),
					{ expirationTtl: 3600 }
				);
				const url = `https://github.com/apps/${slug}/installations/new?state=${state}`;
				return {
					content: [
						{
							type: 'text' as const,
							text:
								`Open this link and install Isomorphic on your GitHub organization, selecting the repositories you want to use as brains:\n\n${url}\n\n` +
								`Installing creates "${display}" here, with you as its owner. When you're back, run connect_brain to adopt a repo as its first brain.\n\n` +
								`(The link expires in 1 hour. Install on an Organization, not a personal account: personal accounts can't host new brains.)`
						}
					],
					structuredContent: { connect: { url } }
				};
			}

			if (env.AUTO_PROVISION !== 'true') {
				return fail(
					'This server does not let members create organizations on its own storage. Ask its administrator, or pass github: true to connect your own GitHub organization.'
				);
			}
			let platform: { org: string; installationId: number };
			try {
				platform = platformInstall(env);
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
			const org = await createHostedOrg(ctx.db, {
				userId: ctx.actorUserId,
				name: display,
				platform
			});
			return {
				content: [
					{
						type: 'text' as const,
						text: `Created "${org.name}", with you as its owner. Its brains are stored on Isomorphic. Start one with create_brain (org: "${org.name}"), or move an existing one in with update_brain (org: "${org.name}").`
					}
				],
				structuredContent: { created: { orgId: org.org_id, orgLabel: org.name } }
			};
		}
	);
}
