# Design: local-first development

Status: **proposed**. A plan to make a first contribution cheap, and to move the write-path
end-to-end batteries into CI as a side effect.

## The problem

A contributor who wants to change the app UI is productive in five minutes. A contributor who
wants to change anything else is not.

Everything past the UI needs a running MCP server, and a running MCP server needs a brain, and a
brain is a GitHub repository reached through a GitHub App. So the on-ramp to the majority of the
codebase is: create a GitHub **organization** you may not want, run a second server
(`pnpm bootstrap`) to do a manifest exchange, install the App, hand-fill five keys in
`.dev.vars`, apply migrations, and work out how to send a bearer header from your MCP client.
None of that is Isomorphic. All of it is GitHub App ceremony inherited from the multi-tenant
deployment, which is not what a first-time contributor is running.

The second cost is the one that actually matters, and it is not about onboarding at all:

**The riskiest code in the repository is the only code with no automated gate.** `pnpm test`
covers a row of pure golden batteries, offline and fork-safe, and `ci.yml` is deliberately built so
a fork PR gets the same green-or-red signal a maintainer does. But the write path (`write_page`
edits, `move_page` link repointing across a folder, `delete_page` on a subtree, the importer's
ledger) is exercised only by `scripts/e2e-librarian.ts` and `scripts/e2e-import.ts`, which need
real GitHub App credentials and therefore cannot run in CI. `CONTRIBUTING.md` tells contributors
they are not expected to run them and a maintainer will. That is a maintainer bottleneck sitting
in front of exactly the changes most likely to lose someone's data.

Both problems have the same root: **GitHub is not swappable**, so there is no way to run the real
tools without a real repository.

## What a contributor can reach today

| Surface                   | Command           | Accounts needed  | What it exercises                       |
| ------------------------- | ----------------- | ---------------- | --------------------------------------- |
| App UI (viewer, editor)   | `pnpm app:dev`    | none             | The UI, over stub fixtures              |
| Pure engines (OKF, views) | `pnpm test`       | none             | Parsing, rendering, planning, authz     |
| The real MCP tool path    | `pnpm worker:dev` | GitHub org + App | Everything, against a real repo         |
| Write path end to end     | `scripts/e2e-*`   | GitHub org + App | The write tools, against a scratch repo |

The gap is the bottom two rows. This plan closes it.

## The goal

```sh
git clone … && cd isomorphic-app && pnpm install
pnpm try ~/Documents/notes
```

A real MCP server on localhost, serving the real tools against a folder of markdown, with a real
content index, and no accounts of any kind. And, from the same machinery, `e2e-librarian` running
in CI on every pull request.

---

## Workstream 0: papercuts

Half a day, no design decisions, each independently mergeable. Good first issues.

- **Pin Node.** There is no `engines` field and no `.nvmrc`. The floor is real: `node:sqlite` is
  Node 22+, and CI runs 24. Someone on 20 gets a confusing failure instead of a clear one.
- **Stop counting tests in prose.** Three documents state the number of golden tests and they
  disagree, because each was written when its number was right: `CONTRIBUTING.md` said eight and
  listed eight of the eleven that exist, `docs/self-hosting.md` and `ci.yml`'s comment each name a
  different figure, and every new battery makes one more of them wrong. Drop the numeral rather
  than correcting it, and keep the enumerated list, which is the part a contributor actually uses.
- **Guard the two-places rule automatically.** `CONTRIBUTING.md` and `CLAUDE.md` both warn that a
  new test must be added to `package.json`'s `test` script _and_ to `ci.yml`, "or it runs in
  exactly one place and nobody notices which". That is a lint, not a warning: assert every
  `test:*` script name appears in `.github/workflows/ci.yml`, and fail CI if not.
- **`pnpm doctor`.** Check the Node version, whether `wrangler.jsonc` exists, which mode
  `.dev.vars` is configured for and what it is missing, then print the next command to run.
  Every support question in a young project's issue tracker is a diagnostic the repo could have
  printed itself.

## Workstream 1: bring your own token

Two days. Removes the GitHub org, the App, and `pnpm bootstrap` from the contributor's critical
path, without touching the tool layer.

Today a repo-scoped Octokit is minted in exactly six places, all `installationOctokit(...)` in
`src/worker.ts`. Add one branch: when `GITHUB_TOKEN` is set, build `new Octokit({ auth })` and
take the brain from `BRAIN_REPO_OWNER`/`BRAIN_REPO_NAME`. Every call `src/lib/brain-repo.ts`
makes (the git data API, `repos.getContent`, the batched GraphQL blob reads, `pulls.*`) is
available to a fine-grained PAT with Contents and Pull requests write.

What it removes from the quickstart: the organization requirement (a token creates repos under
your own account, so `administration: write` and its org-only restriction stop applying), the
manifest flow, the bootstrap server, the PKCS#1 to PKCS#8 conversion, and installation ids.
Five `.dev.vars` keys become two. Commits are attributed to the human rather than to an App,
which for a single user is an improvement.

What it does not do: the App-shaped features have no meaning under a token, so
`connect_github_org`, org provisioning, and the per-tenant installation path do not register.
The precedent is already in the codebase: `FEEDBACK_REPO` unset means `submit_feedback` is never
registered, rather than registered and only able to apologize. Follow that rule exactly.

This workstream is independently valuable. If nothing below ever ships, it still takes a real
brain from thirty minutes to about five.

**Settle the status of `AUTH_MODE=static` first**, because token mode sits beside it and the two
existing statements disagree. `CLAUDE.md` says static "is no longer the default and is not an
access-control model, but it is now the documented **self-hosting** entry point … so it is
supported rather than legacy". `docs/roadmap.md`, under "productionize the MCP server", still
lists phase 3 as "drop the `AUTH_MODE=static` branch and the legacy `MCP_BEARER_TOKEN`". Both
cannot hold. `CLAUDE.md` is the current one and the roadmap line is stale, but a contributor
reading the roadmap would reasonably build toward deletion. Fix the roadmap line before token
mode lands on top of the ambiguity.

## Workstream 2: the `BrainStore` seam

Two to three days. A pure refactor, no behavior change, no new capability.

`src/lib/brain-repo.ts` is already the chokepoint: seventeen of the repository's thirty-six
`octokit.` call sites are in that one file, and the whole read/write contract is seven functions.

| Function           | What it means, runtime-independently            |
| ------------------ | ----------------------------------------------- |
| `getHead`          | current revision of the brain                   |
| `listTree`         | every page path plus a content hash             |
| `fetchPages`       | read many pages by hash                         |
| `readFile`         | read one path at head                           |
| `findOpenConfigPr` | is there a change awaiting review               |
| `commitFiles`      | write a bundle atomically                       |
| `commitOrPR`       | the same, or as a proposal on a protected brain |

Extract those into a `BrainStore` interface, make the current implementation the `GitHubStore`
adapter, and carry the store on `TenantContext` in place of the raw `octokit`. Only fourteen
sites across `src/tools/` and `src/lib/` read `ctx.octokit`, so the blast radius is small.

Two rules for this refactor, both learned from the existing code:

- **Do not generalize past those seven functions.** `CONTRIBUTING.md` lists speculative
  abstraction under "unlikely merged" and it applies here too. This is not a storage layer; it is
  the exact set of operations the tools already perform.
- **`scaffold-core.ts` stays GitHub-shaped for now.** Creating a brain is a different act from
  reading and writing one, and a local brain is a folder that already exists.

Verification is free: `e2e-librarian` drives the write tools against real GitHub through this
interface, so if it still passes, the refactor is clean.

## Workstream 3: the local runtime

About a week. This is the one with an ongoing cost, and it should not start until Workstream 2
has landed and settled.

The Worker cannot do this: workerd has no filesystem. Bootstrap has one but is a one-shot setup
script. So local mode is a third entry point, `src/local.ts`, run with `tsx`, joining
`tsconfig.node.json`'s include list. It is not a port. It supplies four Worker-shaped things,
three of which already exist as test scaffolding:

| Worker thing      | Local substitute                        | Status                                         |
| ----------------- | --------------------------------------- | ---------------------------------------------- |
| `env.PLATFORM_DB` | `node:sqlite` shimmed to the D1 surface | Written: `scripts/e2e-librarian.ts`, ~20 lines |
| `env.OAUTH_KV`    | a `Map`, or one JSON file               | Trivial: it stores the active-brain pointer    |
| `ctx.waitUntil`   | `(p) => { p.catch(() => {}) }`          | Trivial                                        |
| OAuth `props`     | one hardcoded local user                | Trivial                                        |
| `octokit`         | **the fs + git `BrainStore` adapter**   | The only genuinely new code                    |

The transport needs no substitute at all: `WebStandardStreamableHTTPServerTransport` speaks
web-standard `Request`/`Response`, which Node has had since 18, and `@hono/node-server` is already
a dependency.

**A local brain is a git repository on disk, not a bare folder.** `commitFiles` guarantees that a
multi-file bundle lands atomically, and `write_page`'s "an edit batch is never half-applied"
promise leans on that. Plain filesystem writes lose it. Shelling out to `git commit` keeps the
invariant, keeps `view_activity` meaningful, and keeps the product's central claim ("your
knowledge is a git repo you own") literally true rather than true-with-an-asterisk. `ok init`-style
behavior on a folder that is not yet a repo: run `git init`, and say so.

Two structural jobs come with it:

- `buildServer()` is a private method on `McpSession`, which is typed to the Worker `Env`. Either
  export the class and construct it with a structurally-compatible env (which is what the test
  scripts already do to D1), or lift `buildServer` and `tenantContext` into a runtime-neutral
  module. The second is more work and the honest one.
- **Decide what does not exist locally, explicitly.** `members`, `invite_member`, `share_brain`,
  `brain_access`, and `connect_github_org` are multi-tenant surfaces with a single local user.
  They must not register, per the `FEEDBACK_REPO` rule. `commitOrPR` in `pull-request` mode needs
  a defined local answer rather than an accidental one.

## Workstream 4: the payoff, end-to-end tests in CI

Once the fs adapter exists, `e2e-librarian` and `e2e-import` can run against it with no network
and no credentials, which means they can move into `ci.yml` without breaking its fork-safe rule.
The write path stops being maintainer-gated.

This is the strongest argument for Workstreams 2 and 3, and it is worth stating in the pull
request that lands them, because "it also helps onboarding" undersells it. A contributor who
changes `move_page`'s link repointing today cannot prove their change is correct. After this,
CI proves it for them.

Keep the real-GitHub batteries as well, run by maintainers. The fs adapter proves the tool logic;
only real GitHub proves the GitHub adapter.

## Workstream 5: legibility

Cheap, and it compounds with everything above.

- **A request-lifecycle document.** `CLAUDE.md` is the architecture reference and it is excellent
  at invariants and why-it-is-this-way, but it is organized by subsystem and written for agents
  that can hold all of it at once. A newcomer wants one narrative: a tool call arrives at
  `/mcp`, the OAuth provider authenticates it, `McpSession` resolves org then brain then role,
  `ensureFresh` reconciles the content index, the handler runs, the write lands as one commit.
  Two pages with file references, linking into `CLAUDE.md` for the depth.
- **Rewrite `CONTRIBUTING.md`'s opening around `pnpm try`.** Its table is good and its three
  rules are the right three. What changes is that the "needs a GitHub org you control" row
  disappears from the common path.
- **Seed good first issues.** `docs/roadmap.md` already says several items are good first
  contributions, particularly the app UI ones near the top, but nothing is labelled. Label ten,
  including every item in Workstream 0.

---

## Sequencing

Workstream 0 any time, by anyone. Then Workstream 1, which delivers most of the onboarding win on
its own and is reversible. Then Workstream 2, which is a refactor that stands alone and is proven
by an existing battery. Then 3 and 4 together, since a local runtime with no CI story will rot.
Workstream 5 alongside, as each lands.

Do not start 3 before 2 is merged and has survived a release. The temptation will be to write the
fs adapter first because it is the interesting part.

## Non-goals

- **Not a second deploy target.** Cloudflare stays the only supported production runtime. Local
  mode is a development and evaluation surface.
- **Not a divergent format.** A local brain is the same OKF in the same git repository. If the
  two backends can disagree about what a brain is, this was built wrong.
- **Not a hosted-only or a local-only feature.** Per
  [`open-source-boundary.md`](./open-source-boundary.md), everything here ships to everyone.
- **Not a plugin system.** `BrainStore` has two implementations and no registry.

## Risks

- **A third supported configuration rots without CI.** Workstream 4 is the mitigation and is not
  optional.
- **The atomicity gap.** If the fs adapter ever writes files directly instead of committing, the
  local backend silently weakens a guarantee the tools advertise. Test it: a bundle write that
  fails partway must leave the repo unchanged.
- **Token mode quietly becoming a second auth model.** It is a development and single-user
  affordance. If it starts accumulating roles, that is the signal to stop.
