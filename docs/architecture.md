# Architecture: how a tool call travels

Follows one request end to end, naming the file at each step.

[`CLAUDE.md`](../CLAUDE.md) is the reference, organized by subsystem. Read this first, then the
section covering whatever you are changing.

## Three programs, one `src/`

| Program                  | Runtime            | Entry point        | For                                           |
| ------------------------ | ------------------ | ------------------ | --------------------------------------------- |
| **The MCP Worker**       | Cloudflare workerd | `src/worker.ts`    | The deployed product: many users, many brains |
| **The local runtime**    | Node               | `src/local.ts`     | One person, one brain on disk, no accounts    |
| **The bootstrap server** | Node               | `src/bootstrap.ts` | One-shot GitHub App registration              |

`src/lib/` is imported by the Worker, so it may not import `node:*`. `pnpm typecheck` runs three
tsconfigs to catch a leak. Node-only code goes in `src/local/`, `src/bootstrap.ts`, or a
Node-only sibling.

## The journey of a tool call

The user asks Claude to write a page, and Claude calls `write_page`.

**1. It arrives at `/mcp`.** In the Worker, `OAuthProvider` (from
`@cloudflare/workers-oauth-provider`) owns the request lifecycle: it serves the OAuth metadata
endpoints, implements `/token` and `/register`, and rejects anything under `/mcp` without a
valid access token. On success it forwards to `mcpApiHandler` with the grant's identity on
`ctx.props`. Non-POST gets a 405; the stateless transport offers no server-to-client stream. In
the local runtime this step is a Hono route with no auth, bound to loopback.

**2. A server is built, per request.** `McpSession.buildServer()` creates a fresh `McpServer` and
registers every tool. Per request rather than per connection because the transport is stateless
(`sessionIdGenerator: undefined`); an `McpServer` binds to one transport, so a reused one answers
the first call and fails the rest.

**3. The tool handler resolves a context.** Every tool calls `getContext()`, which is
`tenantContext()` in the Worker. Four questions:

- **Who is this?** From the token props: an Auth.js user id, or a GitHub user id.
- **Which brain?** An explicit `brain` argument (fuzzy-matched), else the connection's active
  brain (persisted per user in KV), else the default.
- **What may they do?** `role` is the caller's role on that brain, `orgRole` is their role in
  that brain's org. `effectiveBrainRole` in `src/lib/orgs.ts` is the authority on the first.
- **How do we reach storage?** A `BrainStore`, below.

A tool declares what it needs (`requires: 'editor'` for brain scope, `requiresOrg: 'admin'` for
org scope) and resolution throws if the caller falls short. The two roles are separate so that an
org action cannot be gated on a brain role.

**4. Reads hit the index, not GitHub.** `src/lib/brain-index.ts` keeps a derived index in D1.
Every read calls `ensureFresh` first, which compares the brain's current revision to the one the
index reflects and reindexes what changed. The index is a cache, never the source of truth, so an
edit made on github.com or by another agent is picked up on the next read.

**5. Writes go through one chokepoint.** `commitOrPR` in `src/lib/brain-repo.ts` lands a
multi-file bundle (the page, the changelog, every repointed link) as one atomic commit, or as a
pull request if the brain's branch is protected. `write_page`'s guarantee that an edit batch never
half-applies rests on that atomicity.

**6. The result may carry a widget.** Tools that open the in-client app attach
`_meta.ui.resourceUri`, and the app bundle is served as a `ui://` resource. The bundle is
generated: after editing `app/`, run `pnpm gen:app` or the deployed UI goes stale with no error.

## The storage seam

`BrainStore` (`src/lib/brain-repo.ts`) is the only interface between the tool layer and where a
brain physically lives. Two implementations:

- `githubStore(octokit)` for a GitHub repository.
- `fsBrainStore({ dir })` for a git repository on disk (`src/local/brain-store-fs.ts`).

That is what lets `pnpm try ~/notes` serve the real tools with no accounts, and the write-path
e2e batteries run in CI with no network.

If you reach for `ctx.octokit` while touching a brain's content, the operation belongs on the
store. The `octokit` on the context is optional and covers three things that are GitHub as a
platform rather than a brain as storage: create a repository, list an installation's
repositories, check a repo exists before connecting it.

## What the local runtime leaves out

No org model, so no members, invitations, sharing, connected accounts, or brain switching. With
one brain and one person those tools can only reject, and an advertised tool costs context in
every conversation. The Worker applies the same rule to single-tenant deployments via
`hasOrgModel`; `FEEDBACK_REPO` is the precedent.

## Where to look next

| Changing…                    | Read                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| A write tool                 | `src/tools/librarian.ts`, then run `pnpm test:e2e-librarian`                      |
| Markdown parsing or OKF      | `src/lib/wiki.ts`, `CLAUDE.md`'s Open Knowledge Format section                    |
| `okf-view` directives        | `src/lib/views.ts` + `view-directives.ts`, `pnpm test:views`                      |
| Search, backlinks, the graph | `src/lib/brain-index.ts`, `pnpm test:index`                                       |
| Who can do what              | `src/lib/orgs.ts`, `pnpm test:access` and `pnpm test:scope`                       |
| The viewer or editor         | `app/`, run `pnpm app:dev`; re-run `pnpm gen:app` before committing               |
| Where a brain lives          | `src/lib/brain-repo.ts` (the seam), `src/local/brain-store-fs.ts` (the other end) |
