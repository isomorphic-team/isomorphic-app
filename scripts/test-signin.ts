// Golden test for sign-in modes (src/auth/config.ts), driven through real Auth.js over a
// real D1 schema on node:sqlite.
//
//   pnpm test:signin
//
// It exists to catch:
//   1. Open sign-in (AUTH_SIGN_IN=open, previews only) not producing a real session: the
//      sign-in POST must land the browser on Auth.js's own callback, and that callback
//      must leave a session `getAuthSession` reads back with the typed address.
//   2. Email sign-in changing under the open mode's code path: it must still send through
//      Resend, leave the browser on "check your email", and create no session.
//   3. Anything but the exact value "open" opening sign-in.
//   4. A directory sign-in (docs/design/enterprise-identity.md) going wrong end to end. The
//      directory is a stubbed fetch that issues real signed ID tokens, so Auth.js runs its
//      whole OIDC callback. An address at a connected domain is sent to that org's tenant
//      and ends in a session; a member who had a magic-link account keeps it; a token from
//      another tenant, an address at another domain, and a callback without the signed
//      cookie create no session and no user; an enforced domain refuses a magic link.

import { createSign, generateKeyPairSync } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import { entitlementSql } from '../ee/entitlements.ts';
import { FEATURES } from '../src/lib/entitlements.ts';
import { claimDomain, txtRecordValue, verifyOrgDomain } from '../src/lib/org-domains.ts';
import { SSO_COOKIE } from '../src/lib/sso-cookie.ts';
import { setIdentityConnection } from '../src/lib/sso.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { getAuthSession, handleAuthRequest, signInMode, type AuthEnv } from '../src/auth/config.ts';

import { checker } from './check.ts';

const { check, done } = checker('signin checks');

const ORIGIN = 'http://localhost:8787';

/** A browser's worth of cookies: what each response sets, sent on the next request. */
function cookieJar() {
	const jar = new Map<string, string>();
	return {
		take(res: Response) {
			for (const line of res.headers.getSetCookie()) {
				const [pair] = line.split(';');
				const eq = pair!.indexOf('=');
				const value = pair!.slice(eq + 1).trim();
				// A browser drops a cookie that is set to nothing with Max-Age=0.
				if (value) jar.set(pair!.slice(0, eq).trim(), value);
				else jar.delete(pair!.slice(0, eq).trim());
			}
		},
		get: (name: string) => jar.get(name),
		set(name: string, value: string) {
			if (value) jar.set(name, value);
			else jar.delete(name);
		},
		header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
	};
}

async function submitEmail(env: AuthEnv, email: string) {
	const jar = cookieJar();
	const csrfRes = await handleAuthRequest(new Request(`${ORIGIN}/auth/csrf`), env);
	jar.take(csrfRes);
	const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
	const res = await handleAuthRequest(
		new Request(`${ORIGIN}/auth/signin/resend`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
			body: new URLSearchParams({ email, csrfToken, callbackUrl: `${ORIGIN}/b` })
		}),
		env
	);
	jar.take(res);
	return { res, jar };
}

function baseEnv(over: Partial<AuthEnv>): AuthEnv {
	return {
		PLATFORM_DB: localD1().db,
		AUTH_SECRET: 'test-secret-test-secret-test-secret-0000',
		AUTH_EMAIL_FROM: 'Isomorphic <login@example.com>',
		...over
	};
}

console.log('\nthe mode is open only for the exact value');
{
	check('unset is email', signInMode({}) === 'email');
	check('"open" is open', signInMode({ AUTH_SIGN_IN: 'open' }) === 'open');
	check('"Open" is email', signInMode({ AUTH_SIGN_IN: 'Open' }) === 'email');
	check('" open" is email', signInMode({ AUTH_SIGN_IN: ' open' }) === 'email');
	check('"true" is email', signInMode({ AUTH_SIGN_IN: 'true' }) === 'email');
}

console.log('\nopen sign-in ends in a real session for the typed address');
{
	const env = baseEnv({ AUTH_SIGN_IN: 'open' });
	const warn = console.warn;
	console.warn = () => {};
	try {
		const { res, jar } = await submitEmail(env, 'reviewer@example.com');
		const location = res.headers.get('location') ?? '';
		check('the sign-in POST redirects', res.status === 302, String(res.status));
		check(
			"to Auth.js's own callback on this origin",
			location.startsWith(`${ORIGIN}/auth/callback/resend?`),
			location
		);
		check('with a token', new URL(location, ORIGIN).searchParams.has('token'));

		const callback = await handleAuthRequest(
			new Request(location, { headers: { cookie: jar.header() } }),
			env
		);
		jar.take(callback);
		check(
			'the callback lands on the page that was asked for',
			callback.headers.get('location') === `${ORIGIN}/b`,
			String(callback.headers.get('location'))
		);
		const session = await getAuthSession(
			new Request(`${ORIGIN}/b`, { headers: { cookie: jar.header() } }),
			env
		);
		check(
			'the session is for the typed address',
			session?.user?.email === 'reviewer@example.com',
			JSON.stringify(session)
		);
		check('with a user id', typeof session?.user?.id === 'string' && session.user.id.length > 0);

		// What any script on the origin can fetch. The session token is the cookie's value.
		const raw = await handleAuthRequest(
			new Request(`${ORIGIN}/auth/session`, { headers: { cookie: jar.header() } }),
			env
		);
		const body = await raw.text();
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const cookieValue = jar
			.header()
			.split('; ')
			.find((c) => c.includes('session-token='))
			?.split('=')[1];
		check(
			'/auth/session returns only user and expires',
			JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(['expires', 'user']),
			JSON.stringify(Object.keys(parsed))
		);
		check(
			'/auth/session never contains the session token',
			!!cookieValue && !body.includes(cookieValue) && !body.includes('sessionToken')
		);

		const page = await handleAuthRequest(new Request(`${ORIGIN}/auth/signin`), env);
		check(
			'the sign-in page says no email is sent',
			(await page.text()).includes('no email is sent')
		);
	} finally {
		console.warn = warn;
	}
}

console.log('\nemail sign-in still sends the link and signs no one in');
{
	const env = baseEnv({ AUTH_RESEND_KEY: 're_test' });
	const realFetch = globalThis.fetch;
	const sent: { to: unknown; html: string }[] = [];
	globalThis.fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith('https://api.resend.com/')) {
			const body = JSON.parse(String(init?.body)) as { to: unknown; html: string };
			sent.push(body);
			return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
		}
		throw new Error(`unexpected network call: ${url}`);
	};
	try {
		const { res, jar } = await submitEmail(env, 'member@example.com');
		const location = res.headers.get('location') ?? '';
		check('one email went to Resend', sent.length === 1, String(sent.length));
		check(
			'addressed to the typed address',
			JSON.stringify(sent[0]?.to).includes('member@example.com')
		);
		check('carrying the callback link', (sent[0]?.html ?? '').includes('/auth/callback/resend?'));
		check(
			'the browser is sent to "check your email", not the link',
			location.includes('/auth/verify-request') && !location.includes('token='),
			location
		);
		const session = await getAuthSession(
			new Request(`${ORIGIN}/b`, { headers: { cookie: jar.header() } }),
			env
		);
		check('no session exists before the link is clicked', session === null);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// ── Directory sign-in ─────────────────────────────────────────────────────────

const TENANT_A = '11111111-2222-3333-4444-555555555555';
const TENANT_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLIENT_ID = 'client-id-1';
const issuerOf = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>): string {
	const signed = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
	return `${signed}.${createSign('RSA-SHA256').update(signed).sign(privateKey).toString('base64url')}`;
}

/** A directory and an email provider on `globalThis.fetch`. Anything else throws. */
function fakeNetwork() {
	const net = {
		claims: {} as Record<string, unknown>,
		tokenRequests: [] as URLSearchParams[],
		emails: [] as { to: unknown; html: string }[],
		other: [] as string[]
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin === 'https://api.resend.com') {
			net.emails.push((await request.json()) as { to: unknown; html: string });
			return Response.json({ id: 'email_1' });
		}
		const tenant = url.pathname.split('/')[1] ?? '';
		if (url.origin === 'https://login.microsoftonline.com') {
			const base = `${url.origin}/${tenant}`;
			if (url.pathname.endsWith('/v2.0/.well-known/openid-configuration')) {
				return Response.json({
					issuer: issuerOf(tenant),
					authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
					token_endpoint: `${base}/oauth2/v2.0/token`,
					jwks_uri: `${base}/discovery/v2.0/keys`,
					// Named in the real document and required by Auth.js; never called.
					userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
					response_types_supported: ['code'],
					subject_types_supported: ['pairwise'],
					id_token_signing_alg_values_supported: ['RS256']
				});
			}
			if (url.pathname.endsWith('/discovery/v2.0/keys')) {
				return Response.json({
					keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }]
				});
			}
			if (url.pathname.endsWith('/oauth2/v2.0/token')) {
				net.tokenRequests.push(new URLSearchParams(await request.text()));
				return Response.json({
					access_token: 'access-1',
					token_type: 'Bearer',
					expires_in: 3600,
					id_token: idToken(net.claims)
				});
			}
		}
		net.other.push(request.url);
		throw new Error(`unexpected network call: ${request.url}`);
	}) as typeof fetch;
	return { net, restore: () => (globalThis.fetch = realFetch) };
}

/** An org entitled, holding example.com verified, connected to TENANT_A. */
async function connectOrg(db: D1Database, enforced = false) {
	const claim = await claimDomain(db, {
		orgId: 'o1',
		domain: 'example.com',
		userId: null,
		now: Date.now()
	});
	const dns = (async () =>
		Response.json({
			Status: 0,
			Answer: [{ type: 16, data: `"${txtRecordValue(claim!.challenge)}"` }]
		})) as typeof fetch;
	await verifyOrgDomain(db, 'o1', 'example.com', Date.now(), dns);
	await setIdentityConnection(db, {
		orgId: 'o1',
		tenantId: TENANT_A,
		userId: null,
		now: Date.now()
	});
	await db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId: 'o1',
				feature: FEATURES.enterprise,
				source: 'manual',
				now: Date.now()
			})
		)
		.run();
	if (enforced) await db.prepare(`UPDATE org_domains SET sso_enforced = 1`).run();
}

const countUsers = async (db: D1Database) =>
	(await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? -1;
const sessionOf = (env: AuthEnv, jar: ReturnType<typeof cookieJar>) =>
	getAuthSession(new Request(`${ORIGIN}/b`, { headers: { cookie: jar.header() } }), env);

/** Type an address, follow the directory round trip with these ID token claims. */
async function directorySignIn(
	env: AuthEnv,
	net: ReturnType<typeof fakeNetwork>['net'],
	email: string,
	claims: Record<string, unknown>,
	tamper?: (jar: ReturnType<typeof cookieJar>) => void | Promise<unknown>
) {
	const { res: start, jar } = await submitEmail(env, email);
	const authorize = new URL(start.headers.get('location') ?? 'http://none.invalid');
	const now = Math.floor(Date.now() / 1000);
	net.claims = {
		iss: issuerOf(TENANT_A),
		aud: CLIENT_ID,
		iat: now,
		exp: now + 600,
		nonce: authorize.searchParams.get('nonce') ?? undefined,
		...claims
	};
	await tamper?.(jar);
	const callbackUrl = `${ORIGIN}/auth/callback/microsoft-entra-id?code=code-1&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`;
	const callback = await handleAuthRequest(
		new Request(callbackUrl, { headers: { cookie: jar.header() } }),
		env
	);
	jar.take(callback);
	return { start, authorize, callback, jar };
}

const ssoEnv = (db: D1Database, over: Partial<AuthEnv> = {}): AuthEnv =>
	baseEnv({
		PLATFORM_DB: db,
		AUTH_RESEND_KEY: 're_test',
		AUTH_ENTRA_CLIENT_ID: CLIENT_ID,
		AUTH_ENTRA_CLIENT_SECRET: 'client-secret-1',
		...over
	});

console.log('\na connected domain signs in through its directory (4)');
{
	const { db } = localD1();
	const env = ssoEnv(db);
	const { net, restore } = fakeNetwork();
	const warn = console.warn;
	const error = console.error;
	console.warn = () => {};
	console.error = () => {};
	try {
		// A member with a magic-link account from before the org connected its directory.
		const before = await submitEmail(ssoEnv(db, { AUTH_SIGN_IN: 'open' }), 'grace@example.com');
		const used = await handleAuthRequest(
			new Request(before.res.headers.get('location') ?? '', {
				headers: { cookie: before.jar.header() }
			}),
			ssoEnv(db, { AUTH_SIGN_IN: 'open' })
		);
		before.jar.take(used);
		const graceId = (await sessionOf(env, before.jar))?.user?.id;
		check(
			'a magic-link account exists first',
			typeof graceId === 'string' && (await countUsers(db)) === 1
		);

		await connectOrg(db);

		const ada = await directorySignIn(env, net, 'Ada@Example.com', {
			sub: 'sub-ada',
			tid: TENANT_A,
			name: 'Ada',
			preferred_username: 'Ada@Example.com'
		});
		const q = ada.authorize.searchParams;
		check(
			'the email POST redirects to the directory',
			ada.start.status === 302,
			String(ada.start.status)
		);
		check(
			"at the org's own tenant",
			ada.authorize.origin + ada.authorize.pathname ===
				`https://login.microsoftonline.com/${TENANT_A}/oauth2/v2.0/authorize`,
			ada.authorize.href
		);
		check(
			'as this deployment, back to our callback',
			q.get('client_id') === CLIENT_ID &&
				q.get('redirect_uri') === `${ORIGIN}/auth/callback/microsoft-entra-id`
		);
		check('with the typed address as a hint', q.get('login_hint') === 'ada@example.com');
		check('asking for no Graph access', q.get('scope') === 'openid profile email');
		check('with PKCE and a state', !!q.get('code_challenge') && !!q.get('state'));
		check('no email was sent', net.emails.length === 0);
		const startCookie =
			ada.start.headers.getSetCookie().find((c) => c.startsWith(`${SSO_COOKIE}=`)) ?? '';
		check(
			'the start leaves an HttpOnly cookie scoped to /auth',
			/HttpOnly/.test(startCookie) &&
				/Path=\/auth/.test(startCookie) &&
				/SameSite=Lax/.test(startCookie),
			startCookie
		);

		check(
			'the callback lands on the page that was asked for',
			ada.callback.headers.get('location') === `${ORIGIN}/b`,
			String(ada.callback.headers.get('location'))
		);
		check(
			'the code was redeemed at that tenant with the verifier',
			net.tokenRequests.length === 1 &&
				!!net.tokenRequests[0]?.get('code_verifier') &&
				net.tokenRequests[0]?.get('code') === 'code-1'
		);
		const session = await sessionOf(env, ada.jar);
		check(
			'the session is for the address in the token, lowercased',
			session?.user?.email === 'ada@example.com',
			JSON.stringify(session)
		);
		check(
			'the callback clears the cookie',
			ada.callback.headers
				.getSetCookie()
				.some((c) => c.startsWith(`${SSO_COOKIE}=;`) && /Max-Age=0/.test(c))
		);
		check('nothing but the directory was called', net.other.length === 0, net.other.join());
		const account = await db
			.prepare(`SELECT provider, providerAccountId FROM accounts`)
			.first<{ provider: string; providerAccountId: string }>();
		check(
			'the account is keyed on sub',
			account?.provider === 'microsoft-entra-id' && account.providerAccountId === 'sub-ada'
		);

		const grace = await directorySignIn(env, net, 'grace@example.com', {
			sub: 'sub-grace',
			tid: TENANT_A,
			email: 'grace@example.com'
		});
		const linked = await sessionOf(env, grace.jar);
		check(
			'a member with a magic-link account keeps it',
			linked?.user?.id === graceId,
			JSON.stringify(linked)
		);
		check('and no second user is made', (await countUsers(db)) === 2);

		const users = await countUsers(db);
		const refused = async (label: string, r: Awaited<ReturnType<typeof directorySignIn>>) => {
			check(`${label}: no session`, (await sessionOf(env, r.jar)) === null);
			check(`${label}: no user`, (await countUsers(db)) === users);
		};

		const other = await directorySignIn(env, net, 'eve@example.com', {
			sub: 'sub-eve',
			tid: TENANT_B,
			email: 'eve@example.com'
		});
		check(
			'a token naming another tenant is turned away',
			(other.callback.headers.get('location') ?? '').includes('error='),
			String(other.callback.headers.get('location'))
		);
		await refused('another tenant', other);

		const elsewhere = await directorySignIn(env, net, 'eve@example.com', {
			sub: 'sub-eve',
			tid: TENANT_A,
			email: 'ceo@elsewhere.example'
		});
		await refused('an address at another domain', elsewhere);
		const existing = await directorySignIn(env, net, 'eve@example.com', {
			sub: 'sub-eve',
			tid: TENANT_B,
			email: 'grace@example.com'
		});
		await refused("another tenant claiming a member's address", existing);
		const accounts = await db.prepare(`SELECT COUNT(*) AS n FROM accounts`).first<{ n: number }>();
		check('and links nothing to that member', accounts?.n === 2);
		const nameless = await directorySignIn(env, net, 'eve@example.com', {
			sub: 'sub-eve',
			tid: TENANT_A
		});
		await refused('a token with no address', nameless);

		const tokens = net.tokenRequests.length;
		const noCookie = await directorySignIn(
			env,
			net,
			'eve@example.com',
			{ sub: 'sub-eve', tid: TENANT_A, email: 'eve@example.com' },
			(jar) => jar.set(SSO_COOKIE, '')
		);
		check(
			'a callback without the cookie is refused',
			noCookie.callback.status === 400,
			String(noCookie.callback.status)
		);
		const forged = await directorySignIn(
			env,
			net,
			'eve@example.com',
			{ sub: 'sub-eve', tid: TENANT_A, email: 'eve@example.com' },
			(jar) =>
				jar.set(
					SSO_COOKIE,
					jar.get(SSO_COOKIE)!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
				)
		);
		check(
			'a callback with an altered cookie is refused',
			forged.callback.status === 400,
			String(forged.callback.status)
		);
		check('neither redeems the code', net.tokenRequests.length === tokens);
		await refused('no cookie', noCookie);

		const moved = await directorySignIn(
			env,
			net,
			'eve@example.com',
			{ sub: 'sub-eve', tid: TENANT_B, email: 'eve@example.com', iss: issuerOf(TENANT_B) },
			() =>
				setIdentityConnection(db, {
					orgId: 'o1',
					tenantId: TENANT_B,
					userId: null,
					now: Date.now()
				})
		);
		check(
			'a callback after the org connected another tenant is refused',
			moved.callback.status === 400,
			String(moved.callback.status)
		);
		await refused('tenant changed', moved);
		await setIdentityConnection(db, {
			orgId: 'o1',
			tenantId: TENANT_A,
			userId: null,
			now: Date.now()
		});

		const midFlight = await directorySignIn(
			env,
			net,
			'eve@example.com',
			{ sub: 'sub-eve', tid: TENANT_A, email: 'eve@example.com' },
			() => db.prepare(`DELETE FROM org_entitlements`).run()
		);
		check(
			'a callback after the entitlement ended is refused',
			midFlight.callback.status === 400,
			String(midFlight.callback.status)
		);
		await refused('entitlement ended', midFlight);

		const lapsedStart = await submitEmail(env, 'eve@example.com');
		check(
			'without the entitlement the address gets a magic link',
			(lapsedStart.res.headers.get('location') ?? '').includes('/auth/verify-request') &&
				net.emails.length === 1
		);
	} finally {
		restore();
		console.warn = warn;
		console.error = error;
	}
}

console.log('\nan enforced domain refuses the magic link (4)');
{
	const { db } = localD1();
	const { net, restore } = fakeNetwork();
	const warn = console.warn;
	const error = console.error;
	console.warn = () => {};
	console.error = () => {};
	try {
		// A link issued before the domain was enforced.
		const open = ssoEnv(db, { AUTH_SIGN_IN: 'open' });
		const early = await submitEmail(open, 'ada@example.com');
		const link = early.res.headers.get('location') ?? '';
		check('a link exists from before', link.includes('/auth/callback/resend?'));

		await connectOrg(db, true);
		const used = await handleAuthRequest(
			new Request(link, { headers: { cookie: early.jar.header() } }),
			open
		);
		early.jar.take(used);
		check(
			'the earlier link no longer signs in',
			(await sessionOf(open, early.jar)) === null,
			String(used.headers.get('location'))
		);

		const noApp = ssoEnv(db, {
			AUTH_ENTRA_CLIENT_ID: undefined,
			AUTH_ENTRA_CLIENT_SECRET: undefined
		});
		const refused = await submitEmail(noApp, 'ada@example.com');
		check(
			'with no directory application the address is refused',
			refused.res.status === 403,
			String(refused.res.status)
		);
		check('and told why', (await refused.res.text()).includes('requires single sign-on'));
		check('no email was sent', net.emails.length === 0);

		const routed = await submitEmail(ssoEnv(db), 'ada@example.com');
		check(
			'with one it goes to the directory',
			(routed.res.headers.get('location') ?? '').startsWith(
				`https://login.microsoftonline.com/${TENANT_A}/`
			)
		);

		await db.prepare(`UPDATE org_domains SET sso_enforced = 0`).run();
		const fallback = await submitEmail(noApp, 'ada@example.com');
		check(
			'not enforced and no application: the magic link',
			(fallback.res.headers.get('location') ?? '').includes('/auth/verify-request') &&
				net.emails.length === 1
		);
		const notAForm = await handleAuthRequest(
			new Request(`${ORIGIN}/auth/signin/resend`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{'
			}),
			ssoEnv(db)
		);
		check(
			'a POST that is not a form is left to Auth.js',
			notAForm.status < 500,
			String(notAForm.status)
		);
		const stranger = await submitEmail(ssoEnv(db), 'someone@elsewhere.example');
		check(
			'another domain still gets the magic link',
			(stranger.res.headers.get('location') ?? '').includes('/auth/verify-request') &&
				net.emails.length === 2
		);
	} finally {
		restore();
		console.warn = warn;
		console.error = error;
	}
}

done();
