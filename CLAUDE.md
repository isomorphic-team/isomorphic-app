# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Authoritative external references** (MCP Apps / SEP-1865, the MCP SDK, Claude host design
guidelines, ProseMirror, Cloudflare limits) live in [`docs/references.md`](docs/references.md).
Check there — and read the primary source — before answering from memory about any of that
tech; it moves fast. It also lists hard-won verified facts (display modes, the iframe CSP,
Worker size limits, the codegen `$&` gotcha).

**This repository is public and open source** (GNU AGPL-3.0-only; contributors sign a CLA so
the project can also be licensed commercially). Consequences for anything you write here: no customer names, no real
account or resource identifiers, and no "our deployment" assumptions baked into code or
committed config. Deployment identity lives in generated config and env vars, never in the
repo — see [Deployment config](#deployment-config-wranglerjsonc-is-generated) below and
[`docs/design/open-source-boundary.md`](docs/design/open-source-boundary.md). Governance,
contribution rules, and the licensing rationale: [`CONTRIBUTING.md`](CONTRIBUTING.md),
[`GOVERNANCE.md`](GOVERNANCE.md), [`docs/licensing.md`](docs/licensing.md).

## Commands

```sh
pnpm install
pnpm try <folder>       # local runtime: MCP over a git repo on disk, no accounts (127.0.0.1:8788)
pnpm doctor             # what this checkout has, what it is missing, what to run next
pnpm setup:config       # GENERATE wrangler.jsonc from wrangler.template.jsonc (run this first)
pnpm bootstrap          # one-shot: registers GitHub App, scaffolds the brain repo (http://localhost:3000)
pnpm worker:dev         # `wrangler dev` for the MCP Worker — http://localhost:8787
pnpm worker:deploy      # publish the Worker to Cloudflare
pnpm worker:types       # regenerate Worker types from wrangler.jsonc
pnpm app:dev            # local dev server for the MCP App UI — http://localhost:5175 (see dev/README.md)
pnpm gen:app            # codegen the ui:// app bundle (after editing app/ OR any src/lib/ file it imports)
pnpm test:roundtrip     # editor markdown round-trip golden test
pnpm test:views         # derived-views (okf-view) engine golden test
pnpm test:import        # bulk-import planner golden test
pnpm test:tools         # user-defined (brain-authored) tools parse-layer golden test
pnpm test:patch         # write_page append/edits (page-patch) golden test
pnpm test:structure     # OKF conformance golden test (granularity, type:, nested frontmatter)
pnpm test:links         # wikilink resolution + the broken-link report golden test
pnpm test:access        # per-brain access rule (effectiveBrainRole) golden test
pnpm test:scope         # org-vs-brain scope: which role each tool gates on
pnpm test:loading       # loading-line engine: slot eligibility + per-task wiring
pnpm test:preamble      # the /mcp preamble: which requests need a brain, and what a
                        # failure in front of the SDK answers with
pnpm test:dedupe        # write-attempt ledger: an identical retry is answered, not applied twice
pnpm test:appmeta       # the ui:// app resource's host contract (prefersBorder, tool→app link)
pnpm test:feedback      # submit_feedback composition golden test (redaction, nothing identifying published)
pnpm test:usage         # usage-analytics golden test (tool-classification coverage, the summary fold)
pnpm test:wiring        # every test:* script is in BOTH package.json's `test` and ci.yml
                        # (+ ci.yml's Playwright container tag matches the resolved dep)
pnpm test:e2e-librarian # write tools end to end, offline against a git repo in a temp dir
pnpm test:e2e-import    # the importer end to end, same
pnpm test:ui            # the MCP App UI in a real browser, over the local host harness
pnpm ui:baselines       # regenerate the visual baselines for THIS platform
pnpm typecheck          # runs all four tsconfigs (node, worker, app, tests)
pnpm format             # prettier
```

**TESTS ARE EXPECTED FOR EVERY FEATURE AND EVERY FIX, in the same change.** Not
deferred, not "typecheck covers it", not a manual check narrated in the summary.
Shipping without one is a decision to argue for explicitly, not a default. Two
rules that make the difference between coverage and its appearance:

- **A green suite proves nothing unless it touches the changed code.** Before
  reporting a change as tested, break it deliberately and confirm the test goes
  red. A test that passes against both the old and new behavior is testing
  neither. Say which battery covers a change, and say plainly when none does.
- **Test the thing that DECIDES.** If the deciding logic sits somewhere no test
  can call it (a private method on `McpSession`, a branch inside a handler),
  move the logic instead of skipping the test. That is why so much of
  `src/lib/` is pure: `effectiveBrainRole`, `chooseOrg`, `countedCall`, and
  `resolveOrgForPerson` were all extracted so the rule could be pinned. The
  pattern to copy is: pure or db-only function in `lib/`, thin wiring in the
  Worker.

**Tests.** All offline, all fork-safe, all wired into CI and into the `test` script
(`pnpm test` runs everything): `pnpm test:roundtrip` (editor markdown round-trip),
`pnpm test:views` (okf-view engine), `pnpm test:import` (import planner),
`pnpm test:tools` (brain-authored tool parsing), `pnpm test:patch` (write_page
append/edits), `pnpm test:structure` (OKF conformance), `pnpm test:links`
(wikilink resolution: every spelling a human writes by hand, plus what the
broken-link report says about the ones that match nothing), `pnpm test:index`
(content-index freshness guard: bounded, resumable work per read; wraps an octokit
stub in the REAL `githubStore` so it still covers `fetchPages`'s GraphQL batching),
`pnpm test:policy` (the path-policy wire contract between Worker and app),
`pnpm test:preamble` (the /mcp request preamble: which methods need a brain resolved,
in both directions, and the JSON-RPC error a failure in front of the SDK answers with),
`pnpm test:dedupe` (the write-attempt ledger: the argument fingerprint, the two windows,
the claim being given back on a refusal or a throw, plus the real statements over the
real migration on `node:sqlite`),
`pnpm test:appmeta` (the ui:// resource's HOST contract, over a real client/server
pair: that it declares `prefersBorder` rather than inheriting a default that differs
per platform, that the post-deploy versioned-template read carries the same metadata,
and that every widget tool's `resourceUri` names a resource this server actually
serves),
`pnpm test:loading` (the loading-line engine: that a phrase naming a fact the widget
does not have is never eligible, and that every loading state in the app declares a
task, which is optional in the type and so invisible to typecheck),
`pnpm test:access` (the per-brain access rule: every input to `effectiveBrainRole`),
`pnpm test:scope` (which role each TOOL gates on: the real handlers over a stub server
and a fake `getContext`, asserting org-scope tools read `orgRole` and brain-scope tools
read `role`, plus the `share_brain` and lockout guardrails that live in the tool rather
than the lib; traps BOTH `octokit` and `store` with throwing Proxies so an authz test
that reaches storage fails loudly), `pnpm test:feedback` (what submit_feedback publishes
and what it redacts), `pnpm test:usage` (usage analytics: that every registered tool name
has an explicit `TOOL_KINDS` entry, scanned from the tool sources so a new tool cannot land
unclassified, plus the summary fold, where members at zero and since-removed users both have
to survive or the tiles stop matching the table), and `pnpm test:wiring` (every `test:*`
script appears in both `package.json`'s `test` and `ci.yml`, in three directions, including
itself, plus the Playwright container tag in `ci.yml` and `dev/README.md` matching the
version pnpm actually resolves).

**`pnpm test:ui` is the only battery that needs a browser** (Playwright + Chromium). It
drives the REAL generated app bundle over the local host harness (`dev/harness.ts`), so it
covers the app layer that every other battery is blind to: that each route MOUNTS, that the
tree / folder notes / brain switching WIRE UP, that the editor round-trips, and how the app
LOOKS in three display modes and two themes. It deliberately does not re-assert tool
semantics — the view engine, page patches, the access rule and the analytics fold already
have pure golden tests, and re-checking them through the DOM would be a slow duplicate.
Two things keep it from being a burden on contributors: it **skips green** (loudly) when
Chromium is absent or when this platform has no visual baselines, since both are setup gaps
rather than regressions, and CI sets `UI_STRICT=1` so a container that stopped carrying a
browser cannot hide behind that skip. Determinism needs **two** frozen clocks (`?now=` for
the harness's fixtures, `page.clock.setFixedTime` for the app's own relative-time rendering); freezing
one without the other lets every "5d ago" drift daily. Visual baselines are committed,
per-platform, and regenerated with `pnpm ui:baselines` — NOT a bare `--update-snapshots`,
which only fills in missing ones and silently leaves a changed one alone. Details:
[`dev/README.md`](dev/README.md).

**The two END-TO-END batteries now run in CI too** (changed 2026-08-04):
`pnpm test:e2e-librarian` and `pnpm test:e2e-import` drive the real MCP tool handlers,
through a real content index on `node:sqlite`, against a real brain. By default that is
the fs + git `BrainStore` in a temp directory: no network, no credentials, nothing to
clean up. They gate the write path (write_page's edits/append, move_page's link
repointing over a folder subtree, delete_page's "still referenced" notes, the importer's
no-resurrection ledger), which was previously maintainer-run by hand. `e2e-librarian`
also covers the ORG-scope tools that decide where a brain LANDS (`brains`,
`connect_brain`): real org rows in the same D1, the real `resolveOrgForPerson`, and one
org deliberately holding NO brain, since that is the org `listAccessibleBrains` cannot
see and the one a first adoption used to be impossible into. `--github` runs the
identical assertions against a disposable `brain-*-e2e-*` scratch repo on the platform
org (needs `.dev.vars` with platform App creds, auto-deleted, never a real brain). That
mode is the only coverage of the GitHub adapter itself, so run it when `githubStore`
changes.

Adding a test means adding it in BOTH `package.json`'s `test` script and
`.github/workflows/ci.yml`. `pnpm test:wiring` fails the build if you forget,
rather than the battery silently running in exactly one place. `ci.yml` has two
jobs (the pure-Node `check` and the browser-only `ui`); a new battery goes in
`check` unless it needs a browser, and the lint reads the whole file either way.

**Iterating on the app UI:** use `pnpm app:dev` (renders the real `ui://` bytes via the
official AppBridge host over stubbed fixtures — no Worker/auth/host, live-reload). It
exercises the UI, not the real write path; for that use `pnpm worker:dev` + a local MCP
host (Inspector/Desktop) at `http://localhost:8787/mcp`.

## Runtime architecture (three programs, one `src/`)

Narrative walkthrough for newcomers: [`docs/architecture.md`](docs/architecture.md).

This repo ships **three distinct programs** sharing one `src/`:

1. **Bootstrap server** (`src/bootstrap.ts`) — Node, Hono, run via `tsx`. One-shot setup flow that registers a GitHub App via the manifest flow, exchanges the code for credentials, and scaffolds the brain repo in one atomic Git Data API commit.
2. **MCP Worker** (`src/worker.ts`) — Cloudflare Worker exposing MCP tools over **stateless** Streamable HTTP. Each request builds a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` behind the OAuth provider (`mcpApiHandler`), answering on the same POST (no SSE, no session). The per-request `McpSession` class holds tenant/brain resolution and all tool registration (`buildServer()`). Non-POST `/mcp` returns 405 (the stateless transport offers no server→client stream, and handing GET to the SDK transport on Workers hangs the request). The legacy `IsomorphicMindMcp` `McpAgent` **Durable Object** (`MCP_OBJECT` binding) is retained only as an **unused stub** to keep the binding valid — nothing routes to it. (History: this was a stateful McpAgent DO with long-lived SSE streams until 2026-07-17; the Claude host tore those streams down before async results arrived, so widgets intermittently failed. The stateless move fixed it.)

3. **Local runtime** (`src/local.ts`): Node, run via `tsx` as `pnpm try <folder>`. Serves the same content tools over a **git repository on disk** through the fs `BrainStore` (`src/local/brain-store-fs.ts`), with D1 shimmed over `node:sqlite` (`src/local/d1-sqlite.ts`). No auth (loopback only) and **no org model**, so members/sharing/invites/brain-switching are not registered. Builds a fresh `McpServer` per request for the same reason the Worker does: an `McpServer` binds to one transport. Added 2026-08-04 so a contributor reaches the real tools with no accounts, and so the write-path e2e batteries run offline in CI. `src/local/**` is Node-only and sits outside `src/lib/`. Reads come from the working tree, so its `getHead` reports a digest of that tree while `listCommits` reports git shas.

The split matters for `src/lib/`. Anything imported by `worker.ts` runs on Cloudflare Workers and **cannot use `node:*` modules** (no `node:crypto`, no `node:fs`, etc.). The tsconfigs enforce this: `tsconfig.node.json` includes the bootstrap files, `src/local*`, `scripts/`, and `lib/`; `tsconfig.worker.json` includes `worker.ts` and `lib/`; `tsconfig.app.json` covers `app/`; `tsconfig.tests.json` covers `tests/` + `playwright.config.ts` (Playwright transpiles specs rather than typechecking them, so without it the UI suite is the one body of code where a rename fails in a browser instead of at `pnpm typecheck`). `pnpm typecheck` runs all four. Node-only code goes in `src/local/`, `bootstrap.ts`, or a Node-only sibling, never in `lib/`.

## Auth model

GitHub App auth uses two tokens — see `src/lib/github.ts`:

- **App JWT** — local sign with PEM. App-level reads only (`appOctokit`).
- **Installation token** — fetched via the JWT, scoped to one installation, 1h TTL, refreshed by `@octokit/auth-app` (`installationOctokit`). This is what touches repos.

Permissions are declared in `src/manifest.ts`. The non-obvious one is `administration: write` — required to create repos, **only granted on Organization installs**, never User installs. Bootstrap's install-callback handler explicitly checks this and renders a friendly error if the user installed on a personal account.

### PKCS#1 vs PKCS#8 (don't break this)

GitHub returns App private keys in **PKCS#1**. The `universal-github-app-jwt` library (used by octokit's App auth) only accepts **PKCS#8**. Bootstrap normalizes via `toPkcs8Pem()` (`src/bootstrap.ts`) using `node:crypto.createPrivateKey().export({type:'pkcs8'})` — both at write time (manifest exchange) and as a one-shot migration on every `pnpm bootstrap` run for `.dev.vars` written by older versions. **Do not move this conversion into `lib/`** — Workers don't have `node:crypto` and can't do it at runtime.

## Secrets / config

- `.dev.vars` is the local source of truth (same name Wrangler uses, so it's reused for `worker:dev`). Bootstrap writes to it via `src/persist.ts`; `loadDevVarsIntoEnv()` lifts keys into `process.env` for the Node side.
- Worker reads the same keys from its `Env` binding. For production, upload via `wrangler secret put`.
- Wrangler's `.dev.vars` reload does **not** reliably re-create existing Durable Object instances — after editing `.dev.vars`, restart `wrangler dev` rather than relying on auto-reload, or the McpAgent DO will keep stale env values.

## Deployment config (`wrangler.jsonc` is GENERATED)

`wrangler.jsonc` is **gitignored and generated** from the committed `wrangler.template.jsonc`
by `pnpm setup:config` (`scripts/setup-config.ts`). Added 2026-07-27 when the repo went
public. Never edit `wrangler.jsonc`; it is overwritten. Never commit it; it is one
deployment's identity.

- **Why.** Wrangler will not interpolate env vars into resource bindings, so a config must
  carry literal KV/D1 ids. Committing them puts one deployment's identity (Worker name,
  public URL, resource ids, the App slug, the magic-link From address) into a repo that many
  people deploy: a sanitization problem for us, and a fresh clone that `wrangler deploy`s
  straight into "namespace not found" for everyone else.
- **How.** Every deployment-specific value is a `__DOUBLE_UNDERSCORE__` token in the template,
  resolved from `process.env` → `.dev.vars` → a local-development default. `SETTINGS` in
  `scripts/setup-config.ts` is the single list; adding a token to the template without adding
  it to `SETTINGS` is a hard error rather than a silent passthrough. Substitution is
  split/join, not `String.replace`, for the `$&` reason in `docs/references.md`.
- **Local ids are fake on purpose.** `wrangler dev` and `d1 migrations apply --local` run
  against Miniflare, which never resolves an id against Cloudflare's API — so the default
  profile needs no Cloudflare account at all. Verified: both migrations apply cleanly with
  placeholder ids. `--provision` creates the real KV namespace + D1 database and fills in the
  ids; `--print-ci` emits the `gh variable set` commands for CI.
- **CI.** `ci.yml` runs `pnpm setup:config` (default profile, no secrets — keeps fork PRs
  green). `deploy.yml` regenerates from repository **variables** (not secrets; none of these
  are secret and a visible value is a diagnosable one) and **skips with a warning** if
  `CF_OAUTH_KV_ID`/`CF_D1_DATABASE_ID` are unset, rather than deploying template defaults.
- **Don't hardcode our deployment anywhere else either.** `src/manifest.ts` takes the OAuth
  callback origin as an argument (`workerBaseUrl`, from `PUBLIC_BASE_URL`) instead of baking
  in a hostname; the Worker's install-callback page derives the host from the request URL.
  Both used to be hardcoded, which silently registered our domain on a self-hoster's App.

## Deploys are versioned, and roll themselves back

`deploy.yml` does **not** call `wrangler deploy`. That command uploads code and points
traffic at it in one step, which leaves nothing to fall back to. The job splits them:
record the live version id, `versions upload` (serving no traffic), smoke check the
version's own preview URL, `versions deploy <id>@100%`, smoke check production, and on
failure `wrangler rollback` to the recorded id and fail the run red. Runbook and the
drill to run before trusting it: [`docs/ops/deploy-and-rollback.md`](docs/ops/deploy-and-rollback.md).

- **The checks live in `scripts/smoke.ts`, not in a `run:` block, and `pnpm test:smoke`
  pins them.** This is the code that decides whether a merge stays in production, and it
  fails expensively in both directions: too strict reverts healthy deploys until `main`
  stops shipping, too loose never fires at all. Same rule as everywhere else in this repo:
  test the thing that DECIDES. The four assertions are unauthenticated reads (`/health`,
  an unauthenticated `POST /mcp` that must be `401` with a Bearer challenge, and both
  OAuth metadata documents pointing back at the origin that served them), so they are safe
  against an origin sharing production's bindings.
- **A rollback reverts CODE, never SCHEMA.** Migrations applied in the step before are
  still applied afterward. The additive / expand-then-contract rule already required for
  the deploy window is now what keeps the previous version runnable at any moment.
- **The pre-promotion smoke depends on a fact that could change.** Cloudflare withholds
  preview URLs from Workers implementing a Durable Object and reports the verdict per
  version as `metadata.has_preview`. This Worker gets them today (verified 2026-08-18:
  true on every version since number 77, so the append-only `migrations` array naming the
  deleted `IsomorphicMindMcp` class does not disqualify it). **Adding a Durable Object
  binding would silently drop the pipeline onto promote-then-roll-back**, where a bad
  version serves real traffic for the length of a smoke check. The workflow warns rather
  than going quiet, but that is the trade being made.
- **What none of it catches:** a wrong `PUBLIC_BASE_URL`. `@cloudflare/workers-oauth-provider`
  builds its metadata from the request origin, not from the configured value, so every
  assertion passes on any hostname. The value is read where there is no request to derive
  an origin from (`src/manifest.ts`, the connected-accounts `/link/start` URL).

## Non-obvious wrangler bits

- **No `routes` block, ever.** A custom domain is bound in the Cloudflare **dashboard**, independently of the config. A `routes` entry with `custom_domain: true` makes `wrangler dev` rewrite `request.url`'s host, which breaks the OAuth provider's host-based routing and forces a comment-out dance on every local run. The template says so too; don't re-add one.
- The DO `migrations` array (`v1` new / `v2` deleted `IsomorphicMindMcp`) is **append-only** by Cloudflare's rules. Neither entry may be removed even though nothing routes to the class.
- `AUTH_MODE=static` is the single-shared-bearer path (`MCP_BEARER_TOKEN`). It is no longer the default and is not an access-control model, but it is now the documented **self-hosting** entry point (one person, one brain, no Cloudflare-side identity setup), so it is supported rather than legacy. `oauth` + `IDENTITY_MODE=authjs` is what the hosted deployment runs. (History: an `alias: { "ai": … }` entry once stubbed a transitive import from the `agents` package; both the package and `src/stubs/` are gone.)
- **In static mode, `GITHUB_TOKEN` replaces the GitHub App** (`tokenOctokit` in `src/lib/github.ts`, taken in `tenantContext`'s single-tenant branch ahead of `installationOctokit`). Every call `brain-repo.ts` makes is available to a fine-grained PAT with Contents + Pull requests write on the one repo, so `GITHUB_TOKEN` + `BRAIN_REPO_OWNER`/`NAME` is the whole GitHub side: no org, manifest flow, PKCS conversion, or installation id. The App path is unchanged and still required for `oauth`, which mints a token per tenant from one installation. Commits are attributed to the token's owner rather than to the App.
- **Single-tenant mode does not register the org tools.** `hasOrgModel` (`AUTH_MODE === 'oauth'`) gates `registerMemberTools`, `registerConnectedAccountTools`, and `registerOrgOnboardingTools` in `buildServer`: with no `orgs`/`memberships` rows they can only reject, an advertised tool costs context in every conversation, and a refusal reads to the model as a permissions problem to work around. Same rule as `FEEDBACK_REPO`. `brains` stays registered: the app's nav calls it on every open and learns which destinations exist from its `features`, and with no signed-in user it returns an empty list.

## Brain model: arbitrary structure (no entity types)

**The wiki is arbitrary folder structure.** There are NO fixed entity types (the old
`people/teams/customers/concepts/…` taxonomy was removed 2026-07) and NO auto-generated
by-type index. This is the product model: the app is multi-tenant, managing many brains
that are ordinary GitHub repos owned by different companies — each organized however its
owner likes, not forced into our schema.

- **Librarian tools are path-based:** `write_page` (create-or-update, `mode` guards) takes a
  target `path` anywhere under `wiki/`; `move_page` takes `new_path` (or `new_title` to rename
  in place) and repoints all inbound links; `delete_page` is path-based. `move_page`/`delete_page`
  also accept a folder path (no `.md`) to move or delete a whole subtree. `validate` checks
  broken links plus advisory OKF structure notes (see below); it has no frontmatter-shape or
  orphan checks — those assumed types.
- **`write_page` edits part of a page without replacing it** (`append`, `edits`; engine
  `src/lib/page-patch.ts`, pure, `pnpm test:patch`). `content` still replaces the whole
  body, which made every small change a read-the-whole-page-then-rewrite-it cycle and put
  an agent that couldn't read first one call away from silent data loss (that is exactly
  how this shipped: an agent hunting for `read_page` mid-edit failed to retrieve it and
  reported the retrieval miss as "I have no way to read pages"). `edits` is a list of
  exact find/replace pairs applied in order to the BODY of the authoritative blob;
  `append` adds at the end. Two safety rules, both tested: an anchor must match **exactly
  once** (zero or several aborts the entire call, so a batch is never half-applied), and
  an anchor **inside an `okf-view` snapshot region is refused** because that text is
  regenerated on the same save. Patched bodies bypass `splitProvidedContent` via
  `updatePageWrite`'s `rawBody` arg (they are already frontmatter-free, and a body
  starting with `---` must not be re-parsed as frontmatter). A whole-body `content` write
  now reports the size of what it replaced, so a clobber is visible in the transcript.
- **Only `wiki/log.md` is tool-maintained** (append-only changelog). `wiki/index.md` is
  now just a regular editable page; new brains are scaffolded with no predefined wiki
  folders and no index.
- Frontmatter is optional/free-form, and now WRITABLE that way too: `write_page`'s
  `fields` sets or removes any brain-owned key without touching the body (see [Writing
  frontmatter](#writing-frontmatter-fields-and-the-properties-panel)).
  `isToolMaintained` (src/tools/librarian.ts) and `isEditablePath` (app/main.tsx) are
  the write-policy guards. Schema doc for agents: `brain-template/AGENTS.md`.
- Future: "special folders" (e.g. skills) may get meaning later, but there's no use case
  yet — don't reintroduce a taxonomy speculatively.

## `read_page` vs `view_page` (keep them separate; write the descriptions apart)

Reviewed 2026-07-24 against the "don't grow the tool surface" pressure that took us from
42 → 30 tools. The `list_members`+`view_members` → `members` merge does **not** transfer
here, and the pair stays:

- `read_page` is the **app's own navigation channel** (`app/core/actions.ts` calls it from
  inside the widget). A merged tool would carry `_meta.ui.resourceUri` on the widget's
  internal calls.
- Reading a page is the highest-frequency **intermediate** operation on the surface, where
  the roster and brain list are once-per-conversation surfaces. Widget-per-read is noise,
  and there would be no way to read quietly.

What was actually wrong was the **descriptions**, and it cost us a real failure: the string
`read_page` appeared twice inside **`view_page`'s** description ("prefer this over
read_page…") and zero times in `read_page`'s own one-liner, so a host tool-search for
`read_page` ranked `view_page` first and an agent concluded it couldn't read pages at all.
So: each tool's description must stand alone and **name itself**, cross-tool steering lives
in `SERVER_INSTRUCTIONS` (hosts load it wholesale), and a tool an agent will hunt for by
name mid-task should not be described in one terse line. Both descriptions carry a comment
saying so; don't "tidy" them back.

## `BrainStore`: the storage seam (where a brain physically lives)

`src/lib/brain-repo.ts` exports **`BrainStore`**, the only interface between the tool
layer and a brain's storage, plus **`githubStore(octokit)`**. `TenantContext`/`BrainContext`
carry a `store`; every content read and write goes through it. Added 2026-08-04 so a brain
can also be a git repo on disk (the local runtime, and the e2e batteries with no network).

- **Ten operations:** `getHead`, `branchCommitSha`, `repoWritePolicy`, `listTree`,
  `fetchPages`, `readFile`, `findOpenConfigPr`, `listCommits`, `commitFiles`, `commitOrPR`.
  Not a general storage abstraction: it is what the tools already did, in the shape they
  already did it.
- **`branchCommitSha`, `repoWritePolicy`, and `listCommits` are in it because they were
  raw `octokit.rest.*` calls in `brain-index.ts`, `brain-config.ts`, and `apps.ts`.** A raw
  octokit call in a content path compiles and then fails at runtime on another backend. If
  you reach for `ctx.octokit` while touching a brain's CONTENT, it belongs on the store.
- **`octokit` is still on the context, now OPTIONAL.** It covers the three operations that
  are GitHub as a PLATFORM rather than a brain as STORAGE: create a repository, list an
  installation's repositories, check a repo exists before connecting it. All three are in
  `src/tools/brains.ts` behind `githubClient(ctx)`, all three are org-model tools, and a
  deployment with no GitHub client has no org model and does not register them
  (`hasOrgModel` in `worker.ts`).
- **`commitFiles` atomicity is load-bearing.** `write_page`'s "an edit batch is never
  half-applied" rests on the branch ref not moving unless the whole bundle committed. Any
  implementation must preserve it, which is why a local brain is a git repo, not a folder.
- Coverage: `pnpm test:index` wraps its octokit stub in the real `githubStore` rather than
  stubbing `BrainStore`, so it still exercises `fetchPages`'s GraphQL batching.
  `pnpm test:scope` traps the store with a throwing Proxy, so an authorization test that
  reaches storage fails rather than passes.

## Content index (read-path backend)

The read tools (`search_pages`, `find_inbound_links`, `validate`, `view_graph`) do **not**
scan the repo live anymore — they query a **derived index in D1** (`src/lib/brain-index.ts`,
schema `src/db/index-schema.sql`). This exists because the old live path fetched + parsed
every page from GitHub on each call, which capped scans at ~40 pages (Worker subrequest
budget) and cost hundreds of ms. Querying the index is one or two local D1 statements —
unbounded and ~10× faster.

- **The index is a derived cache, NEVER the source of truth** — the GitHub repo is. Every
  read calls `ensureFresh(db, octokit, repoArgs, brainId, config)` first, which compares the
  branch HEAD (one `getRef`) to `brain_index_meta.indexed_commit_sha`. Unchanged → serve from
  D1. Moved → reindex the changed pages (diff blob shas), then serve. So a query can never
  return content stale relative to the branch, even after edits made **outside our tools**
  (github.com, another agent, a merged PR). There is deliberately **no webhook** — the
  read-time HEAD guard is the correctness mechanism; webhooks would only be a freshness
  optimization (see TODO).
- **Keyed by `brainId = "owner/repo"`** — universal across identity modes, so it needs nothing
  from the org tables. Threaded through `TenantContext`/`BrainContext` (`db` + `brainId`).
- **Links are stored raw and resolved at QUERY time** (`loadResolvedGraph`) against the current
  page set, so adding/removing a page fixes/breaks inbound links with no whole-brain
  re-resolve. Markdown links resolve via `resolveRelative`; `[[wikilinks]]` go through
  `buildWikilinkIndex` / `resolveWikilink` in `wiki.ts` (see below).
- **Wikilink resolution has THREE LANES and both sides share one key** (`wikilinkKey`,
  fixed 2026-08-06, issue #12). A `[[link]]` is written from memory, so it may be the
  page's title, its filename, either in another case, hyphens where the other has spaces,
  a folder path, or carry a `#heading`. `wikilinkKey` reduces all of that to one form and
  the lookup table is built with the SAME function, in order of specificity: path (every
  multi-segment suffix, so `[[Meetings/Weekly Sync]]` works without knowing the `wiki/`
  prefix) → filename → title. Ties go to the first page in path order, so resolution is
  stable across reads. The bug this replaces keyed the table by RAW filename and queried it
  with SLUGIFIED link text, so any page whose filename was not already slug-shaped
  ("2026-06-26 Weekly Sync.md") was reachable only by title — on one 149-page brain that was
  ~100 links reported broken whose pages `list_pages` and `read_page` returned happily. The
  app viewer calls the same two functions (`app/core/actions.ts`), because a link the viewer
  refuses to open must be one validate reports.
- **Link extraction skips code** (`maskCode` in `wiki.ts`): `[[Name]]` inside a fence or
  backticks on a conventions page is a syntax example, not a link, and reporting it is noise
  no one can ever clear. This is why `INDEX_SCHEMA_VERSION` is 4 — v1–v3 link rows hold those
  examples, so `rebuildDerivedFromStore` now refreshes `brain_links` alongside titles and
  fields, lazily, from stored content.
- **The batched `fetchPages` (GraphQL) is the indexer's fetch engine** — a (re)build costs
  `ceil(changedPages / 100)` subrequests, not one per page. `MAX_SCAN_PAGES` (1500) is now a
  memory/time sanity bound, not a subrequest limit.
- **Schema ships via CI now (don't apply --remote by hand):** the D1 schema is managed by the
  **wrangler migrations framework** (`migrations/`, canonical baseline `migrations/0001_init.sql`;
  `src/db/*.sql` are reference only). The deploy workflow runs `wrangler d1 migrations apply
platform-db --remote` **before** the code ships (schema-first), so a merge to `main` ships
  schema + code together — never run `--remote` manually. Migrations are the half a
  **rollback cannot undo** (see the deploy section below), which is what makes the
  backward-compatibility rule below load-bearing rather than tidy. Locally: `pnpm db:migrate` (apply),
  `pnpm db:migrate:list`, `pnpm db:migrate:new <name>` (create the next `NNNN_<name>.sql`).
  Migrations must be backward-compatible with the still-running old code for the deploy window
  (additive; renames/drops → expand-then-contract). Existing brains self-populate the content
  index lazily on first read (no manual backfill).
- **The write path discovers affected pages via the index, not a whole-brain scan.** Link
  repointing (`move_page`, `write_page` retitle, and `move_page` on a folder) and the "still
  referenced" heads-up on delete (`delete_page`, incl. on a folder path) find the pages they touch through
  `backlinksTo` on the content index (`fetchInboundLinkersForPaths` / `inboundRefs` in
  `src/tools/librarian.ts`), then fetch just those blobs fresh for the read-modify-write.
  Bounded by inbound-link count rather than brain size, and uncapped: a linker beyond the
  old `MAX_SCAN_PAGES` ceiling is no longer silently missed. (The whole-brain `scanContent`
  helper is gone as of this change.)
- **Writes are WRITE-THROUGH** (issue #31). A successful DIRECT commit upserts the index rows
  for exactly the pages its bundle touched (`writeThroughIndex` in `brain-index.ts`, called from
  the `commitBundle` chokepoint in `librarian.ts`) and advances `indexed_commit_sha`, so the
  read an agent makes to verify a write costs one `getRef`, not an incremental reindex. The
  replacement and freshness marker land in ONE conditional D1 transaction: every statement
  requires the index to still be at the commit's base revision and exact row-shape version, so
  a concurrent reconcile/write makes the whole batch a no-op rather than mixing generations.
  Bundles over the conservative 40-statement transaction budget skip write-through and reconcile
  normally on the next read. PR writes do too (the branch has not moved), as does the fs backend:
  its revision is a digest of the mutable working tree, not an immutable commit this bundle alone
  produced. Failures are swallowed because the source-of-truth commit already landed. Blob shas
  are computed with Web Crypto SHA-1 (`gitBlobSha`). The write tools'
  descriptions also carry the timeout-retry guidance (read before retry; a retried create fails
  if it landed). Idempotency keys were considered and deferred — see `docs/roadmap.md`.
- **Queryable frontmatter** (`brain_page_fields`, Phase 1 of the derived-views PRD): every
  scalar/list-of-scalar frontmatter key is indexed per page (hard caps in `brain-index.ts`;
  optional `indexedFields` in `.isomorphic.json` restricts). `brain_index_meta.schema_version`
  lazily backfills brains indexed before the table existed, from stored content, no refetch.
- **No unbounded work in one read.** Both catch-up passes are budgeted and RESUMABLE, because
  an over-long one doesn't degrade to "slow" — it degrades to "this brain can never be read
  again". A whole-brain derived rebuild (a `schema_version` bump) and a large incremental
  reconcile each used to run to completion inline, writing their progress only at the end; on
  a ~3,000-page brain that exceeded the host's 60s tool timeout, so nothing was written and
  the next read restarted it, forever. Now `rebuildDerivedFromStore` walks
  `REBUILD_PAGE_BUDGET` pages per request from `brain_index_meta.rebuild_cursor` and only
  advances `schema_version` when it reaches the end, and `incrementalReindex` re-fetches at
  most `REINDEX_PAGE_BUDGET` changed pages, leaving `indexed_commit_sha` alone when it
  couldn't finish. Successive reads converge. **Any new whole-brain pass belongs in this
  shape** — budget, cursor, advance-the-marker-only-when-done.

## Derived views (okf-view)

Phases 1+2 of `docs/design/derived-views-and-sync-prd.md` (FR-1a/1b/1c/1d + FR-2) are built.
A page declares a computed view as a fenced ` ```okf-view ` block. Grammar: `kind` is the
SOURCE (`backlinks` = pages linking to `of`/this page; `pages` = content pages, optionally
scoped by `under: <prefix>`; `folders` = the direct sub-folders under `under`, each
represented by its folder note — note-less sub-folders show unlinked), `as` is the
RENDERING (`list|table|count`), plus `filter` (frontmatter match), `group-by` (sections, or
per-group tallies with `as: count`), `columns`, `describe`, `sort`/`order`, `label`.
`kind: count` is shorthand for backlinks + `as: count`. A directory index (replaces
hand-written `*/index.md`) is `kind: pages` + `under` + `group-by`; a directory-of-directories
(one row per sub-folder, no per-page `type:` tagging) is `kind: folders` + `under` — its
`under` defaults to the containing page's own directory. Folder-note names
(`FOLDER_NOTE_NAMES` = `index.md` > `README.md`) live in `view-directives.ts` as the single
source of truth (app tree re-exports). Engine: `src/lib/views.ts` (index-coupled) +
`src/lib/view-directives.ts` (pure parse/segment/snapshot layer, safe for the app bundle).

- **Three renderings from one source.** `display` (fence replaced by the live result — what
  `view_page` serves the app), `snapshotted` (fence + cached static rendering between
  `okf-view:snapshot` markers — what's written to the file and what `read_page` serves agents),
  `stripSnapshots` (what `edit_page` sends the editor, so generated content never round-trips
  ProseMirror; snapshots regenerate on save).
- **The snapshot is cosmetic fallback only** (decided 2026-07-22): it exists so github.com /
  raw-OKF consumers see a real table, refreshes only when its own page is written through our
  tools, and is allowed to go stale between writes. Executing consumers always compute live
  from the index (`ensureFresh` first), so app/MCP results can never be stale.
- **Fail-open everywhere:** any view-computation failure falls back to raw content — a view
  never makes a page unreadable or blocks a save. Malformed directives render a visible note.
- `pnpm test:views` is the engine's golden test (pure, stubbed index).

## Folder notes

A folder that has a direct child named `index.md` (preferred) or `README.md` **IS** that
page — the folder note. There's no special file type or frontmatter; it's a naming
convention. The names, in priority order, live in **`FOLDER_NOTE_NAMES` =
`['index.md', 'README.md']`** in `src/lib/view-directives.ts` (the pure view layer) as the
single source of truth; `app/core/util.ts` re-exports it (`isFolderNoteName`) so the browser
tree, breadcrumb, and the view engine can never disagree on what a folder note is. Behavior:

- **App navigation** (`app/`): clicking a folder **in the file tree** opens its folder note
  instead of just expanding it, and the note's own row is hidden as a redundant sibling. A
  note-less folder just expands. Hovering a note-less folder in the tree shows an "Add folder
  note" action that creates `index.md`, pre-seeded with a directory view. **The BREADCRUMB
  does not do this** (changed 2026-08-21): a folder crumb always opens the tree revealed at
  that folder. Opening the note when one existed and the tree when one did not made a single
  control do two different things based on a fact the trail never showed, so pressing `wiki`
  landed on a page and pressing `concepts` landed on the tree with nothing to explain why.
  The tree is the answer that is always available and always the same, and it does not hide
  the note: a folder with one shows it as that folder's own row.
- **Engine** (`kind: folders` okf-view): each direct sub-folder under `under` is represented
  by its folder note (linked via `index.md` > `README.md`); a sub-folder with no note renders
  as an unlinked, deslugged name. This is the directory-of-directories source — see the
  derived-views section above.
- **Telling the model** (added 2026-07-24, after a brain got `vendors/overview.md` instead of
  `vendors/index.md`): the convention is a naming rule with no in-band signal, so an agent
  can't infer it. Three places state it, in descending reach: the `instructions` field of the
  MCP server (`SERVER_INSTRUCTIONS` in `worker.ts`, which reaches every brain including
  adopted repos with no `AGENTS.md`), `write_page`'s `path` description (point of decision),
  and `brain-template/AGENTS.md` (scaffolded brains). `validate` closes the loop after the
  fact: `folderNoteSuggestions` (librarian.ts) flags a note-less folder holding an
  overview-shaped page (`overview|about|home|summary|start-here`, or a filename/title
  matching the folder name) and names the `move_page` to fix it. Deliberately silent on
  folders with no overview-shaped candidate; "this folder has no note" is not a defect.
  Note that `instructions` is only emitted in the `initialize` result (SDK
  `server/index.js` `_oninitialize`), so it is fixed for the life of a connection: making
  it per-brain would go stale on `switch_brain` exactly like the custom-tool roster does.

Why `README.md` too: Obsidian/GitHub-convention vaults (e.g. an Obsidian vault's Projects folder) used
`README.md` as the folder note, so it's accepted as a fallback without forcing a rename.
`index.md` is unambiguous and what "Add folder note" writes. (History: `index.md` used to be
a tool-maintained special file; it was demoted to an ordinary editable page when typed
entities were removed 2026-07 — folder notes are a later, purely navigational convention.)

## Open Knowledge Format (page granularity, `type:`, nested frontmatter)

Brains target Google's **[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**
(OKF v0.2, Apache-2.0). Read the spec before asserting anything about it — it postdates most
model training data, and `okf-view` in this repo is _our_ directive syntax, not part of it.
What OKF actually constrains: every concept is its own `.md` file, `type:` is the **one
required frontmatter field**, `index.md`/`log.md` are **reserved** names (listing and history,
never concept documents), links are ordinary markdown (bundle-relative `/…` preferred), and
consumers must tolerate missing optional fields, unknown `type` values, and broken links.
None of this reintroduces a taxonomy: `type` is a free-form string, and folders stay arbitrary.

- **Why this got added** (2026-07-24): a brain that correctly gave every system, vendor, and
  person its own page then wrote **twelve event franchises as bullet sections inside one
  `index.md`**. Two failures at once — twelve concepts with no path (unlinkable, untypeable,
  invisible to search and to any view), inside the one filename OKF reserves as a listing. The
  cause was not ignorance of the pattern (the sibling folders were right); it was an
  instruction ("don't put specific event data in the brain") over-applied from _no instances_
  to _no entities_. A concept is the recurring named thing (the series); a record is a dated
  occurrence. `type:` is the discriminator that forces that question, and the brain wasn't
  carrying it.
- **Telling the model**, same descending-reach pattern as folder notes: `SERVER_INSTRUCTIONS`
  (a ONE PAGE = ONE CONCEPT bullet plus a "match the brain you are in" bullet), `write_page`'s
  own description and its new **`type` argument** (the point of decision — a schema slot the
  model sees on every call beats prose it may not read), and `brain-template/AGENTS.md`.
  `write_page` puts `type` first in generated frontmatter and falls back to a `type` the caller
  wrote into the content's own frontmatter.
- **`validate` closes the loop** (`pnpm test:structure`, pure): `inlinedConceptSuggestions`
  flags a folder note holding ≥4 sibling sections that have prose, no links out, and no page of
  their own — tuned against false positives with a structural-heading stoplist
  (`overview|background|risks|…`), a narrative-heading guard (question marks, leading
  verbs/`why`/`how`, >6 words), and the fenced-block strip so a rendered `okf-view`'s generated
  headings don't count. `typeFieldSuggestions` reports **inconsistency**, not absence: a wholly
  untyped brain gets one soft adoption note, a half-typed one gets its stragglers named. Both
  are advisory; nothing blocks a save.
- **Nested frontmatter is preserved verbatim** (`FrontmatterBlock` in `wiki.ts`). This fixed a
  live data-loss bug, not just an OKF gap: the flat parser (`string | string[]`) reduced
  `generated: {by, at}` to `''` and `sources: [{resource, title}]` to one mangled list item,
  and `serializeFrontmatter` wrote that back — so any externally-produced OKF page (ETL,
  github.com edit) lost its provenance on the first save through our tools. Nested runs are now
  captured as opaque lines and replayed byte-for-byte (`|`/`>` indicators kept). They are
  deliberately **not interpreted**: not indexed into `brain_page_fields`, so `okf-view`
  `filter:`/`group-by:` can't see inside them, and the importer treats a block as never-equal
  so a source-owned key still overwrites. `INDEX_SCHEMA_VERSION` went 1 → 2 because v1 rows
  hold the old mangled values; existing brains rebuild lazily from stored content, no refetch.
- **One title resolver, and the H1 counts** (`pageTitle` in `wiki.ts`). A page can state its
  name three ways — `title:` frontmatter, a body `# H1`, its filename — and there were **two
  duplicate implementations** of the fallback (`brain-index.ts` and `librarian.ts`), neither of
  which looked at the H1. So a page could render under one name, be listed under another, and
  be `[[linkable]]` by a third; worse, every folder note without frontmatter was titled
  **"index"**, because that is its filename. Now one resolver: explicit `title:` > first body
  `# H1` (fences stripped, inline markup stripped) > filename, or the **folder's** name for a
  folder note. Wikilinks resolve by title, so widening this widens what `[[Foo]]` finds.
  `INDEX_SCHEMA_VERSION` → 3 and `rebuildFieldsFromStore` became `rebuildDerivedFromStore`,
  which now also refreshes `brain_pages.title` (it only rebuilt field rows, so a version bump
  alone would have left stale titles).
- **`backlinksTo` returns a single `count`.** Links come in two syntaxes and every consumer had
  to remember to add `mdCount + wikiCount`; one that forgets silently under-counts. `count` is
  the total and is what callers should use, with the split kept only for surfaces that report
  the two syntaxes to a human (`find_inbound_links`). Two more `validate` advisories close the
  loop on both redundancies: `ambiguousTitleSuggestions` (pages sharing a title, so a wikilink
  can only reach one) and `wikilinkPortabilityNote` (a one-line count of links an outside OKF
  reader cannot follow — informational, since a brain may be deliberately Obsidian-first).
- **Known divergences from OKF, accepted deliberately:** `[[wikilinks]]` are an Isomorphic
  extension no outside OKF reader resolves (markdown links are the portable form);
  `README.md` as a folder-note fallback is not an OKF reserved name, so such a page is
  technically a concept document owing a `type`.

## Writing frontmatter (`fields` and the properties panel)

Built 2026-08-10, from the "Related" half of issue #14. Frontmatter was read as an
open key space and written as a closed one: the indexer stores **every** flat key
(`brain_page_fields`), `okf-view` filters and groups by any of them, and the app
renders any of them as a properties grid, while `write_page` exposed exactly four
(`title`, `type`, `description`, `status`). So a brain could invent a vocabulary,
query it, and display it, but the only way to SET one of its own keys was `content`,
which replaces the whole body. The reported case was 44 archived todos that could
not be marked `done:` without rewriting all 44 pages.

- **`fields` on `write_page`** is JSON Merge Patch (RFC 7386): a present key sets, an
  explicit `null` removes, an absent key is untouched. It rides the path that already
  existed, since `updatePageWrite` keeps the body verbatim when a call carries neither
  `content` nor a patch. Engine is `applyFieldPatch` in `src/lib/page-patch.ts`, pure,
  beside the body patcher it is the twin of (`pnpm test:patch`).
- **Three refusals, each forced by something else in the codebase, not by taste.**
  (1) Key names must match `parseFrontmatter`'s `FM_KEY_RE` (`[A-Za-z0-9_-]`), which
  SKIPS lines it cannot parse: a key with a space would be written successfully and
  vanish on the next read, so the writer must not be able to produce a file our own
  reader loses. (2) The managed keys are refused with a pointer to their own argument;
  `title` is why this is a rule rather than a preference, since a retitle repoints every
  inbound wikilink in the same save and a `fields`-set title would break links silently.
  (3) A key currently holding a nested `FrontmatterBlock` is refused for BOTH set and
  remove, because those runs are replayed byte for byte and flattening one destroys
  provenance the caller has not read. That is the same invariant `edits` enforces: you
  cannot destroy what you have not seen.
- **This is deliberately PER-PAGE, and the batch case is unbuilt.** A `set_fields`
  tool (an explicit `paths` list, one `commitOrPR` bundle, one changelog line) was
  written and then cut before merge. The reasoning is in
  [`docs/roadmap.md`](docs/roadmap.md): the routing rule between it and `fields` came
  out to "how many pages", which is the wrong axis (the real question is whether it is
  the SAME change), and the more valuable missing capability turned out to be bulk
  find/replace, which `set_fields` would not have covered. So the 44-page case still
  costs 44 calls and 44 changelog bullets. Do not re-add a fields-only batch tool
  without reading that item first.
- **The app's properties panel is editable** (`PageProperties` in
  `app/views/PageView.tsx`), which is the half that serves humans rather than agents.
  Its edit policy is not a second copy of the rules: it imports `isUsableFieldKey` from
  the write path, routes `type`/`description`/`status` through their own arguments, and
  never offers an edit on `sources` (rendered as a count, often the nested block) or
  `updated` (stamped every save). Editing is offered in the VIEWER only, never in
  `EditView`, where a property write would race the unsaved body the author has open.
- **Told to the model in the usual three places**, descending reach: `SERVER_INSTRUCTIONS`
  ("metadata is a field write, not a rewrite"), `write_page`'s own description and the
  `fields` argument, and `brain-template/AGENTS.md`.
- **Indexing needed nothing.** `brain_page_fields` already indexes every flat key, so a
  new key is filterable on the next read. `write_page` does warn past
  `MAX_FIELD_KEYS_PER_PAGE` (24), where the indexer stops reading keys: without that,
  the field would be set in the file and invisible to `okf-view`, surfacing later as a
  view that mysteriously misses pages.
- Coverage: `pnpm test:patch` (the pure engine, including byte-for-byte survival of a
  nested block), `pnpm test:e2e-librarian` (the real write path: body untouched, one
  commit, every refusal proving nothing was written), and `pnpm test:scope`, which now
  registers the librarian tools and asserts all three content writes gate on the BRAIN
  role at `editor` in both directions. **Uncovered:** the app layer, as everywhere else.

## Retried writes, and what a lost answer costs (issue #50)

A caller reported ~40% of MCP calls failing with Cloudflare `502
origin_bad_gateway` inside a ten-minute window, the connect included, every one
of them succeeding on retry. The functional half was recoverable. The
correctness half was not: a 502 on `write_page` says nothing about whether the
commit landed, so every retry had to be preceded by a `read_page`, and both ways
of guessing wrong are silent — a retried `append` duplicates the text, a retried
`mode: "create"` fails claiming the page exists.

Read the error body before assuming the origin was ours. Its `zone` was
`api.anthropic.com`, not this Worker's, so the 502 was generated in front of
Anthropic's API by ITS origin; a slow Worker is one way to cause that and not the
only one. The evidence in that report says our commits never landed at all (every
retried create SUCCEEDED, which `mode: "create"` would have refused had the first
attempt committed), and there was no deploy that day. Confirming it needs the
Worker's own logs for the window, which is what the ray ids in the report are for.

**The write-attempt ledger** (`src/lib/write-dedupe.ts` pure + the D1 half
`src/lib/write-dedupe-store.ts`, migration 0007, `pnpm test:dedupe`) makes an
identical retry safe rather than merely documented. `guardedWrite` in
`librarian.ts` wraps `write_page` / `move_page` / `delete_page`.

- **It is keyed on the CALL, never on the commit**, and that is the whole design.
  An append's bundle is not stable across a retry: attempt 1 reads body B and
  commits B+T; if that lands, attempt 2 reads B+T and commits B+T+T. Anything
  fingerprinting content would miss exactly the case this exists for. The
  fingerprint is SHA-256 over (actor, tool, canonicalized arguments), with the
  `brain` routing argument excluded because the resolved `brainId` already keys
  the row.
- **The claim is taken BEFORE the handler and given back on any non-landing
  exit.** Before, because the client gives up long before the Worker does and a
  row written only on success would let the retry commit a second time. Given
  back, because a refusal is deterministic (re-running it says the same thing) and
  a fingerprint left reserved by a failed call blocks that write for minutes.
- **It wraps the whole handler, not `commitBundle`.** The create case never
  reaches a commit: `write_page`'s own "that path already exists" check fires
  first, and what that check told a retry was the confusing half of the bug.
- **Two windows, answering different questions.** `IN_FLIGHT_GRACE_MS` (2 min) is
  how long an unfinished attempt speaks for itself; past it a claim is TAKEN OVER,
  because a Worker killed mid-request leaves a row nobody will finish and a
  permanently blocked fingerprint is worse than the duplicate it prevents.
  `DONE_TTL_MS` (10 min) is how long a completed attempt is replayed. Rows are
  pruned by the next claim on the same brain, so there is no prune job and the
  table is bounded by write concurrency rather than write volume.
- **Fail-open, twice over.** A ledger that cannot be reached runs the handler
  exactly as it ran before this existed, and bookkeeping AFTER the write never
  changes the answer: the commit is the fact and this table is a cache of it, the
  same rule `writeThroughIndex` follows.
- **The accepted trade-off:** a DELIBERATE identical write inside the done window
  is reported as already applied rather than applied again. It is not silent (the
  caller is told what it is repeating and when it landed), varying anything makes
  it a different write, and the alternative is being unable to tell it apart from
  the retry — which is the bug. **Not covered:** `sync_records`, which has its own
  ledger-backed idempotency, and the editor's saves, which are sha-guarded.

**The `/mcp` preamble** (`src/lib/mcp-preamble.ts`, `pnpm test:preamble`) is the
other half, and it is about the request path rather than the write.

- **A throw in the preamble used to leave no reply at all.** `loadActiveBrain`,
  `buildServer` and `server.connect` run before the transport, outside any tool
  handler, so the SDK's error mapping never sees them — and
  `workers-oauth-provider` does not catch around its api handler either. An
  uncaught exception reads upstream as an invalid response and reaches the user as
  a bare gateway error. The handler answers with a JSON-RPC error carrying the
  reason and the **CF ray id**: the report that opened this listed four ray ids
  and there was nothing to join them against. 200 when the request id is known (a
  JSON-RPC error object IS a completed exchange, and it is the form that reaches
  the user as OUR message), 500 only when no valid reply can be addressed.
- **`initialize` no longer resolves a brain.** Every POST used to pay for a KV
  read, a tenant lookup, an installation-token mint and an index freshness check
  before anyone read the method — all to discover the brain's own `tools/` pages.
  `needsBrainPreamble` skips that for `initialize`, `ping` and notifications, and
  is conservative in both unknown directions. **`tools/list` still resolves**, on
  purpose: a brain's own tools belong in the list it returns.
- `loadActiveBrain` is fail-open like `loadCustomTools`. That pointer is a
  preference; a KV blip should fall back to the default brain, not fail the call.

**Still open from that report:** whether the Worker itself was slow during the
window (needs the logs), and the installation-token cache on `docs/roadmap.md`,
which would take one more GitHub round trip off every call.

## User-defined tools (brain-tools)

A brain can define its **own MCP tools**: any content page under a **`tools/`** folder
(e.g. `wiki/tools/standup-digest.md`) is registered as a tool named `tool_<filename>` in
Claude's tool list. Engine: `src/lib/custom-tools.ts` (pure parse/schema/interpolation,
`pnpm test:tools`) + `src/tools/custom.ts` (index discovery + registration + execution).
Built 2026-07-24 (branch `feat/user-defined-tools`).

- **A tool is a page.** `isToolPagePath` = any `.md` under a `tools/` path segment that
  isn't a folder note. Discovery (`loadCustomToolDefs`) runs off the content index
  (`listIndexedPages` filtered, then the few blobs fetched + parsed — "index to discover,
  blobs for authority", same as the write path), so it's cheap when there are none and
  **per-brain** (switching brains swaps the toolset). Capped at 25/brain to bound the
  host's tool-list context cost; overflow/malformed/dup pages are reported by `validate`.
- **Declared in a fenced ` ```tool ` block** (the okf-view precedent — a small line grammar,
  NOT YAML, so it survives the flat `parseFrontmatter` and ProseMirror round-trips). Grammar:
  `input: <name> (<type>[, default=][, optional]) <desc>` where `<type>` is
  `string|number|boolean|enum: a|b|c`; `op:` + `arg: k = v`; `widget`; `view:` (rest of the
  block is the directive). The page body outside the fence is the instruction payload. Name
  comes from the filename, description from frontmatter.
- **Three read-only kinds, none escape the brain:** `prompt` (return the interpolated body
  to the model — a saved skill), `op` (run ONE whitelisted read: `search_pages` / `read_page`
  / `find_inbound_links` / `list_pages`, append its result), `view` (render ONE okf-view via
  the same `tryRenderViews` engine `view_page` uses; `widget` returns the app's page shape so
  it opens in the viewer). Args are interpolated as DATA (`{{name}}` via `fill`), never
  evaluated — no code execution, and reads can't exceed the caller's existing access. Writes
  are deliberately NOT in the op whitelist (v1).
- **Registration** is one `registerCustomTools(server, getContext, defs)` in `buildServer`,
  AFTER all first-party tools (a `tool_` name can't shadow a built-in) and before the
  claude.ai `execution`-strip loop (so custom tools get that fix too). `loadCustomTools()`
  runs in the async window before `buildServer` (alongside `loadActiveBrain`), fail-open on
  no-brain/static mode. On-by-default, **editor**-authored (writing `tools/` is a normal page
  write — no opt-in flag, no admin gate).
- **No `list_changed` push** (stateless transport), so create/move/delete of a `tools/` page
  appends a **reconnect nudge** to the librarian response (`toolRosterNote`); the host only
  sees a new/renamed/removed tool after it re-lists. Editing an existing tool's BODY takes
  effect on its next call with no reconnect (the handler reads the def fresh each request).
- Authors write these conversationally via `write_page` (Claude authoring Claude's own future
  tools). Contract for agents: `brain-template/AGENTS.md`. E2e: `e2e-librarian.ts` drives
  author → discover → reconnect → invoke against real GitHub. **Not built:** hiding `tools/`
  pages from normal content listing/search (they currently show as ordinary pages);
  server-side tool-to-tool chaining (compose at the model layer instead).

## Bulk import (sync_records — PRD Phase 3, FR-3)

Non-destructive upsert-by-key from an external source (spreadsheet/CRM), replacing
wipe-and-regenerate ETLs. Planner: `src/lib/brain-import.ts` (pure; `pnpm test:import`);
tool: `src/tools/importer.ts`. Invariants, in order: human edits are sacred (only declared
`source_owned` frontmatter is written; body at create only); deletions are PROPOSED, never
applied (requires the call to pass the full key `manifest`); NO RESURRECTION (a per-source
repo ledger at `.isomorphic/imports/<source>.json` records ever-imported keys — a key whose
page a human removed becomes a needsDecision, not a create); idempotent (unchanged run =
no commit). Pages bind to keys via `source_key` frontmatter; curators alias a consolidated
duplicate's key onto the surviving page via `source_keys` (both are ordinary frontmatter, so
key→page discovery is one `brain_page_fields` query — but diffs run on authoritative blobs,
never index values). Batched ≤200 records/call; lands as one `commitOrPR` bundle (pages +
ledger + changelog). A create aimed at an existing page ERRORS (clobber guard) unless the
call passes `adopt_existing: true`, which binds the unclaimed page instead (field merge +
`source_key`, body untouched) — the migration path for brains that predate import keys. `resolve_import` applies the human answers durably (suppress / delete /
alias-onto-surviving-page / recreate) so the next sync stops asking; FR-4's
`sourceOfTruth` config is parsed ('app' default; 'source' reserved — the importer refuses
it). **Open questions persist in the ledger's `pending` list** (merged chunk-safely: a
call only speaks for its own record keys; only manifest calls replace absence proposals)
and **`validate` surfaces them** — so unanswered questions are visible without a sync run
in hand, until resolve_import clears them. `scripts/e2e-import.ts` is the manual
real-GitHub battery (32 checks, scratch repo, D1 shimmed on node:sqlite — run by hand when
the import path changes, never in CI). Not built yet: a reconciliation widget; the
the contacts-brain ETL cutover.

## Product feedback (submit_feedback)

`submit_feedback` (`src/tools/feedback.ts` + the pure `src/lib/feedback.ts`,
`pnpm test:feedback`) files a user's bug/idea as an issue on a GitHub tracker, so
feedback reaches the maintainers from inside the conversation and the reporter needs
no GitHub account. Built 2026-07-30. Four decisions that are load-bearing:

- **It does NOT use the platform GitHub App.** `src/manifest.ts` declares no
  `issues` permission and must not gain one: that would widen the scope of every
  customer org's installation to buy those customers nothing, and a self-hoster's
  App cannot reach this project's repo anyway. Filing runs on a separate narrowly
  scoped credential, `FEEDBACK_TOKEN` (Issues: write on one repo).
- **Destination is config, never identity** (`FEEDBACK_REPO`, "owner/repo"). Unset →
  the tool is **not registered**, so a fork neither files into our tracker nor
  advertises a tool that can only apologize. Same rule as `PUBLIC_BASE_URL` and the
  App slug. See [Deployment config](#deployment-config-wranglerjsonc-is-generated).
- **The tracker is public, so nothing identifying is published.** The issue carries
  the user's words plus an opaque `ISO-XXXXXXXX` report id; who filed it, from which
  org and brain, goes to a private D1 row (`feedback_reports`, `migrations/0005`).
  That is how "who asked for this?" stays answerable without a customer's email
  being permanently indexed on a public repo. `composeIssue` takes no identity
  argument at all, and the golden test asserts its arity to keep it that way: a
  well-meaning "include the reporter so we can follow up" edit reads as an
  improvement in review and is a privacy regression.
- **The confirm gate is the real backstop, not the redaction.** A call without
  `confirm: true` posts nothing and returns the exact title and body for the user to
  read. `redact()` only strips shapes that are never legitimately in a bug report
  (PEM blocks, bearer headers, `gh*_`/`re_`/`sk-` tokens, JWTs, emails) and
  deliberately leaves commit shas, paths, and error text intact, because a scrubber
  aggressive enough to catch every secret makes reports useless and gets deleted.
  Both halves are pinned by `pnpm test:feedback`.

Identity is read straight off the token props in `worker.ts`, **not** through
`tenantContext`, which throws `NoBrainError` for a user with no brain: the user who
cannot resolve a brain is exactly the user with something to report, so the one tool
that reports it must not depend on resolution succeeding. Also fail-open on the
duplicate search and on the D1 rate-limit count. **Not built:** an in-app form
widget (v1 is conversational only), and any write back to the reporter when an issue
is closed.

## Usage analytics (the org Analytics tab)

`analytics` (`src/tools/analytics.ts` + the pure `src/lib/usage.ts` and the D1
half `src/lib/usage-store.ts`, `pnpm test:usage`) answers "is this organization
actually using its brains, and who isn't": active members over the window, reads
vs edits per day, a per-brain breakdown, and a per-person table. Built 2026-08-04.
UI is `app/views/AnalyticsView.tsx`, an ORG-scope destination beside Members.

- **Per-day counters, not an event log** (`usage_daily`, `migrations/0006`). One
  UPSERT per tool call at grain (day, org, brain, user, tool), so rows are bounded
  by members × brains × tools × days and every query is a GROUP BY. A raw event
  log was the alternative and was rejected on three counts: unbounded growth
  needing a prune job on day one, a per-person action timeline sitting in D1, and
  scans instead of aggregates. One UTC day is the finest granularity the tab has
  any use for. `brain_id` is `''` and never NULL for org-scope calls, because
  SQLite treats PK NULLs as DISTINCT and a nullable column would defeat the
  upsert, appending a row per call forever.
- **`USAGE_ANALYTICS` (and `hasOrgModel`) gate BOTH the recording and the tool registration**, so a
  deployment that disables it records nothing and never shows a tab that can only
  answer zero. The generated config defaults it to `"true"`; set it to `"false"` to
  turn the feature off. Single-tenant deployments do not register it either: the tab
  is org-scope and there is no org to resolve. The Worker compares `=== 'true'` rather than `!== 'false'`,
  so a config that does not mention the key at all (hand-written, or predating this)
  records nothing: the only way to start collecting is a config that says so.
- **Recording rides the loop that already rewrites every registration.**
  `McpSession.instrument()` (worker.ts) wraps each `_registeredTools` callback in
  the same pass as the claude.ai `execution` shim, so it is the one place that
  sees every tool by name and the one place a new tool cannot forget to opt into.
  It writes through `ctx.waitUntil` after the result has gone back, swallows its
  own failures (a counter must never turn into a failed `read_page`), counts an
  `isError` result as an error rather than a success, and clears `_resolvedScope`
  first so a call that resolves no org records nothing instead of borrowing the
  previous call's. Under-counting is fine; blocking a read is not. The wrapping
  logic itself is `countedCall` in the pure lib, extracted so it is testable: it is
  the riskiest code here, since it replaces the function the SDK invokes and a
  mistake breaks every tool rather than skewing a chart. **The SDK field is
  `handler`, not `callback`** — see `docs/references.md`; getting that wrong threw
  on every request and typechecking could not see it through the required cast.
- **TWO SCOPES AGAIN, and the gate is split.** Org totals and the per-brain table
  are viewer+ like the roster; the PEOPLE table is admin+, and is **withheld from
  the payload** rather than hidden by the widget. Per-person read counts are a
  record of what a colleague did with their week, which is a different thing to
  publish than the roster's names. Authorization reads `ctx.orgRole`, never
  `ctx.role`, for the reason in `docs/design/brain-level-permissions.md`.
- **It measures the PRODUCT, not the repository.** An edit made on github.com, by
  a merged PR, or by another agent holding the repo token never reaches a tool
  handler and is invisible here. `FOOTNOTE` says so and travels with every
  rendering; `view_activity` remains the repo-history surface. Do not "fix" this by
  folding commits in: they are a different population and mixing them silently
  double-counts our own writes.
- **`TOOL_KINDS` must gain an entry for every new tool.** Unknown names fall back
  to `read`, which is correct for brain-authored `tool_*` pages (all three kinds
  are read-only by construction) and silently wrong for a new write tool.
  `pnpm test:usage` scans `src/tools/*.ts` **and `src/worker.ts`** for registered
  names and fails on any that is unclassified, so the omission is a red test rather
  than a permanently under-reported edit column.
- **The chart is two small multiples, not one stacked bar.** Reads outnumber edits
  by an order of magnitude, so a shared scale renders the edit series at sub-pixel
  height: the number that answers "is anyone maintaining this?" would be the
  invisible one. Each row is a single series in `--c-accent` scaled to its own
  labelled max, which also means no categorical palette and no legend. (A gray/accent
  two-series version was tried first and failed the `dataviz` validator's chroma
  floor, with dark-mode tritan separation at ΔE 6.4.)
- **The nav learns what exists from `features` on the `brains` payload.** A widget
  cannot list the host's tools, and `ensureBrainList()` already runs on every open,
  so the Analytics row appears only where the server registered it. A picker must
  never offer a destination whose click is refused.
- **Coverage.** `pnpm test:usage` covers the classification map (scanning the tool
  sources so a new tool cannot land unclassified), the summary fold, `countedCall`
  on all five paths (sync/async x return/throw, plus the `isError` result that never
  threw), the SDK internals it depends on including a real dispatch, and the actual
  `usage_daily` statements against the real migration over `node:sqlite`.
  `pnpm test:scope` covers the authorization: that the per-person table gates on
  `orgRole`, asserted on the PAYLOAD (a non-admin's rows must be absent, not merely
  flagged) and in both directions. **Still uncovered:** the `features` flag reaching
  the nav, tool registration actually being skipped when the flag is off, and the
  whole app layer.
- **Not built:** retention/pruning (rows are small, but nothing deletes them),
  a CSV export, per-brain analytics (this is deliberately org-scope), and any
  notion of a session or of time-on-page.

## Loading states (the rotating status line)

Every `{ kind: 'loading' }` in the app renders through one `LoadingView`, which shows
the caller's own literal label first and then rotates through phrases from
`src/lib/loading-lines.ts` (pure, `pnpm test:loading`). Built 2026-08-18.

- **The label leads, always.** The rotation starts 2.4s in, so a load that resolves
  quickly reads exactly as it did before: nothing whimsical is ever the only thing on
  screen while someone waits for an answer, and the personality is spent only on waits
  long enough to feel like waits.
- **The two kinds of line ALTERNATE**, one naming this brain and the next naming the
  library, opening on a specific one. The name-free lines were a fallback queued behind
  the specific ones at first, which spent a normal-length wait entirely on facts and put
  the humor past where almost anybody got to. Interleaved, a rotation reads as one voice
  that happens to know the brain's name. `pnpm test:loading` pins the SLSLSL shape, so a
  change back to appending fails rather than quietly draining the humor out.
- **A slot is a REQUIREMENT.** A template naming `{brain}` / `{org}` / `{subject}` /
  `{pages}` is ineligible when that value is unknown, rather than rendering blank. This
  is structural rather than a pile of conditionals because the state with the fewest
  facts (a cold self-boot: no brain list, no tree, no org) is both the most common and
  the least likely to get tested by hand, and its failure mode is a customer reading
  "Asking undefined…". `pnpm test:loading` walks every template's own slots to prove it.
- **Personalization is LOCAL and free.** The facts come from what the widget already
  holds: the brain it is showing, that brain's org label, the page/folder/query it was
  asked for, and the size of the cached tree. Nothing calls a tool to decorate a wait,
  since the alternative to a wait cannot be a second wait. Nothing reaches for a
  person's name or email either: identity is fetched by one screen on request, and a
  colleague's name is not chrome.
- **`task` is optional on the view and so invisible to typecheck.** An omitted one is
  not an error, it is a screen that quietly stops naming anything the user is looking
  at. The golden test scans `actions.ts` / `main.tsx` / `store.ts` for every
  `kind: 'loading'` and fails on any without a `task`, the same way `pnpm test:usage`
  scans for unclassified tools.
- **Motion is off under `prefers-reduced-motion`**, in CSS (both the fade and the
  shimmer sweep in `app/styles.css`) and in JS (the timer never starts, so one phrase
  holds: the label). Only the label is announced, from an element that never remounts;
  the rotating span is `aria-hidden`, since a live region re-reading a new phrase every
  three seconds is noise.
- **The VIEW is covered too**, unusually for the app layer: `tests/ui/loading.spec.ts`
  drives the real bundle over the `#loading` harness route, which opens the tree and
  then holds the app's own fetches open forever so a wait stays on screen. It pins the
  label leading, a swap happening, the swapped line naming the brain and the page, the
  announcement staying put, and reduced motion holding one phrase.
- **A rotation cannot be STEPPED, only watched**, so that spec records the line with a
  MutationObserver INSIDE the frame and reads the result back at the end. `page.clock.install()` does not pause
  timers here: probed directly, a `setTimeout` in the main frame AND in the app's iframe
  both fire with no `runFor`, so an installed clock moves only what `Date.now()` reports
  while a `setTimeout` chain keeps running on the wall clock. (`advanceable` is still
  right for `refresh.spec.ts`, which asserts on a rendered AGE.) The first version of the
  loading spec asserted at fixed moments and so raced the machine: it checked "still the
  label" after a click plus three awaits, which passed locally and failed on CI, where
  the runner had already spent the 2.4s the label holds for. The second version polled
  `textContent({ timeout: 100 })` from the test and was worse, because it failed
  SILENTLY: under CI load every one of those calls timed out, so it recorded nothing and
  reported an empty sequence rather than a wrong one. Recording in the page is what
  finally held, because runner speed then changes when the answer arrives rather than
  what it says. Assert on ORDER, never on what is on screen at a given millisecond. Also note `test.use({ reducedMotion })`
  at describe level does NOT reach this page; the spec calls `page.emulateMedia`.
- **Three other kinds of wait exist and deliberately do NOT rotate.** (1) Button busy
  labels: `Creating…` (AddBrainView), `Saving…` / `Adding image…` (EditView), `Sharing…`
  (ShareBrainView). Those are a control reporting its own state, and a button whose text
  cycles jokes while a save is in flight is a broken control, not a charming one. (2) The
  two `<MenuNote>Loading…</MenuNote>` in `Breadcrumb.tsx` (folder entries, the brain
  list): a popover the reader is currently aiming at, where text moving under the cursor
  is hostile. (3) `.asset-loading` in `app/styles.css`, the placeholder an `<img>` sits in
  while its bytes arrive, which is a skeleton rather than a status line and is the one
  place the shimmer could extend to. Several paths are also deliberately SILENT and
  should stay that way: `refreshPage`, `revalidateBrowse`, `refreshBrowse`, and entering
  or leaving the editor, all of which keep real content on screen instead of flashing.
- **Not built:** skeleton shells for the page/tree/graph, which are the other half of
  this and are still on `docs/roadmap.md`.

## Brain templates

The brain repo's initial scaffold lives in `brain-template/` (the editable source of truth). Because the MCP Worker now scaffolds brains too (auto-provisioning, below) and Workers have no filesystem, the templates are **codegen'd** into `src/lib/brain-template.generated.ts` via `pnpm gen:templates` (run it after editing anything under `brain-template/`; the generated file is committed). Both runtimes import that module — the scaffold logic lives in `src/lib/scaffold-core.ts` (Worker-safe, octokit Git Data API, no `node:*`), used by both `bootstrap.ts` and the Worker.

## Platform provisioning (who touches GitHub)

The design goal: an **admin** sets the platform up once; **readers/creators never see GitHub**. Mechanism:

- The admin runs `pnpm bootstrap`, registers the platform App, and installs it on **one platform org**. The install-callback records `PLATFORM_ORG` + `PLATFORM_INSTALLATION_ID` (and scaffolds a canary brain to prove repo-create works).
- In `oauth` mode with `AUTO_PROVISION=true`, a signed-in user with no tenant row triggers `provisionBrainForUser()` (`src/lib/provision.ts`) on their first MCP request: it creates `brain-<login>` under the platform org via the **single platform installation**, scaffolds it, and writes the D1 tenant row. No per-user App install, no org-vs-user gate, no repo picking. See `McpSession.autoProvision()` in `worker.ts`.
- Provisioning is idempotent: existing tenant short-circuits; a repo-name collision (partial prior run / concurrent first calls) adopts the existing repo instead of failing.

## Two identity modes (`IDENTITY_MODE`)

The Worker is an OAuth 2.1 server to Claude via `@cloudflare/workers-oauth-provider` (unchanged). What varies is the **upstream human-auth** step behind `/authorize`, selected by `IDENTITY_MODE`:

- **`github`** (legacy/admin) — `src/oauth/github-handler.ts`. GitHub OAuth; token props carry `{ gh_user_id, gh_login }`. Tenant resolved from the flat `tenants` table (`src/lib/tenants.ts`), keyed by `gh_user_id`. Treated as `owner` (full access).
- **`authjs`** (member-facing, **current prod default**) — `src/oauth/auth-handler.ts` + `src/auth/config.ts`. Auth.js (`@auth/core` + `@auth/d1-adapter`) with a **Resend magic-link** provider; users need no GitHub account. Token props carry `{ user_id, email }`. **Google/OIDC is the recommended future primary provider** (redirect-based, same-browser — immune to email prefetch and the cross-browser OAuth-bridge fragility); magic-link works but keep that in mind.

Auth.js specifics that bite: config MUST be built per-request with `env.PLATFORM_DB` (bindings are request-scoped) — `buildAuthConfig(env)`, never a module singleton. DB-strategy sessions **omit `user.id`** unless a `session` callback copies it (we do — the OAuth bridge keys identity on it). The `/oauth/complete` bridge stashes the client's OAuth request in `OAUTH_KV` under `pending_auth:<state>` across the email hop; `authjs.callback-url` cookies are sticky and will silently steer a bare `/auth/signin` visit — clear cookies / use incognito when testing.

## Product identity → org → brain (the authjs authorization model)

`docs/design/org-roles-permissions.md` is the full RFC. Phase 2 is **built and live**. The tenant layer for authjs identities is the org model, NOT the `gh_user_id` `tenants` table:

- **Tables** (`src/db/auth-schema.sql`, app-level; Auth.js's own `users`/`sessions`/etc. are separate, created by `@auth/d1-adapter`): `app_users` (Auth.js user projection — named apart from Auth.js `users` to avoid collision), `orgs` (Model A `platform` / Model B `customer`, holds `installation_id` + `brain_owner`), `memberships` (user→org + `role`), `brains` (org→repo, supersedes `tenants.brain_*`), `invitations` (email invites; written by `invite_member`, consumed at first sign-in via `provisionOrgForUser`).
- **Resolution** (`tenantContext()` in `worker.ts`, via `src/lib/orgs.ts`): `props.user_id` → `app_users` → `memberships` → `orgs` (+ role) → default `brains` row → mint installation token from `org.installation_id`. First-touch users with no membership get a Model-A **org only** (no brain) via `provisionOrgForUser()` when `AUTO_PROVISION=true`; brains are then created **explicitly** (see below). When the org has no brain yet, brain-scope resolution throws `NoBrainError` and the app shows the "create your first brain" state. Org-scope actions (create_brain) resolve via `orgContext()`, which needs no brain.
- **Brain creation & init** (Phase 8, `docs/design/brain-creation-and-init.md`): brains are stood up EXPLICITLY, not auto-provisioned. `create_brain` (any `editor`+, authjs-only) scaffolds a fresh repo via `createAndScaffoldBrain`, writes a `brains` row with a user-given `name` (repo_name is the derived slug; `brainLabel` shows `name`), and switches to it. The app has a "New brain" switcher entry + a create-first-brain empty state (`CreateBrainView` in `app/main.tsx`). **Access is unchanged in this slice** — new brains keep `visibility='org'` (per-brain membership/private-by-default is the deferred follow-up in the design doc).
- **Roles & authz**: `viewer < editor < admin < owner` (`src/lib/orgs.ts`). `tenantContext({ requires })` gates: write tools pass `requires: 'editor'`; reads are open to `viewer`+. The github/static paths report `owner`. (The role token was renamed `member`→`editor` on 2026-07-13 — see `src/db/migrations/`. "member" the noun still means org membership; it's no longer a role name.)
- **TWO ROLES, TWO SCOPES: don't collapse them** (brain-level permissions, built 2026-07-28, `docs/design/brain-level-permissions.md`). `TenantContext` carries `role` (the caller's role **on the resolved brain**) and `orgRole` (their role **in that brain's org**), and `TenantOpts` gates on either: `requires` for brain scope, `requiresOrg` for org scope. Org scope = manage people, connect the GitHub org, create/connect/disconnect brains. Brain scope = read, write, move/delete, configure, share. Gating an org action on `role` is the bug this split exists to prevent: `members.ts` did exactly that, so being shared one brain as admin would have conferred the whole org roster. **`src/lib/orgs.ts:effectiveBrainRole` is the single authority** on whether a caller can reach a brain and at what role: three additive sources (org visibility, an explicit `brain_memberships` grant, the org-admin floor), highest wins, never demotes, unknown `visibility` fails OPEN. It is pure; `pnpm test:access` walks its whole input space, and `pnpm test:scope` pins the other half (which of the two roles each tool actually gates on, in both directions). Every consumer (`listAccessibleBrains`, `getDefaultBrainForUser`, `listBrainAccess`) resolves rows in SQL and then admits them through that function: **do not re-express the policy in a WHERE clause**, or the two copies will eventually disagree. `create_brain` defaults to `visibility='private'` + an admin grant for the creator; `connect_brain` defaults to `'org'` (an admin act on a repo the org already owns); brains that predate the change keep `'org'` and are unaffected. Revocation must actually revoke, so grants are torn down with what they hang off: `disconnect_brain` → `deleteBrainGrants`, `remove_member` → `deleteUserBrainGrantsInOrg`.
- **Brain sharing** (`src/tools/brain-access.ts`): `brain_access` (any access to the brain) opens the inline sharing panel and returns the list as data; `share_brain` (brain admin+) is every mutation in one verb: grant, change level, revoke (`access: 'none'`), and the `private`/`org` visibility flip. Guardrails: share only within the brain's org (a grant to a non-member is unreachable anyway, since resolution starts from `memberships`), never above your own brain role, never revoke yourself. UI is `app/views/BrainAccessView.tsx`. Sharing is a **brain-scope destination** (in `brainDestinations()` and the ⋯ menu's "This brain" group, beside Files/Graph/Recent changes/Members) because it passes the trail's scope test: switching brains shows a different answer. Ungated in both, since `brain_access` is read-only and open to anyone with access; only its controls are admin-gated. That is why `brain_access` is registered **`sticky: true`** in `worker.ts` like the other in-client view tools: the **Share** control in the brains list opens it for a NAMED brain, and without sticky the panel would render under another brain's crumb. Share is gated on `canShare` (brain role), which is deliberately not `canManage` (org role, gates disconnect). Adding someone is `app/views/ShareBrainView.tsx`, a pushed flow off that panel's header (the `app/ui/Flow.tsx` convention that every add-shaped action follows) and the brain-scope twin of `InviteMemberView`. Role NAMES are shared between the two scopes, descriptions are not: `ROLE_BLURB` vs `BRAIN_ROLE_BLURB` in `app/components/RoleSelect.tsx`.
- **Member management** (built 2026-07-13, `src/tools/members.ts`): the org-admin roster surface. `members` (viewer+) both opens the in-client roster UI (`app/views/MembersView.tsx`) and returns the roster as data; **it is an ORG-scope destination in the nav, not a brain one** (`orgDestinations()` in `app/components/Breadcrumb.tsx`, and the ⋯ menu's "Organization" group) because every brain in one org shows the same roster: it takes the back arrow rather than the brain crumb, so it never reads as "these people belong to this brain". Contrast `brain_access`, which IS brain-scope. The three nav scopes (`brain` / `org` / `account`) are the `Scope` type there, and `DESTINATIONS`/`SCOPE_LABEL` are the one place each list and its wording live; the mutations `invite_member` / `set_member_role` / `remove_member` are admin+. (The former split `list_members`/`view_members` pair was merged into `members` on 2026-07-24, tool-surface consolidation.) Lockout-proof guardrails live in `members.ts`: `owner` is never assignable/removable/demotable, you can't edit your own membership, and you can't grant above your own role. Admins can make Admins; all members can see the roster (incl. emails). Invites are consumed at first sign-in by the already-wired `provisionOrgForUser` path. `orgId`/`actorUserId` ride on `TenantContext` (authjs path only; single-tenant paths reject with "org accounts only").
- **Multi-brain selection** (P1, built 2026-07-14, `src/tools/brains.ts`): one connection can reach several brains (personal / team / client). `tenantContext({ requires, brain })` now resolves the CHOSEN brain — explicit `brain` arg (fuzzy-matched) → the connection's **active brain** → the default (oldest). Per-brain org token + role + commit attribution; the content index already isolates by `brainId`, so a call never crosses brains. Tools: `brains` (interactive switcher + data) / `switch_brain`, plus an optional **`brain` arg on every tool**. (`list_brains`/`view_brains` were merged into `brains` on 2026-07-24.) Active brain is persisted in `OAUTH_KV` (`active_brain:<userKey>`), **per-user** (the stateless transport has no per-connection DO state); loaded once per request, and the write is **awaited** rather than fired into `waitUntil` (see below). The app's **top-left nav becomes a brain switcher** when there are 2+ brains (`BrainSwitcher` in `app/main.tsx`; still the Files button with one brain). Key seam for P2: `personUserIds(userId)` (worker.ts) and `listAccessibleBrains(db, userIds[])` (orgs.ts) take a SET of user ids — identity-linking just widens that set. **No schema change.**
- **Multi-brain P2 (identity linking)** is built. A person's emails share an `app_users.person_id`; `linkedUserIds` turns one signed-in id into the person's whole set, and resolution unions across it. Surface: `connected_accounts` / `link_identity` / `unlink_identity`, verified by a magic-link round trip. **Org scope was the last path still keyed on a single user id** (`orgContext` called `getMembershipWithOrg(db, userId)`), so `create_brain` and `connect_github_org` behaved as though nothing had been linked while every brain query already unioned. It reads `listAccessibleOrgs(db, personUserIds)` now. See `docs/design/org-roles-permissions.md`.
- **The brain a RESULT names beats the active-brain pointer, in the app** (built 2026-08-11, issue #26). Both answer "which brain", and they are not the same question: the pointer is one KV key per user, while a `brain:`-targeted `view_page` / `browse_brain` opens a widget on a brain the pointer may not have caught up to. It is written by the request that opens the widget and read back by the next one — and the app fetches its brain list (`ensureBrainList`) on every open — so the list came back naming the PREVIOUS brain and the app adopted it: crumb, file tree, picker tick and every subsequent widget call retargeted, while the model reported the brain it had actually opened. `pickShownBrain` (`app/core/store.ts`) is the rule: the pointer wins only when the widget has no brain of its own yet (the self-boot) or when the result declares a deliberate move (`switched`, set by `switch_brain` / `create_brain`; `connect_brain` adopts a repo without moving anyone into it). `setActiveBrain` is the single seam that also drops what belonged to the brain being left — the cached file tree, which backs folder-note lookup and wikilink resolution, and the path policy — because a brain can now be entered from any result, not just `switchBrain`. The Worker's own write is awaited so the next request cannot read a write that had not started; KV stays eventually consistent across locations, which is why the app treats the result as authoritative rather than trusting the fix. Covered by `pnpm test:policy` (the store rule, pure) and `pnpm test:ui` (the `#other-brain` harness route, which is the whole scenario end to end).
- **`browse_brain` returns a SUMMARY, and the tree only while it is small** (`src/lib/browse.ts`, same issue). It used to send every path twice — as text and again in `structuredContent` with a title per page — which on a 556-page brain was 83,708 characters, over the host's tool-result limit and spilled to a file. The text block is now the brain's shape (page count, per-folder tallies below the shared root, where to get the rest); the tree rides along only under `MAX_INLINE_TREE_CHARS`, measured on the serialized payload rather than a page count. Above it the app fetches the tree with `list_pages`, which is a widget-initiated call the conversation never pays for — the `else openBrowse()` branch of `handleToolResult`, which predates this. `list_pages` itself is unchanged: the widget parses its text block for the path list.
- **Placing a brain uses `listAccessibleOrgs`, never `listAccessibleBrains`.** The latter inner-joins `brains`, so an org holding none produces no row: correct for choosing a brain to act on, wrong for choosing where to PUT one. That made the first brain in a freshly connected org unreachable. `connect_brain` picked its org by naming a brain already in it, and `create_brain` had no org argument at all and resolved through a `LIMIT 1` with no `ORDER BY`, so a person in two orgs got an arbitrary one. Both take an optional **`org`** now (fuzzy-matched on name / GitHub owner / org id by `matchOrg`); `connect_brain`'s `brain` argument is gone, since it only ever meant "which org". `chooseOrg` is the pure pick and throws rather than guessing: named handle > the active brain's org > oldest. The `brains` payload carries the org list, because the widget's picker could not derive a brainless org either. Covered by `pnpm test:access` (the query and the pick) and `pnpm test:scope` (that both tools forward `org`, and that the payload carries the list).
- **Founding operator**: `src/db/seed-operator-org.sql` is a one-shot migration template that maps the founding operator's email onto a pre-existing brain (adopt, not re-provision) — fill in the placeholders and apply to local + remote D1.
- **Model-B onboarding** (built, `docs/ops/onboarding-a-customer-org.md`): standing up a customer-owned org now has two paths. **Self-serve** — `connect_github_org` (`src/tools/org-onboarding.ts`) returns a GitHub App install URL carrying a KV-stashed `state`; installing redirects to `/github/install-callback`, which resolves the installation (App JWT) and writes the `customer` org + owner membership via `connectCustomerOrg` (`src/lib/org-connect.ts`), idempotent on re-install. The user then adopts a repo with `connect_brain`. Needs `GITHUB_APP_SLUG` on the Worker. **Operator** — `pnpm onboard-org` (`scripts/onboard-org.ts`) is the scripted replacement for hand-editing `seed-customer-org.sql`: it resolves `installation_id` from GitHub, verifies repo reachability, bakes the operator email into `created_by`/`invited_by`, and writes the org/brain/invite rows (dry-run by default; `--apply local|remote|both`).
- **Not yet built** (design steps 4/6): invitations/admin UI, Google/SSO providers.

## State of the repo

Bootstrap + MCP server are the only things built. Possible next pieces (webhook receivers, a lint/validation agent) do not exist. The old `raw/` → ingest-agent → synthesis pipeline was dropped (the `synthesize` tool and `ingest` tool were removed; bulk import is now `sync_records`). When the user references roadmap items, they're referring to a plan, not a codebase. `docs/roadmap.md` (formerly `TODO.md`) is that plan, and it is now public.

## Public-repo hygiene (added 2026-07-27)

The repo is public, so a few things that used to be free are not:

- **No customer, client, or personal names** in code, comments, tests, or docs. The golden-test fixtures and design docs were scrubbed of real org names on 2026-07-27; use `example-org`, `Acme`, `Northwind` and the like. A real name in a test fixture is a leak with a `git blame` attached.
- **No real account or resource identifiers.** Cloudflare KV/D1 ids, installation ids, org logins, and our hostname come from generated config or env vars. `src/db/seed-*.sql` are `<PLACEHOLDER>` templates on purpose; keep them that way.
- **`/ops/` is gitignored** (root-anchored, so the tracked `docs/ops/` runbooks are unaffected). Anything naming real infrastructure or a real customer goes there.
- **Nothing hosted-only.** The hosted service is a deployment of `main`, not a fork or a superset: no private module, no paid-tier feature flag, no `if (isHosted)`. If a change only makes sense for our deployment, it goes in as configuration or it does not go in. The full reasoning, including the cases that will test the line, is [`docs/design/open-source-boundary.md`](docs/design/open-source-boundary.md).
- **No telemetry.** No phone-home, no usage beacon, in any build. Nothing this
  software does may report anything to us, or to anyone but the operator running it.
  The rule is about WHERE data goes, not about whether usage is ever counted: the org
  Analytics tab (below) records per-day counters into the deployment's own D1, which
  never leave it and which we cannot see on someone else's install. That is why it is
  allowed to be ON by default (`USAGE_ANALYTICS`, which a self-hoster sets to `false`
  to disable). A change that SENDS any of it anywhere is the thing this rule forbids,
  regardless of how aggregated or anonymous it looks, and no amount of "it's only
  counts" makes an outbound call acceptable.
