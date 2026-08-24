# Authoritative references

External sources of truth for the tech this repo is built on. When something about
MCP Apps, the MCP SDK, the ProseMirror editor, or the Cloudflare deploy target is
unclear, check here first and read the primary source — don't answer from memory
(these move fast). Add to this list whenever a load-bearing external fact is found.

---

## MCP Apps / SEP-1865 (the extension the brain UI is built on)

The in-client viewer/editor (`ui://isomorphic-mind/brain-app.html`) is an **MCP App**:
a server-declared HTML resource the host renders in a sandboxed iframe, linked from a
tool via `_meta.ui.resourceUri`, talking back over `tools/call`.

- **Spec (SEP-1865, "Final"):** https://modelcontextprotocol.io/community/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- **Overview:** https://modelcontextprotocol.io/extensions/apps/overview
- **ext-apps repo (spec + SDK, `@modelcontextprotocol/ext-apps`):** https://github.com/modelcontextprotocol/ext-apps
- **Versioned spec (dated snapshots):** https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- **API reference (generated):** https://apps.extensions.modelcontextprotocol.io/
- **Blog announcements:** https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/ · https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/

We use `@modelcontextprotocol/ext-apps`: `/server` (registerAppTool / registerAppResource
/ RESOURCE_MIME_TYPE) on the Worker, `App` + `PostMessageTransport` in the iframe, and
`AppBridge` on the host side (used by the local preview harness).

## Claude as an MCP Apps host

- **Claude MCP Apps design guidelines (host-specific: display modes, sizing, layout):**
  https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
- **Known host-rendering gaps (why an iframe may not mount despite a correct payload):**
  - ext-apps#671 — https://github.com/modelcontextprotocol/ext-apps/issues/671
  - anthropics/claude-ai-mcp#236 — https://github.com/anthropics/claude-ai-mcp/issues/236

## MCP core + TypeScript SDK

- **MCP spec / docs:** https://modelcontextprotocol.io
- **TypeScript SDK (`@modelcontextprotocol/sdk`):** https://github.com/modelcontextprotocol/typescript-sdk

## Editor stack (Phase D WYSIWYG)

- **ProseMirror guide + reference:** https://prosemirror.net/
- `prosemirror-markdown` (parse/serialize): https://github.com/ProseMirror/prosemirror-markdown
- `prosemirror-tables`: https://github.com/ProseMirror/prosemirror-tables
- Preact (React-compat runtime, via `preact/compat`): https://preactjs.com/
- Tailwind CSS v4 (CSS-first): https://tailwindcss.com/docs

## Open Knowledge Format

- **OKF v0.2 specification:** https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- `status` is an optional lifecycle field with values `draft | stable | deprecated`;
  absence means `stable`. `type` is the only always-required frontmatter key.

## Deploy target

- **Cloudflare Workers limits (script size, etc.):** https://developers.cloudflare.com/workers/platform/limits/
- Wrangler: https://developers.cloudflare.com/workers/wrangler/
- **Gradual deployments / versions / rollback:** https://developers.cloudflare.com/workers/configuration/versions-and-deployments/
- **Preview URLs:** https://developers.cloudflare.com/workers/configuration/previews/

---

## Verified facts worth remembering

Non-obvious things confirmed against the sources above (with the "why it bit us"):

- **`wrangler versions upload` inherits the Worker's secrets; `wrangler deploy` is what you
  give up to get a rollback.** Verified against wrangler 4.85 on 2026-08-18. Secrets set with
  `wrangler secret put` carry into a new version and are only replaced when `--secrets-file`
  is passed, so splitting `deploy` into `versions upload` + `versions deploy` costs nothing in
  secret handling. Machine-readable output comes from `WRANGLER_OUTPUT_FILE_DIRECTORY`, which
  makes wrangler write ndjson records; the `version-upload` entry carries `version_id`,
  `preview_url`, and `preview_alias_url`, so nothing has to scrape stdout. `deployments status
--json` gives the live version as `.versions[] | select(.percentage == 100) | .version_id`,
  and `versions list --json` is **ascending**, so the second-newest is `.[-2]`, not `.[1]`.

- **This Worker DOES get preview URLs, despite the Durable Object migrations array.**
  Cloudflare withholds them from Workers implementing a DO, and `wrangler.template.jsonc`
  still carries the append-only `migrations` array declaring `IsomorphicMindMcp` new in v1 and
  deleted in v2, which looked like it might disqualify us and would have sunk both the deploy
  pipeline's pre-promotion check and the preview-environments design. It does not: the check
  keys off bindings, not that array. The verdict is per version, reported by the server as
  `metadata.has_preview`, and it is `true` on every version from number 77 onward, which is
  when `preview_urls: true` entered the config. Read it with
  `wrangler versions list --json | jq '[.[] | {number, preview: .metadata.has_preview}]'`.
  **Adding a Durable Object binding takes this away silently**, so anything depending on it
  should branch on `has_preview` rather than assume.

- **`server._registeredTools[name]` stores the function as `handler`, NOT `callback`**
  (SDK 1.29, verified against the installed package). Two things in `src/worker.ts`
  reach into this private map: the claude.ai compatibility shim (which blanks
  `.execution`) and usage instrumentation (which wraps the function). The first
  version of the wrapper used `.callback`, which is `undefined` there, so it threw on
  `.bind()` and would have failed every request the moment `USAGE_ANALYTICS` was
  switched on. Nothing caught it: reaching into privates requires an
  `as unknown as` cast, which turns typechecking off exactly where it was needed, and
  the flag was off locally. `pnpm test:usage` now pins the field name AND drives a
  real `tools/call` over an in-memory client/server pair, because the field existing
  does not prove the SDK still dispatches through it (if `registerTool` closed over
  the original function, replacing the property would be a silent no-op and every
  counter would read zero forever). Re-run that test after any SDK bump.

- **MCP Apps display modes are `inline | fullscreen | pip`** — there is **no "sidebar"
  host mode.** A sidebar is a layout you build _inside_ a fullscreen app (Claude's design
  guidelines recommend exactly that for editors). PiP is a floating window, not a dock.
  The app opts in via `app.requestDisplayMode({ mode })` after checking
  `availableDisplayModes` in host context.
- **Resource MIME type is `text/html;profile=mcp-app`**; tool→app link is
  `_meta.ui.resourceUri` (nested form; legacy flat `_meta["ui/resourceUri"]` is
  deprecated).
- **The host's border default is PER-PLATFORM, not per-host.** An app that does not
  declare `_meta.ui.prefersBorder` renders borderless on web and **bordered on mobile**
  (Claude's design guidelines, "Borderless inline"). This app draws its own bordered
  card in inline mode, so the unspecified default nested a border inside a border on
  phones and nowhere else. It is declared `false` on the `ui://` resource, at both the
  `resources/list` entry and the `resources/read` content item (the content item wins
  when both carry `_meta.ui`). Borderless also means no host padding, which is what
  otherwise absorbs `hostContext.safeAreaInsets`, so the app owes those insets on
  mobile. Pinned by `pnpm test:appmeta`.
- **Inline cards size to the app's own content height, with no minimum.** The SDK's
  `autoResize` measures `documentElement` and reports it via
  `ui/notifications/size-changed`, so a one-line render gets a one-line card. The
  design guidelines cap what belongs in one: no nested scrolling, at most 2 actions
  and 4-5 data points, "No drill-ins, breadcrumbs, or multiple views". On mobile a
  vertical pan starting inside an inline app is handed to the CONVERSATION scroll,
  so an inline app's own vertical scroll container does not work there at all.
- **claude.ai may not mount the iframe even with a byte-correct protocol exchange**
  (ext-apps#671) — client-side, not fixable from the server. Verify payloads with a
  known-good host (MCPJam Inspector, VS Code Copilot) to isolate host vs. server.
- **The iframe CSP blocks all external hosts** — no CDN, no external stylesheet/font, no
  code-splitting. Everything ships inlined in the one `ui://` resource (`pnpm gen:app`).
- **NATIVE FORM SUBMISSION DOES NOT WORK IN THE APP IFRAME.** The frame is sandboxed, and
  without `allow-forms` the browser blocks submission outright:
  `Blocked form submission to '' because the form's frame is sandboxed and the
'allow-forms' permission is not set.` **Blocked means the `submit` event is never
  DISPATCHED**, so an `onSubmit` handler never runs at all — a correct
  `e.preventDefault()` inside it never gets the chance, which is what makes this so easy
  to miss in review. It takes out the keyboard too, since Enter in an input triggers the
  same native submission. This silently killed all four add-shaped flows (invite member,
  share brain, connect account, add brain): the button appeared to do nothing, with no
  toast and no error. So drive every flow from an explicit `onClick`, and handle Enter
  yourself (`submitOnEnter` in `app/ui/Flow.tsx`). Keep the `<form>` for semantics and
  autofill; never depend on its submit event. Found by `pnpm test:ui`, which renders the
  app in a sandbox exactly like a host's — and note the sandbox flags are the HOST's
  choice, not something the app can request, so this is not fixable from our side.
- **Cloudflare Worker script limit: 3 MB compressed (Free) / 10 MB (Paid), 64 MB
  uncompressed.** The app HTML is compiled _into_ the Worker, so it counts against this.
  Design the app bundle for ≤~500 KiB uncompressed for boot latency; the hard wall is
  far above that.
- **String-replacement codegen corrupts JS:** injecting a bundle with
  `String.replace(marker, code)` makes `$&`/`$$`/`$1`… in the payload act as patterns.
  Always use a **replacer function** (`gen-app.ts`). This once silently broke the whole
  app bundle.
