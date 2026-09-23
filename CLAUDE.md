# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Authoritative external references** (MCP Apps / SEP-1865, the MCP SDK and the 2026-07-28
protocol, Claude host design guidelines, ProseMirror, Cloudflare limits) live in
[`docs/references.md`](docs/references.md). Read it, and the primary source, before answering
from memory about any of that tech; it moves fast. It also lists verified facts (display modes,
the iframe CSP, Worker size limits, the codegen `$&` gotcha).

**This repository is public and open source** (GNU AGPL-3.0-only; contributors sign a CLA so
the project can also be licensed commercially). Anything you write here carries no customer
names, no real account or resource identifiers, and no "our deployment" assumptions in code or
committed config. Deployment identity lives in generated config and env vars (see
[Deployment config](#deployment-config-wranglerjsonc-is-generated) and
[`docs/design/open-source-boundary.md`](docs/design/open-source-boundary.md)). Governance and
licensing: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`GOVERNANCE.md`](GOVERNANCE.md),
[`docs/licensing.md`](docs/licensing.md).

Subsystem detail lives in [`.claude/rules/`](.claude/rules/) and loads when you touch the
matching files; see [Where subsystem rules live](#where-subsystem-rules-live).

## Commands

```sh
pnpm install
pnpm try <folder>       # local runtime: MCP over a git repo on disk, no accounts (127.0.0.1:8788)
pnpm doctor             # what this checkout has, what it is missing, what to run next
pnpm setup:config       # GENERATE wrangler.jsonc from wrangler.template.jsonc (run this first)
pnpm bootstrap          # one-shot: registers the GitHub App, scaffolds a brain (http://localhost:3000)
pnpm onboard-org        # operator: write a customer org's rows (dry-run; --apply local|remote|both)
pnpm worker:dev         # `wrangler dev` for the MCP Worker, http://localhost:8787
pnpm worker:deploy      # manual `wrangler deploy`; CI deploys differently (see Deploys below)
pnpm worker:types       # regenerate Worker types from wrangler.jsonc
pnpm app:dev            # the MCP App UI over the AppBridge harness, http://localhost:5175 (dev/README.md)
pnpm web:dev            # seed the demo brains, then `pnpm try` them: the app as a WEB page at
                        # http://127.0.0.1:8788/b/local/demo-brain (no auth; --reset re-seeds)
pnpm gen:app            # codegen the ui:// app bundle (after editing app/ OR any src/lib/ file it imports)
pnpm gen:templates      # codegen brain-template/ into src/lib/brain-template.generated.ts
pnpm regen:pr <n>       # regenerate the bundle on a PR branch that could not (Dependabot); --push sends it
pnpm db:migrate         # apply D1 migrations LOCALLY (also db:migrate:list, db:migrate:new <name>)
pnpm test               # every offline battery (the same list ci.yml runs)
pnpm test:ui            # the MCP App UI in a real browser (Playwright + Chromium)
pnpm ui:baselines       # regenerate the visual baselines for THIS platform
pnpm probe:report <folder> <probes.json>   # retrieval probes through the real search, offline
pnpm consolidate:report <folder>           # the consolidation detector over a brain on disk
pnpm security:audit     # pnpm audit --prod --audit-level high (reporting only in CI)
pnpm typecheck          # all four tsconfigs (node, worker, app, tests)
pnpm format             # prettier
```

Each `test:*` battery is named in `package.json`; what it pins is in the header of the script it
runs (`scripts/test-*.ts`, plus `roundtrip-check.ts` and `e2e-*.ts`).

## Testing policy

**TESTS ARE EXPECTED FOR EVERY FEATURE AND EVERY FIX, in the same change.** Not deferred, not
"typecheck covers it", not a manual check narrated in the summary. Shipping without one is a
decision to argue for explicitly.

- **A green suite proves nothing unless it touches the changed code.** Before reporting a
  change as tested, break it deliberately and confirm the test goes red. Say which battery
  covers a change, and say plainly when none does.
- **Test the thing that DECIDES.** If the deciding logic sits where no test can call it (a
  private method on `McpSession`, a branch inside a handler), move the logic. That is why so
  much of `src/lib/` is pure (`effectiveBrainRole`, `chooseOrg`, `countedCall`,
  `planPageWrite`, `resolveOrgForPerson`). Pattern: pure or db-only function in `lib/`, thin
  wiring in the Worker.
- **Every battery is offline and fork-safe.** Adding one means adding it to BOTH
  `package.json`'s `test` script and `.github/workflows/ci.yml`; `pnpm test:wiring` fails the
  build otherwise (and lints the pnpm scripts named in every workflow). `ci.yml` has two jobs:
  pure-Node `check` and browser-only `ui`. A new battery goes in `check` unless it needs a
  browser.

**`pnpm test:ui` is the only browser battery.** It drives the REAL generated bundle over the
local host harness (`dev/harness.ts`; projects in `playwright.config.ts`, including `web` for
the web host), so it covers what every other battery is blind to: routes mount, the tree,
folder notes and brain switching wire up, the editor round-trips, and how the app LOOKS in three
display modes and two themes. It does not re-assert tool semantics. It **skips green** (loudly)
without Chromium or without baselines for this platform; CI sets `UI_STRICT=1` so that skip
cannot hide a broken container. Determinism needs **two** frozen clocks (`?now=` for fixtures,
`page.clock.setFixedTime` for the app's relative times). `page.clock.install()` does NOT pause
`setTimeout` here. Regenerate baselines with `pnpm ui:baselines`, never a bare
`--update-snapshots` (it silently keeps changed ones). Details: [`dev/README.md`](dev/README.md).

**The end-to-end batteries run in CI.** `pnpm test:e2e-librarian` and `pnpm test:e2e-import`
drive the real MCP tool handlers through a real content index on `node:sqlite` against a real
brain: by default the fs + git `BrainStore` in a temp directory, no network. They gate the write
path and the org-scope tools that decide where a brain lands. `--github` runs the same
assertions against a disposable scratch repo on the platform org (needs `.dev.vars` with platform
App creds); that is the only coverage of the GitHub adapter, so run it when `githubStore`
changes.

## Runtime architecture (three programs, one `src/`)

Walkthrough: [`docs/architecture.md`](docs/architecture.md).

1. **Bootstrap server** (`src/bootstrap.ts`): Node, Hono, via `tsx`. Registers a GitHub App via
   the manifest flow, exchanges the code for credentials, and scaffolds a brain repo in one
   atomic Git Data API commit.
2. **MCP Worker** (`src/worker.ts`): a Cloudflare Worker serving MCP over **stateless**
   Streamable HTTP. Each request builds a fresh `McpServer` behind the OAuth provider
   (`mcpApiHandler`) and answers the same POST with JSON (no SSE, no session), in either
   protocol era via `serveMcp` (`src/lib/mcp-serve.ts`). The per-request `McpSession` holds
   tenant/brain resolution and all tool registration (`buildServer()`). The Worker also serves
   the web app (`/b/...`), `/health`, the OAuth and Auth.js routes, and the GitHub install
   callback. There is no Durable Object: the stateful McpAgent was removed because hosts tore
   down its long-lived SSE streams mid-result; only its append-only DO `migrations` entries
   remain in the template.
3. **Local runtime** (`src/local.ts`): Node, `pnpm try <folder>`. The same content tools over a
   **git repository on disk** through the fs `BrainStore` (`src/local/brain-store-fs.ts`), D1
   shimmed over `node:sqlite` (`src/local/d1-sqlite.ts`). Loopback only, no auth, **no org
   model** (members, sharing, invites, brain switching are absent). It also serves the web app
   shell locally. Writes are local commits, never pushed.

**Anything imported by `worker.ts` runs on Workers and cannot use `node:*`.** The tsconfigs
enforce it: `tsconfig.node.json` (bootstrap, `src/local*`, `scripts/`, `lib/`),
`tsconfig.worker.json` (`worker.ts` + `lib/`), `tsconfig.app.json` (`app/`),
`tsconfig.tests.json` (`tests/` + `playwright.config.ts`, since Playwright transpiles without
typechecking). Node-only code goes in `src/local/`, `bootstrap.ts`, or a Node-only sibling,
never in `lib/`.

## Auth model

GitHub App auth uses two tokens (`src/lib/github.ts`):

- **App JWT**: signed locally with the PEM; App-level reads only (`appOctokit`).
- **Installation token**: minted via the JWT, scoped to one installation, 1h TTL
  (`installationOctokit`). This touches repos. Which installation a brain uses comes from its
  storage connection (see `.claude/rules/org-model-and-permissions.md`).

Permissions are declared in `src/manifest.ts`. `administration: write` is required to create
repos and is **only granted on Organization installs**; the install callback refuses a personal
account install with a friendly error. Human sign-in (Auth.js, oauth mode only) is in the
org-model rules file.

### PKCS#1 vs PKCS#8 (don't break this)

GitHub returns App private keys in **PKCS#1**; `universal-github-app-jwt` accepts only
**PKCS#8**. Bootstrap normalizes with `toPkcs8Pem()` (`src/bootstrap.ts`,
`node:crypto.createPrivateKey().export({type:'pkcs8'})`), at manifest exchange and as a
migration on every `pnpm bootstrap` run. **Do not move this conversion into `lib/`**: Workers
have no `node:crypto`.

## Secrets / config

- `.dev.vars` is the local source of truth (Wrangler's own filename, reused by `worker:dev`).
  Bootstrap writes it via `src/persist.ts`; `loadDevVarsIntoEnv()` lifts keys into
  `process.env` for Node.
- The Worker reads the same keys from `Env`. Production secrets go in via `wrangler secret put`.

## Deployment config (`wrangler.jsonc` is GENERATED)

`wrangler.jsonc` is **gitignored and generated** from the committed `wrangler.template.jsonc`
by `pnpm setup:config` (`scripts/setup-config.ts`). Never edit it (it is overwritten); never
commit it (it is one deployment's identity).

- **Why:** Wrangler will not interpolate env vars into resource bindings, so a config carries
  literal KV/D1 ids. Committed, they leak one deployment's identity and send every fresh clone's
  `wrangler deploy` into "namespace not found".
- **How:** every deployment-specific value is a `__DOUBLE_UNDERSCORE__` token resolved from
  `process.env` → `.dev.vars` → a local default. `SETTINGS` in `scripts/setup-config.ts` is the
  single list; a template token missing from it is a hard error. Substitution is split/join,
  not `String.replace` (the `$&` gotcha).
- **Local ids are fake on purpose:** Miniflare never resolves them, so the default profile needs
  no Cloudflare account. `--provision` creates the real KV namespace and D1 database;
  `--print-ci` emits the `gh variable set` commands.
- **CI:** `ci.yml` runs `pnpm setup:config` with no secrets (fork PRs stay green). `deploy.yml`
  regenerates from repository **variables** and **skips with a warning** if
  `CF_OAUTH_KV_ID`/`CF_D1_DATABASE_ID` are unset rather than deploying template defaults.
- **Don't hardcode our deployment anywhere.** `src/manifest.ts` takes the OAuth callback origin
  as an argument (`PUBLIC_BASE_URL`); the install-callback page derives its host from the request.

## Deploys are versioned, and roll themselves back

`deploy.yml` does **not** call `wrangler deploy` (it uploads and routes traffic in one step,
leaving nothing to fall back to). It records the live version id, `versions upload`s (no
traffic), smoke checks the version's preview URL, `versions deploy <id>@100%`, smoke checks
production, and on failure `wrangler rollback`s to the recorded id and fails red. Migrations
apply in the step before, schema first. Runbook and drill:
[`docs/ops/deploy-and-rollback.md`](docs/ops/deploy-and-rollback.md).

- **The checks live in `scripts/smoke.ts`, pinned by `pnpm test:smoke`.** They decide whether a
  merge stays in production, and fail expensively in both directions. Five unauthenticated
  reads: `/health`; an unauthenticated `POST /mcp` that must be `401` with a Bearer challenge;
  both OAuth metadata documents pointing back at the serving origin; and a signed-out `GET /b/`
  that must redirect to sign-in on the same origin, or 404.
- **A rollback reverts CODE, never SCHEMA.** Migrations must stay additive (renames and drops go
  expand-then-contract) so the previous version is runnable at any moment.
- **The pre-promotion smoke depends on preview URLs,** which Cloudflare withholds from Workers
  implementing a Durable Object (`metadata.has_preview`). This Worker has them today. **Adding a
  Durable Object binding would silently drop the pipeline onto promote-then-roll-back**, where a
  bad version serves real traffic during the smoke. The workflow warns rather than failing.
- **Nothing catches a wrong `PUBLIC_BASE_URL`:** the OAuth provider builds metadata from the
  request origin, so every check passes on any hostname.

## Dependency and code scanning

- **Dependabot** (`.github/dependabot.yml`): weekly npm, monthly actions, GROUPED (production
  minor/patch, development, security, actions); majors stay individual. `package-ecosystem: npm`
  is correct for pnpm.
- **CodeQL** (`.github/workflows/codeql.yml` + `.github/codeql/codeql-config.yml`) runs the
  `security-and-quality` suite. **Do not enable CodeQL default setup in the repository
  settings**: it takes over and runs the narrower `default` suite, silently dropping the quality
  rules. The config excludes `src/lib/app-bundle.generated.ts`.
- **`pnpm security:audit`** runs in ci.yml as a `continue-on-error` reporting step; `--prod`
  drops the wrangler/miniflare subtree. Drop `continue-on-error` once the tree is clean.
- Snyk was not adopted: it needs an account and token that a fork cannot have.

**A Dependabot PR that bumps a BUNDLED dependency always fails CI** ("Generated artifacts in
sync"), because `pnpm gen:app` inlines what the app imports (`zod`, `marked`, and more) and
Dependabot does not run repository code. A maintainer regenerates with **`pnpm regen:pr
<number>`** (`scripts/regen-pr.ts`, a throwaway worktree, pushes only with `--push`). This is
deliberately not a workflow: it would bundle an unreviewed version with a write token at a bot's
say-so, and a `GITHUB_TOKEN` push does not re-trigger checks anyway.

## Non-obvious wrangler and mode bits

- **No `routes` block, ever.** Custom domains are bound in the Cloudflare dashboard. A `routes`
  entry with `custom_domain: true` makes `wrangler dev` rewrite `request.url`'s host and breaks
  the OAuth provider's host-based routing.
- The DO `migrations` array (`v1` new / `v2` deleted `IsomorphicMindMcp`) is **append-only** by
  Cloudflare's rules. Neither entry may be removed.
- **`AUTH_MODE=static`** (one shared bearer, `MCP_BEARER_TOKEN`) is the supported
  **self-hosting** entry point: one person, one brain, no sign-in. `oauth` (Auth.js email
  sign-in) is what the hosted deployment runs. **Both run the same org model**: a static
  deployment writes its own org, operator and brain rows from config on first use
  (`ensureStaticTenant`, `src/lib/static-tenant.ts`), so there is ONE resolution path.
  `IDENTITY_MODE=github` and the `tenants` table were removed on 2026-09-23 (production held one
  dead row); a deployment still setting it gets a 501 at `/authorize` saying so.
- **In static mode `GITHUB_TOKEN` can replace the GitHub App**: a fine-grained PAT with
  Contents + Pull requests write on one repo, plus `BRAIN_REPO_OWNER`/`NAME`. It is recorded as a
  `github-token` storage connection that names the secret and never holds it; `credentialFor`
  (`src/lib/storage-connections.ts`, pure) picks token vs installation from the binding. Commits
  are attributed to the token's owner. `oauth` still requires the App.
- **ONE capability flag: `multiUser`** (`AUTH_MODE === 'oauth'`, in `buildServer`), meaning
  "anyone besides the operator can sign in". Without it: members, `brain_access`/`share_brain`,
  connected accounts, `create_org`, `analytics`, and `switch_brain`/`create_brain`/
  `connect_brain`/`disconnect_brain` are NOT registered (an advertised tool costs context, and a
  refusal reads as a permissions problem to work around; same rule as `FEEDBACK_REPO`). `brains`
  and `configure_brain` always are. The app learns it from `features.people` on the `brains`
  payload and hides Sharing, Members, Analytics, Manage brains, Share, disconnect, Add brain and
  Connected accounts (`NavCaps.people`). `pnpm test:scope` pins the surface (and scans
  `worker.ts` for the gates it cannot call); `pnpm test:policy` pins the nav.

## Brain model

**A brain is an ordinary git repo with arbitrary folder structure.** There are NO fixed entity
types and no generated by-type index; each owner organizes it however they like. **Don't
reintroduce a taxonomy speculatively.** Brains target the Open Knowledge Format (one concept per
page, `type:` frontmatter, `index.md` folder notes); see the OKF rules file.

- **Tools are path-based** (36 today).
  `write_page` creates or updates anything under the content roots (`content`, `edits`,
  `append`, `fields`, `type`); `move_page` and `delete_page` take a page, a folder (a whole
  subtree), or a non-page file, repointing or reporting inbound links. `attach_media` /
  `read_media` handle files. `validate` reports defects and findings; `resolve` answers findings.
- **Only `wiki/log.md` is tool-maintained** (append-only changelog). Path roles (content,
  source, log, system) come from `.isomorphic.json` via `src/lib/brain-policy.ts`, shared by
  Worker and app.
- **`BrainStore` (`src/lib/brain-repo.ts`) is the only seam between tools and storage**:
  `githubStore(octokit)` for GitHub, the fs store for the local runtime. Content reads and
  writes never call octokit directly.
- **The content index in D1 is a derived cache, never the source of truth**; every read checks
  the branch head first. Details: `.claude/rules/content-index-and-store.md`.
- Frontmatter is optional and free-form; `write_page`'s `fields` edits any brain-owned key
  without touching the body. Agent-facing schema doc: `brain-template/AGENTS.md`.

**Brain templates.** The scaffold's source of truth is `brain-template/`. Workers have no
filesystem, so it is codegen'd into `src/lib/brain-template.generated.ts` by
`pnpm gen:templates` (run after any edit there; the output is committed).
`src/lib/scaffold-core.ts` (Worker-safe) scaffolds for both `bootstrap.ts` and the Worker's
`create_brain`.

**Tool descriptions and server instructions.** Each tool's description stands alone and names
itself; cross-tool steering lives in `SERVER_INSTRUCTIONS` (`src/lib/server-instructions.ts`).
A convention the model cannot infer is stated in three places, in descending reach: server
instructions, the tool's own description or argument, and `brain-template/AGENTS.md`.

## State of the repo

Built: the hosted multi-tenant Worker (orgs, per-brain access, guests, identity linking,
storage connections), the static self-host path, the local runtime, bootstrap, the MCP App UI
and the web app, and the tools above. Not built: webhooks, Google/SSO sign-in, a second storage
backend, invitation emails. The old `raw/` → ingest → synthesize pipeline was removed (bulk
import is `sync_records`). [`docs/roadmap.md`](docs/roadmap.md) is the public plan: when the
user references a roadmap item, check the code before assuming it exists or does not.

## Public-repo hygiene

- **No customer, client, or personal names, anywhere.** Code, comments, tests, fixtures, error
  and tool strings, docs, commit messages, pull request titles and descriptions, branch names.
  A comment that retells a real incident is the usual way one gets in: write the example with
  a neutral name (`Acme`, `Northwind`, `example-org`, `brain: "acme"`), never the real org,
  brain, repo, or person, even when you are quoting what happened.
- **No real account or resource identifiers.** Cloudflare ids, installation ids, org logins, the
  Worker name and our hostname come from generated config or env vars. `src/db/seed-*.sql` are
  `<PLACEHOLDER>` templates; keep them that way.
- **`/ops/` is gitignored** (root-anchored; `docs/ops/` runbooks are tracked). Anything naming
  real infrastructure or a real customer goes there.
- **Nothing hosted-only.** The hosted service is a deployment of `main`: no private module, no
  paid-tier flag, no `if (isHosted)`. A change that only makes sense for our deployment goes in
  as configuration or not at all.
- **No telemetry.** Nothing may report anything to us or to anyone but the operator. The org
  Analytics tab counts into the deployment's own D1 and never leaves it; a change that SENDS any
  of it anywhere is forbidden however aggregated it looks.

## Keeping the docs true

This file, the `.claude/rules/` files, the docs and the comments are read as current fact by
every agent that opens this repo. When they drift, an agent acts on the drift with confidence.

- **A change that makes a sentence false fixes it in the same pull request.** Wherever the
  sentence lives: here, a rules file, a doc, a comment, a tool description, an error string.
  On every pull request CI lists the rules files whose `paths:` cover the files changed
  (`scripts/rules-for-change.ts`); reread those before merging.
- **Write the fact, not the story.** A comment or doc states what the code does now, plus at
  most one line on why the obvious alternative is not used. How it got that way (the first
  version, the incident, the issue number, the measured numbers) goes in the commit message
  and the pull request description, where it is dated and never mistaken for current
  behavior. Decision records live in `docs/design/` and `docs/roadmap.md`.
- **`pnpm test:docs` checks what a machine can** (`scripts/test-docs.ts`): repo paths and
  relative links in the reference docs exist, backticked symbols are in the code, tool-shaped
  names (`verb_noun`) are registered tools anywhere in the docs or `src/` (a retired name may
  appear only on a line that says it was retired), quoted constants match their literal, each
  rules file's globs all match files, and each design doc opens with a `Status:` from a fixed
  set. It cannot see a sentence that became false while every name in it still exists; the
  first rule above covers that.
- **A new rules file needs `paths:` built from the current file layout**, and a moved or
  renamed file needs its rules globs updated; `pnpm test:docs` fails on a glob that matches
  nothing.

## Where subsystem rules live

Each file under `.claude/rules/` has `paths:` frontmatter and loads when a session reads a
matching file. Read the relevant one before changing a subsystem from a session that has not
loaded it.

| File                                   | Covers                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org-model-and-permissions.md`         | identity modes, sign-in email, orgs (platform/customer/hosted), roles and the two scopes, `effectiveBrainRole`, sharing, guests, members, invitations, multi-brain, storage connections, moving brains, `create_org` |
| `web-app.md`                           | `/b/` web host, cookie `/mcp` + CSRF gate, `WEB_TOOL_ROUTING`, address bar, Open in browser                                                                                                                          |
| `app-widget.md`                        | the `ui://` bundle, `tool-payloads.ts`, `pickShownBrain`, `features`, `browse_brain` summary                                                                                                                         |
| `mcp-request-path-and-tool-surface.md` | `serveMcp` and the two protocol eras, the preamble and its logging, registration and gating, `whoami`, tool-description rules                                                                                        |
| `content-index-and-store.md`           | `BrainStore`, the D1 index, freshness, wikilinks, write-through, budgets                                                                                                                                             |
| `search.md`                            | ranking, proximity, FTS5 decision, probes, cross-brain search                                                                                                                                                        |
| `write-path.md`                        | `page-write`, patches, `fields`, `write-target`, `change-record`, the retry ledger                                                                                                                                   |
| `okf-folder-notes-and-findings.md`     | OKF, folder notes, `validate` / `resolve`, advisories, findings ledger, consolidation                                                                                                                                |
| `derived-views.md`                     | `okf-view` grammar and the three renderings                                                                                                                                                                          |
| `markdown-renderer.md`                 | `render.ts` sanitization and hooks                                                                                                                                                                                   |
| `media.md`                             | attachments, URL fetch guards, `read_media`                                                                                                                                                                          |
| `brain-authored-tools.md`              | `tools/` pages as MCP tools                                                                                                                                                                                          |
| `bulk-import.md`                       | `sync_records` invariants and import decisions                                                                                                                                                                       |
| `usage-analytics.md`                   | the Analytics tab, `TOOL_KINDS`, recording                                                                                                                                                                           |
| `feedback.md`                          | `submit_feedback` privacy and credential rules                                                                                                                                                                       |
| `loading-states.md`                    | the rotating loading line and its tests                                                                                                                                                                              |

## Rules that apply everywhere

Restated from the rules files so they hold even when those are not loaded.

- **Never run `wrangler d1 migrations apply --remote` (or `d1 execute --remote`) by hand.**
  `deploy.yml` applies migrations before code ships. Create migrations with
  `pnpm db:migrate:new`; keep them additive (expand, then contract). `src/db/*.sql` are
  reference only.
- **Never add a Durable Object binding** without reading the deploy section: it silently loses
  preview URLs and the pre-promotion smoke.
- **No `routes` block** in the wrangler template. **Never edit or commit `wrangler.jsonc`.**
- **Never add an `issues` (or any widening) permission to the platform App** in
  `src/manifest.ts`; feedback uses its own `FEEDBACK_TOKEN`.
- **Don't enable CodeQL default setup** in repository settings.
- **Don't move PKCS#8 conversion (or any `node:*` use) into `src/lib/`.**
- **Don't re-add `update_brain`, a `manage_*` tool, or a fields-only batch tool** (`set_fields`)
  without reading `docs/design/storage-and-tenancy.md` §6 and `docs/roadmap.md`. Moves and
  renames live in `connect_brain` and `configure_brain`.
- **Don't grow the tool surface for a variant**: media move/delete use `move_page` /
  `delete_page`; import decisions and finding dismissals share `resolve`.
- **Every tool description stands alone and names itself**; cross-tool steering goes in
  `SERVER_INSTRUCTIONS`. Keep `read_page` and `view_page` separate.
- **Every new tool needs a `TOOL_KINDS` entry** (`src/lib/usage.ts`; `pnpm test:usage` fails
  otherwise) and, if it is a widget tool, a `WEB_TOOL_ROUTING` decision (`src/lib/web-app.ts`;
  `pnpm test:web` fails otherwise).
- **Never re-express `effectiveBrainRole` in SQL.** Fetch rows, then admit them through the
  function. Gate org actions on `orgRole` and brain actions on `role`; read a null `orgRole` as
  "not a member".
- **Place brains with `listAccessibleOrgs`, never `listAccessibleBrains`.**
- **Only `switch_brain`, `create_brain` and `disconnect_brain` move the active-brain pointer.**
  A view never does.
- **Any whole-brain index pass is budgeted and resumable** (budget, cursor, advance the marker
  only when done). Work added to `brains` answers from the index before touching GitHub.
- **Content reads and writes go through `BrainStore`**, never raw octokit.
- **Don't adopt FTS5** without reading its entry in `docs/references.md`.
- **Treat any change to `src/lib/render.ts`'s policy constants as a security change.**
- **Changelog, commit and reply wording comes from `src/lib/change-record.ts`**; path rules
  from `src/lib/write-target.ts`. Don't inline copies in a tool.
- **Run `pnpm gen:app` after editing `app/` or a `src/lib/` file it imports, and
  `pnpm gen:templates` after editing `brain-template/`.**
- **OKF is a contract with every brain repo.** Read the spec before asserting anything about
  it; a format change must keep working for existing brains.
- **`submit_feedback` publishes nothing identifying**; `composeIssue` takes no identity.
- **No telemetry, no hosted-only code.**
- **No customer, client, or personal names and no real deployment identifiers, anywhere**,
  including comments, fixtures, commit messages and pull requests. Use `Acme`, `example-org`.
- **Fix the sentences a change makes false, in the same change; write the fact, not the
  story.** See [Keeping the docs true](#keeping-the-docs-true).
