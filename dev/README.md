# `dev/` — local dev server for the MCP App UI

The brain viewer/editor is an **MCP App**: it renders inside a real MCP host
(claude.ai) and only there. That makes iterating on the UI slow — you'd have to
deploy the Worker and reconnect a connector for every change.

This directory is a local harness that renders the **same** `ui://` bytes the Worker
serves, driven by the official `AppBridge` host with **stubbed tools over in-memory
fixtures** — no Worker, no auth, no host.

## Run it

```sh
pnpm app:dev      # → http://localhost:5175/
PORT=5185 pnpm app:dev   # when 5175 is taken (another checkout's harness)
```

Edit anything in `app/` (or `src/lib/wiki.ts`) and the browser live-reloads:
`pnpm gen:app` regenerates the `ui://` bundle → esbuild rebuilds the harness → reload.

### Views (URL controls)

| URL                                                   | Shows                           |
| ----------------------------------------------------- | ------------------------------- |
| `/`                                                   | opens a page (default: Vision)  |
| `/#browse`                                            | the file tree                   |
| `/#edit`                                              | the editor for the default page |
| `/#edit=wiki/playbooks/brand-voice.md`                | edit a specific page (tables)   |
| `/?mode=pip` (or `?mode=inline` / `?mode=fullscreen`) | force a display mode            |

### Derived-views demo (okf-view)

`wiki/orgs/acme-health.md` in the fixtures carries live `okf-view` directives: a
Contact-filtered count and a roster table with frontmatter columns. (An
UNfiltered `backlinks` view would just duplicate the app's built-in Linked
references panel — filters/columns are the point.) The harness runs the REAL
views engine (`src/lib/views.ts`) over a fixture-built context, mirroring prod
semantics end to end:

- open the page (picker, or the Customers link on the index page): fences render
  as computed results;
- edit a contact page (retitle Ada, or delete Grace via the tree) and reopen the
  org page: the count/roster update;
- open the org page in the editor (`/#edit=wiki/orgs/acme-health.md`): you see
  the fences but no generated snapshot (stripped, exactly like prod);
- `wiki/people/sam-street.md` is a `Reporter`: excluded from the roster/count,
  still visible in the page's Linked references panel;
- `wiki/people/index.md` is a **directory index** (Phase 2): `kind: pages` +
  `under: wiki/people/` + `group-by: type` renders a grouped table of exactly
  the person pages that exist — create or delete one and reopen it;
- `wiki/index.md` carries a **`kind: folders`** view (bare — `under` defaults to
  the page's own `wiki/` dir): one row per sub-folder, linked via its folder note
  where it has one (`Organizations`, `People`) and shown as a plain name where it
  doesn't (`concepts`, `decisions`, `playbooks`). Add an `index.md` to a note-less
  folder (via the tree's "Add folder note") and reopen the index: the row becomes
  a link. `wiki/orgs/index.md` is that folder note, itself a nested directory
  index of the orgs;
- **folder notes**: a folder with an `index.md` hides that row and opens the
  page when you click the folder (tree AND breadcrumb). Hover a note-less
  folder (e.g. `concepts`) → the file icon creates one, pre-seeded with a
  directory view.

## What's real vs. faked

- **Real:** the exact generated app bytes (`src/lib/app-bundle.generated.ts`), the
  `AppBridge` host + `PostMessageTransport` (`@modelcontextprotocol/ext-apps`), the
  sandboxed iframe, display-mode negotiation, and theming — i.e. everything a real
  host does at the protocol layer.
- **Faked:** the tools. `dev/harness.ts` answers `read_page` / `list_pages` /
  `create_page` / `move_page` / `delete_page` / etc. from `dev/fixtures.json` in
  memory. So this exercises the **UI**, not the real path-based writes against a
  GitHub repo.

To test the real write path, run `pnpm worker:dev` (→ `http://localhost:8787/mcp`)
and point a local MCP host (MCP Inspector, Claude Desktop) at it.

## Files

- `harness.ts` — the AppBridge host: mounts the app in an iframe, sends the opening
  tool result, and services the app's callback tool calls from fixtures.
- `fixtures.json` — an in-memory brain (real pages copied from a live brain).
- `index.html` — the host shell (top bar + iframe slot + live-reload).
- `bundle.js` — esbuild output (git-ignored; built by `pnpm app:dev`).
