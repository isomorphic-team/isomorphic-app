// Org-onboarding tool — the self-serve "connect your GitHub org" entry point.
//
// `connect_github_org` is the runtime analog of `pnpm onboard-org`: instead of an
// operator hand-seeding a customer org, a signed-in product user starts it
// themselves. The tool does NOT create anything by itself — it stashes the caller
// under `pending_org_connect:<state>` and returns a GitHub App install URL that
// carries the state. Installing the App redirects to `/github/install-callback`,
// which resolves the installation and writes the customer org + owner membership
// (see src/lib/org-connect.ts). Ownership is proven by the GitHub install — the
// same "the redirect carries verified state" trust chain as link_identity.
//
// Kept in its own module (not brains.ts) so it composes with, but doesn't tangle
// into, the multi-brain tool surface.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OrgScope, Role } from '../lib/orgs.ts';

// The Worker Env bits this tool needs: KV for the pending-connect challenge and
// the App slug to build the install URL (a tool handler has no request context).
interface OrgOnboardingEnv {
	OAUTH_KV: KVNamespace;
	GITHUB_APP_SLUG?: string;
}

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

export function registerOrgOnboardingTools(
	server: McpServer,
	// Org-scoped (brain-less) context, like create_brain: connecting a GitHub org
	// must work for a first-touch user who has no brain yet. Using tenantContext
	// here would throw NoBrainError before the tool could run.
	orgContext: (opts?: { requires?: Role }) => Promise<OrgScope>,
	env: OrgOnboardingEnv
) {
	server.registerTool(
		'connect_github_org',
		{
			title: 'Connect your GitHub organization',
			description:
				'Start connecting the user\'s own GitHub organization to Isomorphic, so its repos can become brains their team reads inside Claude. Use when the user wants to bring their company / team GitHub org onto the platform, or asks to "connect our GitHub org". Returns a link they open to install the Isomorphic app on their org (choosing which repos to expose); installing makes them the org\'s owner here. After that, they run connect_brain to adopt a repo as the first brain. Product (email/SSO) sign-ins only.',
			inputSchema: {}
		},
		async () => {
			// orgContext() itself rejects non-product (single-tenant) connections
			// with a clear message, and guarantees actorUserId for everyone else.
			const ctx = await orgContext();
			const slug = env.GITHUB_APP_SLUG;
			if (!slug) {
				return fail(
					'Connecting a GitHub org is not configured on this server (missing GITHUB_APP_SLUG).'
				);
			}
			const state = crypto.randomUUID();
			await env.OAUTH_KV.put(
				`pending_org_connect:${state}`,
				JSON.stringify({ user_id: ctx.actorUserId, email: ctx.author?.email ?? null }),
				{ expirationTtl: 3600 }
			);
			const url = `https://github.com/apps/${slug}/installations/new?state=${state}`;
			return {
				content: [
					{
						type: 'text' as const,
						text:
							`Open this link and install Isomorphic on your GitHub organization, selecting the repositories you want to use as brains:\n\n${url}\n\n` +
							`Installing makes you the owner of the org here. When you're back, run connect_brain to adopt a repo as your first brain.\n\n` +
							`(The link expires in 1 hour. Install on an Organization, not a personal account — personal accounts can't host new brains.)`
					}
				],
				structuredContent: { connect: { url } }
			};
		}
	);
}
