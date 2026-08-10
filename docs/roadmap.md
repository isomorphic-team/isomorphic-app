# Roadmap

What the maintainers are planning, in roughly the order we plan to do it, including the
unglamorous parts and the things we have decided against.

How to read it:

- Each `# TODO:` section is a unit of work. Sections marked **DONE** are kept rather than
  deleted, because the reasoning in them explains why the code looks the way it does. The
  `~~strikethrough~~` items inside a section are sub-items already shipped.
- A **(dropped)** section is a direction we abandoned. The reasoning is left in place so
  nobody re-proposes it without knowing why it failed.
- Nothing here is a commitment or a date. Priorities move.

If you want to work on something in here, say so in an issue first so two people do not
build the same thing. Several of these are good first contributions, particularly the app
UI items near the top. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Architecture and invariants live in [`CLAUDE.md`](../CLAUDE.md), which describes what is
built. This file describes what is not.

---

# TODO: better loading states (Claude-like rotating status)

The app's loading states are plain static text ("Loading…", "Building the graph…",
etc. via `{ kind: 'loading', label }` in app/main.tsx). Replace with something
alive: a **Claude-style rotating/cycling status line**, a sequence of short phrases
that swap on an interval (with a subtle fade/shimmer), so waits feel intentional
rather than stalled. Notes:

- Centralize it: one `LoadingView` that cycles a small set of context-appropriate
  phrases (per action: opening a page, building the graph, searching, scanning for
  links). Respect `prefers-reduced-motion` (hold one phrase, no motion).
- Consider skeleton shimmers for the page/tree/graph shells where the layout is
  known, so the frame appears instantly and only the content streams in.
- Pairs with the flash-free transitions we just landed (we removed several loading
  states entirely on edit enter/cancel/save; this is for the loads that remain:
  first connect, navigate, browse, search, graph build, activity).
- Keep phrases short and evocative rather than instructional. See the "show, don't
  tell" note in CLAUDE.md.

# TODO: file/folder management UX (create / rename / move / delete)

The brain's file-tree management (`FileTree` in `app/main.tsx`) works but is rough. It
grew per-feature and the interactions feel unfinished. Overhaul the whole
create/rename/move/delete surface for files **and folders** as one coherent pass.
Landed the _capability_ with brain creation (2026-07-16); this is the polish pass.

Pain points to fix:

- **New-page flow on an empty brain is weak.** The root-level "New page" input
  (`commitRootAdd` / `rootAddRow`) and the create-first-brain empty state
  (`CreateBrainView`) are functional but visually unfinished: a bare inline input. Make
  the empty state feel intentional (clear primary action, real affordance), and make
  "New page" / "New folder" first-class rather than a hover-only `+`.
- **Folders are second-class.** A folder can only be made implicitly by typing a nested
  path ("notes/todo"); there's no explicit "New folder". Create / rename / move / delete
  of FOLDERS should be real operations, not side effects of page paths.
- **Rename is fiddly.** Inline rename (`startRename`/`commitRename` → `move_page`
  with `new_title`) is awkward, and folder rename doesn't exist. Want smooth inline edit
  with clear affordances plus keyboard support, and folder rename (repoints all child
  paths and inbound links).
- **Moving is clunky.** Drag-and-drop (`onDragStart`/`onDropFolder` → `move_page`) only
  drops a single file onto a folder. Want reliable DnD (files AND folders, into nested
  targets, with a drop indicator) plus a non-DnD fallback ("move to…" picker) for
  precision and accessibility.
- **Delete** (`confirmDelete` → `delete_page`) is per-file with a tiny inline confirm; add
  folder delete (count-aware confirm) and make the confirm consistent across the surface.

Notes:

- Rides the existing librarian tools (`write_page` / `move_page` / `delete_page`), which
  already repoint inbound links on move. Folder ops just fan those out over the subtree.
- Respect the brain's content roots (`brainPolicy.contentRoots`): root ops target the
  first content root (repo root for a whole-repo brain).
- Bi-modal: keep the conversational path (Claude creates/moves/deletes via the tools) while
  the in-app UX gets the polish.

# TODO: naming brains (rename, and a name at every creation path)

A brain's display name is `brains.name`, and for most brains it is null — because only
ONE of the four ways a brain comes into existence sets it. `create_brain` takes a name;
`connect_brain` did not until 2026-07-29; `src/db/seed-operator-org.sql` and
`scripts/onboard-org.ts` both omit the column from their INSERT entirely. And nothing
anywhere can change a name once written.

`brainLabel` (`src/lib/orgs.ts`) used to paper over this by inventing a label: prefix the
org when an org held several brains, borrow the org's name when it held one, say
"Personal" for a platform org. That made a brain's name depend on how many SIBLINGS it
had, so adopting a second brain into an org silently renamed the first. Removed
2026-07-29 in favour of one rule (named, else repo-derived), with the org shown as a
grouping heading in the two surfaces that list brains.

Which leaves the real gap:

- **No rename.** Every brain adopted or seeded before `connect_brain` took a name is
  stuck with its repo name forever. Wants a `rename_brain` tool (admin+, one D1 UPDATE)
  and an inline rename on the Manage brains screen beside the disconnect ✕, matching the
  file tree's rename affordance. Note this ADDS to a tool surface deliberately
  consolidated 42 → 30, which is the reason it was not just built: worth doing, worth
  being deliberate about. Folding it into `configure_brain` is the wrong shortcut —
  that writes `.isomorphic.json` in the repo, while a name is a D1 field, so one tool
  would be doing two unrelated writes to two different stores.
- **The scripted paths still cannot name.** Add the `name` column to the seed template
  and a `--name` flag to `scripts/onboard-org.ts`, or every operator-onboarded org
  starts out needing the rename that does not exist yet.
- **Backfill is optional and probably not worth it.** A migration could set a name for
  existing null rows, but only the owner knows what each brain should be called. A
  rename they can reach beats a guess we make for them.

## Decided against: a global org picker

Raised 2026-07-29 alongside the above. There is no active-org pointer in the model at
all — `tenantContext` derives the org from whichever brain you chose — and everywhere org
genuinely matters it is already an ARGUMENT at the point of decision: `AddBrainView` asks
which organization, and `create_brain` / `connect_brain` take an `org`. A global picker
would add a second selection that most screens ignore, plus a real ambiguity: if the
active org is A and the active brain lives in B, which one does `members` show?

Org stays derived. Where it needs to be visible it is a grouping heading (the brain
picker, Manage brains) or a qualifier on an otherwise ambiguous label
(`brainLabelQualified`, used in the "which of these did you mean" errors). If a user ever
needs another org's roster without switching brains, that is an org argument ON the
members screen — an argument again, not a mode.

# TODO: local-first development (make a first contribution cheap). **DONE 2026-08-04**

Full plan, including where it turned out to be wrong:
[`docs/design/local-first-development.md`](design/local-first-development.md).

All five workstreams shipped. `pnpm try <folder>` serves the real MCP tools over a git repo on
disk with no accounts; `GITHUB_TOKEN` replaces the whole GitHub App for a single user;
`BrainStore` is the storage seam; and **both write-path e2e batteries now run offline in CI**,
which was the point. Remaining sub-items are struck through below.

Today a contributor can reach the app UI in five minutes (`pnpm app:dev`, no accounts) and the
pure engines instantly (`pnpm test`, offline). Everything else needs a GitHub org, a GitHub App,
and `pnpm bootstrap`, because a brain is a GitHub repo and GitHub is not swappable. The same root
cause keeps `scripts/e2e-librarian.ts` and `scripts/e2e-import.ts` out of CI, which means the
write path (the riskiest code we have) is gated by a maintainer running them by hand rather
than by a check on the pull request.

Five workstreams, in order. The first two stand alone; do not start the fourth before the third
has landed and settled.

- ~~**Papercuts.** Pin Node (`engines` + `.nvmrc`; `node:sqlite` needs 22+, CI runs 24). Fix the
  golden-test counts stated in `CONTRIBUTING.md`, `docs/self-hosting.md`, and `ci.yml`'s comment,
  which disagree and will drift again: drop the numerals, keep the lists. Lint the documented
  two-places rule: every
  `test:*` script in `package.json` must appear in `ci.yml`. Add `pnpm doctor`. All good first
  issues.~~ DONE (plus `pnpm doctor`, and `test:wiring` lints the two-places rule).
- ~~**Bring your own token.** `GITHUB_TOKEN` + `BRAIN_REPO_*` builds a plain Octokit, replacing the
  App for single-user and development use. Six `installationOctokit(...)` call sites, all in
  `worker.ts`. Removes the org requirement, the manifest flow, bootstrap, and the PKCS conversion
  from the critical path. App-only tools do not register, per the `FEEDBACK_REPO` precedent.~~ DONE.
- ~~**The `BrainStore` seam.** `src/lib/brain-repo.ts` is already the chokepoint (17 of the repo's
  36 `octokit.` call sites; ten operations as built). Extract an interface, make GitHub one adapter,
  carry the store on `TenantContext`.~~ DONE, at ten operations rather than seven.
- ~~**The local runtime.** `src/local.ts`, a Node MCP host over a git repo on disk. D1 becomes the
  `node:sqlite` shim the e2e scripts already carry, KV becomes a `Map`, `waitUntil` and the OAuth
  props become stubs, and the transport needs nothing (it is web-standard and `@hono/node-server`
  is already a dependency). The only new code is the fs + git adapter. A local brain is a git
  repo, not a bare folder, so `commitFiles`'s atomicity survives.~~ DONE: `pnpm try ~/notes`.
- ~~**End-to-end tests in CI.** The payoff. Both e2e batteries run against the fs adapter with no
  network and no credentials, so they move into `ci.yml` without breaking its fork-safe rule.
  Keep the real-GitHub runs for the GitHub adapter itself.~~ DONE: `--github` runs the identical assertions by hand.

Related: the section below productizes the same flow for **users**; this one is about
**contributors**, and the two share the bootstrap-removal work.

# TODO: productize the bootstrap flow for other users

What's needed to take the current single-developer flow (run `pnpm bootstrap` locally, register an App, install on your org, scaffold) and let arbitrary users run it without help.

- Register the App **once**, platform-owned and public, so users only install. Drops the manifest flow from the user-side path. (Phase 3 cutover.)
- Deploy bootstrap as a Cloudflare Worker so callbacks have a real HTTPS URL (not `localhost:3000`).
- ~~Move tenant routing (`installation_id`, `brain_owner`, `brain_repo`) out of `.dev.vars` into a D1 `tenants` table keyed by `gh_user_id`. Read per-request by the MCP server.~~ Read path landed (phase 2.0). **Write path landed (phase 2.1)**: rather than a per-user install-callback upsert, the MCP Worker auto-provisions on first authenticated use. `tenantContext()` → `autoProvision()` → `provisionBrainForUser()` (`src/lib/provision.ts`) creates `brain-<login>` under the **platform org** via the **single platform installation** and writes the tenant row. Readers/creators never install the App. Admin records `PLATFORM_ORG` + `PLATFORM_INSTALLATION_ID` once via bootstrap. Gated by `AUTO_PROVISION`.
- ~~User-facing flow: sign in → pick brain repo name + visibility → install App on org → done.~~ Collapsed to **sign in → done** (brain auto-provisioned). Repo name is derived (`brain-<login>`); per-user name/visibility picking is deferred, revisit if users need to choose.
- ~~Show the "must be an Organization" gate **before** the install click, with a one-click create-org link.~~ No longer user-facing: only the admin installs, and the org gate stays in the bootstrap install-callback for that one-time setup.
- ~~Make install + scaffold idempotent so repeat callbacks and re-installs don't double-create or crash.~~ `provisionBrainForUser()` is idempotent (existing-tenant short-circuit + repo-collision adopt). Still TODO: a DO/D1 lock to serialize truly-concurrent first requests for the same user (today they race benignly; the second create 422s and adopts).
- Add a webhook receiver for `installation` events (install / uninstall / suspend / permissions update) to keep tenant rows consistent.
- Webhook-source signing keys (Slack `/save`, Granola, email forwarder, etc.): one platform-wide secret per integration source for verifying inbound signatures, _not_ per-tenant. Tenant identity is resolved from the verified payload (Slack user ID, etc.) after signature check. Per-tenant LLM keys are explicitly NOT a platform concern, see the `.dev.vars deconstruction` section.
- Error pages with retry + observable logs so failures are debuggable without paste-the-stack.

# TODO: productionize the MCP server

Current state: Worker (`src/worker.ts`) with the librarian (`write_page` / `move_page` / `delete_page` / `find_inbound_links` / `validate` / `search_pages`), read tools (`list_pages` / `read_page` / `whoami`), the brain-app, member, brain-selection, and import suites. **Live at `https://mcp.isomorphic.sh`** with `workers.dev` fallback. Auth path selectable via `AUTH_MODE`: `oauth` (workers-oauth-provider + GitHub upstream, brain resolved per-request from D1 `tenants` keyed by the OAuth-bound `gh_user_id`) or `static` (legacy single bearer, hardcoded brain via env vars, fails fast if those env vars aren't set).

- ~~Replace static `MCP_BEARER_TOKEN` with OAuth.~~ Phase 1 done. OAuth path live behind `AUTH_MODE=oauth`.
- ~~Multi-tenant routing (phase 2 read path): per-request D1 lookup keyed by the OAuth-bound `gh_user_id`.~~ Done in phase 2.0, `tenantContext()` in `worker.ts`. The static-mode env vars (`BRAIN_REPO_*`, `GITHUB_APP_INSTALLATION_ID`) remain as the legacy fallback until phase 3 cutover.
- Phase 3 cutover: ~~hoist platform App creds to Worker secrets~~ done. Still to do: register the public _platform-owned_ App (the one in use is currently a user-owned dev App), decommission the user-owned dev App. **`AUTH_MODE=static` is NO LONGER slated for removal** (changed 2026-08-04): it is the documented single-tenant self-hosting path, `GITHUB_TOKEN` mode is built on it, and `CLAUDE.md` has described it as supported rather than legacy since the repo went public. `MCP_BEARER_TOKEN` stays with it.
- ~~Routes / custom-domain dev hassle~~: solved by binding the custom domain via the Cloudflare dashboard instead of via `wrangler.jsonc` routes. Dashboard binding is independent of the config, so local dev with `wrangler dev` no longer rewrites `request.url`. Don't re-add a `routes` block; it reintroduces the bug.
- Disable `workers_dev` (`workers_dev: false`) so the custom domain is the canonical entry point. Cosmetic: the workers.dev URL works fine, just unnecessary now that the custom domain is live.
- Claude Code MCP client OAuth bug: token is issued but not attached to the post-flow `/mcp` reconnection ([#46140](https://github.com/anthropics/claude-code/issues/46140)). Inspector works; track upstream until Anthropic fixes.
- **Tool-list changes don't auto-propagate to claude.ai web. This is expected, don't chase it.** The web client caches a connector's tool list and only re-fetches on a manual **"update tools"** / reconnect (Settings → Connectors), _not_ on a new chat, and _not_ on a server-sent `notifications/tools/list_changed`. Server-side changes go live instantly on deploy, but users must click "update tools" to see added/renamed tools or changed descriptions/schemas (tool _behavior_ changes need nothing: same signature, new code path). Investigated and reverted a server-side `list_changed` emitter (2026-07-06, local branch `feature/tools-list-changed`, unmerged): each MCP session was its own Durable Object, so Claude's reconnect churn reset the per-session revision state and the notification never fired, and claude.ai web ignores it regardless. Claude _Code_ (CLI) only gained `list_changed` support in 2.1.0. Don't re-attempt for the web client; revisit only if we target CLI clients. Refs: [claude-code#13646](https://github.com/anthropics/claude-code/issues/13646), [#50339](https://github.com/anthropics/claude-code/issues/50339).
- Add `propose_change` (PR-style write for `wiki/`) once the lint agent exists. Without lint, a PR just sits there.
- Split read vs write MCP scopes so read-only clients can't accidentally mutate. Today the OAuth grant is a single bucket.
- Cache installation tokens across tool invocations.
- `list_pages` does 4 sequential GitHub API calls per invocation. Cache the tree SHA per branch and short-circuit on a cheap `getRef`; invalidate via a `push` webhook on the brain repo.
- Handle Git tree truncation (`tree.truncated === true`) for large brains by falling back to recursive directory walks.
- Pagination / size cap on `list_pages`, which currently dumps everything as one text blob and will choke on real-sized brains.
- Structured errors: surface GitHub 404 / 403 / rate-limit as MCP-shaped errors instead of letting exceptions bubble through octokit.
- Anthropic SDK Zod v3/v4 type mismatch: the SDK's `zodOutputFormat` helper has `import type { ZodType } from 'zod'` (v3) in its `.d.ts` but `require('zod/v4')` at runtime, so we sidestep it and pass the JSON schema literal directly. Switch back to `zodOutputFormat` once the SDK aligns its types with its runtime.

# TODO: live-deploy hardening

Now that the Worker is on the internet. Today's posture is fine because the multi-tenant gate in `tenantContext()` blocks anyone without a D1 row from doing anything. The hardening below matters most when strangers can self-onboard.

- **D1 onboarding policy decision** before self-onboarding opens up. Auto-admit any user who installs the App? Allowlist? Manual review queue? Pick a policy consciously rather than letting the default become "anyone can onboard."
- **Cloudflare rate-limit rules** on `/register` and `/authorize` if abusive traffic shows up. Don't pre-empt; wait for signal.
- **Webhook signature verification** when webhook receivers (Slack `/save`, Granola, etc.) land. Standard HMAC pattern, per-source signing key.
- **Anthropic spend cap**, if any LLM-calling feature is ever added back. Set a hard monthly limit in the Anthropic console to bound the worst-case bill. Nothing in the Worker calls an LLM today (`synthesize` was removed), so this is dormant until that changes.
- **Per-tenant Anthropic keys** if that day comes. A platform-wide `ANTHROPIC_API_KEY` means one user's behavior spends on the operator's bill. Move to brain-repo Actions secrets per the `.dev.vars` deconstruction plan.

# TODO: `.dev.vars` deconstruction

`.dev.vars` currently mixes three categories that need to split out as we productionize. This section is the migration reference; the work items above (multi-tenant routing, phase 3 cutover, webhook signing keys) point here.

| Variable                        | Category                | Target home                                                                                                        |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`                 | Platform infra          | Worker secrets (prod), `.dev.vars` (local mirror)                                                                  |
| `GITHUB_APP_SLUG`               | Platform infra          | Worker secrets                                                                                                     |
| `GITHUB_APP_CLIENT_ID`          | Platform infra          | Worker secrets                                                                                                     |
| `GITHUB_APP_CLIENT_SECRET`      | Platform infra          | Worker secrets                                                                                                     |
| `GITHUB_APP_WEBHOOK_SECRET`     | Platform infra          | Worker secrets                                                                                                     |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | Platform infra          | Worker secrets                                                                                                     |
| `GITHUB_APP_INSTALLATION_ID`    | Tenant routing          | D1 `tenants` table (key: `gh_user_id`)                                                                             |
| `BRAIN_REPO_OWNER`              | Tenant routing          | D1 `tenants` table                                                                                                 |
| `BRAIN_REPO_NAME`               | Tenant routing          | D1 `tenants` table                                                                                                 |
| `MCP_BEARER_TOKEN`              | Legacy single-user auth | Removed (OAuth replaces it in phase 3 cutover)                                                                     |
| `ANTHROPIC_API_KEY`             | Tenant LLM key          | Brain repo's GitHub Actions secrets (when automated synthesis migrates to Actions), explicitly NOT on our platform |

Three categories the table captures:

- **Platform infrastructure** (rows 1-6): the platform App's own credentials. One value, shared across all tenants. Worker secrets in prod; `.dev.vars` becomes a local mirror.
- **Tenant routing** (rows 7-9): which installation and brain repo belong to which authenticated user. Per-tenant. D1.
- **Tenant LLM keys** (row 11): the user's Anthropic key. Lives in their brain repo's Actions secrets, not our platform.

What `.dev.vars` contains once everything's home: platform infrastructure only.

Discrete migration steps (each maps to an existing work item above):

- Hoist platform App creds (rows 1-6) to Worker secrets via `wrangler secret put`. Tied to the phase 3 cutover.
- Tenant routing (rows 7-9) to D1. Tied to multi-tenant routing (phase 2).
- `MCP_BEARER_TOKEN` removal: dies with the phase 3 OAuth cutover.
- `ANTHROPIC_API_KEY` removal: when automated synthesis migrates to brain-repo Actions.
- Webhook signing keys (Slack, Granola, etc.) added as new platform secrets when those integrations land, one per source, shared across tenants.

# TODO: librarian tool suite (from AI-wiki commit-pattern analysis)

Derived 2026-07-06 from commit-history analysis of two production AI-maintained wikis. Dominant finding: **the unit of work is a multi-file bundle, not a single file**. A content change is page + index entry + changelog bullet in one commit (one repo: roughly every content commit; the other: 81% changelog co-touch, median 2-3 files/commit). Second finding: conventions enforced only as prose get skipped (raw dumps bypassing index+changelog were both repos' worst commits), so **encode invariants as tool preconditions rather than AGENTS.md prose**.

**Cross-cutting design principle: the user never sees git.** Writes appear as instantaneous saves; commit messages are auto-generated (intent-rich, `Co-Authored-By` trailer); branches, SHAs, and PRs are backend implementation details. Review-lane output is framed as "proposed changes", never "opened PR #N". Tool results speak in wiki terms ("Saved wiki/concepts/ledger.md and updated the index"), not git terms.

**Status 2026-07-06: all bullets below landed** (`src/tools/librarian.ts` + `src/lib/wiki.ts` + `src/lib/brain-repo.ts`), verified end-to-end by `scripts/e2e-librarian.ts` (manual, real-GitHub). Remaining follow-up: tools' read-modify-write pairs (e.g. publish's idempotency check) read GitHub's eventually-consistent contents API, so a sub-second double-call can act on a stale read. Harmless today (idempotent content); revisit with a storage cache.

- **Atomic bundle commits.** Rework the write tools onto a shared Git Data API `commitFiles()` primitive (one tree, one commit) so page + index entry + `wiki/log.md` entry land together. Reuses the tree-commit machinery already in `scaffold-core.ts`.
- **Structured frontmatter + type routing.** `write_page` takes `title` / `description` / `type` instead of a raw path; the tool generates schema-valid frontmatter (`updated` auto-set, `status: draft` default) and derives the kebab-case slug. Invariants validated at write time. Evidence: both wikis treat frontmatter as a machine-checked contract.
- **`move_page` / `delete_page` with link integrity.** Move/rename rewrites all inbound relative links in the same commit; delete surfaces (or fixes) dangling inbound links and index entries. Evidence: real knowledge-base restructures touched 17-22 files each, hand-repointing links; deletions always bundled link cleanup. Hard rule borrowed: never change a published slug.
- **`find_inbound_links` (backlinks).** Given a page, list every page linking to it. Substitute for the backlink index neither wiki has; feeds move/delete and the lint agent.
- **`validate` tool.** Broken relative links, malformed frontmatter, index entries pointing nowhere. A predecessor knowledge base's hand-written `validate` script is the model: validation as executable spec, runnable by the agent before and after writes.
- **Draft to publish lifecycle.** `status: draft | published` in frontmatter as a first-class act. Draft pages visible to tools but flagged; a publish act flips status and logs it. Keeps the "proposed changes" review lane separate from the fast direct-save lane.
- **Open-questions page**: a living page whose bullets get struck through and linked when a later page resolves them. Add to the brain template.

# TODO: bulk page updates (batch field writes, and find/replace across pages)

Every write tool targets one logical thing: one page, or one folder subtree. The
underlying primitive does not have that limit, since `commitFiles` already lands N
files in one atomic commit. Three wants sit on the other side of that gap.

**Batch field writes.** The case that produced issue #14: 44 archived todos, each
needing `done:`. With `fields` on `write_page` that is 44 calls, 44 commits, and 44
near-identical `wiki/log.md` bullets for one human act ("I archived the finished
work"). The changelog is a product surface, so that last part is a data-quality
problem and not only a latency one.

**Find/replace across pages.** Renaming a term, a product, or a person everywhere it
appears. Impossible today except page by page, and unlike the field case there is no
workaround at all. Probably the more valuable half.

**Appending the same block to a set of pages.** Rarer, but it falls out of the same
shape for free.

A `set_fields` tool covering only the first was built and then cut before merge
(branch `feat/frontmatter-fields`, if the code is wanted). Two reasons, both worth
keeping:

- **The routing rule was wrong.** Steering between `set_fields` and `write_page`'s
  `fields` came out as "how many pages", which is not the real axis: `set_fields`
  applies ONE patch to many pages, so an agent setting each todo's `done:` to the
  date it actually finished has 44 pages and cannot use it. The better discriminator
  is modifier versus verb (is a body write happening anyway?), and that only pays for
  itself once the batch verb does more than one thing.
- **It answered the smaller half.** Shipping the fields-only batch would have spent
  the tool slot, and the naming, on the want that already has a workaround.

Design questions to settle before building:

- **Shape.** The natural generalization is `write_page`'s partial-update vocabulary
  applied to a set: `{fields?, edits?, append?}` over N paths, one commit, one
  changelog line. That is one tool for all three wants.
- **The exactly-once rule does not survive the jump.** `edits` is safe on one page
  because an anchor matching zero times or several aborts the whole call. Across 44
  pages a find string legitimately matches zero times on most of them, so bulk
  find/replace needs "skip where absent", which is the very rule that makes the
  single-page version safe. Needs an explicit answer (a per-page outcome report? a
  required `expect:` count? apply only where unambiguous and name the rest?), not a
  quiet relaxation.
- **Selection: explicit paths, folder, or query.** Explicit paths make the blast
  radius visible in the transcript, which matters for a call that atomically rewrites
  200 pages. A folder path is the middle ground and matches what `move_page` and
  `delete_page` already accept. A `filter:` expression (reusing okf-view's selection
  language) is the powerful option and the dangerous one: a computed target set is a
  blast radius the caller cannot see. If it is ever offered, it wants a preview step
  like `sync_records`' proposal pattern rather than a bare write.
- **Idempotence.** The cut implementation skipped pages already carrying the values so
  a re-run wrote no commit at all. Worth keeping in any version; it is what makes the
  tool safe to retry.
- **Not `sync_records`.** It is already the general bulk writer, and it was rejected
  here for a specific reason: it binds every page it touches to an import source
  (`source_key` plus a ledger entry), a permanent side effect for a one-off update.
  The objection was the binding, not the batching.

# TODO: brain schema migrations (fleet-wide template/schema updates)

How template and schema changes reach every customer brain after they're scaffolded. Today this is manual, which doesn't scale past a handful of tenants.

**Recommended shape: versioned, idempotent migrations applied lazily on first touch.**

- **Version markers.** Each brain records its `schema_version` (small `.brain-version` file at repo root: machine-readable, mostly invisible to users). Mirror it as a column in D1 so the Worker can check without a GitHub call. Platform ships `CURRENT_SCHEMA_VERSION` plus an ordered migration registry (`src/lib/migrations/NNN-name.ts`).
- **Migration contract.** A migration is an idempotent async function `(octokit, repoArgs) => void` producing at most ONE atomic commit (commitFiles) plus a `wiki/log.md` entry, so the librarian visibly did maintenance, consistent with the no-git principle. Idempotent because a crashed run must be safely re-runnable; the version marker only advances after success.
- **Lazy application in `tenantContext()`.** After tenant resolution: if D1 `schema_version` < current, take a per-tenant lock (the same serialization we already want for concurrent auto-provision), run pending migrations in order, bump D1 and the in-repo marker. Piggybacks on the auto-provision pattern; dormant brains migrate on their next use; no fleet job needed. Budget-cap the work per request (Worker subrequest limits) so large data migrations chunk across successive touches ("migrate up to N pages per request until done").
- **Eager batch runner (optional, later).** A cron Worker iterating D1 tenants for migrations that must land everywhere promptly (security fixes, breaking tool changes). Same migration functions, different driver.
- **The clobber policy is the hard part.** Classify brain files:
  - _Platform-owned_ (e.g. `.brain-version`): overwrite freely.
  - _Platform-managed but user-visible/customizable_ (`AGENTS.md`, README, index skeleton): overwrite ONLY if the current content hash matches a known prior template version (keep a historical hash table per file: the "does it look like a template we shipped" guard, formalized). If the user customized it, don't clobber. Open a proposed change for human review, and record the skip.
  - _User content_ (`wiki/**` pages): never template-overwritten. Only surgical data migrations, always shape-preserving and idempotent.
- **Version-skew tolerance.** Tools must read old and new schema during transition windows (the frontmatter parser already tolerates both) so a half-migrated fleet never breaks reads. Schema-version gates belong in write paths, not read paths.
- **Canary first.** Run pending migrations against the platform canary brain on deploy; a failure blocks the rollout before any customer brain is touched. Log migration outcomes (per-tenant version, skips due to customization) for observability.

# TODO: synthesis pipeline (dropped)

The automated raw-to-wiki synthesis pipeline was cut as no longer relevant, and the
`synthesize` tool (single-page LLM proposal + PR) removed. The `ingest` tool was removed
too (2026-07-24, tool-surface consolidation): nothing automated consumed `raw/`, and
brains are arbitrary repos organized however the owner likes, so source material is added
via GitHub (into a `source/`-role area) and cited by pages. Writing wiki pages is `write_page`
(create-or-update). If an automated importer is wanted later, `sync_records` (bulk import,
PRD Phase 3) is the current mechanism, not an LLM synthesis agent.

# TODO: MCP resources

The MCP spec has a `resources` primitive distinct from tools: read-only, URI-addressed, client/user-driven (the client UI surfaces them; users attach them to conversations or `@`-mention them). Today everything goes through tools, so every page read costs a Claude turn. Resources let the client pre-load context and browse the brain natively.

- Expose `brain://schema` (AGENTS.md) and `brain://index` (wiki/index.md) as always-attachable resources. Highest-leverage starter: makes Claude convention-aware at conversation start without a `read_page("AGENTS.md")` round-trip.
- Per-page wiki resources at `brain://wiki/<path>` so clients with resource trees (Claude Desktop) and `@`-mention autocomplete (Claude Code) can browse and pin individual pages.
- Resource templates with URI parameters (`brain://wiki/{type}/{name}`) for autocomplete-driven attachment.
- Fire `resources/updated` notifications when a page commits or a `push` webhook fires on the brain, to keep attached resources fresh in long conversations.
- Skip source material from the default resource tree: transcripts are big and noisy; expose only via the `read_page` tool when Claude needs them.
- Token-size guards: refuse to serve resources above a per-resource cap (or annotate `mimeType` and size so clients can choose). One user attaching 30 wiki pages should not silently blow the context window.
- Privacy via path: filter private paths out of `resources/list` results, mirroring the existing path-as-ACL convention.

# TODO: media attachments (upload, view, and pass images through MCP). **DONE 2026-08-05**

Images (and PDFs) live in a brain, render in the app, and can be handed to Claude to
look at. Full design: [`docs/design/media-attachments.md`](design/media-attachments.md).

**The constraint that set the shape: the model cannot hand us bytes.** Tool arguments
are JSON produced by the model, and a model shown an image holds visual tokens, not
base64. No host passes a conversation attachment into a tool call. So "Claude, save
this screenshot" cannot be made to work by any tool design, and the upload surface is
the **app iframe** (a real browser context with a real file input). The conversation is
where images are read, not written. `attach_media`'s own description says so, because
that is where an agent hunting for the tool will look.

What shipped:

- ~~**Binary storage.** `FileWrite` grew an `encoding`; binary becomes a blob referenced
  by sha, because `createTree`'s inline `content` decodes as UTF-8 and silently mangles
  a PNG. Both write paths now build trees through one shared helper. The fs adapter got
  the same rule plus a rollback fix (it captured prior contents as a utf8 _string_, so
  undoing a half-written bundle would have corrupted any binary it restored).~~
- ~~**Attachments in the link graph.** `MD_LINK_RE` always matched `![](…)`, but
  `loadResolvedGraph` dropped non-`.md` targets, so `backlinksTo` reported an image as
  referenced by nobody — `move_page` would repoint nothing and `delete_page` would call
  a still-used image unreferenced. Asset links now resolve into a separate `assetEdges`
  list (separate because the graph view builds nodes from `pages`). They still never
  count as `broken`: the index has no asset inventory, and guessing makes `validate` cry
  wolf.~~
- ~~**Tools:** `attach_media`, `read_media`, plus attachment branches in `move_page` /
  `delete_page` rather than media twins. Both treated "no `.md`" as "folder", so an image
  path would have been handled as a _subtree_ — the asset check runs first in both.~~
- ~~**App:** images hydrate as `data:` URIs after render (the iframe CSP is
  `img-src 'self' data:`, and a private brain repo has no URL to point at); drop-target
  upload with client-side downscale to a 2576px long edge; attachments browsable in the
  file tree with their own asset view showing preview, metadata, and which pages use it.~~
- ~~**One rule for link classification** (`src/lib/links.ts`). It used to be inlined in
  `loadResolvedGraph`, so nothing outside D1 could reuse it and the dev harness carried a
  divergent copy — which made the preview report "no references" for an image that was
  plainly on a page. A preview wrong in a _different direction_ than prod is worse than
  no preview: it manufactures bugs and conceals real ones.~~

Decisions worth not relitigating: **data URIs, not a CSP allowlist** (brain repos are
private, so raw GitHub URLs need expiring signed redirects to a host you would not
naturally declare); **5 MiB cap** (git keeps every version forever in a repo the customer
clones); **co-located `assets/`** (so `move_page` on a folder carries its pictures, and
plain markdown readers resolve the link); **images embed, documents link** (`![](…)` on a
PDF is a broken image everywhere, including github.com).

Not built, in rough priority order:

- **Phase 0 host verification, still open.** Whether a sandboxed MCP App iframe in Claude
  permits `<input type="file">` and drag-drop. Everything above stands either way, but if
  it is blocked the upload _entry point_ needs rethinking. Verify before building further
  on it.
- Making the dev harness run the real server (its own section below).
- An orphan advisory in `validate` (an attachment nothing references is invisible in the
  app yet still in every clone forever), a brain-wide `assets/` option for shared images,
  returning PDFs to the model (unverified whether this host turns an embedded resource
  blob into a document block), and retention/pruning.
- **Attaching a file the agent MADE.** URL ingest (below) covers anything with a public
  address; it does not cover bytes that exist only on the agent's own disk, which is the
  literal case in issue #20 (a PDF page rendered to PNG and cropped). The candidate is a
  two-step upload: a call returning a short-lived signed URL, the agent POSTs the bytes
  out-of-band, the token redeems them. Verify first, in the Phase 0 shape: whether an
  agent sandbox can POST to the Worker at all. The reporter's sandbox had egress
  restrictions that would decide this either way.

# TODO: URL ingest for attachments. **DONE 2026-08-10**

`attach_media` takes `url` as an alternative to `data`: the server downloads the file, so
the bytes never cross the model's output. This is the answer to issue #20, where an agent
could find, fetch, crop and compress a floor plan and then had no way to hand over 14 KB
of PNG. It attempted the base64 by hand, mis-transcribed the tail, and failed.

It is a partial answer on purpose. The reported file existed only on the agent's disk, and
the crop meant even a source handle from another connector would have carried the wrong
bytes; what `url` buys is the larger population around that case, in one call with no human
in the loop. It also routes around something the app path cannot: the fetch runs on the
Worker, so a domain the agent's own sandbox is blocked from is still reachable.

The guards are the work, not the fetch, because this makes the Worker fetch a
caller-supplied URL for anyone with `editor` on a brain: https only, no credentials in the
URL, a refused-address list (loopback, private ranges, link-local and therefore cloud
metadata, the IPv6 spellings including IPv4-mapped, `.local` / `.internal`), redirects
followed by hand so each hop is re-checked, a `Content-Length` refusal plus a streaming cap
because a header is only a claim, a served-type/filename agreement check (which mostly
catches URLs answering with an HTML login wall), and a 15s timeout. All in `src/lib/media.ts`
with an injected fetch, so `pnpm test:media` covers every branch offline.

Same change, unrelated half: **`read_media`'s data URI is now opt-in** (`include_data`, set
by the app). Hosts put `structuredContent` in front of the model, so every image was also
being spent as a second and larger copy in text, long enough to truncate the response it
was attached to. Also issue #20.

Decisions worth not relitigating: **https only** (one rule, no per-deployment allowlist);
**hostname guards, not a resolver check** (a public name resolving to a private address
defeats them, and Cloudflare's fetch egresses to the public internet rather than into
anything of ours, so what remains reaches nothing either deployment owns); **manual
redirects** (`redirect: 'follow'` validates the first address and then lets a 302 point
anywhere).

# TODO: make `pnpm app:dev` run the real server, not a reimplementation of it

The dev harness (`dev/harness.ts`) loads the REAL app bytes and drives them over the
REAL `AppBridge`, so the app side is production code. But it answers every tool call
itself, from fixtures. That second half is roughly 1,400 lines reimplementing the
server, and it is the largest remaining source of "works in the preview, differs in
prod".

It bit us on 2026-08-05. The harness scanned links with its own regex that only counted
`.md` targets, so the asset view reported "no page shows this file" for an image that
was plainly on a page — while production answered correctly. **A preview that is wrong
in a different direction than prod is worse than no preview: it manufactures bugs that
do not exist and conceals ones that do.** The immediate fix extracted the rule to
`src/lib/links.ts` so both call the same function, but that is one rule out of many;
`list_pages`, `read_page`, `find_inbound_links`, `search_pages`, the write tools and the
members/analytics surfaces all still have a hand-written twin in there.

Why the stubs exist: the harness runs **in a browser tab**, and the real read path needs
a `BrainStore` (octokit or `node:fs`) plus D1 for the content index. Neither exists in a
browser, so it imports the pure libs it can (`renderViews`, `effectiveBrainRole`,
`classifyMdLink`, `resolveRelative`) and fakes the rest.

That reason expired with the local-first work (**DONE 2026-08-04**). `pnpm try <folder>`
already serves the real MCP tools over a git repo on disk, with a real store and D1 over
`node:sqlite`. So the harness no longer needs to fake a server — it needs to _talk_ to
one:

- `scripts/app-dev.ts` boots a `pnpm try` server on a scratch brain seeded from
  `dev/fixtures.json`, and the browser-side harness forwards `callServerTool` to it over
  HTTP instead of answering from a `switch`.
- The AppBridge/iframe/host-context half stays exactly as it is. That part is already
  faithful and is not what drifts.
- Delete the tool `switch` and the fixture-shaped duplicates of server logic. The seeded
  brain becomes ordinary markdown files in a temp directory, which is also easier to
  extend than a JSON blob.

Payoff: the preview exercises the same handlers, gates, and index as prod, so divergence
stops being a category of bug. It also makes the harness the natural place to reproduce a
reported issue. Cost: `app:dev` gains a server process and a scratch directory, and the
offline-with-no-setup property has to survive (`pnpm try` is already offline, so it
should).

Keep one escape hatch: some previews are _states_, not data — `#nobrains`, the
"adopted repo, no content configured" empty state, a brain with 3,000 pages. Those want
seeded fixtures or flags, not a live server, so the harness should still be able to
force a state without pretending to be a server.

# TODO: derived views & non-destructive sync

Full PRD: [`design/derived-views-and-sync-prd.md`](design/derived-views-and-sync-prd.md).

**Status 2026-07-22: Phases 1+2 BUILT** (FR-2 queryable frontmatter + ALL of FR-1):
`src/lib/views.ts` + `view-directives.ts` engine, `brain_page_fields` index table
(migration 0002, lazy backfill via `schema_version`), okf-view fences executed live in
`view_page`/`read_page`, snapshots regenerated on write, stripped in `edit_page`.
Grammar: `kind: backlinks|pages` (source) × `as: list|table|count` (rendering) plus
`filter`/`under`/`group-by`/`columns`/`describe`/`sort`. Directory indexes
(`kind: pages` + `under` + `group-by`) replace hand-enumerated `*/index.md` files (AC-2).
`pnpm test:views` covers the engine. Remaining: Phase 3 (FR-3 importer + FR-4
source-of-truth policy), Phase 4 (FR-5 migration tooling).

Follow-up (viewer UX, not PRD-scoped): **dynamic filters on the Linked references
panel.** The panel and the `backlinks` view share one engine; the panel's gap is
ad-hoc, per-viewer filtering (by `type` or any indexed field) while browsing, with
no authoring. Natural bridge: a "pin this filter into the page" action that writes
the equivalent okf-view directive, making views discoverable from the panel. An
unfiltered backlinks directive duplicates the panel, so steer authors toward
filtered/columned views (the demo fixture models this).

Follow-ups surfaced retrofitting an existing Obsidian vault to okf-view. The
folder indexes went live, but three gaps showed:

- **Auto-generated frontmatter `summary` (highest value).** okf-view's `describe:` can
  only read a _frontmatter_ field, but real vaults keep the one-line blurb in the page
  BODY (that vault's `build_index.py` extracted the first prose under `## Context` /
  `## Summary` / `## Goal`). So converting to okf-view lost the rich per-item blurbs and
  entries are bare links now. Fix: a step (write-time hook, or a `harvest`-style tool)
  that derives a `summary` from the body and writes it to frontmatter, where it's indexed
  (FR-2) and rendered via `describe:`. Then live indexes regain their descriptions. Note
  the blurbs contain wikilinks; either resolve them in view cells (see below) or
  store a plain-text summary.
- ~~**okf-view can't list subfolders / folder-notes.**~~ DONE: `kind: folders` + `under`
  lists the direct sub-folders, each represented by its folder note (index.md > README.md),
  no per-page `type:` tagging. `under` defaults to the containing page's own directory;
  note-less sub-folders render as unlinked names. Engine: `folderCandidates` in `views.ts`.
- ~~**Folder notes only recognize `index.md`, not `README.md`.**~~ DONE: `FOLDER_NOTE_NAMES`
  (`index.md` > `README.md`) in `view-directives.ts`, shared by the file tree and the engine.
- Wikilinks inside computed view cells render as literal `[[text]]` (dead on GitHub);
  resolving them to real links in `describe:`/column output would let summaries keep their
  links. Pairs with the auto-summary item.

**Why now (real use case).** A contacts brain (`example-org/contacts-brain`: ~2,900 people
linked to ~930 orgs, OKF-formatted) was seeded by an external ETL that baked derived data into
static markdown: "N tracked contacts" counts on each org page and hand-enumerated
`organizations/index.md` / `roles/index.md` listings. The editorial team then curated in the app
(consolidating a duplicate org: moved a contact, deleted the dupe). Result: the count still reads
"13" (should be 14) and the index still lists the deleted page. Nothing recomputes them, and the
only thing that _would_ (re-running the ETL) does `rmtree` + regenerate from the spreadsheet, which
would **erase the curation**. Two writers (ETL and app) overwrite each other with no signal.

**Root cause.** One content primitive (the static page) is doing two jobs: authored content AND
derived/aggregate views. Derived views modeled as static markdown are stale-by-construction, and
bulk regeneration of them is destructive-by-construction. Patching individual counts does not
converge.

**The systematic fix (see PRD for FRs, acceptance criteria, phasing):**

- **Live derived views**: computed backlink listings, frontmatter-filtered listings, counts, and
  directory indexes, rendered from the D1 content index at read time (never stored, so they
  self-correct on edit/move/delete). Builds directly on the content index work: `brain_links`
  already powers backlink views; extend it. Prefer a fenced `okf-view` directive that
  degrades to valid markdown for GitHub/OKF consumers.
- **Queryable frontmatter** (enabler): the index stores page `content` + raw `links` but **no
  parsed frontmatter today**, so "people where `organization = X`" isn't answerable. Add an
  additive D1 table (e.g. `brain_page_fields`) populated in the same incremental-reindex pass;
  per-brain `indexedFields` allowlist in `.isomorphic.json` to bound size.
- **Non-destructive bulk sync**: replace wipe-and-regenerate with a reconciling importer.
  Upsert by stable key, field-level merge (source-owned scalars vs human-owned content),
  **deletions proposed not automatic** (a consolidation legitimately removes a page the source
  still lists), idempotent, landing through the existing PR/auto-merge write path. Identity/dedup
  stays a source-side responsibility (the ETL already does union-find + alias collapsing well).
- **Source-of-truth policy**: per-brain/per-subtree flag (app-authored vs source-authored;
  default app-authored) so the two writers stop overwriting each other.

Respects the architecture: stateless Worker (no `node:*`), D1 derived cache reconciled at read via
`ensureFresh` (no new webhook), GitHub as source of truth, subrequest budget, OKF-valid output.
Zero-migration for existing brains (new `.isomorphic.json` keys optional).
Related: the content-index section below, the librarian tool suite (write bundles + link
repointing the importer reuses), and brain schema migrations (the clobber-policy classification is
the same problem).

# Design: WYSIWYG markdown editor (MCP Apps)

A rich editor for brain pages surfaced inside the MCP host (MCP Apps / SEP-1865), with
`edit_page` + `save_page` tools and a codegen'd `ui://` HTML resource. Full architecture,
tradeoffs, and phased checklist: [`design/wysiwyg-markdown-editor.md`](design/wysiwyg-markdown-editor.md).

# TODO: test harness

A dozen golden tests exist today (`pnpm test`), all offline, plus two end-to-end batteries
that drive the real tool handlers against a git repo in a temp directory (**DONE 2026-08-04**,
see the local-first section above). What's still missing is unit-level and in-workerd coverage.

- **Vitest unit tests for pure helpers.** `slugify`, `insertLogEntry`, `isRawPath`,
  `utf8ToBase64`. Fast, no I/O, instant feedback.
- **`@cloudflare/vitest-pool-workers` for tool handlers.** Runs tests inside workerd with
  KV / DO bindings via Wrangler's local emulation. Mock octokit at the import boundary (or
  inject as factories, which is easier to test). Cover each tool's happy path, write
  refusal on non-content paths, and dedup behavior.
- **OAuth-metadata regression test**: hit `/.well-known/oauth-authorization-server` and
  assert `issuer` / `authorization_endpoint` / `token_endpoint` resolve to the request
  origin. Would have caught the `custom_domain: true` rewrite bug we hit during phase 1.
- **Skip list:** no E2E against **real GitHub** in CI (rate limits, flakiness, secret
  management). The `--github` mode stays a by-hand maintainer step, while the offline
  fs-backed run of the same assertions is in CI; no verbatim LLM output pinning; no bootstrap
  E2E (snapshot-test `buildManifest` and call it done, since registering a real GitHub App from
  CI is gnarly).
- **Mocking strategy:** if the octokit mock surface grows past a few methods, build a thin
  in-memory GitHub stub instead of stacking `vi.mock` calls.

# TODO: Auth.js identity live-test blocker

**Status 2026-07-06: magic-link auth VERIFIED working; the blocker was the OAuth
bridge, not email auth.** The earlier "cross-browser magic-link" diagnosis (commit
`e1cf6d6`) was wrong, corrected below.

- **What was verified.** Driving Auth.js directly against local `wrangler dev`
  (bypassing the MCP client): `/auth/signin` → email → click link → `/auth/callback/resend`
  verifies (302, token consumed) → `/auth/session` returns
  `{"user":{"email":"…"},…}`. Email send, token verification, session creation, and
  the session cookie round-trip all work. So the Resend/Auth.js layer was never the
  problem.
- **Actual root cause: the `/oauth/complete` bridge** (`src/oauth/auth-handler.ts`),
  two independent faults, neither cross-browser:
  1. **Sticky `authjs.callback-url` cookie.** Auth.js resolves the post-sign-in
     redirect as: explicit `callbackUrl` param, then the **`callback-url` cookie**, then
     the site base. A prior connector attempt left a cookie pointing at
     `/oauth/complete?state=<OLD>`, so even a clean `/auth/signin` visit (no param)
     redirected there after verifying, and `<OLD>` was long gone from KV, giving a 400
     "Invalid or expired authorization request." This is what made the manual test
     look broken. (The real connector path always sets a fresh `callbackUrl` param,
     which outranks the cookie, so it wasn't hit there, but it poisoned debugging.)
  2. **`pending_auth:<state>` loss at completion.** The stash TTL was 600s, too
     tight for an email round-trip (delivery + human + click), so slow hops expired
     the entry; dev-server restarts also cleared local KV. Either way `/oauth/complete`
     found no pending request and 400'd.
- **Fixes applied:**
  - `session.user.id` is now populated via a `session` callback in `buildAuthConfig`
    (`src/auth/config.ts`). DB-strategy sessions omit the id by default, so
    `/oauth/complete` was resolving identity with `userId: ''` and silently falling
    back to email as the primary key. Verified: `/auth/session` now returns
    `user.id`.
  - `PENDING_AUTH_TTL_SECONDS` 600 → 3600 (`auth-handler.ts`) to cover the email
    round-trip.
  - `/oauth/complete` deletes the pending entry **after** `completeAuthorization`
    succeeds (previously before, so a transient error stranded the user into a fresh
    sign-in), and the missing-pending case now returns an actionable message
    ("…start the connection again") plus a `console.warn`, instead of a bare 400.
- **Still TODO: full connector end-to-end.** The above is verified at the Auth.js
  and bridge-unit level; the whole `/authorize` → sign-in → `/oauth/complete` →
  code-back-to-client loop still needs one clean pass through MCP Inspector (or the
  Claude connector). Clear the browser's `authjs.*` cookies first, or use incognito,
  to avoid the stale `callback-url` cookie above.
- **Still recommended: Google/OIDC as the PRIMARY connector provider.** Not to
  rescue email auth (it works), but as the durable, low-friction path: redirect-based,
  same-browser, seconds-long round-trip, so it's immune to email prefetch and to
  TTL/round-trip fragility. Mirror a known-good SvelteKit Auth.js `auth.config.ts`
  (`allowDangerousEmailAccountLinking`, `authorization.params.prompt=select_account`,
  lowercased-email profile, `signIn` allowlist callback feeding org membership).
  Needs a Google OAuth client (id/secret + `/auth/callback/google` redirect URI).
  Keep magic-link as a secondary provider; add a confirm-page/POST step to defeat
  prefetch when it becomes user-facing.
- **Reconsider later:** a sibling SvelteKit app uses JWT sessions (`session.strategy=jwt`);
  we scaffolded DB sessions. DB sessions are why the id-callback was needed and why
  `getAuthSession` re-reads `/auth/session` per request. Revisit if the bridge stays
  fragile, but it's working now.
- **Test harness quirks:** Inspector needs the proxy token (or
  `DANGEROUSLY_OMIT_AUTH=true`); its "Clear OAuth State" button doesn't clear
  `lastBearerToken` (use incognito). Local KV/D1 persist across restarts
  under `.wrangler/state`, but a restart mid-flow still races an in-flight pending
  entry; re-initiate from the client after any restart.

# TODO: branch-protected brains (write path) + non-technical-user UX

**Context.** The write tools (`write_page`, `save_page` from the editor,
`move_page`, `delete_page`) all end in `commitFiles()` → `updateRef` on the repo's
**default branch**. On a repo whose default branch is **protected** (requires PRs or
status checks), GitHub rejects that commit. An early customer brain had exactly this:
`main` required a PR plus a `validate` status check, so that brain was **read-only
through our tools**. Browse, read, and edit-open worked, but _Save_ failed. (Confirmed
2026-07-08: a direct `.isomorphic.json` PUT returned 409 "Changes must be made through
a pull request.")

**Chosen design (decided 2026-07-08): auto-detect, PR when protected.**

- When loading a brain's config, also read the default branch's protection status and
  store it on the cached `BrainConfig`. Needs `administration: read`; the App already has
  `administration: write`.
- Write path chooses: default-branch unprotected → direct `commitFiles` (today's
  behavior, "Saved."). Protected → open a PR: commit the same multi-file bundle to
  a fresh branch (`isomorphic/<slug>-<date>`) and open a PR against the default
  branch; tool response becomes "Proposed a change, PR #N (awaiting review)."
- Add an explicit `writeMode: "direct" | "pull-request"` to `.isomorphic.json` to
  force either regardless of detection.
- Reuse the existing PR machinery: `commitOrPR` (`src/lib/brain-repo.ts`) already does the
  multi-file "commit to branch + open PR" path, so page + log + repointed-link bundles land
  in one PR. The App install already has `pull_requests: write` + `contents: write`.

**The real gap: non-technical users.** PR-per-edit strands non-technical members. They
won't review or merge PRs, so their edits sit open indefinitely and the knowledge base
never updates from their side. Options to smooth, to design before shipping PR-mode to
member-facing brains:

- **Auto-merge on green.** Enable PR auto-merge so a change lands as soon as the
  required checks pass, with no human step for routine edits. Gate by member role
  (`editor`+ auto-merges; `viewer` can't write anyway).
- **Route to an approver.** Notify/assign the org's `admin`/`owner` (or a
  configured reviewer) on each proposal; they one-click merge.
- **Surface status in-app.** After a save, the editor shows "Pending review,
  PR #N" with a live status pill (checks running / mergeable / merged) instead of
  a silent success, so the member knows their change isn't live yet.
- **Batch a session's edits** into one PR/branch rather than one PR per save, so a
  member's run of edits is a single reviewable unit.
- **Per-brain policy** for who may auto-merge vs. propose-only, stored on the org.

**Per-directory / per-path protection (beyond branch-level).** Protection isn't
only whole-branch. A repo may gate _specific folders_, via CODEOWNERS requiring
review on `internal/`, or a GitHub Actions workflow that fails the required check
only when certain paths change, while leaving other folders freely committable.
So write mode should ultimately resolve **per target path**, not just per branch:
a change touching a protected subtree goes via PR; a change confined to an open
subtree can commit directly. First cut can approximate this in `.isomorphic.json`
(e.g. `protectedPaths: ["internal/**"]` → PR for matches, direct otherwise); the
faithful version reads CODEOWNERS plus branch/ruleset path filters. Note a bundle
that spans both (page in an open folder + changelog in a protected one) forces the
whole bundle to PR, so keep bundles within one protection domain where possible.

Ship order: (1) auto-detect branch protection + PR fallback so protected brains
stop erroring; (2) per-path/per-directory protection resolution; (3)
auto-merge-on-green so routine member edits land without a human; (4) in-app
pending-status UX (the editor currently shows the PR url in its result text but
still tracks the old `main` sha, so a second save opens a second PR, and it needs
real "pending review" state); (5) approver routing once the admin surface exists.

# TODO: commit attribution (who made each change). **DONE 2026-07-09**

~~Every write went through the GitHub App installation token with no commit author,
so `git blame` showed the bot for every edit.~~ **Shipped:** `commitFiles` /
`commitOrPR` (`src/lib/brain-repo.ts`) take an `author?: CommitAuthor`;
`validCommitAuthor` guards it (drops blank/invalid emails and falls back to the App,
never a 400). `TenantContext.author` is resolved per-request in `worker.ts`: the authjs
path uses `app_users.name`+`email` (via `getAppUser`); the github path uses GitHub's
canonical noreply `<id>+<login>@users.noreply.github.com` (links the commit to the
profile). The static path leaves it undefined (App-authored). Threaded through
`BrainContext` to all librarian write tools plus `save_page`. `committer` is filled
from `author` by the GitHub API, so blame reflects the human. The scaffold commit
(`scaffold-core.ts`) stays App-authored deliberately. Verified live against a
scratch repo (author lands; committer fills from author; no-author and invalid-email
both fall back to the App).

Remaining niceties (not blocking): put "Edited by <name>" in PR bodies, and offer a
per-brain noreply address instead of the token email for members who'd rather not
expose a real address.

# TODO: activity / audit screen. **DONE 2026-07-09** (follow-ups below)

**Shipped:** `view_activity` app-tool (`src/tools/apps.ts`), one `repos.listCommits`
call (default branch; optional `path` scopes to a page's history; limit ≤50),
mapping commits to `{ authorName, authorLogin?, message, path?, date, shortSha, url }`
in `structuredContent`. The path is parsed from our own commit messages
(`"… (wiki/…md)"`) so entries link straight to the page. App renders a **Recent
changes** timeline (`ActivityView` in `app/main.tsx`): name-tinted **initials
avatars** (NOT GitHub avatar images, since the iframe CSP blocks external hosts),
`@login` only when the commit links to a GitHub user (authjs members show name
only), relative time, "Open page" + commit link. Reached via a clock icon in the
header (`openActivity`). This is where commit attribution pays off. The harness stubs
`view_activity` and a `#activity` hash for `pnpm app:dev`.

Follow-ups (not blocking):

- **Per-page history entry point:** the tool already takes `path`; add a "History"
  affordance on the page (menu or `PageProperties`) that calls `openActivity(path)`,
  and a "last edited by X, N days ago" line on the page itself.
- **Open PRs (pending review):** merge `pulls.list` (open) into the feed for
  PR-mode brains so in-flight changes show before they auto-merge. Ties into the
  editor pending-review state in the branch-protected-brains section.
- **Pagination / "load more"** once a brain has a long history (listCommits is one
  page; add a `page` param).
- **Diff / pending changes:** for PR-mode brains, show open PRs touching a page as
  "pending review" with a diff link.

# TODO: content index (uncaps + speeds up the read tools). **DONE 2026-07-13**

~~Reads fetched + parsed every page from GitHub on each call, capping scans at ~40
pages (Worker subrequest budget) and costing hundreds of ms.~~ **Fixed in two steps.**
First, `fetchPages` was rebatched onto GraphQL (one request per ~100 blobs), lifting
the cap from 40 to 1500. Then the durable fix: a **derived D1 index** (`src/lib/brain-index.ts`,
`src/db/index-schema.sql`) now backs `search_pages`, `find_inbound_links`, `validate`,
and `view_graph`. Each read calls `ensureFresh()`, a read-time HEAD-sha guard that
reconciles the index with the repo (incremental reindex of only changed pages) before
serving, so it's correct even after edits made outside our tools, with no webhook.
Links stored raw and resolved at query time; keyed by `brainId="owner/repo"`. See the
"Content index" section in CLAUDE.md.

Future ideas (deliberately deferred; the read-time guard already makes reads correct
and unbounded, so these are optimizations or new surfaces):

- **Use the index in more places.** ~~(a) `list_pages`/`browse_brain` serve the page list
  with titles from `brain_pages`.~~ **DONE 2026-07-13**: both serve from the index
  (`listIndexedPages`); `structuredContent.pages` carries `{path,title}`, and the app's file
  tree now labels files by title (falling back to filename). `list_pages` keeps the live tree
  walk only for the prefix case (which can target non-content areas). ~~(b) link-repointing
  capped at 40.~~ **DONE 2026-07-13**: `fetchInboundLinkers` uses `backlinksTo()` to discover
  the linking pages via the index, then fetches only those fresh (at the commit's `head`) to
  rewrite; bounded by inbound-link count and uncapped.
  (c) **still TODO**: editor **wikilink autocomplete**, querying the index for page
  titles/paths to offer `[[…]]` completions in the ProseMirror editor.
- **FTS5 ranked search.** Search is currently `LIKE` plus in-Worker line extraction (correct,
  matching the old scan). A D1 FTS5 virtual table would add relevance ranking and speed for
  large brains. Verify D1 FTS5 support first.
- **Push-webhook freshness.** A `/webhooks/github` receiver (secret + manifest `push`
  subscription) reindexing on push would keep the index fresh _before_ a read reconciles,
  removing the per-read `getRef` and the post-external-edit reindex spike. Pure freshness
  optimization; the HEAD guard already covers correctness. Manifest change means orgs re-approve.
- **sha-check TTL cache + write-through.** Cache the HEAD-sha check per brain (~30-60s) to drop
  the per-read `getRef` in steady state; on our own writes call `invalidateIndex()` (already
  exported) so the just-edited state reflects immediately.
- **Report index truncation past 1500 pages** in the graph payload (search and validate already do).

# TODO: graph view (link graph of the brain). **DONE 2026-07-13**

~~Obsidian-style graph of pages as nodes and wikilinks/markdown-links as edges.~~
**Built.** Server tool `view_graph` (`src/tools/apps.ts`) builds the adjacency
list from the SAME link extraction as `validate` / `find_inbound_links` (markdown
links via `resolveRelative`, wikilinks by path/filename/title), deduped undirected,
nodes carrying a `degree`. Returns `{ view:'graph', nodes, edges, focus?, truncated }`
in `structuredContent`. Rendered by `GraphView` (`app/main.tsx`), a dependency-free
canvas force layout (O(n²) springs, fine at the scan ceiling): repulsion +
link springs + origin gravity, pre-settled synchronously then a cooling rAF loop.
Drag to pan, scroll to zoom (cursor-anchored), drag a node to reposition, click a
node to open it; hover highlights neighbors; nodes colored by folder and sized by
degree; theme-aware (re-reads `--c-*` tokens on `data-theme` / scheme change). The header
graph icon opens it (passing the current page as `focus`); works inline (bounded
420px card) and fullscreen (72vh). Bundle grew ~0 KiB of deps. Dev preview:
`pnpm app:dev` → `#graph`.

Follow-ups (not built): local-graph depth filter (n-hop around focus); orphan
de-emphasis toggle; group-by-tag coloring.

# TODO: inline-mode height responsiveness. **DONE 2026-07-09**

~~In inline mode the app rendered at a full-viewport height (a tall blob) and didn't
track content.~~ **Fixed:** the root shell only applies `min-h-screen` when
`displayMode !== 'inline'` (`app/main.tsx` `Root`). The App's `autoResize`
(ResizeObserver on body, default on) already reports content height to the host;
`min-h-screen` was pinning the body to 100vh so the report never changed. Now the
inline card sizes to content, growing and shrinking as folders expand and collapse, and
the host applies its own inline cap and scroll for very tall content. Fullscreen and pip
keep `min-h-screen` (they own their window). The dev harness now wires
`bridge.onsizechange` to size the `#frame-slot` to the reported height (bounded by
`INLINE_MAX_PX`, top-aligned), so `pnpm app:dev ?mode=inline` faithfully previews
it. Verified via the AppBridge harness: short tree fits exactly; a long page caps
and scrolls internally.
