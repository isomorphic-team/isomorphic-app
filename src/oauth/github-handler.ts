// GitHub OAuth bridge for `@cloudflare/workers-oauth-provider`.
//
// This is the `defaultHandler` we hand to the provider. It runs for any
// non-API request (or API request lacking a valid token). We implement two
// routes:
//
//   GET /authorize             — start the dance: parse the inbound OAuth
//                                request, stash it in OAUTH_KV under a CSRF
//                                state nonce, redirect to GitHub for sign-in.
//   GET /oauth/github/callback — GitHub returns here. Exchange the code for a
//                                user-to-server token, fetch the user, and
//                                call `completeAuthorization` with the user's
//                                GitHub identity in `props`.
//
// Pending OAuth requests live in OAUTH_KV under `pending_auth:<state>` with a
// 10-minute TTL. The state is the CSRF nonce that round-trips via GitHub.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

interface GithubHandlerEnv {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	GITHUB_APP_CLIENT_ID: string;
	GITHUB_APP_CLIENT_SECRET: string;
}

interface GitHubUser {
	id: number;
	login: string;
}

interface GitHubTokenResponse {
	access_token?: string;
	error?: string;
	error_description?: string;
}

const PENDING_AUTH_TTL_SECONDS = 600;

export const githubHandler = {
	async fetch(request: Request, env: GithubHandlerEnv): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/authorize') {
			return startGithubFlow(request, env, url);
		}

		if (url.pathname === '/oauth/github/callback') {
			return finishGithubFlow(env, url);
		}

		return new Response('Not found', { status: 404 });
	}
};

async function startGithubFlow(
	request: Request,
	env: GithubHandlerEnv,
	url: URL
): Promise<Response> {
	const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const state = crypto.randomUUID();
	await env.OAUTH_KV.put(`pending_auth:${state}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: PENDING_AUTH_TTL_SECONDS
	});

	const ghAuthUrl = new URL('https://github.com/login/oauth/authorize');
	ghAuthUrl.searchParams.set('client_id', env.GITHUB_APP_CLIENT_ID);
	ghAuthUrl.searchParams.set('redirect_uri', `${url.origin}/oauth/github/callback`);
	ghAuthUrl.searchParams.set('state', state);
	// GitHub Apps with user-OAuth don't take `scope` here — user-level perms
	// are negotiated at install time / declared on the App.
	return Response.redirect(ghAuthUrl.toString(), 302);
}

async function finishGithubFlow(env: GithubHandlerEnv, url: URL): Promise<Response> {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) {
		return new Response('Missing code or state', { status: 400 });
	}

	const pendingJson = await env.OAUTH_KV.get(`pending_auth:${state}`);
	if (!pendingJson) {
		return new Response('Invalid or expired authorization request', { status: 400 });
	}
	const oauthReqInfo = JSON.parse(pendingJson);
	await env.OAUTH_KV.delete(`pending_auth:${state}`);

	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': 'isomorphic-mind-mcp'
		},
		body: new URLSearchParams({
			client_id: env.GITHUB_APP_CLIENT_ID,
			client_secret: env.GITHUB_APP_CLIENT_SECRET,
			code
		})
	});
	const tokenData = (await tokenRes.json()) as GitHubTokenResponse;
	if (!tokenData.access_token) {
		return new Response(
			`GitHub OAuth exchange failed: ${tokenData.error_description ?? tokenData.error ?? 'unknown'}`,
			{ status: 502 }
		);
	}

	const userRes = await fetch('https://api.github.com/user', {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'isomorphic-mind-mcp'
		}
	});
	if (!userRes.ok) {
		return new Response(`GitHub user lookup failed: ${userRes.status}`, { status: 502 });
	}
	const user = (await userRes.json()) as GitHubUser;

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: String(user.id),
		metadata: { gh_login: user.login },
		scope: oauthReqInfo.scope ?? [],
		props: {
			gh_user_id: user.id,
			gh_login: user.login
		}
	});
	return Response.redirect(redirectTo, 302);
}
