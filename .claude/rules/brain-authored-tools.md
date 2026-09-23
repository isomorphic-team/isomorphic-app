---
paths:
  - "src/lib/custom-tools.ts"
  - "src/tools/custom.ts"
  - "scripts/test-tools.ts"
---

# User-defined tools (brain-authored)

Any content page under a `tools/` folder (e.g. `wiki/tools/standup-digest.md`) is registered
as an MCP tool named `tool_<filename>`. Engine: `src/lib/custom-tools.ts` (pure parse, schema,
interpolation; `pnpm test:tools`) + `src/tools/custom.ts` (discovery, registration, execution).
Contract for agents: `brain-template/AGENTS.md`.

- **A tool is a page.** `isToolPagePath` = any `.md` under a `tools/` segment that is not a
  folder note. Discovery (`loadCustomToolDefs`) uses the content index, then fetches the few
  blobs: index to discover, blobs for authority. Per brain, capped at `MAX_CUSTOM_TOOLS` (25)
  to bound tool-list context; overflow, malformed and duplicate pages are reported by
  `validate`.
- **Declared in a fenced ` ```tool ` block**, a small line grammar (NOT YAML, so it survives
  the flat frontmatter parser and ProseMirror): `input: <name> (<type>[, default=][, optional])
  <desc>` with `<type>` = `string|number|boolean|enum: a|b|c`; `op:` + `arg: k = v`; `widget`;
  `view:` (the rest of the block is the directive). The body outside the fence is the payload;
  the name comes from the filename, the description from frontmatter.
- **Three read-only kinds, none escape the brain:** `prompt` (return the interpolated body),
  `op` (ONE whitelisted read: `search_pages` / `read_page` / `find_inbound_links` /
  `list_pages`), `view` (render ONE okf-view via `tryRenderViews`; `widget` opens it in the
  viewer). Args are interpolated as DATA (`fill`), never evaluated. **Writes are deliberately
  not in the op whitelist.**
- **Registered after every first-party tool**, before the usage wrapper. `loadCustomTools()`
  runs before `buildServer`, fail-open. Authoring is an ordinary editor page write.
- **No `list_changed` push** (stateless, `listChanged: false`): creating, moving or deleting a
  `tools/` page appends a reconnect nudge (`toolRosterNote` in `change-record.ts`). Editing an
  existing tool's body takes effect on its next call.
- `pnpm test:e2e-librarian` drives author → discover → reconnect → invoke (offline by default).
- **Not built:** hiding `tools/` pages from listing and search; server-side tool chaining.
