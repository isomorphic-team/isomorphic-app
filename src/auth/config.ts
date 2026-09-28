// Auth.js configuration for product-native (non-GitHub) identity.
//
// This is the identity layer that lets members/readers sign in WITHOUT a GitHub
// account (email magic link). GitHub stays as storage only, reached via each
// brain's storage connection (an App installation token). See
// docs/design/org-roles-permissions.md.
//
// @auth/core is runtime-agnostic (Web Request/Response), so it runs on workerd.
// Two Workers-specific constraints, both handled here:
//   1. Bindings (D1) are request-scoped — the config MUST be built per request
//      with the live env, never a module singleton. Hence `buildAuthConfig(env)`.
//   2. nodemailer won't run on workerd (Node `stream`/`dns`), so magic-link email
//      goes through the HTTP-based Resend provider, not SMTP.

import type { AuthConfig } from '@auth/core';
import { Auth } from '@auth/core';
import Resend from '@auth/core/providers/resend';
import { D1Adapter } from '@auth/d1-adapter';

import { sendSignInEmail } from '../lib/signin-email.ts';

export interface AuthEnv {
	// Shared with the Worker's D1 binding: Auth.js user/session/account/
	// verification_token tables live here, created by migrations/0001_init.sql
	// (vendored DDL, see src/db/authjs-schema.sql; the adapter does not create them).
	PLATFORM_DB: D1Database;
	// Signs sessions. Required in authjs mode; unset in github mode.
	AUTH_SECRET?: string;
	// Resend API key + From address for magic-link email. Without AUTH_RESEND_KEY
	// no sign-in link can be sent, so authjs mode needs it.
	AUTH_RESEND_KEY?: string;
	AUTH_EMAIL_FROM?: string;
}

// Auth.js owns every route under this prefix (signin, callback, session, csrf,
// verify-request, …). Kept distinct from the MCP OAuth server's own endpoints
// (/authorize, /token, /register) which belong to @cloudflare/workers-oauth-provider.
export const AUTH_BASE_PATH = '/auth';

export function buildAuthConfig(env: AuthEnv): AuthConfig {
	return {
		basePath: AUTH_BASE_PATH,
		secret: env.AUTH_SECRET,
		// workerd is not Vercel; trust the incoming Host header for URL derivation.
		trustHost: true,
		adapter: D1Adapter(env.PLATFORM_DB),
		// Database sessions (not JWT) so we can read the session server-side in
		// the OAuth completion step below via the /auth/session endpoint.
		session: { strategy: 'database' },
		callbacks: {
			// With the database strategy, Auth.js does NOT surface the user id on
			// session.user by default — /auth/session returns only email/name/image.
			// The OAuth bridge (/oauth/complete) needs the stable user id to key the
			// product identity (otherwise it falls back to email, which is not a
			// durable primary key). The `user` arg here is the adapter's DB row, so
			// copy its id onto the session.
			session({ session, user }) {
				if (session.user && user?.id) session.user.id = user.id;
				return session;
			}
		},
		providers: [
			Resend({
				apiKey: env.AUTH_RESEND_KEY,
				// No hardcoded fallback sender. A default pointing at somebody else's
				// domain is worse than no default: the send fails Resend's domain
				// verification, and the failure reads as "magic links are broken"
				// rather than "you did not set AUTH_EMAIL_FROM". The empty string
				// surfaces as a configuration error from Resend instead. Set it via
				// `pnpm setup:config` (AUTH_EMAIL_FROM) on a domain you have verified.
				from: env.AUTH_EMAIL_FROM ?? '',
				// Our own template instead of Auth.js's stock one, which Gmail
				// classifies as spam. See src/lib/signin-email.ts.
				sendVerificationRequest: ({ identifier, url, provider }) =>
					sendSignInEmail({
						url,
						email: identifier,
						maxAgeSeconds: provider.maxAge ?? 24 * 60 * 60,
						apiKey: provider.apiKey ?? '',
						from: provider.from ?? ''
					})
			})
		]
	};
}

export interface AuthSessionUser {
	id?: string;
	email?: string;
	name?: string | null;
}

// Read the current Auth.js session for an incoming request by replaying its
// cookies against Auth.js's own /auth/session endpoint. Returns null when the
// caller is signed out. Every magic-link sign-in goes through this
// (/oauth/complete reads the session it just created), as does the web app's
// cookie path; no automated test drives it against a real Auth.js session.
export async function getAuthSession(
	request: Request,
	env: AuthEnv
): Promise<{ user?: AuthSessionUser } | null> {
	const origin = new URL(request.url).origin;
	const sessionReq = new Request(`${origin}${AUTH_BASE_PATH}/session`, {
		headers: { cookie: request.headers.get('cookie') ?? '' }
	});
	const res = await Auth(sessionReq, buildAuthConfig(env));
	if (!res.ok) return null;
	const data = (await res.json().catch(() => null)) as { user?: AuthSessionUser } | null;
	return data && data.user ? data : null;
}
