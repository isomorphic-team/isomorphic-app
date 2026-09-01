// The web shell: what the server serves at `/b/...`, and nothing the app runs.
//
// Split from web-app.ts on purpose. That module holds the rules BOTH sides share
// (what a URL means, whether a cookie call may proceed) and the app bundle imports
// it for the parser. This one is server-only: the shell that wraps the bundle, its
// response headers, the tab icon, the sign-in redirect. Kept apart so the ui://
// bundle does not carry its own wrapper as dead bytes, and so `pnpm test:web` can
// assert the MCP App resource has no icon by reading its head rather than by
// hoping a string literal is absent from a megabyte of minified JavaScript.
//
// Pure and Worker-safe, like its sibling.

// ---------- the shell ----------

// Tell the bundle which host is serving it, before any of its own code runs.
//
// A flag stamped at serve time rather than an AppBridge handshake the app waits
// on and gives up: the answer is known here, and inferring it from a timeout
// would make every web boot pay the timeout and make a slow MCP host look like a
// browser.
export function webShell(bundleHtml: string): string {
	const head = `<head>\n<script>window.__ISO_WEB__=true</script>\n${WEB_FAVICON_LINK}`;
	// Replacer function, never a string: a `$&` in the payload would be treated
	// as a pattern reference. See docs/references.md.
	return bundleHtml.replace('<head>', () => head);
}

// The tab icon: the Isomorphic mark, from the marketing site's `static/brand/`
// (isomorphic-website), inlined as a data URI because the shell may load nothing
// from another origin and there is no static asset route on this Worker. Web only:
// the same bundle served as the MCP App resource has no tab to name. Kept as the
// source SVG rather than pre-encoded so it can be read and updated.
export const WEB_FAVICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
	'<rect width="512" height="512" rx="96" fill="#0f172a"/>' +
	'<path d="M112 183C159 139 207 139 257 170C314 206 360 222 400 180" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="30"/>' +
	'<path d="M112 286H400M112 366H400" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="30"/>' +
	'</svg>';

const WEB_FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(WEB_FAVICON_SVG)}">`;

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
