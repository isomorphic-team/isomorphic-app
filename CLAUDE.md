# CLAUDE.md

**Authoritative external references** (MCP Apps / SEP-1865, the MCP SDK and the 2026-07-28
protocol, Claude host design guidelines, ProseMirror, Cloudflare limits) live in
[`docs/references.md`](docs/references.md). Read it, and the primary source, before answering
from memory about any of that tech; it moves fast.

**This repository is public and open source** (GNU AGPL-3.0-only; contributors sign a CLA).
Nothing written here carries customer names, real account or resource identifiers, or "our
deployment" assumptions; see [Public-repo hygiene](#public-repo-hygiene) and
[`docs/design/open-source-boundary.md`](docs/design/open-source-boundary.md).

This file holds what every session needs. Subsystem detail lives in
[`.claude/rules/`](.claude/rules/) and loads when you touch matching files; repeatable
procedures are skills in [`.claude/skills/`](.claude/skills/); rules that must always hold are
hooks. See [Agent tooling](#agent-tooling).

## Commands

```sh
pnpm install
pnpm try <folder>       # START HERE: MCP over a git repo on disk, no accounts (127.0.0.1:8788)
pnpm doctor             # what this checkout has, what it is missing, what to run next
pnpm web:dev            # seed the demo brains and serve the app as a web page (--reset re-seeds)
pnpm app:dev            # the MCP App UI over the AppBridge harness, http://localhost:5175
pnpm setup:config       # generate wrangler.jsonc (needed before worker:dev, worker:types, db:*)
pnpm worker:dev         # `wrangler dev` for the MCP Worker, http://localhost:8787
pnpm bootstrap          # register the GitHub App and scaffold a brain (http://localhost:3000)
pnpm gen:app            # codegen the ui:// app bundle (after editing app/ OR any src/lib/ file it imports)
pnpm gen:templates      # codegen brain-template/ into src/lib/brain-template.generated.ts
pnpm db:migrate         # apply D1 migrations LOCALLY (also db:migrate:list, db:migrate:new <name>)
pnpm typecheck          # all four tsconfigs (node, worker, app, tests)
pnpm test               # every offline battery (the same list ci.yml runs)
pnpm test:ui            # the MCP App UI in a real browser (Playwright + Chromium)
pnpm format             # prettier
```

`package.json` has the rest (`worker:deploy`, `worker:types`, `onboard-org`, `probe:report`,
`consolidate:report`, `regen:pr`, `ui:baselines`, `security:audit`). Each `test:*` battery's header says what it pins.

## Testing policy

**TESTS ARE EXPECTED FOR EVERY FEATURE AND EVERY FIX, in the same change.** Not deferred, not
"typecheck covers it", not a manual check narrated in the summary. Shipping without one is a
decision to argue for explicitly.

- **A green suite proves nothing unless it touches the changed code.** Before reporting a
  change as tested, break it deliberately and confirm the test goes red. Say which battery
  covers a change, and say plainly when none does.
- **Test the thing that DECIDES.** If the deciding logic sits where no test can call it (a
  private method on `McpSession`, a branch inside a handler), move the logic. That is why so
  much of `src/lib/` is pure (`effectiveBrainRole`, `chooseOrg`, `planPageWrite`,
  `resolveOrgForPerson`). Pattern: pure or db-only function in `lib/`, thin wiring in the Worker.
- **Every battery is offline and fork-safe**, and is listed in BOTH `package.json`'s `test`
  script and `.github/workflows/ci.yml` (`pnpm test:wiring` fails otherwise). The browser
  battery, the e2e batteries and baselines: `.claude/rules/testing.md`.

## Runtime architecture (three programs, one `src/`)

Walkthrough: [`docs/architecture.md`](docs/architecture.md).

1. **Bootstrap server** (`src/bootstrap.ts`): Node, Hono, via `tsx`. Registers a GitHub App via
   the manifest flow and scaffolds a brain repo in one atomic Git Data API commit.
2. **MCP Worker** (`src/worker.ts`): a Cloudflare Worker serving MCP over **stateless**
   Streamable HTTP. Each request builds a fresh `McpServer` behind the OAuth provider and
   answers the same POST with JSON (no SSE, no session), in either protocol era via `serveMcp`
   (`src/lib/mcp-serve.ts`). The per-request `McpSession` holds brain resolution and all tool
   registration (`buildServer()`). The Worker also serves the web app (`/b/...`), `/health`,
   the OAuth and Auth.js routes, and the GitHub install callback. There is no Durable Object.
3. **Local runtime** (`src/local.ts`): Node, `pnpm try <folder>`. The same content tools over a
   **git repository on disk** through the fs `BrainStore` (`src/local/brain-store-fs.ts`), D1
   shimmed over `node:sqlite` (`src/local/d1-sqlite.ts`). Loopback only, no auth, no members,
   sharing or brain switching. Writes are local commits, never pushed.

**Anything imported by `worker.ts` runs on Workers and cannot use `node:*`.** The tsconfigs
enforce it: `tsconfig.node.json` (bootstrap, `src/local*`, `scripts/`, `lib/`),
`tsconfig.worker.json` (`worker.ts` + `lib/`), `tsconfig.app.json` (`app/`),
`tsconfig.tests.json` (`tests/` + `playwright.config.ts`). Node-only code goes in `src/local/`,
`bootstrap.ts`, or a Node-only sibling, never in `lib/`.

**Two auth modes, one org model.** `AUTH_MODE=static` (one shared bearer) is the self-hosting
entry point; `oauth` (Auth.js email sign-in) is what the hosted deployment runs. The only mode
difference a tool sees is `multiUser`, which gates the member, sharing and multi-brain tools.
GitHub App tokens and PKCS#8: `.claude/rules/github-app-auth.md`. Orgs, roles and static mode:
`.claude/rules/org-model-and-permissions.md`. Deployment config and deploys:
`.claude/rules/deploy-and-config.md`.

## Brain model

**A brain is an ordinary git repo with arbitrary folder structure.** There are NO fixed entity
types and no generated by-type index. **Don't reintroduce a taxonomy speculatively.** Brains
target the Open Knowledge Format (one concept per page, `type:` frontmatter, `index.md` folder
notes); see the OKF rules file.

- **Tools are path-based** (36 today). `write_page` creates or updates anything under the
  content roots; `move_page` and `delete_page` take a page, a folder, or a non-page file.
  `validate` reports defects and findings; `resolve` answers findings.
- **`BrainStore` (`src/lib/brain-repo.ts`) is the only seam between tools and storage.**
  Content reads and writes never call octokit. Only `wiki/log.md` is tool-maintained.
- **The content index in D1 is a derived cache, never the source of truth**; every read checks
  the branch head first.
- **Brain templates:** `brain-template/` is codegen'd into `src/lib/brain-template.generated.ts`
  (Workers have no filesystem). `src/lib/scaffold-core.ts` scaffolds for bootstrap and
  `create_brain`. Agent-facing schema doc: `brain-template/AGENTS.md`.
- **Tool descriptions:** each stands alone and names itself; cross-tool steering lives in
  `SERVER_INSTRUCTIONS` (`src/lib/server-instructions.ts`). Adding a tool: the `add-tool` skill.

## State of the repo

Not built: webhooks, Google/SSO sign-in, a second storage backend, invitation emails.
[`docs/roadmap.md`](docs/roadmap.md) is the public plan: when the user references a roadmap
item, check the code before assuming it exists or does not.

## Public-repo hygiene

- **No customer, client, or personal names, anywhere.** Code, comments, tests, fixtures, error
  and tool strings, docs, commit messages, pull request titles and descriptions, branch names.
  A comment that retells a real incident is the usual way one gets in: use a neutral name
  (`Acme`, `Northwind`, `example-org`), even when quoting what happened.
- **No real account or resource identifiers.** Cloudflare ids, installation ids, org logins, the
  Worker name and our hostname come from generated config or env vars. `src/db/seed-*.sql` are
  `<PLACEHOLDER>` templates. `/ops/` is gitignored for anything naming real infrastructure.
- **Nothing hosted-only.** The hosted service is a deployment of `main`: no private module, no
  paid-tier flag, no `if (isHosted)`. A deployment-specific need goes in as configuration.
- **No telemetry.** Nothing may report anything to us or to anyone but the operator. The
  Analytics tab counts into the deployment's own D1 and never leaves it.

## Keeping the docs true

This file, the rules and skills, the docs and the comments are read as current fact by every
agent that opens this repo. When they drift, an agent acts on the drift with confidence.

- **A change that makes a sentence false fixes it in the same pull request**, wherever it lives.
  On every pull request CI lists the rules files whose `paths:` cover the files changed
  (`scripts/rules-for-change.ts`); reread those before merging.
- **Write the fact, not the story.** A comment or doc states what the code does now, plus at
  most one line on why the obvious alternative is not used. How it got that way goes in the
  commit message and the pull request description. Decision records live in `docs/design/`.
- **`pnpm test:docs` checks what a machine can** (`scripts/test-docs.ts`): paths, links,
  backticked symbols, tool names, quoted constants, rules globs, design-doc `Status:` lines. It
  cannot see a sentence that became false while every name in it still exists.
- **This file stays under 200 lines** (`pnpm test:docs`). Detail for some files goes in a rules
  file with `paths:` from the current layout, a procedure in a skill, a rule that must hold in
  a hook.

## Agent tooling

- **Hooks** (`.claude/settings.json`, logic in `scripts/agent-hooks.ts`, pinned by
  `pnpm test:hooks`). A PreToolUse hook refuses edits to `wrangler.jsonc`, to `*.generated.ts`
  and to committed migrations, and refuses remote D1 writes and force-adding `.dev.vars` or
  `wrangler.jsonc`. The Stop hook reruns `gen:app` / `gen:templates` when their sources changed
  and hands the turn back if that changed a file. Reading `.dev.vars` is denied.
- **Skills** (`.claude/skills/`): `add-tool`, `add-battery`, `new-migration`, and the
  user-invoked `regen-pr` and `ui-baselines`. `pnpm test:docs` checks them like the rules.

| Rules file                             | Covers                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `org-model-and-permissions.md`         | identity, orgs, roles, `effectiveBrainRole`, sharing, guests, storage connections, static mode |
| `github-app-auth.md`                   | App JWT and installation tokens, manifest permissions, PKCS#8                                  |
| `deploy-and-config.md`                 | `wrangler.jsonc` generation, versioned deploys and rollback, Dependabot, CodeQL                |
| `testing.md`                           | `test:ui`, visual baselines, the e2e batteries                                                 |
| `web-app.md`                           | `/b/` web host, cookie `/mcp` + CSRF gate, `WEB_TOOL_ROUTING`                                  |
| `app-widget.md`                        | the `ui://` bundle, `tool-payloads.ts`, `pickShownBrain`, `features`                           |
| `mcp-request-path-and-tool-surface.md` | `serveMcp`, the preamble, registration and gating, tool-description rules                      |
| `content-index-and-store.md`           | `BrainStore`, the D1 index, freshness, wikilinks, budgets                                      |
| `search.md`                            | ranking, proximity, FTS5 decision, probes, cross-brain search                                  |
| `write-path.md`                        | `page-write`, patches, `fields`, `write-target`, `change-record`, the retry ledger             |
| `okf-folder-notes-and-findings.md`     | OKF, folder notes, `validate` / `resolve`, findings, consolidation                             |
| `derived-views.md`                     | `okf-view` grammar and the three renderings                                                    |
| `markdown-renderer.md`                 | `render.ts` sanitization and hooks                                                             |
| `media.md`                             | attachments, URL fetch guards, `read_media`                                                    |
| `brain-authored-tools.md`              | `tools/` pages as MCP tools                                                                    |
| `bulk-import.md`                       | `sync_records` invariants and import decisions                                                 |
| `usage-analytics.md`                   | the Analytics tab, `TOOL_KINDS`, recording                                                     |
| `feedback.md`                          | `submit_feedback` privacy and credential rules                                                 |
| `loading-states.md`                    | the rotating loading line and its tests                                                        |

## Rules that apply everywhere

Each is stated in full in its rules file; these hold even when that file has not loaded.

- **Never add a Durable Object binding** (it silently loses preview URLs and the pre-promotion
  smoke) or a `routes` block to the wrangler template.
- **Never widen the platform App's permissions** in `src/manifest.ts`.
- **Don't enable CodeQL default setup** in repository settings.
- **Don't re-add `update_brain`, a `manage_*` tool, or `set_fields`**, and don't grow the tool
  surface for a variant. Keep `read_page` and `view_page` separate.
- **Every new tool needs a `TOOL_KINDS` entry** and, if a widget tool, a `WEB_TOOL_ROUTING`
  decision.
- **Never re-express `effectiveBrainRole` in SQL.** Place brains with `listAccessibleOrgs`,
  never `listAccessibleBrains`. Only `switch_brain`, `create_brain` and `disconnect_brain` move
  the active-brain pointer.
- **Any whole-brain index pass is budgeted and resumable.**
- **Don't adopt FTS5** without reading its entry in `docs/references.md`. Any change to
  `src/lib/render.ts`'s policy constants is a security change. Changelog, commit and reply
  wording comes from `src/lib/change-record.ts`; path rules from `src/lib/write-target.ts`.
- **OKF is a contract with every brain repo.** A format change must keep working for existing
  brains.
- **`submit_feedback` publishes nothing identifying**; `composeIssue` takes no identity.
