---
paths:
  - "src/lib/{web-app,web-shell,brain-slug}.ts"
  - "src/local.ts"
  - "app/main.tsx"
  - "app/core/{host,host-web,store}.ts"
  - "scripts/{test-web,web-dev}.ts"
  - "tests/ui/web-nav.spec.ts"
---

# The web app (the same bundle, in a browser tab)

Design: `docs/design/link-sharing-and-the-web-app.md`. `/b/<brain>/<path>` serves the
SAME generated bundle as the `ui://` resource, authenticated by the Auth.js session cookie.
Rules live in `src/lib/web-app.ts` (pure, `pnpm test:web`); routes in the Worker's `fetch`,
ahead of the OAuth provider.

- **It is another MCP CLIENT holding a cookie instead of a Bearer token.** The port is one
  branch that builds `props` from a validated session; tenant resolution, `effectiveBrainRole`
  and analytics are the code that already runs, so the web app cannot do anything the connector
  cannot. **Anything that widens what a caller can do belongs in a tool, not in this route.**
- **The cookie branch claims a `/mcp` request by what it CARRIES** (`claimsWebMcp`: a cookie
  and no Bearer). Claiming every Bearer-less request would steal an MCP host's first contact,
  which the OAuth provider must answer `401` + `WWW-Authenticate: Bearer` (the smoke check
  asserts it).
- **The cookie `/mcp` branch is a CSRF-shaped write endpoint.** `checkWebMcpRequest` is the
  gate: a Bearer token is refused outright (the two auth paths must never be confusable), the
  `Origin` must match, `Sec-Fetch-Site: cross-site` is refused, and the content type must be
  JSON (no HTML form can send it).
- **The host seam is `app/core/host.ts`; nothing outside it touches `App`.** `callTool`,
  `openLink`, `connectHost`, `registerHostEvents`.
- **Which host is serving is a FLAG stamped at serve time** (`window.__ISO_WEB__`), never
  inferred from an AppBridge timeout. `pnpm test:web` asserts the bundle never sets it itself.
- **`parseWebPath` and `webPathFor` are inverses in ONE module**, imported by Worker and app.
- **The URL is written as well as read** (`syncAddressBar`, `registerWebNavigation` in
  `host-web.ts`). `show()` in `app/core/store.ts` is the one chokepoint; `push: false` replaces
  the history entry. Dead code in the MCP App (`isWebHost()` is false).
- **Back/forward must parse `location.search` too**, since every non-page destination lives
  there. Its test must navigate IN-APP: two `page.goto`s and a `goBack` re-boot from the URL
  and pass with the bug reinstated.

## `WEB_TOOL_ROUTING`: what has a URL

The one list (`src/lib/web-app.ts`), keyed on the WIDGET TOOL. `pnpm test:web` scans
`registerAppTool` call sites and fails on any tool that is neither addressable nor carrying an
explicit `why` it is not. **Every new widget tool needs a decision here.**

- **The token is an alias, not the tool name**, so a tool rename or merge does not break links
  already sent.
- **Path space is only ever pages.** Destinations ride the query string (`?view=<token>` plus
  at most one argument); `/b/<brain>/graph` is a page called `graph`.

## Brain slugs and old links

- **The brain segment is ONE path segment: `<name>-<handle>`** (`src/lib/brain-slug.ts`), the
  `id` every brain payload carries (`listAccessibleBrains`). `brains.handle` is six random hex
  characters (migration 0012; a row without one is given one when first listed). The handle
  identifies the brain; the name part is for people and goes stale on rename.
- **A URL is a contract.** `canonicalWebPath` (pure, `pnpm test:web`) decides the Worker's
  `301` for a stale name (followed by handle) and for `/b/<owner>/<repo>/...` (every link made
  before slugs). It runs AFTER sign-in, over the caller's own brains only, so a redirect says
  nothing about a brain the caller cannot reach. Tools accept the same aliases through
  `matchBrain`.
- **Never build a URL or a `brain` argument from `owner/repo`.** It is where a brain is
  stored, which a relocation changes; use the brain's `id`.
- **Three questions, all must pass:** would you send it, can the URL alone rebuild it, is
  arriving cold harmless. `edit_page` fails the last two.
- **Org-scope screens (`members`, `analytics`) are addressed through a brain**, deliberately;
  an org-keyed prefix is deferred (`org_id` is the only unique handle and it is a uuid). See
  `docs/design/org-scope-resolution.md`.

## Local and window behavior

- **The local runtime IS the web host locally.** `src/local.ts` serves the shell at
  `/b/<folder>` with the same `webShell` / `WEB_APP_HEADERS` (`web-shell.ts`) and
  `checkWebMcpRequest`; `pnpm web:dev` is "seed, then `pnpm try`". Browser tests are Playwright's
  `web` project. Do not build a second server or proxy; `pnpm app:dev` cannot stand in for it
  (it mounts the bundle over AppBridge, so `host-web.ts` is unreachable). Both hosts seed from
  `dev/seed.ts`. The local runtime has no session and reports `owner` for everything: right for
  behavior, wrong for access.
- **A tab owns its window:** the web host starts in `fullscreen` and stamps `:root.web`; the
  tab title follows `pageTitle`.
- **"Open in browser"** is in the header's window group (`WindowControls` in `app/main.tsx`).
  The widget builds the URL (`webLinkFor` in `store.ts`) from `features.webBase` on the `brains`
  payload (`webBaseUrl`: authjs + `PUBLIC_BASE_URL`, else absent). Never on the web host or the
  editor. Every widget result (`view_page`, `browse_brain`, `view_graph`, `view_activity`)
  carries `webUrl` in BOTH `structuredContent` and the text: hosts that get
  `structuredContent` drop the text. `test:e2e-librarian` pins both. `read_page` carries none.
- **`script-src` still carries `'unsafe-inline'`** because the bundle is one self-contained
  HTML file. Hashes belong in `pnpm gen:app`, never a blind replace over minified JS.
  Markdown-borne XSS is closed at the source by `src/lib/render.ts`.

`pnpm test:web` pins the sign-in redirect (`callbackUrl`); `tests/ui/web-nav.spec.ts` covers
navigation. The full sign-in round trip through a real Auth.js session has no automated
coverage: click through it on a preview version when changing auth.
