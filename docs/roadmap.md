# Roadmap

What the maintainers are planning, in roughly the order we plan to do it, including the
unglamorous parts and the things we have decided against.

How to read it:

- Each `# TODO:` section is a unit of work that is not built yet. Finished work is removed
  from this file; what it does is described in [`CLAUDE.md`](../CLAUDE.md) and the design
  docs under [`design/`](design/). Where a finished item left a decision worth keeping, the
  section keeps that decision and nothing else.
- A **Decided against** or **(dropped)** section is a direction we chose not to take. The
  reasoning is left in place so nobody re-proposes it without knowing why.
- Nothing here is a commitment or a date. Priorities move.

If you want to work on something in here, say so in an issue first so two people do not
build the same thing. Several of these are good first contributions, particularly the app
UI items near the top. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

# TODO: honor hostContext.safeAreaInsets in the app

The `ui://` resource now declares `_meta.ui.prefersBorder: false`, because the app draws
its own bordered card inline and the host's unspecified default is bordered on mobile,
which nested one border inside another. The trade that comes with borderless is that the
host contributes no padding, and host padding is what otherwise absorbs
`hostContext.safeAreaInsets`. The app reads none of them today, in any display mode, so
on a phone the composer and the navigation bar can overlay content flush to the edge.

Apply the insets as padding on the root container (`Root` in `app/main.tsx`), and as
`scroll-padding` on any scroll-snap container. They arrive in `ui/initialize`'s host
context and again on `ui/notifications/host-context-changed`, which `applyHostContext`
in `app/core/host.ts` already receives and currently ignores.

The alternative is to hand the chrome back to the host: `prefersBorder: true` AND drop
the app's own inline border, since the two must never both draw one. That gets the
padding for free and is closer to the design guidelines' "inherit the containing
environment", at the cost of the app no longer controlling its own card. Either way the
two halves move together, which is what `pnpm test:appmeta` pins.

# TODO: skeleton shells for the page, tree, and graph

The rotating status line landed (`src/lib/loading-lines.ts` + `app/views/LoadingView.tsx`,
`pnpm test:loading`), which covers the wait itself. What it does not do is show the
SHAPE of what is coming. Where the layout is known before the content is (a page, the
file tree, the graph) a skeleton would let the frame appear instantly and only the
content stream in, which is a different and better answer than a centered line of text.

Worth doing per view rather than centrally: the point is that each shell matches its own
view's real layout, and a generic skeleton that matches nothing is worse than the line.
Reuse the `.loading-shimmer` sweep and the `prefers-reduced-motion` rule already in
`app/styles.css`.

# TODO: file tree polish (a non-drag move, and keyboard support)

The file tree (`FileTree` in `app/views/Browse.tsx`) now covers the whole create / rename /
move / delete surface for files **and** folders: "New note" and "New folder" in the header
toolbar and in each folder's `⋯` menu, inline rename for both (a folder rename repoints every
child path and inbound link through `move_page`), drag-and-drop of files and folders into
nested folders, and a delete with a confirm that says a folder takes everything inside it.
What is missing:

- **A non-drag "move to…" picker.** Drag-and-drop is the only way to move something in the
  app today. A picker is the precise option and the accessible one.
- **Keyboard support across the tree**, beyond Enter and Escape in the rename and add inputs.

Keep the conversational path working alongside it: Claude creates, moves, and deletes through
the same tools the tree calls.

# TODO: naming brains from the scripted paths

A brain's display name is `brains.name`. `create_brain` and `connect_brain` take a name, and
`configure_brain` renames any brain (brain admin; the name is a D1 field, so this is the one
`configure_brain` argument that does not write `.isomorphic.json`). The two scripted paths
still cannot name: `src/db/seed-operator-org.sql` and `scripts/onboard-org.ts` both omit the
column, so every operator-onboarded brain starts under its repo name and needs a rename. Add
the column to the seed template and a `--name` flag to the script.

A backfill for existing unnamed rows is probably not worth it: only the owner knows what each
brain should be called, and they can now rename it themselves.

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

# TODO: productize the bootstrap flow for other self-hosters

What is needed to take the single-operator flow (run `pnpm bootstrap` locally, register an
App, install it on your org) and let arbitrary people run it without help. Members of a
deployment never touch GitHub already; this is about the operator.

- Register the App **once**, platform-owned and public, so an operator only installs. Drops
  the manifest flow from the operator's path.
- Deploy bootstrap as a Cloudflare Worker so callbacks have a real HTTPS URL (not
  `localhost:3000`).
- Add a webhook receiver for `installation` events (install / uninstall / suspend /
  permissions update) to keep org rows consistent.
- Webhook-source signing keys (Slack `/save`, Granola, an email forwarder): one platform-wide
  secret per integration source for verifying inbound signatures, _not_ per tenant. Tenant
  identity is resolved from the verified payload after the signature check. Per-tenant LLM
  keys are explicitly not a platform concern.
- Error pages with retry and observable logs, so failures are debuggable without
  paste-the-stack.

# TODO: productionize the MCP server

The Worker is live at `https://mcp.isomorphic.sh` (with a `workers.dev` fallback), on
`AUTH_MODE=oauth` (Auth.js email sign-in). `AUTH_MODE=static` with `MCP_BEARER_TOKEN` stays,
as the documented single-user self-hosting path, and `GITHUB_TOKEN` mode is built on it; both
run the same org model.

Decided, keep: **no `routes` block.** The custom domain is bound in the Cloudflare dashboard,
independently of the config. A `routes` entry makes `wrangler dev` rewrite `request.url` and
breaks the OAuth provider's host-based routing.

Decided, keep: **tool-list changes do not auto-propagate to claude.ai web, and that is
expected.** The web client caches a connector's tool list and re-fetches only on a manual
"update tools" / reconnect (Settings → Connectors), not on a new chat and not on a
server-sent `notifications/tools/list_changed`. Tool _behavior_ changes need nothing. A
server-side `list_changed` emitter was tried and reverted on 2026-07-06; the transport is now
stateless, so there is nowhere to hold the revision state anyway. Revisit only for clients
that honor the notification. Refs:
[claude-code#13646](https://github.com/anthropics/claude-code/issues/13646),
[#50339](https://github.com/anthropics/claude-code/issues/50339).

Open:

- Disable `workers_dev` (`workers_dev: false`) so the custom domain is the canonical entry
  point. Cosmetic.
- Claude Code MCP client OAuth bug: token is issued but not attached to the post-flow `/mcp`
  reconnection ([#46140](https://github.com/anthropics/claude-code/issues/46140)). Inspector
  works; track upstream.
- Add `propose_change` (PR-style write for `wiki/`) once a lint agent exists. Without lint, a
  PR just sits there.
- Split read vs write MCP scopes so read-only clients cannot mutate. Today the OAuth grant is
  a single bucket.
- **Installation-token cache.** Every request builds a fresh `App`/octokit and mints an
  installation token on first use (and tenant resolution can run twice per request: preamble
  and handler). Caching the token in KV against its 1h TTL would drop one GitHub round trip,
  and the token-mint rate pressure, from every tool call.
- Handle Git tree truncation (`tree.truncated === true`) in `listTree` for very large
  repositories, by falling back to a recursive directory walk.
- Pagination or a size cap on `list_pages`, which still returns every path in one text
  block. (`browse_brain` already sends a summary once the tree is large.)
- Structured errors: surface GitHub 404 / 403 / rate-limit as MCP-shaped errors instead of
  letting exceptions bubble through octokit.

# TODO: live-deploy hardening

The org model's gates (`tenantContext`, `effectiveBrainRole`) are what stand between a
stranger and a brain today. The hardening below matters most as self-onboarding opens up.

- **Onboarding policy.** `AUTO_PROVISION` is the switch today: on, anyone who signs in gets an
  org of their own; off, the deployment is invite-only. Decide deliberately whether the hosted
  service wants an allowlist or a review queue in between.
- **Cloudflare rate-limit rules** on `/register` and `/authorize` if abusive traffic shows up.
  Do not pre-empt; wait for signal.
- **Webhook signature verification** when webhook receivers (Slack `/save`, Granola, etc.)
  land. Standard HMAC pattern, per-source signing key.

## Decided: principles from the librarian tool suite

The write tools were derived (2026-07-06) from commit-history analysis of two production
AI-maintained wikis. Two findings set their shape and still hold. **The unit of work is a
multi-file bundle, not a single file** (page, changelog, and repointed links in one commit),
which is why every write goes through one atomic `commitOrPR`. **Conventions enforced only as
prose get skipped**, so invariants are tool preconditions rather than `AGENTS.md` prose. And
**the user never sees git**: results speak in wiki terms, and a protected brain's pull request
is described as a proposed change.

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

# TODO: sharing a page by link with someone who has no access

The web app half of this shipped: every page has a URL (`/b/<owner>/<repo>/<path>`), the same
MCP App bundle served in a browser tab over the Auth.js session, and markdown rendering moved
to `src/lib/render.ts` with sanitization on the way. A colleague who already has access to the
brain can be sent a link today.

What is not built is the other recipient. Someone **outside** the brain (a client, a
candidate, a vendor) gets a **reader**: a revocable, expiring, server-rendered read-only page
at a secret link, with no app bundle, no tools, no identity, and links out of the shared set
flattened to plain text at the horizon. `effectiveBrainRole` gains no new input for it: a share
is scoped to a path, capped at read, and belongs to nobody, so the reader resolves its own
narrow context and cannot construct a `TenantContext`. (A person can already be given a whole
brain as a guest through `share_brain`; this is for a page, without an account.)

Full design: [`design/link-sharing-and-the-web-app.md`](design/link-sharing-and-the-web-app.md)
(Phases 1 and 2). Unresolved there: whether the reader needs its own hostname.

# TODO: the seam between brains (publishing across a brain boundary)

One person reaches several brains, and work in one belongs partly in another: a
client engagement, a personal to-do list tracking that client's work, a venture
brain holding the methodology the client should receive. The only transport today
is a human copying text, and nothing records that the copy happened.

The design splits the want in two, and the split is the point. **"I need to find
it"** is a reader who already has access to both brains, and copying is the wrong
answer. That half is a READ feature, and its first piece shipped:
`search_pages` with `scope: "all"` searches every brain the caller can reach, and every
result names its brain. Cross-brain wikilinks are not built. **"Someone who cannot reach
my brain needs to see it"** is a client, and content genuinely has to cross into a
repository they can read. That second half is publishing, and it is the only case where a
copy is correct. Naming it publishing rather than sync puts the question that matters (who
can now read this) in the name.

Most of the machinery for publishing exists. `sync_records`' planner is already
non-destructive, key-addressed, idempotent, ledger-backed, with proposed-not-applied
deletions and a no-resurrection rule. What is actually new: two brains resolved in one
request for a WRITE (cross-brain search reads several, but never writes across the `brainId`
isolation line), a `body: source-owned` policy the importer deliberately does not have (its
bodies belong to humans; a publication's body IS the payload), link flattening at the
published set's horizon, and a publication/subscription handshake declared in BOTH repos so
neither end can open a channel alone. Identity is a key, never a path, or a routine
`move_page` on either side becomes a delete plus a create.

Full design: [`docs/design/brain-seams.md`](design/brain-seams.md).

# TODO: brain schema migrations (fleet-wide template/schema updates)

How template and schema changes reach every customer brain after they're scaffolded. Today this is manual, which doesn't scale past a handful of tenants.

**Recommended shape: versioned, idempotent migrations applied lazily on first touch.**

- **Version markers.** Each brain records its `schema_version` (small `.brain-version` file at repo root: machine-readable, mostly invisible to users). Mirror it as a column in D1 so the Worker can check without a GitHub call. Platform ships `CURRENT_SCHEMA_VERSION` plus an ordered migration registry (`src/lib/migrations/NNN-name.ts`).
- **Migration contract.** A migration is an idempotent async function `(store, repoArgs) => void` producing at most ONE atomic commit (commitFiles) plus a `wiki/log.md` entry, so the librarian visibly did maintenance, consistent with the no-git principle. Idempotent because a crashed run must be safely re-runnable; the version marker only advances after success.
- **Lazy application in `tenantContext()`.** After tenant resolution: if D1 `schema_version` < current, take a per-brain lock, run pending migrations in order, bump D1 and the in-repo marker. Dormant brains migrate on their next use; no fleet job needed. Budget-cap the work per request (Worker subrequest limits) so large data migrations chunk across successive touches ("migrate up to N pages per request until done").
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
- Access: `resources/list` and `resources/read` must resolve the brain and the caller's role through the same `tenantContext` / `effectiveBrainRole` path the tools use. There is no per-path access inside a brain, so a resource is readable exactly when the brain is.

# TODO: media attachments, what is left

Images and PDFs live in a brain, render in the app, and can be handed to Claude to look at
(`attach_media`, `read_media`, `src/lib/media.ts`, `pnpm test:media`). `attach_media` also
takes a `url`, and the server downloads the file, so the bytes never cross the model's
output. Full design: [`docs/design/media-attachments.md`](design/media-attachments.md).

**The constraint that set the shape: the model cannot hand us bytes.** Tool arguments are
JSON produced by the model, and a model shown an image holds visual tokens, not base64. No
host passes a conversation attachment into a tool call. So the upload surface for a file
with no URL is the **app iframe** (a real browser context with a real file input), and
`attach_media`'s own description says so.

Decisions worth not relitigating:

- **Data URIs, not a CSP allowlist**, for showing images in the app (brain repos are private,
  so raw GitHub URLs need expiring signed redirects to a host you would not naturally
  declare).
- **5 MiB cap** (git keeps every version forever in a repo the customer clones).
- **Co-located `assets/`** (so `move_page` on a folder carries its pictures, and plain
  markdown readers resolve the link).
- **Images embed, documents link** (`![](…)` on a PDF is a broken image everywhere,
  including github.com).
- For URL ingest: **https only** (one rule, no per-deployment allowlist); **hostname guards,
  not a resolver check** (a public name resolving to a private address defeats them, and
  Cloudflare's fetch egresses to the public internet rather than into anything of ours);
  **manual redirects** (`redirect: 'follow'` validates the first address and then lets a 302
  point anywhere).
- **`read_media`'s data URI is opt-in** (`include_data`, set by the app). Hosts put
  `structuredContent` in front of the model, so every image was being spent twice.

Not built, in rough priority order:

- **Host verification of the upload entry point.** Whether a sandboxed MCP App iframe in
  every host permits `<input type="file">` and drag-drop. If it is blocked somewhere, the
  upload entry point needs rethinking there.
- Making the dev harness run the real server (its own section below).
- An orphan finding in `validate` for attachments (one nothing references is invisible in
  the app yet still in every clone forever), a brain-wide `assets/` option for shared
  images, returning PDFs to the model (unverified whether a host turns an embedded resource
  blob into a document block), and retention/pruning.
- **Attaching a file the agent MADE.** URL ingest covers anything with a public address; it
  does not cover bytes that exist only on the agent's own disk (issue #20: a PDF page
  rendered to PNG and cropped). The candidate is a two-step upload: a call returning a
  short-lived signed URL, the agent POSTs the bytes out of band, the token redeems them.
  Verify first whether an agent sandbox can POST to the Worker at all.

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

# TODO: derived views and non-destructive sync, what is left

Full PRD: [`design/derived-views-and-sync-prd.md`](design/derived-views-and-sync-prd.md).
Phases 1 to 3 are built: `okf-view` computed views (`src/lib/views.ts`,
`src/lib/view-directives.ts`, `pnpm test:views`), queryable frontmatter
(`brain_page_fields`), and the non-destructive importer (`sync_records` and `resolve`,
`src/lib/brain-import.ts`, `pnpm test:import`). Remaining from the PRD: a reconciliation
widget for import questions, `sourceOfTruth: "source"` (parsed, and refused by the importer
today), and Phase 4 (FR-5 migration tooling).

Follow-up (viewer UX, not PRD-scoped): **dynamic filters on the Linked references
panel.** The panel and the `backlinks` view share one engine; the panel's gap is
ad-hoc, per-viewer filtering (by `type` or any indexed field) while browsing, with
no authoring. Natural bridge: a "pin this filter into the page" action that writes
the equivalent okf-view directive, making views discoverable from the panel. An
unfiltered backlinks directive duplicates the panel, so steer authors toward
filtered/columned views (the demo fixture models this).

Follow-ups surfaced retrofitting an existing Obsidian vault to okf-view:

- **Auto-generated frontmatter `summary` (highest value).** okf-view's `describe:` can
  only read a _frontmatter_ field, but real vaults keep the one-line blurb in the page
  BODY (that vault's `build_index.py` extracted the first prose under `## Context` /
  `## Summary` / `## Goal`). So converting to okf-view lost the rich per-item blurbs and
  entries are bare links now. Fix: a step (write-time hook, or a `harvest`-style tool)
  that derives a `summary` from the body and writes it to frontmatter, where it's indexed
  and rendered via `describe:`. Then live indexes regain their descriptions. Note the
  blurbs contain wikilinks; either resolve them in view cells (see below) or store a
  plain-text summary.
- Wikilinks inside computed view cells render as literal `[[text]]` (dead on GitHub);
  resolving them to real links in `describe:`/column output would let summaries keep their
  links. Pairs with the auto-summary item.

# TODO: records tables (dated activity against a brain's concepts)

Full PRD: [`design/records-tables-prd.md`](design/records-tables-prd.md).

A brain has one content primitive, the page, which models a **concept**. There is no home
for a **record**: a dated occurrence that points at concepts. Concepts are stable and few;
activity against them is dated and unbounded, and forcing the second into the first evicts
concept data from the index. A page per event on a ~4,000-page brain crosses `MAX_SCAN_PAGES` (5000)
within months, at which point the _concepts_ become unfindable.

Shape: brain-declared tables (`records/<table>.md` carrying an `okf-table` schema under
OKF's conventional `# Schema` heading), rows stored record-per-section in monthly shards
under `records/<table>/`, indexed into D1 as a derived cache exactly the way pages are.
**Row-to-page references are wikilinks, not a new foreign key.** That one decision means
backlinks, `validate`, the graph view, and `move_page`'s inbound repointing all cover
records with no new machinery.

Four capabilities: the tables themselves; aggregation in `okf-view` (`kind: records`,
group-by a link column, and date-window predicates, which is the one genuinely new
expression the engine needs); a propose-and-admit ledger so an agent can draft rows from an
external signal and a human admits them per item with durable declines; and an optional
attested-counting layer for deployments where a count is consequential outside the system
(billable hours, contributor compensation, audit evidence).

The PRD surveys eight domains that share the same four roles (subject, actor, optional work
unit, record) and vary only in schema, which is why schemas are brain-defined and none ship
with the platform. Two things it deliberately does NOT ask for: work-unit pages (a story, a
requisition, a matter) are ordinary pages and need no platform feature, and cross-table joins
belong in a warehouse. §9 states that line, and §9.1 notes OKF's own answer for data that
already has a home elsewhere: a table declaration with a `resource` pointer and a schema but
no rows.

Depends on nothing already in flight, but overlaps two items here: **bulk page updates**
(the find/replace half, since records are an alternative answer to some of the same
pressure) and **raising `MAX_SCAN_PAGES`**, which the PRD scopes in §8.1 (the ceiling is a
sanity bound, not a platform limit; the resumable rebuild budgets are what actually make a
large brain work).

# TODO: folder notes and OKF conformance (split the listing from the overview)

Full PRD: [`design/folder-notes-and-okf-conformance.md`](design/folder-notes-and-okf-conformance.md).

A folder note does two jobs in one file: it holds an **authored overview** (frontmatter, a
type, narrative) and a **generated listing** (an `okf-view` fence plus its regenerated
snapshot). OKF forbids the combination, since `index.md` is reserved and "MUST NOT be used
for concept documents". But the better argument has nothing to do with conformance:
regenerating the listing rewrites the file holding the prose, so adding one page under
`vendors/` produces a diff in `vendors/index.md` that nobody authored. Every listing regen
dirties the authored document and its `git log` is mostly noise.

Split them. The overview moves to `overview.md` (additive: `FOLDER_NOTE_NAMES` gains it at
the front, no existing brain changes behavior) and keeps the view directive; `index.md`
becomes a tool-maintained materialization of that directive, like `log.md` already is.
**Composition needs no new machinery**, since a page containing a view is what pages already
are: clicking a folder still renders overview prose with the listing computed live in place,
wherever the author put the fence.

Two findings from reading the code. Existing brains are mostly conformant already; the
_platform_ is what introduces violations, because `folderNoteSeed` (`app/views/Browse.tsx`)
passes a `title` into `write_page`, which forces frontmatter into every app-created
`index.md`. That `title` is redundant, since `pageTitle` already derives a folder note's name
from its folder. Dropping it and seeding an `# H1` instead is roughly three lines and is
worth doing on its own, ahead of everything else here.

The sequencing is forced and getting it wrong is destructive: reserved names can only leave
the concept index (so a generated listing per folder does not shadow real pages in search and
wikilink resolution) **after** brains have moved authored content out of `index.md`. Doing
that step early silently removes real content from search. §5 of the PRD has the order.

Migration is advisory, never forced, like every other OKF rule here: one `move_page` per
folder, surfaced by pointing the existing `folderNoteSuggestions` advisory the other way.
Fleet-wide, it fits the **brain schema migrations** item above rather than a bespoke tool.

# TODO: test harness

About thirty golden batteries run offline in `pnpm test`, plus two end-to-end batteries that
drive the real tool handlers against a git repo in a temp directory, the browser suite
(`pnpm test:ui`), and the deploy smoke checks (`scripts/smoke.ts`, pinned by
`pnpm test:smoke`, which also covers the OAuth metadata documents). What is still missing is
in-workerd coverage of the tool handlers.

- **`@cloudflare/vitest-pool-workers` for tool handlers.** Runs tests inside workerd with
  KV and D1 bindings via Wrangler's local emulation. Cover each tool's happy path, write
  refusal on non-content paths, and dedupe behavior, in the runtime production uses.
- **Skip list:** no E2E against **real GitHub** in CI (rate limits, flakiness, secret
  management). The `--github` mode stays a by-hand maintainer step, while the offline
  fs-backed run of the same assertions is in CI; no verbatim LLM output pinning; no bootstrap
  E2E (snapshot-test `buildManifest` and call it done, since registering a real GitHub App from
  CI is gnarly).
- **Mocking strategy:** if the octokit mock surface grows past a few methods, build a thin
  in-memory GitHub stub instead of stacking mocks.

# TODO: Google / OIDC sign-in

Magic-link sign-in works and is what the hosted service runs. The recommended PRIMARY
provider is still Google/OIDC: redirect-based, same-browser, a round trip of seconds, and so
immune to email prefetch and to the TTL fragility of an email hop. Mirror a known-good
Auth.js config (`allowDangerousEmailAccountLinking`,
`authorization.params.prompt=select_account`, lowercased-email profile, a `signIn` callback
feeding org membership). Needs a Google OAuth client (id/secret plus an
`/auth/callback/google` redirect URI). Keep magic-link as a secondary provider, and add a
confirm-page/POST step to defeat link prefetch.

Reconsider at the same time: Auth.js is on database sessions, which is why the `session`
callback has to copy `user.id` and why the bridge re-reads the session per request. JWT
sessions would drop both.

# TODO: branch-protected brains, what is left

Built: a write to a brain whose default branch is protected opens a pull request instead of
committing (detected from branch protection, or forced with `"writes": {"mode": ...}` in
`.isomorphic.json`), carrying the same multi-file bundle, and arms GitHub auto-merge by
default so a routine edit lands once checks pass (`"autoMerge": false` turns that off). The
editor reports a proposed change rather than claiming it saved.

Open, in rough order:

1. **Per-path protection.** Protection is not only whole-branch: a repo may gate specific
   folders through CODEOWNERS or a required check that fails only on certain paths. Write
   mode should ultimately resolve per target path. A first cut can approximate it in
   `.isomorphic.json` (`protectedPaths: ["internal/**"]`); the faithful version reads
   CODEOWNERS plus branch/ruleset path filters. A bundle that spans both domains goes whole
   to PR.
2. **Pending-review state in the app.** The editor reports the proposal, but nothing
   remembers it: the page shows the branch as it is, so a second edit starts from the
   unmerged base and opens a second pull request. Wants a "pending review" state with the pull request's status.
3. **Batch a session's edits** into one pull request rather than one per save.
4. **Approver routing** (notify or assign the org's admins on each proposal), and a per-brain
   policy for who may auto-merge versus propose only.

# TODO: commit attribution niceties

Writes are attributed to the person who made them (`author` on `commitFiles` /
`commitOrPR`, resolved per request). Two niceties remain: put "Edited by <name>" in pull
request bodies, and offer a per-brain noreply address for members who would rather not
expose a real one.

# TODO: activity feed follow-ups

`view_activity` is built (the brain's or one page's commit history). Follow-ups:

- **A per-page history entry point** on the page itself (the tool already takes `path`), and a
  "last edited by X, N days ago" line.
- **Open pull requests** in the feed for PR-mode brains, so in-flight changes show before
  they merge, with a diff link.
- **Pagination / "load more"** once a brain has a long history (one page of up to 50 commits
  today).

# TODO: content index, optional work

The derived D1 index is built and is what every read tool queries (see CLAUDE.md, "Content
index"). What remains is optimization and new surface; the read-time HEAD guard already makes
reads correct and unbounded.

- **Wikilink autocomplete in the editor**, querying the index for titles and paths to offer
  `[[…]]` completions.
- **Push-webhook freshness.** A `/webhooks/github` receiver reindexing on push would keep the
  index fresh before a read reconciles, removing the per-read `getRef` and the
  post-external-edit reindex spike. The manifest change means orgs re-approve.
- **sha-check TTL cache.** Cache the HEAD check per brain (~30-60s) to drop the per-read
  `getRef` in steady state. Our own direct writes already advance the index through
  write-through, so only outside edits would wait out the TTL.

Decided against: **FTS5.** Verified available in D1 and not used: a virtual table disables
`wrangler d1 export` for the whole database, and BM25 cannot meet the requirement that
ranking be reproducible from row data and pinned by a pure test. Ranking is `src/lib/search.ts`;
the reasoning is in [`design/search-relevance.md`](design/search-relevance.md).

# TODO: graph view follow-ups

`view_graph` is built. Not built: a local-graph depth filter (n hops around the focus), an
orphan de-emphasis toggle, and group-by-tag coloring.
