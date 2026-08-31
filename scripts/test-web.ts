// Golden test for the web app's two decisions (src/lib/web-app.ts). Pure: no
// D1, no network, no browser.
//
//   pnpm test:web
//
// 1. WHAT A `/b/...` URL MEANS. The Worker builds these and the app parses
//    them, from the same two functions, so a link that opens a different page
//    than it names fails here rather than in someone's browser.
//
// 2. WHETHER A COOKIE-AUTHENTICATED `/mcp` POST IS ALLOWED. This is the one
//    that matters. The endpoint performs WRITES and is reached with an ambient
//    cookie rather than a token the caller had to hold, which is the shape CSRF
//    exploits. Every rule is asserted in BOTH directions: a test that only
//    proves good requests pass would stay green with the whole gate removed.

import {
	parseWebPath,
	webPathFor,
	checkWebMcpRequest,
	webShell,
	WEB_APP_HEADERS,
	signInRedirect,
	type WebMcpRequest
} from '../src/lib/web-app.ts';
import { BRAIN_APP_HTML } from '../src/lib/app-bundle.generated.ts';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

// ---------- what a web URL means ----------

{
	console.log('\nweb paths');

	check(
		'a page URL names its brain and path',
		JSON.stringify(parseWebPath('/b/acme/brain/wiki/index.md')) ===
			JSON.stringify({ brain: 'acme/brain', path: 'wiki/index.md' })
	);
	check(
		'a bare brain URL names no page',
		JSON.stringify(parseWebPath('/b/acme/brain')) ===
			JSON.stringify({ brain: 'acme/brain', path: '' })
	);
	check('a trailing slash is not a page', parseWebPath('/b/acme/brain/')?.path === '');
	check('a non-web path is not a target', parseWebPath('/mcp') === null);
	check('the prefix alone is not a target', parseWebPath('/b/acme') === null);

	// Round-trip, which is the property that actually matters: whatever the
	// Worker puts in a link, the app has to read back as the same page.
	for (const path of [
		'wiki/index.md',
		'wiki/Meetings/2026-06-26 Weekly Sync.md',
		'wiki/plans/q3 & q4.md',
		'wiki/décisions/plan.md',
		'wiki/a+b/c#d.md'
	]) {
		const round = parseWebPath(webPathFor('acme/brain', path));
		check(`round-trips: ${path}`, round?.path === path, JSON.stringify(round));
	}
	check(
		'a brain with no page round-trips too',
		parseWebPath(webPathFor('acme/brain', ''))?.path === ''
	);

	// A repo path never contains these, and passing one through would hand `..`
	// to the store as though an author had written it.
	check('a traversal segment is refused', parseWebPath('/b/acme/brain/wiki/../../etc') === null);
	check('an encoded traversal is refused', parseWebPath('/b/acme/brain/wiki/%2e%2e/x') === null);
	check('a bare dot segment is refused', parseWebPath('/b/acme/brain/./x') === null);
	check('a malformed escape is refused', parseWebPath('/b/acme/brain/wiki/%zz.md') === null);
}

// ---------- the cookie gate ----------

{
	console.log('\ncookie-authenticated /mcp');

	const good: WebMcpRequest = {
		method: 'POST',
		selfOrigin: 'https://brain.example.com',
		origin: 'https://brain.example.com',
		fetchSite: 'same-origin',
		contentType: 'application/json',
		hasAuthorization: false
	};
	const verdict = (over: Partial<WebMcpRequest>) => checkWebMcpRequest({ ...good, ...over });

	check('a same-origin JSON POST is allowed', verdict({}).ok);
	check(
		'a charset on the content type is still JSON',
		verdict({ contentType: 'application/json; charset=utf-8' }).ok
	);
	check('a browser that sends no Origin is allowed', verdict({ origin: null }).ok);
	check('a typed URL (Sec-Fetch-Site: none) is allowed', verdict({ fetchSite: 'none' }).ok);
	check('a browser that sends no Sec-Fetch-Site is allowed', verdict({ fetchSite: null }).ok);

	// The refusals. Each is the whole reason the corresponding rule exists.
	const refused = (name: string, over: Partial<WebMcpRequest>, status: number) => {
		const v = verdict(over);
		check(name, !v.ok && v.status === status, JSON.stringify(v));
	};

	// Mixing the two auth paths is how a cookie stands in for a token that
	// failed validation.
	refused('a Bearer token is never served by the cookie path', { hasAuthorization: true }, 401);
	refused('a GET is refused', { method: 'GET' }, 405);
	// A cross-site fetch carries an Origin, so a mismatch is an attack.
	refused('a cross-origin POST is refused', { origin: 'https://evil.example' }, 403);
	refused('a cross-site fetch is refused', { fetchSite: 'cross-site' }, 403);
	refused('a same-site-but-not-same-origin fetch is refused', { fetchSite: 'same-site' }, 403);
	// An HTML form can only POST these three, which is exactly why requiring
	// JSON means a form cannot reach this endpoint even carrying the cookie.
	for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
		refused(`a form content type is refused: ${ct}`, { contentType: ct }, 415);
	}
	refused('a missing content type is refused', { contentType: null }, 415);
}

// ---------- the shell ----------

{
	console.log('\nthe shell');

	const shell = webShell(BRAIN_APP_HTML);
	check('the shell declares the web host', shell.includes('window.__ISO_WEB__=true'));
	// Before ANY of the bundle's own code: the flag decides which transport the
	// app uses, so it has to be set before the app reads it.
	check(
		'the flag runs before the bundle',
		shell.indexOf('window.__ISO_WEB__=true') < shell.indexOf('<style'),
		`flag at ${shell.indexOf('window.__ISO_WEB__=true')}, first style at ${shell.indexOf('<style')}`
	);
	check('the bundle itself is unchanged otherwise', shell.includes(BRAIN_APP_HTML.slice(200, 400)));
	// The bundle READS the flag (that is `isWebHost`), so the identifier is in
	// there either way. What must never be true is the bundle SETTING it: the
	// same bytes are served as the MCP App resource, and a bundle that declared
	// itself the web host would make the app in Claude POST to an origin it
	// cannot reach instead of calling its host.
	check(
		'the MCP App resource does not declare itself the web host',
		!BRAIN_APP_HTML.includes('__ISO_WEB__=true') && !BRAIN_APP_HTML.includes('__ISO_WEB__ = true')
	);

	const csp = WEB_APP_HEADERS['content-security-policy'];
	check('the shell denies everything by default', csp.includes("default-src 'none'"));
	check('it may talk to its own origin', csp.includes("connect-src 'self'"));
	check('it may render data-URI attachments', csp.includes('img-src') && csp.includes('data:'));
	check('it cannot be framed', csp.includes("frame-ancestors 'none'"));
	check('it cannot post a form anywhere', csp.includes("form-action 'none'"));
	check(
		'authenticated content is never stored',
		WEB_APP_HEADERS['cache-control'].includes('no-store')
	);
	check('and never indexed', WEB_APP_HEADERS['x-robots-tag'].includes('noindex'));

	check(
		'signing in returns you to the page you asked for',
		signInRedirect('/b/acme/brain/wiki/x.md', '') ===
			'/auth/signin?callbackUrl=%2Fb%2Facme%2Fbrain%2Fwiki%2Fx.md'
	);
}

console.log(failures === 0 ? '\nAll web checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
