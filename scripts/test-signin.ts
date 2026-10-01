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
				jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
			}
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

done();
