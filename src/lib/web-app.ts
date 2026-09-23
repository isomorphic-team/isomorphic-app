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

import { handleOfSlug, labelOfSlug } from './brain-slug.ts';

export const WEB_ROUTE_PREFIX = '/b/';

// ---------- what a web URL means ----------

// WHICH URL EACH WIDGET TOOL CORRESPONDS TO.
//
// A web URL and a widget tool call answer the same question ("show me this"), so
// this is ONE table rather than a second vocabulary invented beside the tool
// surface, which would drift from it.
//
// Every widget tool must appear here, INCLUDING the ones that get no URL, and
// `pnpm test:web` scans `registerAppTool` call sites and fails on any that is
// missing. That is the same guard `TOOL_KINDS` uses in the usage analytics: a new
// destination silently having no link should be a red test, not something noticed a
// year later.
//
// THE TOKEN IS AN ALIAS, NOT THE TOOL NAME, and that is deliberate. A URL is a
// permanent contract (these functions are inverses so links do not rot), while the
// tool surface is actively consolidated (`list_members` + `view_members` became
// `members`). Coupling the two literally would make every future merge a
// link-breaking change; with an alias, a rename is one line here.
//
// Three questions decide whether a tool earns a URL, and all three must pass. Would
// you send it to someone (a destination, not a step)? Can the URL alone rebuild it
// (no hidden state)? Is arriving cold harmless (no unsaved work, no half-finished
// mutation)?
export type WebRouting =
	// The page path IS the URL: `/b/<brain>/<path>`.
	| { kind: 'path' }
	// The bare brain URL, `/b/<brain>`, optionally with `?focus=`.
	| { kind: 'root' }
	// `?view=<token>`, plus at most one argument under `param`.
	| { kind: 'view'; token: string; param?: string }
	// Deliberately not addressable. `why` is not decoration: it is the thing a
	// future reader needs in order to decide whether the answer has changed.
	| { kind: 'none'; why: string };

export const WEB_TOOL_ROUTING: Readonly<Record<string, WebRouting>> = {
	view_page: { kind: 'path' },
	browse_brain: { kind: 'root' },
	view_graph: { kind: 'view', token: 'graph', param: 'focus' },
	view_activity: { kind: 'view', token: 'activity', param: 'path' },
	brain_access: { kind: 'view', token: 'access' },
	// Not a widget tool (the app calls it and renders the hits itself), but it is a
	// destination by the three tests above, and the query is the whole of its state.
	search_pages: { kind: 'view', token: 'search', param: 'q' },

	// ORG SCOPE, ADDRESSED THROUGH A BRAIN, and the wart is deliberate rather than
	// unnoticed. These two answer the same thing for every brain in one org, so N
	// brains give N URLs for one roster. The canonical alternative is an org-keyed
	// prefix, and it is not worth it yet: `org_id` is a uuid (the only unique handle
	// — `name` is mutable and `brain_owner` is SHARED by every platform-model org),
	// so it would buy an unreadable second addressing scheme to serve two screens.
	// The threshold to revisit is a third and fourth org-scope destination (billing,
	// SSO, an audit log); at that point `/o/<org_id>` earns itself.
	//
	// This reads as "the roster of the org that owns this brain", which is true. The
	// worry that it asserts those people belong to the BRAIN is a UI concern, and the
	// nav already answers it by giving these the back arrow rather than the brain
	// crumb — a URL is a locator, not a claim.
	//
	// What this does NOT fix: both tools resolve their org THROUGH a brain, so an org
	// holding no brain still has no reachable roster. That is a resolution defect
	// rather than an addressing one. See docs/design/org-scope-resolution.md.
	members: { kind: 'view', token: 'members' },
	analytics: { kind: 'view', token: 'analytics', param: 'days' },

	edit_page: {
		kind: 'none',
		why: 'unsaved text is not in the URL, so a link would open the editor on saved content and discard its own premise'
	},
	connected_accounts: { kind: 'none', why: 'account scope, and personal to the viewer' },
	// The switcher is a step on the way somewhere, and where it lands already has a
	// URL of its own.
	brains: {
		kind: 'none',
		why: 'a picker, not a destination: every choice it offers is itself a URL'
	}
};

// The addressable tokens, derived rather than restated so the two cannot disagree.
export type WebView = string;

const VIEW_ROUTES = Object.values(WEB_TOOL_ROUTING).filter(
	(r): r is Extract<WebRouting, { kind: 'view' }> => r.kind === 'view'
);

export interface WebTarget {
	// The brain's handle, one path segment: `<name>-<handle>` (src/lib/brain-slug.ts),
	// or a folder name on the local runtime. Tools accept it as their `brain`.
	brain: string;
	// Repo-relative page path, or '' for a non-page destination.
	path: string;
	// A non-page destination's token, from `?view=`.
	view?: WebView;
	// That destination's single argument, under whatever param name its route
	// declares (`q` for search, `focus` for the graph, `path` for activity). With no
	// `view` it is the folder the file tree should reveal.
	arg?: string;
}

// A provisional display name for a brain the URL named, before the brain list has
// arrived to supply the real one: the slug's name part. `ensureBrainList` replaces
// it with the brain's actual label a moment later.
export function brainLabelFor(brain: string): string {
	return labelOfSlug(brain);
}

// `?days=` off an analytics URL, or undefined to let the tool pick its default.
//
// A URL is editable text, so this argument can say anything, and `analytics`
// declares `days` as a `z.number()` — a NaN from `Number('later')` fails schema
// validation, so a mistyped link would error instead of falling back. Deliberately
// does NOT re-apply the tool's `[1, MAX_DAYS]` clamp: that lives in the tool, and a
// second copy here would drift from it. This only decides usable-or-not.
//
// Pure, and here rather than in the app, because it is the thing that DECIDES.
export function analyticsDays(arg: string | undefined): number | undefined {
	if (!arg) return undefined;
	const n = Number(arg);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

// `/b/<brain>/<path...>` (+ query) -> what to show.
//
// Built by `webPathFor` and read by both the Worker and the app, so a link that
// opens the wrong page is a single test failure rather than a mismatch between
// two parsers.
//
// PATH SPACE IS ONLY EVER PAGES. Everything after the brain is a repo path, so a
// destination cannot be a path segment without colliding with a real page called
// `graph` or `search`. That is why the non-page destinations ride the query string
// instead: it keeps page links unambiguous and leaves the path grammar closed.
export function parseWebPath(pathname: string, search = ''): WebTarget | null {
	const m = /^\/b\/([^/]+)(?:\/(.*))?$/.exec(pathname);
	if (!m) return null;
	let brain: string;
	try {
		brain = decodeURIComponent(m[1]);
	} catch {
		return null;
	}
	const raw = (m[2] ?? '').replace(/\/+$/, '');

	let params: URLSearchParams;
	try {
		params = new URLSearchParams(search);
	} catch {
		params = new URLSearchParams();
	}
	const extras: Omit<WebTarget, 'brain' | 'path'> = {};
	// An unknown token is not a destination: fall through to the tree rather than
	// invent a view kind from whatever the URL happened to say.
	const route = VIEW_ROUTES.find((r) => r.token === params.get('view'));
	// With no `view`, the one argument is the folder the file tree should reveal.
	const param = route ? route.param : 'focus';
	if (route) extras.view = route.token;
	const arg = param ? params.get(param) : null;
	// The argument names a page or folder in the same repo, so it is held to the
	// same rule as a path: a traversal segment is a bad URL, not a destination. A
	// free-text search query cannot contain a bare `..` segment either, so the one
	// rule is safe to apply to all of them.
	if (arg && !arg.split('/').some((seg) => seg === '..' || seg === '.')) {
		extras.arg = arg;
	}

	if (!raw) return { brain, path: '', ...extras };
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
	return { brain, path, ...extras };
}

export function webPathFor(
	brain: string,
	path: string,
	extras: Omit<WebTarget, 'brain' | 'path'> = {}
): string {
	const encoded = path
		? `/${path
				.split('/')
				.map((seg) => encodeURIComponent(seg))
				.join('/')}`
		: '';
	// Insertion order is fixed rather than incidental, so the same destination
	// always produces the same string: a URL that varies between renders is one
	// the history stack cannot compare, and `syncAddressBar` compares it.
	const params = new URLSearchParams();
	const route = extras.view ? VIEW_ROUTES.find((r) => r.token === extras.view) : undefined;
	if (route) params.set('view', route.token);
	// The param name comes from the route, so it stays the inverse of the parser by
	// construction rather than by two lists agreeing. No `view` means the tree, whose
	// one argument is the folder to reveal.
	const param = route ? route.param : 'focus';
	if (param && extras.arg) params.set(param, extras.arg);
	const qs = params.toString();
	return `${WEB_ROUTE_PREFIX}${encodeURIComponent(brain)}${encoded}${qs ? `?${qs}` : ''}`;
}

// Where a `/b/...` URL should REDIRECT, or null to serve it as it is.
//
// A URL is a contract, so two kinds of old link keep working:
//   - a slug whose name part is stale (the brain was renamed): the handle still
//     identifies it, and the redirect updates the name;
//   - `/b/<owner>/<repo>/...`, every link made before brains had slugs.
// `brains` is the SIGNED-IN caller's accessible set, so a redirect never says
// anything about a brain the caller cannot reach: an unknown URL is served as is
// and the app reports it the same way whether or not the brain exists.
// Path and query are carried over byte for byte.
export function canonicalWebPath(
	pathname: string,
	search: string,
	brains: { id: string; handle: string; repo_owner: string; repo_name: string }[]
): string | null {
	const m = /^\/b\/([^/]+)(?:\/(.*))?$/.exec(pathname);
	if (!m) return null;
	let seg: string;
	try {
		seg = decodeURIComponent(m[1]);
	} catch {
		return null;
	}
	const rest = m[2] ?? '';
	const to = (b: { id: string }, tail: string) =>
		`${WEB_ROUTE_PREFIX}${encodeURIComponent(b.id)}${tail ? `/${tail}` : ''}${search}`;

	if (brains.some((b) => b.id === seg)) return null;
	const handle = handleOfSlug(seg);
	const renamed = handle ? brains.find((b) => b.handle === handle) : undefined;
	if (renamed) return to(renamed, rest);

	const slash = rest.indexOf('/');
	const repo = slash === -1 ? rest : rest.slice(0, slash);
	const tail = slash === -1 ? '' : rest.slice(slash + 1);
	let repoName: string;
	try {
		repoName = decodeURIComponent(repo).toLowerCase();
	} catch {
		return null;
	}
	const legacy = brains.find(
		(b) => b.repo_owner.toLowerCase() === seg.toLowerCase() && b.repo_name.toLowerCase() === repoName
	);
	return legacy ? to(legacy, tail) : null;
}

// The web URL a widget tool's RESULT should carry, from the same table the app's
// address bar reads, so a link in the chat and the URL in the tab never disagree.
// Undefined for a tool with no URL, or a deployment with no web app (no `base`).
// `path` is the tool's own path argument: the page for view_page, the focus for
// view_graph, the scope for view_activity, the revealed folder for browse_brain.
export function webUrlFor(
	base: string | undefined,
	tool: string,
	brain: string,
	path?: string
): string | undefined {
	if (!base) return undefined;
	const route = WEB_TOOL_ROUTING[tool];
	if (!route || route.kind === 'none') return undefined;
	if (route.kind === 'path') return path ? `${base}${webPathFor(brain, path)}` : undefined;
	if (route.kind === 'root') return `${base}${webPathFor(brain, '', path ? { arg: path } : {})}`;
	return `${base}${webPathFor(brain, '', { view: route.token, ...(path ? { arg: path } : {}) })}`;
}

// ---------- does this deployment have a web app, and where? ----------

// The origin the web app is served from, or undefined when this deployment has no
// web app to link to. The route itself is mounted on the same three facts in the
// Worker; this is the one place they are asked together so a widget is never handed
// a base URL for a route that does not exist. Trailing slashes dropped so a path can
// be appended without producing `//b/`.
//
// oauth only: the cookie session is what Auth.js issues, and a static deployment has
// no sign-in and so no browser session to read, so `/b/` is not served there.
export function webBaseUrl(env: { authMode?: string; publicBaseUrl?: string }): string | undefined {
	if (env.authMode !== 'oauth') return undefined;
	const base = (env.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
	return base || undefined;
}

// ---------- is this /mcp request the web app's at all? ----------

// Which of the two auth paths a `/mcp` POST belongs to, decided on what the request
// CARRIES rather than on what it lacks.
//
// Why not "every request with no Bearer token": an MCP host's first contact is a
// POST with no credential at all, and the OAuth provider must answer it with `401` +
// `WWW-Authenticate: Bearer` so the host can discover the authorization server
// (`scripts/smoke.ts` asserts it). The cookie branch's bare `401 Not signed in` gives
// the host nothing to go on.
//
// A cookie is what a browser sends and an MCP client never does, so its presence is
// the discriminator. Whether the cookie holds a VALID session is the next question,
// answered by the session lookup; an expired one simply means a 401 from this path,
// which the app turns into a sign-in redirect. A Bearer token always wins: the
// provider owns that request, and the two paths must never be confusable.
export function claimsWebMcp(req: { hasAuthorization: boolean; hasCookie: boolean }): boolean {
	return !req.hasAuthorization && req.hasCookie;
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
