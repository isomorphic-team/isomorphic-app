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

## Deploy target

- **Cloudflare Workers limits (script size, etc.):** https://developers.cloudflare.com/workers/platform/limits/
- Wrangler: https://developers.cloudflare.com/workers/wrangler/

---

## Verified facts worth remembering

Non-obvious things confirmed against the sources above (with the "why it bit us"):

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
- **claude.ai may not mount the iframe even with a byte-correct protocol exchange**
  (ext-apps#671) — client-side, not fixable from the server. Verify payloads with a
  known-good host (MCPJam Inspector, VS Code Copilot) to isolate host vs. server.
- **The iframe CSP blocks all external hosts** — no CDN, no external stylesheet/font, no
  code-splitting. Everything ships inlined in the one `ui://` resource (`pnpm gen:app`).
- **Cloudflare Worker script limit: 3 MB compressed (Free) / 10 MB (Paid), 64 MB
  uncompressed.** The app HTML is compiled _into_ the Worker, so it counts against this.
  Design the app bundle for ≤~500 KiB uncompressed for boot latency; the hard wall is
  far above that.
- **String-replacement codegen corrupts JS:** injecting a bundle with
  `String.replace(marker, code)` makes `$&`/`$$`/`$1`… in the payload act as patterns.
  Always use a **replacer function** (`gen-app.ts`). This once silently broke the whole
  app bundle.
