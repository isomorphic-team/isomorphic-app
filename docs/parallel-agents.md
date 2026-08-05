# Running agents in parallel

Several agents can work this repository at once without colliding. This covers the seams that
make that possible, what each worker has to own, and what is still shared.

The architecture landed in [PR #10](https://github.com/isomorphic-team/isomorphic-app/pull/10)
([`docs/design/local-first-development.md`](design/local-first-development.md)), which framed it
as contributor onboarding plus moving the write-path end-to-end batteries into CI. Isolation is
the other thing it bought, and this document is the part that was missing.

## What it solved

Running the real MCP tools used to mean a real GitHub repository reached through a GitHub App,
and the write-path batteries created a scratch repo on one platform org. Every worker on the
machine shared one credential, one remote, and one Cloudflare account. Two agents running
`e2e-librarian` at the same time were two agents in the same org with the same token.

The tool layer now talks to an interface, so everything below it can be per-worker.

## The seams

| Seam                | Where                                                             | What a worker owns               |
| ------------------- | ----------------------------------------------------------------- | -------------------------------- |
| Storage             | `BrainStore`, `src/lib/brain-repo.ts`, ten operations             | Its own brain                    |
| Platform vs storage | `ctx.octokit` optional, `githubClient()` in `src/tools/brains.ts` | No GitHub account at all         |
| Runtime             | Three programs, three tsconfigs                                   | Node instead of workerd          |
| Index               | `node:sqlite` at `<brain>/.isomorphic/index.sqlite`               | Its own content index            |
| Capability          | `hasOrgModel`                                                     | A smaller, coherent tool surface |
| Atomicity           | `commitFiles` over a git repo                                     | Writes that cannot half-apply    |

Two of those carry rules.

**Storage.** `BrainStore` is the only interface between the tool layer and where a brain
physically lives. Two adapters: `githubStore(octokit)` and `fsBrainStore({ dir })` in
`src/local/brain-store-fs.ts`. The rule that keeps it that way: **if you reach for `ctx.octokit`
while touching a brain's content, the operation belongs on the store.** A raw `octokit.rest.*`
call in a content path compiles and then fails at runtime on the other backend. Three of the
seam's ten operations exist because they were exactly that (`branchCommitSha`,
`repoWritePolicy`, `listCommits`).

`octokit` is still on the context, and optional. It covers the three operations that are GitHub
as a platform rather than a brain as storage: create a repository, list an installation's
repositories, check a repository exists. All three sit behind `githubClient(ctx)` and are
org-model tools.

**Atomicity.** `commitFiles` lands a bundle whole or not at all, and `write_page`'s promise that
an edit batch is never half-applied rests on it. That is why a local brain is a git repository
and not a folder. Point `pnpm try` at a plain directory and it runs `git init` and commits what
was already there.

## What each worker owns

| Thing                                 | Why it is per worker                                             |
| ------------------------------------- | ---------------------------------------------------------------- |
| A worktree under `.claude/worktrees/` | Its own branch and working tree                                  |
| `node_modules`                        | gitignored; run `pnpm install` in the new worktree               |
| `wrangler.jsonc`                      | gitignored and generated; run `pnpm setup:config`                |
| `.dev.vars`                           | gitignored, so absent in a fresh worktree; `pnpm try` needs none |
| `.wrangler/`                          | gitignored, so local D1 and KV state is per checkout             |
| The brain                             | A folder or temp directory, never shared with another worker     |
| `<brain>/.isomorphic/index.sqlite`    | The content index travels with the brain                         |
| A port                                | See below                                                        |

## Ports

| Command             | Default | Override                                         |
| ------------------- | ------- | ------------------------------------------------ |
| `pnpm try <folder>` | 8788    | `PORT=… pnpm try <folder>`                       |
| `pnpm app:dev`      | 5175    | `PORT=… pnpm app:dev`                            |
| `pnpm worker:dev`   | 8787    | `pnpm worker:dev --port …`                       |
| `pnpm bootstrap`    | 3000    | none; `PORT` is a constant in `src/bootstrap.ts` |

Two workers on the default `pnpm try` port is the most common collision. Bootstrap is a one-shot
setup flow, so a second worker should not be running it at all.

## Spinning one up

```sh
# from the main checkout
git worktree add .claude/worktrees/<name> -b worktree-<name>
cd .claude/worktrees/<name>
pnpm install
pnpm setup:config
pnpm test                             # offline, no credentials
PORT=8790 pnpm try /tmp/brain-<name>  # its own brain, index, and port
```

Nothing in that sequence touches GitHub, Cloudflare, or another worker. In Claude Code, the
`EnterWorktree` tool creates the worktree in the same place; the `pnpm install` and
`pnpm setup:config` steps still apply, because both outputs are gitignored.

## What is still shared

- **The main checkout's branch.** A worker must not `git checkout` or `git switch` in the shared
  checkout. That is what the worktree is for.
- **Generated files.** `src/lib/app-bundle.generated.ts` and `src/lib/brain-template.generated.ts`
  are committed, so two workers editing `app/` or `brain-template/` will conflict on them.
  Resolve by re-running `pnpm gen:app` or `pnpm gen:templates` after the merge, not by editing
  the diff.
- **A GitHub-hosted brain.** Two workers sharing `GITHUB_TOKEN` and
  `BRAIN_REPO_OWNER`/`BRAIN_REPO_NAME` write the same branch ref. Give each its own local brain,
  or its own repository.
- **Remote Cloudflare state.** Never run `wrangler d1 migrations apply --remote` or
  `pnpm worker:deploy` from a worker. Schema ships from `deploy.yml` on merge to `main`.
- **The platform org, in `--github` mode.** `pnpm exec tsx scripts/e2e-librarian.ts --github` and
  its `e2e-import.ts` twin create a real `brain-*-e2e-<timestamp36>` repository and delete it
  afterwards. The timestamped names mean parallel runs do not collide, but the mode reads
  `.dev.vars` for platform App credentials and reaches a real org. Offline is the default and is
  what a parallel worker should run; use `--github` only when the GitHub adapter itself changed.

## Rules for an agent working here

1. Work in your own worktree. Do not switch branches in the shared checkout.
2. Run `pnpm install` and `pnpm setup:config` first in a fresh worktree. Both outputs are
   gitignored, so a new worktree has neither.
3. Use `pnpm try` with your own brain folder and your own `PORT`. Do not reuse another worker's
   brain directory; the sqlite index lives inside it.
4. Run `pnpm test` offline. Do not pass `--github` unless you changed the GitHub adapter in
   `src/lib/brain-repo.ts`.
5. Never deploy, and never apply a migration with `--remote`.
6. Re-run `pnpm gen:app` after touching `app/` or anything under `src/lib/` it imports, and
   `pnpm gen:templates` after touching `brain-template/`. After a rebase that conflicts on a
   `.generated.ts`, regenerate instead of merging.
7. If you need a brain's content and reach for `ctx.octokit`, stop. The operation belongs on
   `BrainStore`, or it will fail on the fs backend.

## Non-goals

**Not sandboxing.** A worker is isolated from other workers, not from the machine.

**Not concurrency control inside one brain.** Two writers on the same brain still race at the
branch ref. `commitOrPR` and the optimistic `sha` guard in `edit_page` are what exist there, and
they are a different mechanism from anything above.

**Not a second deploy target.** Cloudflare remains the only supported production runtime; the
local runtime is a development and evaluation surface.
