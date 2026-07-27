// Product-identity handler behind the MCP OAuth server's /authorize.
//
// The Worker stays an OAuth 2.1 authorization server to Claude via
// @cloudflare/workers-oauth-provider — THAT is unchanged. This handler is the
// `defaultHandler` for IDENTITY_MODE=authjs; it replaces the GitHub bridge
// (github-handler.ts) with Auth.js so members sign in via email/SSO and never
// need a GitHub account. See docs/design/org-roles-permissions.md.
//
// Flow:
//   /auth/*          → handed to Auth.js (signin, callback/resend, session, …)
//   /authorize       → stash the MCP client's OAuth request, redirect to sign-in
//   /oauth/complete  → after sign-in, read the session, complete the OAuth grant
//                      with a PRODUCT identity in props (not a GitHub one)

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Auth } from '@auth/core';
import { buildAuthConfig, getAuthSession, AUTH_BASE_PATH, type AuthEnv } from '../auth/config.ts';
import { resolveProductIdentity } from '../lib/identity.ts';
import { getAppUser, upsertAppUser, mergePersons } from '../lib/orgs.ts';

interface AuthHandlerEnv extends AuthEnv {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
}

// Mirrors github-handler's pending-auth pattern: the MCP client's OAuth request
// is stashed in KV under a state nonce while the human authenticates, then
// reloaded to complete the grant. TTL must cover the full magic-link round-trip:
// email delivery + the human noticing + clicking, which routinely runs into
// minutes. 600s was too tight and produced "expired" 400s at /oauth/complete for
// slow email hops; 1h leaves generous headroom (the grant itself is single-use,
// so a long-lived pending entry is not a meaningful exposure).
const PENDING_AUTH_TTL_SECONDS = 3600;

export const authHandler = {
	async fetch(request: Request, env: AuthHandlerEnv): Promise<Response> {
		const url = new URL(request.url);

		// 1. Auth.js owns everything under /auth/* (its signin form, the Resend
		//    callback that verifies the magic link, /session, /csrf, …).
		if (url.pathname === AUTH_BASE_PATH || url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
			return Auth(request, buildAuthConfig(env));
		}

		// 2. OAuth authorize entry from the MCP client (Claude). Stash the parsed
		//    request, then send the user into Auth.js sign-in, returning to
		//    /oauth/complete afterward via callbackUrl.
		if (url.pathname === '/authorize') {
			// parseAuthRequest throws on a malformed request (missing client_id,
			// redirect_uri, etc.). Return a clean 400 rather than a raw 500 — a real
			// MCP client always sends valid params, but a bare browser hit shouldn't
			// surface a stack trace.
			let oauthReqInfo;
			try {
				oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
			} catch (err) {
				return new Response(
					`Invalid authorization request: ${err instanceof Error ? err.message : String(err)}`,
					{ status: 400 }
				);
			}
			const state = crypto.randomUUID();
			await env.OAUTH_KV.put(`pending_auth:${state}`, JSON.stringify(oauthReqInfo), {
				expirationTtl: PENDING_AUTH_TTL_SECONDS
			});
			return redirectToSignIn(url.origin, state);
		}

		// 3. Completion. After the magic link / SSO redirect lands here, read the
		//    Auth.js session, reload the stashed OAuth request, resolve the
		//    product identity, and complete the grant back to the MCP client.
		if (url.pathname === '/oauth/complete') {
			const state = url.searchParams.get('state');
			if (!state) return new Response('Missing state', { status: 400 });

			const session = await getAuthSession(request, env);
			if (!session?.user?.email) {
				// Not signed in yet (e.g. first hop). Send into sign-in, return here.
				return redirectToSignIn(url.origin, state);
			}

			const pendingJson = await env.OAUTH_KV.get(`pending_auth:${state}`);
			if (!pendingJson) {
				// The user IS signed in (session read succeeded) but the stashed OAuth
				// request is gone — TTL expiry, a server restart that cleared KV, or a
				// stale/reused sign-in link. There is nothing to complete: the grant
				// needs the client's original redirect_uri/client_id, which lived only
				// in that entry. This is unrecoverable here (we cannot re-mint the
				// client's request), so guide the user back to the MCP client to
				// restart the connect, and log it so it's not mistaken for a code bug.
				console.warn(
					`[oauth/complete] no pending_auth for state=${state} (expired/restart/reused link)`
				);
				return new Response(
					'Your sign-in link expired or was already used. Return to your app and start the connection again.',
					{ status: 400 }
				);
			}
			const oauthReqInfo = JSON.parse(pendingJson);

			const identity = await resolveProductIdentity(env.PLATFORM_DB, {
				userId: session.user.id ?? '',
				email: session.user.email,
				name: session.user.name ?? null
			});

			const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
				request: oauthReqInfo,
				userId: identity.user_id,
				metadata: { email: identity.email },
				scope: oauthReqInfo.scope ?? [],
				props: {
					user_id: identity.user_id,
					email: identity.email,
					org_id: identity.org_id,
					role: identity.role
				}
			});

			// Delete only after the grant is minted. If identity resolution or
			// completeAuthorization throws, the pending entry survives so the user
			// can retry the same link rather than being forced through a fresh
			// sign-in (the old code deleted first and stranded any transient error).
			await env.OAUTH_KV.delete(`pending_auth:${state}`);
			console.log(`[oauth/complete] granted for ${identity.email} (state=${state})`);
			return Response.redirect(redirectTo, 302);
		}

		// 4. Identity-linking ("Connected accounts"). `link_identity` (a tool)
		//    stashes { actor_user_id } under pending_link:<state> and hands the user
		//    this URL. /link/start sends them into a FRESH Auth.js sign-in as the
		//    OTHER account; /link/complete reads the now-verified session and merges
		//    that identity into the actor's person. Reuses the exact pending-auth KV
		//    + magic-link trust chain — email ownership is proven by the sign-in.
		if (url.pathname === '/link/start') {
			const state = url.searchParams.get('state');
			if (!state || !(await env.OAUTH_KV.get(`pending_link:${state}`))) {
				return linkPage(
					'Link expired',
					'This linking link is invalid or has expired. Start again from Connected accounts in Claude.',
					400
				);
			}
			return redirectToLinkComplete(url.origin, state);
		}

		if (url.pathname === '/link/complete') {
			const state = url.searchParams.get('state');
			if (!state) return new Response('Missing state', { status: 400 });

			const pendingJson = await env.OAUTH_KV.get(`pending_link:${state}`);
			if (!pendingJson) {
				return linkPage(
					'Link expired',
					'This linking session expired or was already used. Start again from Connected accounts in Claude.',
					400
				);
			}
			const { actor_user_id } = JSON.parse(pendingJson) as { actor_user_id: string };

			const session = await getAuthSession(request, env);
			if (!session?.user?.email || !session.user.id) {
				// Not signed in yet — send into sign-in, return here.
				return redirectToLinkComplete(url.origin, state);
			}

			// Identity-mismatch guard: if the verified session is the ACTOR itself
			// (sticky cookie, never re-authed as a different account), there's nothing
			// to link. Leave the KV entry so they can retry the same link.
			const actor = await getAppUser(env.PLATFORM_DB, actor_user_id);
			const sameById = session.user.id === actor_user_id;
			const sameByEmail = !!actor && session.user.email.toLowerCase() === actor.email.toLowerCase();
			if (sameById || sameByEmail) {
				return linkPage(
					'Sign in as the account to link',
					`You're still signed in as ${actor?.email ?? 'your current account'}. To connect a different account, open the link again and sign in with the email you want to add.`,
					400
				);
			}

			// Verified a DIFFERENT identity → project it and merge into the actor's person.
			await upsertAppUser(env.PLATFORM_DB, {
				user_id: session.user.id,
				email: session.user.email,
				name: session.user.name ?? null
			});
			await mergePersons(env.PLATFORM_DB, actor_user_id, session.user.id);
			await env.OAUTH_KV.delete(`pending_link:${state}`); // consume only on success
			console.log(`[link/complete] linked ${session.user.email} → person of ${actor_user_id}`);
			return linkPage(
				'Account linked',
				`Linked ${session.user.email} to your account. Return to Claude — all your brains are now reachable from either sign-in.`
			);
		}

		return new Response('Not found', { status: 404 });
	}
};

function redirectToSignIn(origin: string, state: string): Response {
	const completeUrl = `${origin}/oauth/complete?state=${encodeURIComponent(state)}`;
	const signInUrl = new URL(`${origin}${AUTH_BASE_PATH}/signin`);
	signInUrl.searchParams.set('callbackUrl', completeUrl);
	return Response.redirect(signInUrl.toString(), 302);
}

function redirectToLinkComplete(origin: string, state: string): Response {
	const completeUrl = `${origin}/link/complete?state=${encodeURIComponent(state)}`;
	const signInUrl = new URL(`${origin}${AUTH_BASE_PATH}/signin`);
	signInUrl.searchParams.set('callbackUrl', completeUrl);
	return Response.redirect(signInUrl.toString(), 302);
}

// A minimal self-contained result page for the link hops (inline styles only —
// no external assets to trip a CSP).
function linkPage(title: string, body: string, status = 200): Response {
	const esc = (s: string) =>
		s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
	const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(
		title
	)}</title><style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#444}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#bbb}}</style><h1>${esc(
		title
	)}</h1><p>${esc(body)}</p>`;
	return new Response(html, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});
}
