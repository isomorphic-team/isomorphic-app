# Design — WYSIWYG markdown editor via MCP Apps

> **Update (tool-surface consolidation, 2026-07-24):** the `save_page` tool described
> below was folded into the librarian's page-write tool, and `create_page` + `update_page`
> were themselves merged into one `write_page` (create-or-update, with a `mode` guard, an
> optional `sha` concurrency guard, and a metadata-only mode that also absorbed
> `publish_page`). The editor now calls `write_page({ path, content, sha })`. References to
> `save_page` / `update_page` here are historical; the mechanism (sha-guarded,
> frontmatter-preserving, logged, atomic bundle commit) is unchanged.

Status: **Phases A–C built 2026-07-06** (viewer-first, `feature/mcp-apps-ui`), with one
deliberate deviation: the editor is a **plain-markdown textarea over the page body** (zero
round-trip risk) rather than WYSIWYG — Milkdown/ProseMirror remains the Phase D upgrade.
Scope also widened beyond the editor per the product principle "viewers live almost entirely
in MCP Apps": the shipped app is a full brain **viewer** (rendered pages, clickable
wikilinks + relative links, index browse, search) with the editor as one view.

What shipped: `app/` (viewer/editor source) → `pnpm gen:app` → `src/lib/app-bundle.generated.ts`
(committed, self-contained HTML, ~419 KiB); `src/tools/apps.ts` registers the
`ui://isomorphic-mind/brain-app.html` resource + `view_page` / `browse_brain` / `edit_page` /
`save_page` (sha-guarded, frontmatter-preserving, logged, atomic bundle commit).
`@modelcontextprotocol/sdk` bumped to 1.29.0 (ext-apps peer requirement) with a pnpm override
because the `agents` package pins 1.23.0 — single SDK version keeps `McpAgent` types coherent.
The app bundles the Worker's own `src/lib/wiki.ts` helpers, so frontmatter/link semantics are
identical on both sides. E2E: app section of `scripts/e2e-librarian.ts`.

Let a user edit a brain page in a rich editor surfaced _inside the MCP host_, not in
GitHub. Built on the **MCP Apps** extension (SEP-1865, Final): the server declares a
`ui://` HTML resource, a tool links it via metadata, the host renders it in a sandboxed
iframe, and the iframe calls back over standard `tools/call`.

Refs: [SEP-1865](https://modelcontextprotocol.io/community/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) ·
[ext-apps repo](https://github.com/modelcontextprotocol/ext-apps/) ·
[MCP Apps blog post](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/)

## What MCP Apps gives us (the mechanics)

- **Predeclared UI resource** under the `ui://` scheme, mimeType
  `text/html;profile=mcp-app`, served via `resources/read` (HTML inline as `text`).
- **A tool links to it** via `_meta.ui.resourceUri: "ui://…"`. When the tool runs, the
  host renders the linked iframe and feeds the tool's input/result in via
  `ui/notifications/tool-input` and `ui/notifications/tool-result`.
- **The iframe calls back** with standard `tools/call`. Hosts can gate UI-initiated
  calls behind user consent.
- **Capability negotiation**: client advertises `io.modelcontextprotocol/ui` with
  `mimeTypes: ["text/html;profile=mcp-app"]`.
- SDK: `@modelcontextprotocol/ext-apps` (`/server` for registration, `/app-bridge` +
  `PostMessageTransport` for the iframe side).

## How it maps onto this repo

The brain is markdown files in a GitHub repo; the Worker already has the read/write
plumbing (`read_page` / `update_page`, `tenantContext()`, installation octokit). A
WYSIWYG editor is a thin UI layer over that, plus one new write callback.

```
User: "edit wiki/customers/acme.md"
  └─ Claude calls  edit_page({ path })
       └─ Worker: read file → returns { markdown, sha } as structuredContent
                  + _meta.ui.resourceUri = ui://isomorphic-mind/markdown-editor
  └─ Host fetches the ui:// resource, renders a sandboxed iframe,
     posts {path, markdown, sha} in via ui/notifications/tool-result
  └─ User edits in WYSIWYG, clicks Save
       └─ iframe → tools/call save_page({ path, markdown, sha })
            └─ Worker commits via installation octokit (same OAuth token → same tenant)
               returns new sha; iframe updates its baseline
```

UI tool calls ride the same OAuth token, so `tenantContext()` resolves the brain with
**no new auth**.

### Three new server pieces

1. **UI resource `ui://isomorphic-mind/markdown-editor`** — self-contained HTML (inlined
   JS+CSS, no CDN: the iframe sandbox/CSP blocks external hosts, same constraint as
   Artifacts). Workers have no filesystem and the spec wants _predeclared_ templates, so
   reuse the existing `brain-template.generated.ts` codegen pattern: author the editor
   under `editor/`, bundle to one HTML string via esbuild, codegen
   `src/lib/editor-bundle.generated.ts`, add `pnpm gen:editor`, commit the generated
   file. `registerResource(...)` returns the string.
2. **`edit_page` tool** — input `{ path }`. Returns the markdown as BOTH a plain text
   block (fallback for non-UI hosts/agents) and `structuredContent { path, markdown,
sha }`, with `_meta.ui.resourceUri` set. Reuses `read_page`'s decode path. Guards:
   reuse `isRawPath` (raw/ read-only or refused), `.md` only.
3. **`save_page` tool** (the iframe callback) — input `{ path, markdown, sha, message? }`.
   Carries the `sha` from `edit_page` for **optimistic concurrency**: GitHub 409 on
   mismatch → return a "page changed on disk, reload" error the UI renders. Reuses
   `update_page`'s guards/commit path; kept separate so it can be annotated as a
   UI-initiated write (host consent) and carry the sha.

## The hard parts (and recommended calls)

- **Frontmatter (the central fidelity decision).** Brain pages carry YAML frontmatter
  (`sources`, `last_compiled`, `confidence`). Split frontmatter from body on load, edit
  only the body in WYSIWYG, render frontmatter in a separate read-only/structured panel,
  re-attach verbatim on save. A body-WYSIWYG that round-trips the whole file will mangle
  the YAML.
- **Wikilinks `[[Page]]`** aren't standard markdown. MVP: preserve as literal text so the
  serializer never drops them. Later: a remark node rendering them as chips.
- **Round-trip safety.** Golden rule: load→serialize of an _unedited_ real brain page
  must be byte-stable (or near). This drives the editor-lib choice — prefer **Milkdown**
  or **ProseMirror + prosemirror-markdown** (remark-based, faithful) over
  contenteditable + turndown (lossy).
- **Host support.** Only MCP-Apps-capable hosts render the iframe (claude.ai / Desktop).
  **Claude Code terminal and MCP Inspector do not** — so `edit_page` must degrade: the
  plain-text block lets a non-UI agent still read and fall back to `update_page`. Verify
  Claude's current MCP Apps support level _before_ investing — this is the gating spike.
- **SDK gap risk.** Pinned `@modelcontextprotocol/sdk@1.23.0`'s `McpServer` may not expose
  first-class `_meta.ui.resourceUri` / capability registration; may need manual `_meta`
  plus adding `@modelcontextprotocol/ext-apps`. Verify in the spike.

## Phasing / checklist

- [x] **Phase A — SDK spike.** `@modelcontextprotocol/ext-apps@1.7.4` added
      (`registerAppTool` / `registerAppResource` / `RESOURCE_MIME_TYPE` server-side; `App` +
      `callServerTool` in the iframe). SDK bumped to 1.29.0 via pnpm override (see status
      note). **Still to verify live: the real claude.ai host rendering the iframe** — local
      E2E covers everything except the host's actual iframe/postMessage layer; non-UI hosts
      are covered by text-fallback blocks on every app tool.
- [x] **Phase B — viewer** (expanded): rendered page view with frontmatter chip bar,
      clickable wikilinks (slug-resolved via `list_pages`) and relative links, index browse,
      search view (via new `structuredContent.hits` on `search_pages`), back-stack.
- [x] **Phase C — editing + `save_page`** with sha-based conflict detection (stale sha →
      friendly "reopen" error, verified in E2E), frontmatter preserved verbatim +
      `updated` bumped, change logged, single atomic commit.
- [ ] **Phase D — WYSIWYG upgrade** (Milkdown/ProseMirror over the body) + round-trip
      golden tests; frontmatter _editing_ panel (today it's read-only chips).
- [ ] **Phase E — polish:** draft/autosave; diff-before-save; optionally route saves
      through a PR (tie into the planned `propose_change` + lint agent) instead of
      committing to the default branch directly. Bundle diet: zod locales dominate the
      419 KiB app bundle (via SDK types) — alias them out if size starts to matter.
