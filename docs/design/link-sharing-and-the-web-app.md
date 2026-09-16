# Design: sharing a page by link (and the web app behind it)

- Status: Phase 0 is BUILT (`src/lib/render.ts`, `pnpm test:render`). Phases 1-4 are a
  draft for discussion. Open questions in §16 are unresolved.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-24
- Audience: the engineering session that picks this up, and Jon deciding whether it should exist
- Related: `docs/design/brain-level-permissions.md` (the access rule this must not duplicate),
  `docs/design/brain-seams.md` (publishing to someone who HAS a brain),
  `docs/design/media-attachments.md` (assets, and what may be served),
  `docs/design/open-source-boundary.md` (nothing hosted-only),
  `CLAUDE.md` (Auth model, Content index, BrainStore, Deployment config)

## 1. Summary

A page in a brain has no URL. It can be read inside Claude through `view_page`, and it exists on
github.com at a path nobody in the org can open, because the product deliberately keeps members
away from GitHub: the App installs on one org, members are not repo collaborators, and that is
the point. The side effect is that the most ordinary request anyone makes of a knowledge base,
"send me that doc", has no answer.

This proposes two surfaces, deliberately separate:

- **The reader.** A revocable, expiring, server-rendered read-only page at a link, for a
  recipient with no account: a client, a candidate, a vendor, a colleague reading on a phone. No
  app bundle, no tools, no identity, no JavaScript required.
- **The web app.** The existing MCP App bundle, running in a browser tab against the same tool
  handlers, authenticated by the Auth.js session that already exists. This is what makes a link
  work for a colleague who does have access but is not in Claude at that moment.

The load-bearing claim is that the second one is far smaller than "build a web app" sounds. The
app couples to its MCP host through exactly five calls in one file (`app/core/host.ts`:
`callTool`, `openLink`, `getHostContext`, `requestDisplayMode`, and the theme appliers). Swap
that file and the same bundle runs anywhere. The tool layer needs no port either: identity
reaches `McpSession` as `props` (`user_id`, `email`, `gh_user_id`, `gh_login`, `org_id`), and a
browser session already produces the first two. The web app is another MCP client, holding a
cookie instead of a Bearer token.

The reader is the part that is genuinely new, and most of this document is about it, because it
is the part that puts brain content on the public internet.

## 2. The motivating case: one verb, three recipients

"Share this doc" means three different things, and the difference is who the recipient is:

1. **A colleague in the org.** They already have access under `effectiveBrainRole`. What they
   lack is a URL, and a place to open it. Sharing here grants nothing; it is navigation.
2. **Someone outside the org.** A client reading a proposal, a candidate reading a role
   description, a vendor reading an integration note. They must not get an account, an org
   membership, or anything beyond the one page.
3. **Everyone.** A public handbook, a changelog, a methodology page. Same machinery as (2) with
   no secret in the URL and an explicit act to opt in.

Case 1 is the web app. Cases 2 and 3 are the reader. Building one surface for all three is the
failure mode: it either drags an authenticated app bundle in front of anonymous readers, or it
drags anonymous-reader semantics into the app.

There is a fourth recipient already designed for elsewhere. A person who **has their own brain**
and needs the content to live in it is publishing, not sharing, and belongs to
`docs/design/brain-seams.md`. A link is a window; a publication is a copy with a ledger. Do not
let this design grow into that one.

## 3. What exists today, and what does not

Built and reusable:

- **Identity in a browser.** Auth.js with a Resend magic link (`src/auth/config.ts`), database
  sessions in D1, cookies on the Worker's own origin, `/auth/*` owned by the OAuth provider's
  `defaultHandler`. A signed-in browser is already a solved problem.
- **Authorization.** `effectiveBrainRole` (`src/lib/orgs.ts`) is the single authority on who can
  reach a brain and at what role, with `pnpm test:access` walking its whole input space.
- **Content.** `BrainStore` reads pages and blobs, `ensureFresh` guarantees the content index is
  not stale relative to the branch, `renderViews` executes `okf-view` fences,
  `buildWikilinkIndex`/`resolveWikilink` resolve links the way the viewer does.
- **Rendering.** `renderMarkdown` in `app/core/actions.ts` (wikilink pre-pass, then `marked`).
- **A public HTML surface.** The Worker already serves the install-callback card pages, so
  serving HTML from `fetch` ahead of the OAuth provider is an established pattern, not a new one.

Not built: any URL for a page, any notion of a share, any HTTP route that serves content, any
asset route (images reach the app as base64 through `read_media`), and any HTML sanitization.

## 4. The reader

### 4.1 It is server-rendered, and that is the design

The reader does not serve the app bundle. It renders HTML in the Worker and sends it.

- The bundle is ~1MB of generated JavaScript whose entire purpose is calling tools. An anonymous
  reader may call no tools, so nearly all of it would be dead weight guarded by a flag, and a
  flag is one bug away from being the wrong value.
- A share link is pasted into Slack, iMessage, and email. Those clients fetch it with a bot that
  runs no JavaScript. A server-rendered page unfurls; a client-rendered one shows a spinner
  forever, or nothing.
- The blast radius argument is the strongest one. An anonymous surface that cannot call tools
  cannot be tricked into calling one.

### 4.2 A share is a row, and the token is a credential

New table `page_shares` (migration `0007`), additive per the expand-then-contract rule:

| column                                                 | meaning                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `share_id`                                             | primary key, the public path segment                                           |
| `token_hash`                                           | SHA-256 of the secret. **The secret itself is never stored**                   |
| `brain_id`                                             | `owner/repo`, the same key the content index uses                              |
| `scope_path`                                           | one page, or a folder prefix for a subtree share                               |
| `pinned_sha`                                           | null for live, else the commit this share is frozen at                         |
| `audience`                                             | `link` (secret in URL), `email` (recipient must sign in), `public` (no secret) |
| `created_by`, `created_at`, `expires_at`, `revoked_at` | provenance and lifecycle                                                       |
| `view_count`, `last_viewed_at`                         | aggregate only, see §12                                                        |

Storing a hash rather than the secret is the one thing here that cannot be retrofitted. A share
URL is a bearer credential; D1 rows land in exports, backups, and any future admin screen. The
URL is shown once at creation, exactly like an API key, and a lost one is regenerated rather
than recovered.

`share_id` and the secret are separate path segments (`/s/<share_id>/<secret>`) so a lookup is
one indexed read and the comparison is constant-time against the hash.

### 4.3 Live by default, pinnable on request

A share resolves against branch HEAD through the same `ensureFresh` guard every read tool uses,
and the rendered page carries a visible "as of" stamp. The alternative, freezing at creation, is
the failure people actually complain about: a client reads a proposal you corrected an hour
after sending it.

`pinned_sha` exists for the case where that is exactly what you want (a proposal that must not
change under a client mid-negotiation). It reads through `listCommits`/`branchCommitSha`, which
are already on `BrainStore`. A pinned share says so on the page.

### 4.4 The link horizon

A shared page links to other pages. Those pages are not shared. Every link is classified at
render time against the share's scope:

- Inside the scope: rewritten to a URL under the same share.
- Outside it: **flattened to plain text**, keeping the link text and dropping the target.
- External `http(s)`: left alone, with `rel="noopener nofollow"` and the referrer suppressed
  (see §12).

Flattening rather than 404-ing is the rule `brain-seams.md` §7 reaches for at a publication's
horizon, for the same reason: a dead link advertises the existence and the title of a page the
reader was not given. A flattened one says nothing.

Unresolvable wikilinks already render as literal `[[text]]` in the app. In the reader they render
as their label, since a reader has no way to fix them and no interest in the syntax.

### 4.5 Assets

`![](assets/diagram.png)` on a shared page needs bytes at a URL. `GET /s/<id>/<secret>/a/<path>`
fetches the blob through the brain's installation token and serves it with a long
`Cache-Control` and an ETag from the blob sha.

Three refusals, each inherited rather than invented: the path must be inside the share's scope,
the extension must be in the `MEDIA_TYPES` allowlist (`src/lib/media.ts`), and the response is
capped at `MAX_ATTACHMENT_BYTES`. SVG is in that allowlist for the app, where it renders inside
the host's sandboxed iframe. **On the reader it is served as a download, never inline**, because
an SVG is a document that can carry script and it would be served from our origin.

### 4.6 Sanitization is required here, and is missing today

`PageView.tsx` renders `renderMarkdown(body)` through `dangerouslySetInnerHTML`, and nothing
sanitizes it. Markdown permits raw HTML, so a page body can carry a `<script>`. Inside the MCP
App this is bounded: the content author already has write access to the brain, and the host
iframe's CSP constrains what the script can reach.

Served from our own origin, next to a session cookie, the same body is stored XSS against every
reader and against the web app in §5. Two mitigations, both required:

1. **Sanitize in the shared render module** (§7), on an allowlist, for both consumers. The app
   gets the fix too, which it should have anyway.
2. **A strict CSP on reader responses** (`default-src 'none'`, `img-src 'self'`,
   `style-src 'self'`, no `script-src` at all) and, if a distinct hostname is available, serve
   the reader from one so no session cookie is in scope. See §16, question 3.

## 5. The web app

The signed-in surface, and the smaller half of the work.

**Transport.** The web client speaks MCP over HTTP to the same `/mcp` handler, authenticated by
the Auth.js session cookie instead of an OAuth Bearer token. `McpSession` reads identity from
`props`, so the change is one branch that builds `props` from a validated session
(`{ user_id, email }`) when there is no Bearer. Everything downstream is untouched: tenant
resolution, `effectiveBrainRole`, the two-scope gating, usage analytics, error shapes. The web
app is structurally incapable of doing something the connector cannot, which is the property
worth protecting.

Two consequences to handle deliberately. A cookie-authenticated POST needs CSRF defence (an
`Origin` check plus `SameSite=Lax` cookies, since the endpoint is same-origin only), and the
session-derived path must be unreachable when a Bearer token is present, so the two auth modes
cannot be confused.

**Host adapter.** `app/core/host.ts` becomes an interface with two implementations:

| host call            | MCP host (today)                         | web host                               |
| -------------------- | ---------------------------------------- | -------------------------------------- |
| `callTool`           | `app.callServerTool` over AppBridge      | `POST /mcp` with the session cookie    |
| `openLink`           | `app.openLink`                           | `window.open`                          |
| `getHostContext`     | host-provided theme, fonts, display mode | `prefers-color-scheme`, own stylesheet |
| `requestDisplayMode` | host negotiation                         | no-op, the tab is fullscreen           |
| theme appliers       | host style variables                     | the app's own tokens                   |

`pnpm gen:app` grows a second target, or the adapter is selected at runtime by whether an
AppBridge handshake completes. Runtime selection keeps one bundle and one codegen step, at the
cost of a small amount of dead code in each context.

**Deep links.** `/b/<brain>/<path>` opens the app on that page, redirecting to sign-in and back
when there is no session. This is the URL a colleague gets, and it grants nothing: access is
still `effectiveBrainRole`, so a link to a brain they cannot reach shows the same refusal it
would show in Claude.

## 6. Authorization: what needs permission, and what does not

The rule, and the sentence that decides every case below: **a link that grants nothing needs no
permission; a link that grants something is a grant.**

- A deep link into the web app (§5) grants nothing. Anyone who can read the page can send it,
  the same way anyone can paste a paragraph into Slack. No new gate.
- A share link (§4) grants read access to someone who had none. It is a grant, and it gates on
  the **brain role** at `admin`, matching `share_brain` in `src/tools/brain-access.ts`.
- A `public` share is a further step and is refused unless the brain's own config opts in
  (`publishing: { public: true }` in `.isomorphic.json`). Making a page world-readable should
  require touching the repository, not only a tool call, because the repository is the artifact
  the org's owner actually controls.

**`effectiveBrainRole` gains no new input.** It is the org-membership rule and its three additive
sources are load-bearing (`pnpm test:access` pins them). A share is not a fourth source and must
never become one: it is scoped to a path set, capped at read, and belongs to nobody. Adding an
anonymous principal there would mean every consumer that resolves a role has to remember that
some roles cannot see the rest of the brain.

Instead the reader resolves its own narrow context and never constructs a `TenantContext`:

```
ShareContext = {
  brainId, repoArgs, store,     // enough to read
  scopePath, pinnedSha,         // what may be read
  config                        // the brain's content shape
}
```

No `role`, no `orgRole`, no `orgId`, no `actorUserId`, no octokit. A share cannot be handed to a
tool, because the tools require the type it does not have. That is a compile-time guarantee
rather than a review convention, which is the same trick `pnpm test:scope` plays with its
throwing Proxies.

## 7. What moves into `src/lib/`

Markdown-to-HTML is currently in the app bundle, and the reader needs the same output or the two
surfaces will drift in exactly the way `wikilinkKey` and `FOLDER_NOTE_NAMES` were extracted to
prevent. Move it:

- **`src/lib/render.ts`** (pure, Worker-safe, no `node:*`): wikilink pre-pass, `marked`, the
  task-list fixup, sanitization, and link classification against a supplied horizon. The app
  imports it (`renderMarkdown` becomes a thin call), the reader imports it, and
  `pnpm test:render` pins both.
- The link-horizon rule lives beside `classifyMdLink` in `src/lib/links.ts`, which already owns
  "one rule for link classification" for exactly this reason.

`marked` moves from `devDependencies` to `dependencies`, since the Worker now ships it. It is
pure JavaScript with no Node built-ins, so this is a bundle-size question rather than a runtime
one, and the Worker's size headroom should be checked against `docs/references.md` before the
first commit.

## 8. Tool and app surface

One new tool, which is a real cost against a surface deliberately consolidated from 42 to 30:

**`share_page`** (brain admin+), following `share_brain`'s "every mutation in one verb" shape:
create a link, list the links on a path, change expiry or audience, revoke (`audience: 'none'`).
It returns the secret URL exactly once, on creation. It is one tool rather than three because the
alternative is `create_share` / `list_shares` / `revoke_share`, and the roster of who can read
this page is one question with one answer.

`TOOL_KINDS` in `src/lib/usage.ts` gains an entry for it, classified as an **edit**: it changes
who can read the brain, and `pnpm test:usage` fails the build if it is left unclassified.

In the app, a **Share** control in the page header opens a sheet listing existing links with
their expiry and open count, plus "create link". It is the page-scope twin of
`BrainAccessView.tsx` and follows the same `app/ui/Flow.tsx` push convention every add-shaped
action uses.

`SERVER_INSTRUCTIONS` gains one line, per the descending-reach pattern used for folder notes and
OKF: sharing exists, it is per page, and it is a grant.

## 9. Configuration and the open-source boundary

- **`SHARE_BASE_URL`**, a new `__DOUBLE_UNDERSCORE__` token in `wrangler.template.jsonc` with a
  matching entry in `SETTINGS` (`scripts/setup-config.ts`), defaulting to `PUBLIC_BASE_URL` so a
  self-hosted deployment gets working links with no extra setup. A token added to the template
  without a `SETTINGS` entry is a hard error, which is the behaviour that keeps this honest.
- **`SHARING`** (`"true"` by default): with it off, `share_page` is not registered and the reader
  routes 404. Same shape as `USAGE_ANALYTICS` and `FEEDBACK_REPO`. An operator who does not want
  their Worker serving anonymous content turns it off and the surface disappears rather than
  sitting there refusing.
- Nothing here may depend on our domain, our org, or our deployment. The hosted service is a
  deployment of `main`, and a self-hoster's shares live on their own origin.

## 10. Implementation plan

**Phase 0: extract the renderer. BUILT.** `src/lib/render.ts` plus sanitization, the app switched
onto it, `pnpm test:render`. No user-visible change, and it fixes an unsanitized `innerHTML` that
was a latent bug regardless of whether the rest of this gets built.

Three things came out of building it that this document had wrong or did not know:

- **`marked` sanitizes nothing whatsoever**, which is worse than §4.6 assumed. Not just raw
  HTML: `javascript:` and `data:` hrefs pass through on links _and_ images, and
  `&#106;avascript:` / `javascript&colon;` reach the browser decoded while a scheme test on the
  raw string sees no scheme at all. The scheme check has to decode entities first.
- **The allowlist is over TAGS WITH ZERO ATTRIBUTES, not over tags and attributes.** With no
  attributes there is no `on*`, no `style`, no `href`, so a listed tag cannot carry a payload.
  `a` and `img` are off the list: markdown's own syntax routes through the renderer where the
  scheme is checked, and a raw anchor would bypass exactly that. Disallowed markup is escaped
  rather than dropped, so it becomes visible to its author instead of silently vanishing.
- **The horizon rule (§4.4) is already in place** as the `href` hook: returning `null` flattens
  a link to plain text. Phase 1 supplies the scope predicate; the renderer needs no further
  change for it, and `pnpm test:render` already pins flatten-keeps-text.

**Phase 1: single-page share links.** Migration `0007`, `share_page`, the reader route and the
asset route in `fetch` ahead of `oauthProvider.fetch`, the link horizon, the app's share sheet.
This is the ask, end to end, and it is shippable on its own.

**Phase 2: subtree shares.** `scope_path` as a prefix, plus a minimal nav rendered from the
shared subtree's folder notes. Mostly a rendering change, since the model already carries a
prefix.

**Phase 3: the web app. BUILT (not yet browser-verified).** Cookie-authenticated `/mcp`, the web
host adapter, `/b/<brain>/<path>` deep links, sign-in and return. Taken FIRST rather than second,
on the owner's call: the motivating want is opening pages in a browser alongside the chat, and the
renderer (Phase 0) was the only thing Phase 1 was going to hand it anyway.

What building it changed about this document:

- **The host seam was leakier than §1 claims.** `app/core/host.ts` exported the raw `App` object
  and five call sites in four files reached through it for `openLink` and `getHostContext`, so
  "swap that file and the same bundle runs anywhere" was not true until those were routed through
  named functions.
- **The adapter is chosen by a FLAG stamped at serve time, not by a handshake that times out.**
  Runtime selection as §5 suggests would make every web boot pay the AppBridge timeout, and would
  make a slow MCP host indistinguishable from a browser.
- **No `initialize` is needed, and the `accept` header is.** A bare `tools/call` POST is answered
  `200` because the transport is stateless; the same request is refused `406` unless it accepts
  BOTH `application/json` and `text/event-stream`, even though no stream is ever opened. Verified
  against the real handlers, recorded in `docs/references.md`.
- **§5's CSRF note needed a third layer.** `Origin` plus `SameSite=Lax` leaves the case where a
  browser sends no `Origin` at all, so the content type must also be JSON: an HTML form can only
  POST three types, none of them JSON, which is what puts this endpoint out of a form's reach even
  with the cookie attached.
- **Still open:** no browser-level coverage of the app in web mode (a harness route driving the
  real bundle against a stubbed `/mcp`), and `script-src` still carries `'unsafe-inline'` because
  the bundle inlines its own JS. Hashes belong in `pnpm gen:app`.

The **session bootstrap link** considered alongside this (a short-lived URL minted by an MCP tool
that plants a session in whatever browser opens it) was **deliberately not built**. It only buys
the two environments a cookie cannot reach, `web_fetch` and a fresh sandboxed browser profile;
Claude in Chrome already carries the user's cookies, and Claude Code's desktop browser persists a
session when that is enabled. Weighed against putting a credential for a whole account into a
conversation transcript, that was not worth it without evidence the cookie path actually falls
short. Revisit only with that evidence, and then with a two-minute lifetime and a session scoped
to brain read/write rather than the full account.

**Phase 4, maybe never: a public site.** Custom domain per brain, sitemap, indexable pages. It is
the same machinery as an `audience: 'public'` share with a hostname in front, and it should not
be designed until somebody asks for it.

## 11. Tests

Per the repo's rule, in the same change, and named where each battery would fail:

- **`pnpm test:share`** (new, pure): token hashing and comparison, scope matching for page and
  prefix shares, expiry and revocation, the link horizon (a link out of scope flattens, a link in
  scope rewrites, an external link survives), asset scope refusal, SVG served as an attachment,
  and that a `ShareContext` cannot satisfy a tool's `TenantContext`.
- **`pnpm test:render`** (new, pure): the app and the reader produce the same HTML for the same
  body, and a body carrying `<script>`, `<iframe>`, `onerror=`, and a `javascript:` href comes
  back inert. Break the sanitizer deliberately and confirm this goes red before believing it.
- **`pnpm test:scope`** (extend): `share_page` gates on brain role at `admin`, in both
  directions, with the store trapped by the throwing Proxy so an authz test cannot reach storage.
- **`pnpm test:usage`** (automatic): fails until `share_page` has a `TOOL_KINDS` entry.
- **`pnpm test:ui`** (extend): the share sheet mounts and lists, and a harness route renders a
  reader page so the flattened-link and no-JavaScript cases are covered where they live.
- **`pnpm test:wiring`** (automatic): both new batteries in `package.json` and `ci.yml`.
- **`scripts/smoke.ts`** (extend): an unknown share id 404s, and a reader response carries the CSP
  and `noindex` headers. Both are unauthenticated reads, so they are safe against production.

## 12. Failure modes the public internet brings

- **Prefetch.** Email clients and link scanners fetch URLs before a human sees them. This
  deployment has already been bitten by it (magic-link auth, `CLAUDE.md` Auth model). So a share
  link must be **idempotent on GET**: no one-time tokens, no burn-on-read, and a fetch must never
  consume or invalidate a share.
- **Unfurl bots.** Slack and Google fetch the page to build a preview card. That is desirable
  (send `og:title` and `og:description` from the page's title and description) and it means view
  counts include bots. Count them, do not try to detect them, and label the number "opens" rather
  than "readers".
- **Referrer leakage.** The secret is in the path, so an outbound click would send it in the
  `Referer` header. `Referrer-Policy: no-referrer` on every reader response, and
  `rel="noopener nofollow"` on external links.
- **Indexing.** `X-Robots-Tag: noindex, nofollow` on every `link` and `email` share. Only `public`
  shares omit it, and only they get a sitemap. A search engine indexing a client proposal because
  a robots header was forgotten is the incident this line prevents.
- **Enumeration.** 128 bits of secret from `crypto.getRandomValues`, constant-time comparison, and
  identical 404s for unknown, expired, and revoked shares. A distinguishable "expired" confirms
  that the share existed.
- **View records are not telemetry, and must not become it.** Aggregate counters on the share row
  stay in the deployment's own D1, exactly like `usage_daily`. **No IP address, no user agent, no
  per-view rows.** A reader is often someone with no relationship to the operator at all, and the
  no-telemetry rule is about where data goes, not about whether counts exist.

## 13. What this is not

- **Not comments or suggestions.** A recipient reads. Feedback comes back through whatever channel
  the link was sent on.
- **Not editing by link.** A write path reachable without an account is a different security
  posture, and nothing in the motivating case needs it.
- **Not a CMS or a theme system.** The reader renders the brain's own styling and nothing else.
- **Not publishing.** A recipient who has a brain should receive a copy with a ledger
  (`brain-seams.md`), not a window.
- **Not an export.** PDF and markdown download are a smaller, unrelated feature. A link stays live
  and can be revoked; a file can be neither.

## 14. Rejected alternatives

- **Add the reader to `effectiveBrainRole` as a fourth source.** Rejected in §6. The rule is
  additive, never demotes, and returns a role that means "on this brain". A share means "on this
  path, forever read-only, to nobody in particular", which is a different type.
- **Serve the app bundle in read-only mode to anonymous readers.** Rejected in §4.1. A megabyte of
  tool-calling client behind a flag, and no unfurl.
- **Make the brain repo public and link to github.com.** It shares the entire brain to share one
  page, exposes commit history and authorship, and hands a non-technical recipient a rendering of
  raw OKF with `okf-view` fences in it.
- **Grant the recipient a `viewer` membership.** It gives them the whole brain, adds a row to the
  roster of an org they do not belong to, and requires them to have an account and sign in to read
  a page someone chose to give them.
- **Mint a signed token instead of a database row.** Stateless and cheap, and unrevocable.
  Revocation is the feature that makes sharing safe to do casually.

## 15. Effort

Phase 0 is a day. Phase 1 is the bulk of the work: a migration, a tool, two routes, the horizon
rule, a sheet in the app, and two new test batteries. Phase 3 is smaller than it looks (an auth
branch, a host adapter, a route) and larger than it sounds in review, because sign-in, redirect
return, CSRF, and cookie scoping each have to be right.

## 16. Open questions for the owner

1. **Which phase first?** This document argues Phase 1 (the reader) because it answers the literal
   request and ships alone. The case for Phase 3 first is that a colleague with access is the most
   common recipient, and a web app makes every other feature reachable outside Claude. If the real
   want is "Isomorphic has a web app", the order flips.
2. **Live or pinned by default?** §4.3 recommends live. A consulting engagement may want the
   opposite default, and it is one column either way.
3. **A separate hostname for the reader?** Cleanest for cookie and CSP isolation
   (`share.<domain>`), at the cost of a second DNS record and a second custom-domain binding in
   the Cloudflare dashboard, which every self-hoster then also has to do. A single origin with a
   strict CSP and cookie-path scoping is probably sufficient, and this should be decided before
   Phase 1 rather than migrated afterwards.
4. **Does the `email` audience earn its place in v1?** It requires the recipient to sign in, which
   means an account, which the motivating case says they should not need. It may be the right
   default for internal-but-sensitive pages, or a v2 nobody asks for.
5. **Expiry default.** No expiry is friendliest and accumulates forever. 30 days is safe and
   generates support requests. A default with a visible "extend" control in the sheet is probably
   the answer, but the number is a product call.
