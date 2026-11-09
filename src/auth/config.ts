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
import type { D1Database } from '@cloudflare/workers-types';

import { FEATURES, hasFeature } from '../lib/entitlements.ts';
import { sendSignInEmail } from '../lib/signin-email.ts';
import {
	SSO_COOKIE,
	SSO_COOKIE_MAX_AGE_SECONDS,
	cookieValue,
	readSsoCookie,
	signSsoCookie,
	ssoSetCookie
} from '../lib/sso-cookie.ts';
import {
	ENTRA_PROVIDER,
	checkSsoSignIn,
	getIdentityConnection,
	magicLinkRefused,
	resolveSignInRoute,
	type EntraClaims,
	type IdentityConnection
} from '../lib/sso.ts';
import { entraProvider } from './entra.ts';

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
	// Reply-To for the magic-link email, e.g. a support address. Empty sends none.
	AUTH_EMAIL_REPLY_TO?: string;
	// "open" signs anyone in as any email they type, with no email sent. For preview
	// deployments only; anything else (unset included) is the emailed magic link.
	AUTH_SIGN_IN?: string;
	// The deployment's multi-tenant Microsoft Entra application, for orgs that sign in
	// through their own directory. Without both, no address is routed to a directory.
	AUTH_ENTRA_CLIENT_ID?: string;
	AUTH_ENTRA_CLIENT_SECRET?: string;
}

/** The provider sign-in a config is built for: one org's directory. */
export interface SsoSignIn {
	connection: IdentityConnection;
	loginHint?: string;
}

function entraApp(env: AuthEnv): { clientId: string; clientSecret: string } | null {
	return env.AUTH_ENTRA_CLIENT_ID && env.AUTH_ENTRA_CLIENT_SECRET
		? { clientId: env.AUTH_ENTRA_CLIENT_ID, clientSecret: env.AUTH_ENTRA_CLIENT_SECRET }
		: null;
}

export type SignInMode = 'email' | 'open';

/** Only the exact value "open" opens sign-in; a typo or an unset var keeps email. */
export function signInMode(env: Pick<AuthEnv, 'AUTH_SIGN_IN'>): SignInMode {
	return env.AUTH_SIGN_IN === 'open' ? 'open' : 'email';
}

// Auth.js owns every route under this prefix (signin, callback, session, csrf,
// verify-request, …). Kept distinct from the MCP OAuth server's own endpoints
// (/authorize, /token, /register) which belong to @cloudflare/workers-oauth-provider.
export const AUTH_BASE_PATH = '/auth';

export function buildAuthConfig(
	env: AuthEnv,
	// Open mode hands the sign-in link here instead of emailing it.
	onSignInLink?: (url: string) => void,
	// Registers the directory provider for this one org. Absent, there is no such provider.
	sso?: SsoSignIn
): AuthConfig {
	const open = signInMode(env) === 'open';
	const app = sso ? entraApp(env) : null;
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
			// Decides whether a sign-in is accepted. It runs before Auth.js creates or links
			// a user, and for a magic link both when the link is requested and when it is used.
			async signIn({ user, account, profile }) {
				if (account?.provider === ENTRA_PROVIDER) {
					if (!sso) return false;
					const decision = await checkSsoSignIn(
						env.PLATFORM_DB,
						(profile ?? {}) as EntraClaims,
						sso.connection
					);
					if (!decision.ok)
						console.warn(
							`[sso] sign-in refused for org ${sso.connection.orgId}: ${decision.reason}`
						);
					return decision.ok;
				}
				const address = user?.email ?? account?.providerAccountId ?? '';
				return !magicLinkRefused(await resolveSignInRoute(env.PLATFORM_DB, address, Date.now()));
			},
			// What /auth/session returns, built field by field. With the database
			// strategy the `session` argument is the stored row, which carries
			// `sessionToken`: the session cookie's value, which the cookie keeps from
			// page scripts. Returning the row would hand it to any script on the origin.
			// The user id is copied from the adapter's row because the OAuth bridge
			// (/oauth/complete) keys the product identity on it, not on the email.
			session({ session, user }) {
				return {
					user: {
						id: user?.id ?? session.user?.id ?? '',
						email: session.user?.email ?? '',
						name: session.user?.name ?? null,
						image: session.user?.image ?? null,
						emailVerified: session.user?.emailVerified ?? null
					},
					expires: session.expires
				} as typeof session;
			}
		},
		providers: [
			Resend({
				// The name labels the button on Auth.js's sign-in page.
				...(open ? { name: 'Preview sign-in (no email is sent)' } : {}),
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
				sendVerificationRequest: async ({ identifier, url, provider }) => {
					if (open) {
						if (!onSignInLink)
							throw new Error('Open sign-in reached Auth.js without a link handler');
						onSignInLink(url);
						return;
					}
					await sendSignInEmail({
						url,
						email: identifier,
						maxAgeSeconds: provider.maxAge ?? 24 * 60 * 60,
						apiKey: provider.apiKey ?? '',
						from: provider.from ?? '',
						replyTo: env.AUTH_EMAIL_REPLY_TO
					});
				}
			}),
			...(sso && app
				? [
						entraProvider({
							...app,
							tenantId: sso.connection.tenantId,
							loginHint: sso.loginHint
						})
					]
				: [])
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
// cookie path. `pnpm test:signin` reads a real Auth.js session back through it.
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

let warnedOpen = false;

/**
 * Every request under AUTH_BASE_PATH. In open mode the email sign-in POST is answered with
 * a redirect to the sign-in link itself instead of Auth.js's "check your email" page, so
 * the link Auth.js mints, verifies and turns into a session is the one an email would
 * carry. Nothing else about the flow differs.
 */
export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response> {
	const sso = await handleSsoRequest(request, env);
	if (sso) return sso;
	if (signInMode(env) !== 'open') return Auth(request, buildAuthConfig(env));
	if (!warnedOpen) {
		warnedOpen = true;
		console.warn(
			'AUTH_SIGN_IN=open: anyone can sign in as any email address. This is for preview deployments only.'
		);
	}
	const url = new URL(request.url);
	if (request.method !== 'POST' || url.pathname !== `${AUTH_BASE_PATH}/signin/resend`) {
		return Auth(request, buildAuthConfig(env));
	}
	let link: string | undefined;
	const res = await Auth(
		request,
		buildAuthConfig(env, (u) => {
			link = u;
		})
	);
	if (!link || res.status < 300 || res.status >= 400) return res;
	const target = new URL(link);
	if (target.origin !== url.origin) return res;
	const headers = new Headers(res.headers);
	headers.set('location', target.toString());
	return new Response(null, { status: 302, headers });
}

const EMAIL_SIGN_IN_PATH = `${AUTH_BASE_PATH}/signin/resend`;
const SSO_SIGN_IN_PATH = `${AUTH_BASE_PATH}/signin/${ENTRA_PROVIDER}`;
const SSO_CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/${ENTRA_PROVIDER}`;

/**
 * The two requests a directory sign-in adds to Auth.js's own, or null for any other request.
 *
 * The email POST from the sign-in page is home-realm discovery: an address at a connected
 * domain starts a sign-in with that org's directory instead of sending a link. The provider's
 * callback is rebuilt for the same org from the signed cookie the start left, and refused
 * without it.
 */
async function handleSsoRequest(request: Request, env: AuthEnv): Promise<Response | null> {
	const url = new URL(request.url);
	const secure = url.protocol === 'https:';

	if (request.method === 'POST' && url.pathname === EMAIL_SIGN_IN_PATH) {
		// Anything but a form is Auth.js's to answer.
		const form = await request
			.clone()
			.formData()
			.catch(() => null);
		if (!form) return null;
		const field = (name: string) => {
			const v = form.get(name);
			return typeof v === 'string' ? v : '';
		};
		const email = field('email').trim().toLowerCase();
		const route = await resolveSignInRoute(env.PLATFORM_DB, email, Date.now());
		if (route.kind === 'sso' && entraApp(env) && env.AUTH_SECRET) {
			const start = new Request(`${url.origin}${SSO_SIGN_IN_PATH}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: request.headers.get('cookie') ?? ''
				},
				body: new URLSearchParams({
					csrfToken: field('csrfToken'),
					callbackUrl: field('callbackUrl')
				})
			});
			const { connection } = route;
			const res = await Auth(
				start,
				buildAuthConfig(env, undefined, { connection, loginHint: email })
			);
			const headers = new Headers(res.headers);
			const cookie = await signSsoCookie(
				{
					orgId: connection.orgId,
					tenantId: connection.tenantId,
					expiresAt: Date.now() + SSO_COOKIE_MAX_AGE_SECONDS * 1000
				},
				env.AUTH_SECRET
			);
			headers.append('set-cookie', ssoSetCookie(cookie, secure));
			return new Response(res.body, { status: res.status, headers });
		}
		if (magicLinkRefused(route)) {
			return ssoPage(
				'Single sign-on required',
				'Your organization requires single sign-on, and it is not available here yet. Ask your administrator.',
				403
			);
		}
		return null;
	}

	if (url.pathname === SSO_CALLBACK_PATH) {
		const connection = await callbackConnection(request, env);
		if (!connection) {
			return ssoPage(
				'Sign-in expired',
				'This sign-in could not be completed. Go back and start again.',
				400,
				ssoSetCookie('', secure)
			);
		}
		const res = await Auth(request, buildAuthConfig(env, undefined, { connection }));
		const headers = new Headers(res.headers);
		headers.append('set-cookie', ssoSetCookie('', secure));
		return new Response(res.body, { status: res.status, headers });
	}

	return null;
}

// The org a callback belongs to: the one its signed cookie names, if that org is still
// connected to the same tenant and still entitled.
async function callbackConnection(
	request: Request,
	env: AuthEnv
): Promise<IdentityConnection | null> {
	const now = Date.now();
	const cookie = await readSsoCookie(
		cookieValue(request.headers.get('cookie'), SSO_COOKIE),
		env.AUTH_SECRET ?? '',
		now
	);
	if (!cookie) return null;
	const connection = await getIdentityConnection(env.PLATFORM_DB, cookie.orgId);
	if (!connection || connection.tenantId !== cookie.tenantId) return null;
	if (!(await hasFeature(env.PLATFORM_DB, connection.orgId, FEATURES.enterprise, now))) return null;
	return connection;
}

function ssoPage(title: string, body: string, status: number, setCookie?: string): Response {
	const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#444}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#bbb}}</style><h1>${title}</h1><p>${body}</p>`;
	const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
	if (setCookie) headers.append('set-cookie', setCookie);
	return new Response(html, { status, headers });
}
