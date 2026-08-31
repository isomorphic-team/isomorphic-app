// The web app: the same MCP App bundle, served in a browser tab.
//
// Pure and Worker-safe. The Worker owns the routes; this owns the rules, so the
// two things that decide anything (what a `/b/...` URL means, and whether a
// cookie-authenticated `/mcp` POST is allowed) can be tested without a request.
//
// The web app is another MCP CLIENT, holding a cookie instead of a Bearer
// token. It reaches the same handlers, so tenant resolution, `effectiveBrainRole`,
// the two-scope gating and usage analytics are all the code that already runs.
// Nothing here may widen what a caller can do; it only changes how they arrive.

export const WEB_ROUTE_PREFIX = '/b/';

// ---------- what a web URL means ----------

export interface WebTarget {
	// "owner/repo", the same key the content index uses.
	brain: string;
	// Repo-relative page path, or '' for the brain's file tree.
	path: string;
}

// `/b/<owner>/<repo>/<path...>` -> the brain and page it names.
//
// Built by `webPathFor` and read by both the Worker and the app, so a link that
// opens the wrong page is a single test failure rather than a mismatch between
// two parsers.
export function parseWebPath(pathname: string): WebTarget | null {
	const m = /^\/b\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname);
	if (!m) return null;
	const raw = (m[3] ?? '').replace(/\/+$/, '');
	if (!raw) return { brain: `${m[1]}/${m[2]}`, path: '' };
	let path: string;
	try {
		path = raw
			.split('/')
			.map((seg) => decodeURIComponent(seg))
			.join('/');
	} catch {
		// A malformed percent-escape is a bad URL, not a page.
		return null;
	}
	// A traversal segment can never be part of a repo path, and letting one
	// through would hand `..` to the store as though the author had written it.
	if (path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
	return { brain: `${m[1]}/${m[2]}`, path };
}

export function webPathFor(brain: string, path: string): string {
	if (!path) return `${WEB_ROUTE_PREFIX}${brain}`;
	const encoded = path
		.split('/')
		.map((seg) => encodeURIComponent(seg))
		.join('/');
	return `${WEB_ROUTE_PREFIX}${brain}/${encoded}`;
}

// ---------- may this cookie-authenticated MCP call proceed? ----------

export interface WebMcpRequest {
	method: string;
	// The request's own origin, from its URL.
	selfOrigin: string;
	// The `Origin` header, absent on same-origin requests from some browsers.
	origin: string | null;
	// `Sec-Fetch-Site`, absent on browsers that do not send it.
	fetchSite: string | null;
	contentType: string | null;
	hasAuthorization: boolean;
}

export type WebMcpVerdict = { ok: true } | { ok: false; status: number; message: string };

// The gate in front of the cookie path, and the reason it is a pure function:
// this is a credential-bearing endpoint that performs WRITES, reached with an
// ambient cookie rather than a token the caller had to hold. Every rule below is
// load-bearing and each one is asserted in both directions.
export function checkWebMcpRequest(req: WebMcpRequest): WebMcpVerdict {
	// A Bearer token means the OAuth provider owns this request. The two auth
	// paths must never be confusable: if a token is present it is validated, and
	// a cookie must not be able to stand in for one that failed.
	if (req.hasAuthorization) {
		return { ok: false, status: 401, message: 'Bearer and cookie auth cannot be mixed.' };
	}
	if (req.method !== 'POST') {
		return { ok: false, status: 405, message: 'Method Not Allowed' };
	}
	// CSRF, layer one. A cross-site `fetch` carries an `Origin`, so a mismatch is
	// an attack rather than an accident.
	if (req.origin !== null && req.origin !== req.selfOrigin) {
		return { ok: false, status: 403, message: 'Cross-origin requests are not allowed.' };
	}
	// CSRF, layer two, for the browsers that send it. `cross-site` is refused
	// outright; `same-origin` and `none` (a typed URL) are fine.
	if (req.fetchSite !== null && req.fetchSite !== 'same-origin' && req.fetchSite !== 'none') {
		return { ok: false, status: 403, message: 'Cross-site requests are not allowed.' };
	}
	// CSRF, layer three, and the one that holds when a browser sends no `Origin`
	// at all. An HTML form can only POST three content types, none of them JSON,
	// so requiring JSON means a form cannot reach this endpoint even with the
	// cookie attached.
	if (!(req.contentType ?? '').toLowerCase().includes('application/json')) {
		return { ok: false, status: 415, message: 'Expected content-type: application/json.' };
	}
	return { ok: true };
}

// ---------- the shell ----------

// Tell the bundle which host is serving it, before any of its own code runs.
//
// A flag stamped at serve time rather than an AppBridge handshake the app waits
// on and gives up: the answer is known here, and inferring it from a timeout
// would make every web boot pay the timeout and make a slow MCP host look like a
// browser.
export function webShell(bundleHtml: string): string {
	const flag = '<head>\n<script>window.__ISO_WEB__=true</script>';
	// Replacer function, never a string: a `$&` in the payload would be treated
	// as a pattern reference. See docs/references.md.
	return bundleHtml.replace('<head>', () => flag);
}

// Response headers for the shell.
//
// `script-src` still needs `'unsafe-inline'`: the bundle is one self-contained
// HTML file with its JavaScript and CSS inlined (the MCP App iframe CSP forbids
// external hosts, which is why it is built that way), so there is no external
// script to point `'self'` at. Hashes or a nonce are the proper fix and belong
// in `pnpm gen:app`, which is the only thing that knows where the script tags
// are; a blind string replace over minified JS risks rewriting the literal text
// `<script` inside it. The threat that made this urgent was markdown-borne XSS,
// and that is closed at the source by `src/lib/render.ts`.
export const WEB_APP_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy': [
		"default-src 'none'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		// Attachments arrive as data URIs through read_media, exactly as in the app.
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		// The only thing it talks to is its own /mcp.
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'"
	].join('; '),
	// A brain page is not for search engines, and this surface is authenticated
	// rather than shared: nothing here should ever be indexed.
	'x-robots-tag': 'noindex, nofollow',
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff',
	// Authenticated content, and the shell carries the identity of whoever asked.
	'cache-control': 'private, no-store'
};

// Where an unauthenticated visitor goes, and how they get back.
export function signInRedirect(pathname: string, search: string): string {
	return `/auth/signin?callbackUrl=${encodeURIComponent(`${pathname}${search}`)}`;
}
