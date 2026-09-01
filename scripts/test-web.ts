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

import { readdirSync, readFileSync } from 'node:fs';
import {
	parseWebPath,
	webPathFor,
	checkWebMcpRequest,
	claimsWebMcp,
	WEB_TOOL_ROUTING,
	type WebMcpRequest
} from '../src/lib/web-app.ts';
import { webShell, WEB_APP_HEADERS, signInRedirect } from '../src/lib/web-shell.ts';
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

// ---------- the destinations that are not a page ----------
//
// These ride the QUERY STRING, and that is the whole design: everything after the
// brain in the path is a repo path, so `/b/o/r/graph` is a page called `graph`. A
// destination as a path segment would collide with a real page the day someone
// writes one, and the collision would be silent.
{
	console.log('\nnon-page destinations');

	const round = (path: string, extras: { view?: string; arg?: string }) => {
		const url = webPathFor('acme/brain', path, extras);
		return parseWebPath(url.split('?')[0], url.split('?')[1] ?? '');
	};

	// Every addressable destination, driven from the table itself, so a route added
	// there without a working round trip fails here rather than shipping one-way.
	for (const [tool, route] of Object.entries(WEB_TOOL_ROUTING)) {
		if (route.kind !== 'view') continue;
		const back = round('', { view: route.token, ...(route.param ? { arg: 'wiki/x.md' } : {}) });
		check(
			`${tool} round-trips as ?view=${route.token}`,
			back?.view === route.token,
			JSON.stringify(back)
		);
		if (route.param) {
			check(`...carrying its ${route.param}`, back?.arg === 'wiki/x.md', JSON.stringify(back));
		}
	}

	check(
		'a query with URL punctuation survives',
		round('', { view: 'search', arg: 'a&b=c?d #e' })?.arg === 'a&b=c?d #e'
	);
	check(
		'the tree keeps its revealed folder',
		round('', { arg: 'wiki/concepts' })?.arg === 'wiki/concepts'
	);

	// A page URL must stay exactly what it was: adding destinations must not have
	// put a query string on the common case.
	check(
		'a plain page URL gains no query',
		webPathFor('acme/brain', 'wiki/index.md') === '/b/acme/brain/wiki/index.md'
	);
	check('a plain tree URL gains no query', webPathFor('acme/brain', '') === '/b/acme/brain');

	// Stable output, because syncAddressBar COMPARES the built URL against the one
	// in the bar to decide whether to write history. A URL that varied between
	// renders would push a duplicate entry on every navigation.
	check(
		'the same destination always builds the same string',
		webPathFor('acme/brain', '', { view: 'graph', arg: 'a.md' }) ===
			webPathFor('acme/brain', '', { arg: 'a.md', view: 'graph' })
	);

	// An unknown view is not a destination. Falling through to the tree is right;
	// inventing a view kind from a URL is not.
	check(
		'an unknown view is ignored',
		parseWebPath('/b/acme/brain', 'view=nonsense')?.view === undefined
	);
	// Held to the same rule as a path, since it names a page in the same repo.
	check(
		'a traversal in an argument is dropped',
		parseWebPath('/b/acme/brain', 'focus=../../etc')?.arg === undefined
	);
	// The editor is deliberately absent from the grammar: unsaved text is not in
	// the URL, so a link to it would open on saved content.
	check(
		'there is no editor destination',
		parseWebPath('/b/acme/brain', 'view=edit')?.view === undefined
	);
}

// ---------- every widget tool is classified ----------
//
// The guard against the drift that produced this table. The first version of the URL
// grammar was written from the VIEW list rather than the TOOL list, and `view_activity`
// and `brain_access` ended up with no URL for no reason anybody had decided. Scanning
// the registration sites means a new widget tool cannot land unaddressed: it either
// gets a route or an explicit `why` it has none. Same shape as `TOOL_KINDS` in the
// usage analytics, for the same reason.
{
	console.log('\nrouting covers the widget tools');

	const toolsDir = new URL('../src/tools/', import.meta.url);
	const registered = new Set<string>();
	for (const f of readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))) {
		const src = readFileSync(new URL(f, toolsDir), 'utf8');
		// `registerAppTool(server, 'name'` is what makes a tool open the widget, so it
		// is exactly the set that could want a URL.
		for (const m of src.matchAll(/registerAppTool\(\s*server,\s*'([a-z_]+)'/g)) {
			registered.add(m[1]);
		}
	}

	check('the scan found the widget tools', registered.size >= 8, `${registered.size} found`);
	const unclassified = [...registered].filter((t) => !WEB_TOOL_ROUTING[t]);
	check(
		'every widget tool is either addressable or explicitly not',
		unclassified.length === 0,
		unclassified.length ? `unclassified: ${unclassified.join(', ')}` : ''
	);

	// An exclusion has to say WHY. Without that the next person cannot tell a
	// decision from an oversight, which is the state this table replaced.
	const silent = Object.entries(WEB_TOOL_ROUTING)
		.filter(([, r]) => r.kind === 'none' && !(r as { why: string }).why.trim())
		.map(([t]) => t);
	check('every exclusion carries its reason', silent.length === 0, silent.join(', '));

	// Two destinations sharing a token would make one of them unreachable.
	const tokens = Object.values(WEB_TOOL_ROUTING)
		.filter((r) => r.kind === 'view')
		.map((r) => (r as { token: string }).token);
	check('tokens are unique', new Set(tokens).size === tokens.length, tokens.join(', '));
}

// ---------- which /mcp requests are the web app's ----------
//
// The decision in FRONT of the gate, and the one that broke the other client when it
// was wrong. An MCP host's first contact is a POST with no credential at all, and it
// must reach the OAuth provider for its `WWW-Authenticate` challenge; claiming it here
// answered `401 Not signed in` with no challenge, which the deploy smoke asserts
// against. So the exact shape `scripts/smoke.ts` sends is pinned as NOT ours.
{
	console.log('\nclaiming /mcp');

	check(
		'a cookie and no token is the web app',
		claimsWebMcp({ hasAuthorization: false, hasCookie: true })
	);
	check(
		'no credential at all is an MCP host making first contact, not ours',
		!claimsWebMcp({ hasAuthorization: false, hasCookie: false })
	);
	check(
		"a Bearer token is the provider's, even beside a cookie",
		!claimsWebMcp({ hasAuthorization: true, hasCookie: true })
	);
	check(
		"a Bearer token alone is the provider's",
		!claimsWebMcp({ hasAuthorization: true, hasCookie: false })
	);
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
	// The tab icon rides in the shell, not the bundle: the MCP App has no tab.
	check(
		'the shell carries the tab icon as a data URI',
		/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/.test(shell)
	);
	// Read from the HEAD, where a tag would be: the bundle's JavaScript may legitimately
	// hold any string.
	const bundleHead = BRAIN_APP_HTML.slice(0, BRAIN_APP_HTML.indexOf('</head>'));
	check('the MCP App resource carries no icon', !/<link[^>]*rel="icon"/.test(bundleHead));
	// And carries none of the shell either: that module is server-only.
	check('the bundle does not carry the shell', !BRAIN_APP_HTML.includes('__ISO_WEB__=true'));
	// What the tab says before a view has named it (loading, or a boot that failed):
	// the product, not the noun the bundle happened to be called.
	check(
		'the tab is called Isomorphic until a view names it',
		shell.includes('<title>Isomorphic</title>')
	);
	// One <head> in the output, since the shell rewrites the tag it matched.
	check('the shell still has exactly one head', shell.split('<head>').length === 2);
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
