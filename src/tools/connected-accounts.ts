// Connected-accounts tools — the per-PERSON identity-linking surface.
//
// One panel tool, two audiences (like members.ts): `connected_accounts` both opens
// the interactive panel in the Isomorphic app (where the user adds/removes linked
// identities inline) AND returns the list as text, so the user can say "what accounts
// are linked to me?" and the model can reason over it. `link_identity` /
// `unlink_identity` are the conversational mutations.
//
// Unlike member tools, this is NOT org-scoped — a person can link identities even
// with a single personal brain — so it gates on `ctx.actorUserId` (present on the
// authjs path and the bridged-github path) rather than requireOrg. The legacy
// static/tenants single-tenant path has no product identity and is rejected.
//
// Verification: `link_identity` does NOT link anything by itself. It stashes the
// caller (the actor) under pending_link:<state> and returns a URL; the user opens
// it and signs in AS the other account (Auth.js magic-link), and /link/complete
// (auth-handler.ts) merges that verified identity into the actor's person. Email
// ownership is proven by the sign-in — the same trust chain as invitations.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	type TenantOpts,
	type ConnectedAccount,
	listConnectedAccounts,
	getAppUserByEmail,
	unlinkIdentity,
	unlinkGithubLink
} from '../lib/orgs.ts';

// The bits of the Worker Env these tools need: KV for the pending-link challenge
// and the public origin to build the sign-in URL (a tool handler has no request URL).
interface ConnectedAccountsEnv {
	OAUTH_KV: KVNamespace;
	PUBLIC_BASE_URL?: string;
}

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

// Narrow to the signed-in person, or throw the caller-facing "not available" error.
// actorUserId is set on the authjs path and the bridged-github path; never on the
// legacy static/tenants single-tenant path.
function requirePerson(ctx: BrainContext): string {
	if (!ctx.actorUserId) {
		throw new Error(
			'Connected accounts are only available for product (email/SSO) sign-ins, not this single-tenant connection.'
		);
	}
	return ctx.actorUserId;
}

// The connected-accounts roster lives inside the "Your settings" surface, so the
// widget resolves to a settings-shaped payload: the identity card fields (from ctx)
// PLUS the linked accounts. list/unlink return just `accounts` (read as data / used to
// refresh the section in place).
function settingsSc(ctx: BrainContext, accounts: ConnectedAccount[]) {
	return {
		view: 'settings' as const,
		email: ctx.author?.email,
		role: ctx.role,
		org: ctx.repoArgs.owner,
		activeBrain: ctx.activeBrain,
		accounts
	};
}

function accountsText(accounts: ConnectedAccount[]): string {
	const emails = accounts.filter((a) => a.kind === 'email');
	const githubs = accounts.filter((a) => a.kind === 'github');
	const lines = emails.map(
		(a) => `- ${a.email}${a.name ? ` (${a.name})` : ''}${a.is_self ? ' — this sign-in' : ''}`
	);
	for (const g of githubs) lines.push(`- @${g.github_login ?? g.github_user_id} (GitHub)`);
	return lines.length
		? `Connected accounts (${accounts.length}):\n${lines.join('\n')}`
		: 'No connected accounts.';
}

export function registerConnectedAccountTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	env: ConnectedAccountsEnv
) {
	// ---------- connected_accounts (panel: interactive widget + data) ----------
	// One tool, both modes: renders the inline Connected accounts panel for the user
	// (with link / unlink controls) AND returns the list as text the model can reason
	// over. The widget always renders (its _meta.ui is static), which for this
	// low-frequency settings surface is fine.
	registerAppTool(
		server,
		'connected_accounts',
		{
			title: 'Connected accounts',
			description:
				'The email logins and GitHub accounts linked to the current person — shown inline as the interactive Connected accounts panel (with controls to link another account or unlink one) AND returned as text you can reason over. Call it whenever the user wants to see, manage, connect, or link their accounts / identities / other email / other login, or when YOU need the list as data.',
			inputSchema: {},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async () => {
			const ctx = await getContext();
			const actorUserId = requirePerson(ctx);
			const accounts = await listConnectedAccounts(ctx.db, actorUserId);
			return {
				content: [{ type: 'text' as const, text: accountsText(accounts) }],
				structuredContent: settingsSc(ctx, accounts)
			};
		}
	);

	// ---------- link_identity (returns a verification URL) ----------
	server.registerTool(
		'link_identity',
		{
			title: 'Link another account to yours',
			description:
				'Start linking another of YOUR sign-in identities (a different email) to this account, so all your brains are reachable from either. Returns a verification link the user opens and signs in with the OTHER email — ownership is proven by that sign-in. Does not link anything until they complete it.',
			inputSchema: {
				email: z
					.string()
					.optional()
					.describe(
						'The other email you want to link (optional — for guidance only; the link works for whichever address you verify).'
					)
			}
		},
		async ({ email }) => {
			const ctx = await getContext();
			const actorUserId = requirePerson(ctx);
			const base = env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
			if (!base) {
				return fail('Account linking is not configured on this server (missing PUBLIC_BASE_URL).');
			}
			const state = crypto.randomUUID();
			await env.OAUTH_KV.put(
				`pending_link:${state}`,
				JSON.stringify({ actor_user_id: actorUserId }),
				{
					expirationTtl: 3600
				}
			);
			const url = `${base}/link/start?state=${state}`;
			const forWhom = email ? ` for ${email.trim()}` : '';
			return {
				content: [
					{
						type: 'text' as const,
						text: `Open this link${forWhom} and sign in with the account you want to connect — then it'll be linked to you:\n\n${url}\n\n(The link expires in 1 hour and can only be used once.)`
					}
				],
				structuredContent: { link: { url, email: email?.trim() } }
			};
		}
	);

	// ---------- unlink_identity ----------
	server.registerTool(
		'unlink_identity',
		{
			title: 'Unlink a connected account',
			description:
				'Detach one of your linked accounts. Pass `email` to unlink an email login, or `github` (the @login) to unlink a GitHub account. That connection stops sharing your brains; nothing else changes.',
			inputSchema: {
				email: z.string().optional().describe('Email login to unlink.'),
				github: z
					.string()
					.optional()
					.describe('GitHub account to unlink (its @login or numeric id).')
			}
		},
		async ({ email, github }) => {
			const ctx = await getContext();
			const actorUserId = requirePerson(ctx);

			if (email) {
				const target = await getAppUserByEmail(ctx.db, email.trim());
				if (!target) return fail(`${email.trim()} isn't one of your connected accounts.`);
				try {
					await unlinkIdentity(ctx.db, actorUserId, target.user_id);
				} catch (err) {
					return fail(err instanceof Error ? err.message : String(err));
				}
				const accounts = await listConnectedAccounts(ctx.db, actorUserId);
				return {
					content: [{ type: 'text' as const, text: `Unlinked ${target.email}.` }],
					structuredContent: { accounts }
				};
			}

			if (github) {
				const handle = github.trim().replace(/^@/, '');
				const accounts = await listConnectedAccounts(ctx.db, actorUserId);
				const match = accounts.find(
					(a) =>
						a.kind === 'github' &&
						(String(a.github_user_id) === handle ||
							(a.github_login ?? '').toLowerCase() === handle.toLowerCase())
				);
				if (!match?.github_user_id)
					return fail(`@${handle} isn't one of your connected GitHub accounts.`);
				try {
					await unlinkGithubLink(ctx.db, actorUserId, match.github_user_id);
				} catch (err) {
					return fail(err instanceof Error ? err.message : String(err));
				}
				const fresh = await listConnectedAccounts(ctx.db, actorUserId);
				return {
					content: [
						{ type: 'text' as const, text: `Unlinked @${match.github_login ?? handle} (GitHub).` }
					],
					structuredContent: { accounts: fresh }
				};
			}

			return fail('Specify which account to unlink: an `email` or a `github` handle.');
		}
	);
}
