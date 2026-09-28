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

Edit anything in `app/` or `src/lib/` and the browser live-reloads:
`pnpm gen:app` regenerates the `ui://` bundle → esbuild rebuilds the harness → reload.

## The OTHER host: `pnpm web:dev`

The same bundle also runs as an ordinary **web page** (`/b/<owner>/<repo>/<path>`,
see the web-app section of `CLAUDE.md`), and this harness cannot show you that. It
mounts the bundle in a sandboxed iframe and drives it over AppBridge, so the web
transport (`app/core/host-web.ts`), the URL round-trip (`parseWebPath`) and the
served shell are all unreachable from here no matter how good the fixtures are.

The web host is **the local runtime itself**: `pnpm try <folder>` serves the shell at
`/b/<folder>` and the real tool handlers at `/mcp`, from one process, exactly
as the Worker does. `pnpm web:dev` only seeds the demo brains and starts it:

```sh
pnpm web:dev              # → http://127.0.0.1:8788/b/demo-brain
pnpm web:dev --reset      # start over from a pristine seed
pnpm try ~/some/vault     # any folder, no seeding: http://127.0.0.1:8788/b/vault
```

The shell and its headers (`src/lib/web-shell.ts`) and the CSRF gate (`src/lib/web-app.ts`) are the shared ones,
and the tool handlers, the content index and the write path are the production ones
over a git repo on disk. `web:dev` seeds that repo from **`dev/seed.ts`, the same
module this harness uses**, so the two hosts show the same three brains and a
difference you notice between them is a difference in the app.

**It has no authentication at all.** Production checks an Auth.js session cookie and
redirects to sign-in; here there is no session and the local runtime reports `owner`
for everything. Right tool for behaviour, wrong tool for access. Loopback only.

### Views (URL controls)

| URL                                                   | Shows                                      |
| ----------------------------------------------------- | ------------------------------------------ |
| `/`                                                   | opens a page (default: Vision)             |
| `/#page=wiki/concepts/vision.md`                      | the viewer on a named page                 |
| `/#browse`                                            | the file tree                              |
| `/#edit`                                              | the editor for the default page            |
| `/#edit=wiki/playbooks/brand-voice.md`                | edit a specific page (tables)              |
| `/?mode=pip` (or `?mode=inline` / `?mode=fullscreen`) | force a display mode                       |
| `/#graph`                                             | the link graph                             |
| `/#activity`                                          | recent changes                             |
| `/#brains`                                            | the brains list (a shortcut, below)        |
| `/#nobrains`                                          | first touch: no brains, the create form    |
| `/#members`                                           | the org roster                             |
| `/#analytics` (or `#analytics=7`)                     | the org Analytics tab (window in days)     |
| `/#access`                                            | the per-brain sharing panel                |
| `/#settings`, `/#connected`                           | Your settings, with the connected accounts |
| `/#browse-empty`                                      | an adopted repo with no content configured |
| `/#cold`                                              | no opening tool result (below)             |
| `/#slow-result`, `/#pending-input`                    | a result slower than the self-boot (below) |
| `/#other-brain`                                       | a brain opened BY NAME (below)             |
| `/#stale`                                             | a page edited behind you (below)           |
| `/#loading`                                           | a wait that never ends (below)             |

`tests/ui/harness.ts` (`ROUTES`) is the checked list: every route there must mount.

`/#brains` is a shortcut rather than a host path. No widget tool opens on the brains
list (`brains` carries no `_meta.ui`); the app reaches it from the trail's brain glyph,
which calls `brains` and renders the result. The route delivers that same payload as
the opening result, so it lands on the same view without the click.

`/#slow-result` and `/#pending-input` deliver the page after the app's 1200ms
self-boot deadline. `#pending-input` announces the call first (`sendToolInput`), which
tells the app a result is coming; `#slow-result` says nothing and names another
brain, so the app has already started drawing the tree when the page arrives. Both
must land on the page.

`/#other-brain` delivers a browse result for a brain that is NOT the one the
connection's active-brain pointer names: what happens when the model calls
`browse_brain` / `view_page` with an explicit `brain:`. A view never moves the pointer
(only `switch_brain`, `create_brain` and `disconnect_brain` do), and the app re-reads
it through `brains` on every open, so the list comes back naming a different brain
than the result (issue #26). The crumb, the tree and the brains list's tick all have to
name the brain the RESULT names.

`/#stale` opens a page and then changes it, so the widget is holding a render the
brain has already moved past with nothing on screen saying so (issue #29). This is the
case the page viewer's refresh control exists for and the one no amount of care on our
own write path prevents: another person, another agent, or an edit made on github.com.
Pressing Refresh has to both replace the content and SAY the page moved, since a
refresh that repaints in silence cannot be told apart from one that failed.

`/#loading` announces a tool call and never answers it, so the loading view stays up
long enough to read. Every other route's stub answers in milliseconds, and the
rotating status line (`app/views/LoadingView.tsx`) holds the caller's literal label
for 2.4s before its first swap, so this is the only way to see the rest of a
rotation. Worth checking here: the label leads, the lines that follow name the brain
and the page rather than reading as generic filler, the shimmer sweeps, and with
`prefers-reduced-motion` set (DevTools rendering pane) nothing moves and the label
simply holds. The app opens the tree by itself after 30s, which is the far end of
the same behavior.

`/#cold` connects and then sends nothing, so the app self-boots: `connectToHost`
opens the file tree itself 1200ms after the handshake. A real host does this
whenever the opening result is slower than the handshake or is never replayed
(a widget re-mounted from scrollback). It is the only path where the app draws a
brain's tree with no app-tool payload to learn the brain from, so it is where the
trail's root crumb and its brain picker have to stand on their own: the crumb
should name the brain (from `list_pages`, which carries `activeBrain`) and its
picker should load the brain list when opened.

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
- **folder notes**: in the tree, a folder with an `index.md` hides that row and
  opens the page when you click the folder. A folder crumb in the trail always
  opens the tree revealed at that folder, note or not. Hover a note-less folder
  (e.g. `concepts`) → the file icon creates one, pre-seeded with a directory view.

### Adding a brain, including into an org that holds none

`/#brains` → **Add brain** → **Connect an existing repo**. The org list comes from
the `orgs` field on the `brains` payload, not from the brains themselves, so it
includes **Contoso Group**: an org with **no brains at all**, holding one connectable
repo (`contoso-io/field-guide`). That org is the case worth clicking: it cannot be
derived from a list of brains, so it is the one a picker built from brains would miss.

Picking it and adopting the repo should land you in the new brain. If Contoso Group is
missing from the picker, the payload lost its `orgs` field.

### Brain sharing demo (per-brain access)

`/#access` opens the sharing panel for the active brain, and the **Share** control
on each row of `/#brains` opens it for that one. The harness runs the REAL access
rule (`effectiveBrainRole` from `src/lib/orgs.ts`) over its fixtures, so what you
see resolves exactly like prod. The three fixture brains cover the whole rule:

- **Personal** is private and mine. Katherine is an org **Editor** shared in
  **read-only**, which is the case per-brain roles exist for; Grace holds no grant
  at all and is there via the **org-admin floor**; Devon cannot see the brain.
  Change a level or revoke and the panel refreshes in place; the header's **Share**
  action opens the add flow (`ShareBrainView`), the brain-scope twin of Invite.
- **Acme** is org-visible, so every member is listed at their own org role and no
  row is individually removable (there is no grant to remove: narrow the brain to
  private first).
- **Northwind** is a client brain shared with me **read-only**. Its Share control
  is absent, because sharing needs admin ON THE BRAIN and my role there is viewer:
  the brain-vs-org role split, visible.

Note `via`: a row can be admitted by a grant, by org visibility, or by the
org-admin floor, and only a `grant` row is editable.

## What's real vs. faked

- **Real:** the exact generated app bytes (`src/lib/app-bundle.generated.ts`), the
  `AppBridge` host + `PostMessageTransport` (`@modelcontextprotocol/ext-apps`), the
  sandboxed iframe, display-mode negotiation, and theming — i.e. everything a real
  host does at the protocol layer.
- **Faked:** the tools. `dev/harness.ts` answers `read_page` / `list_pages` /
  `write_page` / `move_page` / `delete_page` / etc. in memory, over the brains
  `dev/seed.ts` builds. So this exercises the **UI**, not the real write path.

For the real tool handlers over a git repo on disk, use `pnpm web:dev` (above). For
the Worker itself, run `pnpm worker:dev` (→ `http://localhost:8787/mcp`) and point a
local MCP host (MCP Inspector, Claude Desktop) at it.

## Automated tests (`pnpm test:ui`)

This harness is also the fixture for the UI test suite (`tests/ui/`, Playwright +
Chromium). Same bytes, same AppBridge, same fixtures — driven by a browser instead of
by you.

```sh
pnpm exec playwright install chromium   # one time
pnpm test:ui                            # functional + visual
```

It serves on **5176**, not 5175, so it never collides with a preview you have open.
`scripts/app-dev.ts --once` is what it starts: one build, then a plain static server
with no watchers and no live-reload, because a rebuild landing mid-assertion reads as
a flaky app rather than a moving server.

**Three projects, and `web` drives a different host.** `functional` and `visual` run
against this harness; **`web`** (`tests/ui/web-nav.spec.ts`) runs against the local
runtime on **8789**, seeded by `scripts/web-dev.ts --reset` into a throwaway
directory under the OS temp dir so a run never depends on, or disturbs, the brain
you have been editing. Its assertions read the **pair** (url, heading) every time: the
failure it guards is a heading that moves while the URL stands still, and a spec
watching either alone stays green through that.

What the suite covers, and deliberately does not:

- **Covers**: that every route mounts (`smoke`), that the rail, the trail and the
  page actions are wired and stay separate (`chrome`), that the card's bounded box
  holds with a control open (`bounds`), that the tree / folder notes / brain
  switching behave (`navigation`), that a cross-brain hit switches brains before it
  opens (`search`), that the editor round-trips and Cancel discards (`editor`), that
  the add-shaped flows run to COMPLETION (`flows`), that the org roster's mutations
  and lockout guardrails hold (`members`), that the sharing panel puts the access
  rule on screen and gates its controls on the BRAIN role (`sharing`), that analytics
  is anchored to a frozen clock (`analytics`), that Refresh picks up an edit made
  behind the widget and reports the render's age (`refresh`), that the loading line
  leads with its label and then rotates (`loading`), that the web host keeps the URL
  and the view in step (`web-nav`, the `web` project), and how it all looks in three
  display modes and two themes (`visual`).
- **Does not cover**: tool semantics. The view engine, page patches, the access rule
  and the analytics fold are pinned by pure golden tests (`test:views`, `test:patch`,
  `test:access`, `test:usage`) that run in milliseconds. Re-asserting those through the
  DOM would be a slow duplicate that fails for unrelated reasons.
- **Says nothing about the real host.** This harness IS the host, so the claude.ai
  mount gap, the real iframe CSP, and the auth round trip stay invisible here.

### Two frozen clocks

`?now=<ISO>` freezes the **harness's** clock, so the fixtures produce fixed dates
(analytics window and series, activity timestamps, invite ages). That alone is not
enough: the **app** renders those dates relatively ("last active 5d ago") off its own
`Date.now()` inside the iframe, which the harness cannot reach. The tests also call
`page.clock.setFixedTime`, which does reach it. Freeze one without the other and every
relative label drifts daily.

`setFixedTime` pins `Date.now()` and leaves timers running. `openApp`'s `advanceable`
option uses `clock.install()` instead, for the tests that make time pass with
`runFor()` (the refresh control's age). An installed clock does NOT pause timers here:
a `setTimeout` keeps firing on the wall clock in the page and the iframe, so a timer
chain such as the loading rotation cannot be stepped, only watched (see
`tests/ui/loading.spec.ts`).

### Visual baselines

Baselines live in `tests/ui/__screenshots__/<platform>/` and are **committed**: they
are the expected output, not an artifact. They are platform-specific because font
rasterization differs between macOS and the Linux CI runner, so a macOS baseline never
matches CI and vice versa.

`pnpm test:ui` **skips the visual project entirely** on a platform with no baselines,
and skips everything if Chromium is not installed, rather than failing. A missing
browser or a missing baseline is a setup gap, not a regression, and `pnpm test` should
stay green on a fresh clone. `UI_STRICT=1` turns those skips into failures; CI sets it
so a container that stopped carrying a browser cannot hide behind a green skip.

To generate or refresh them:

```sh
pnpm ui:baselines    # playwright test --project=visual --update-snapshots=all
```

Use that script rather than a bare `--update-snapshots`, which only fills in MISSING
baselines and silently leaves a changed one alone (verified on Playwright 1.62).

For Linux baselines from a Mac, run it in the image CI itself runs the UI job in, so
the fonts and the browser build are the same ones that will compare them:

```sh
docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.63.0-noble \
  sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm ui:baselines"
```

That tag and the `container:` in `.github/workflows/ci.yml` must both match the
resolved `@playwright/test` version; `pnpm test:wiring` fails if any of the three
drift.

## Files

- `harness.ts`: the AppBridge host. Mounts the app in an iframe, sends the opening
  tool result for the route, and answers the app's tool calls from the seeded brains.
- `seed.ts`: the three brains both local hosts serve (`pnpm app:dev` in memory,
  `pnpm web:dev` on disk), built on `fixtures.json` plus the states the routes need.
- `fixtures.json`: the default brain's base pages.
- `index.html`: the host shell (top bar, iframe slot, live-reload).
- `bundle.js`: esbuild output (git-ignored; built by `pnpm app:dev` and `pnpm test:ui`).
