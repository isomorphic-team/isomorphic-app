# Contributing to Isomorphic

Contributions are welcome. This file should be enough to get a change merged without asking us
anything first.

Two things before you start:

1. The project is **open source under [AGPL-3.0-only](LICENSE)**, an OSI-approved license.
   [`docs/licensing.md`](docs/licensing.md) covers what that asks of you if you self-host a
   modified copy, and what it does not reach.
2. Contributors sign a [CLA](CLA.md). It is one bot comment on your first pull request and it
   does not take your copyright. It exists so we can also license Isomorphic commercially to
   organizations that cannot ship copyleft, and in exchange it binds us to keep your
   contribution under an OSI-approved license permanently. Reasoning, including the asymmetry
   it creates, is in
   [the licensing doc](docs/licensing.md#the-cla-and-what-commercialize-later-means).

Typo and documentation fixes need no CLA. Everything else does.

## Get it running in about five minutes

You need Node 24+ (there is an `.nvmrc`) and `pnpm`. You do **not** need a GitHub account, a
Cloudflare account, a GitHub App, or an email provider to work on most of the codebase.

```sh
git clone https://github.com/isomorphic-team/isomorphic-app
cd isomorphic-app
pnpm install
pnpm setup:config       # writes wrangler.jsonc for local-only development
pnpm test               # the golden tests, no network, should be green
pnpm doctor             # what your checkout has, and what to run next
```

That is the whole loop for the parts of the project most changes touch. From there:

| You want to work on                          | Run                | What you get                                                                         |
| -------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| The real MCP tools, end to end               | `pnpm try ~/notes` | `http://127.0.0.1:8788/mcp`, serving a folder of markdown. No accounts.              |
| The in-client app UI (viewer, editor, graph) | `pnpm app:dev`     | `http://localhost:5175`, real `ui://` bytes over stub fixtures, live reload, no auth |
| Markdown / OKF / view engine logic           | `pnpm test`        | Pure golden tests, instant, no network                                               |
| The Worker, auth, orgs, multi-tenancy        | `pnpm worker:dev`  | `http://localhost:8787/mcp`, needs a GitHub token (below)                            |
| The one-time GitHub App setup flow           | `pnpm bootstrap`   | `http://localhost:3000`, needs a GitHub org you control                              |

**Start with `pnpm try <folder>`.** It runs the real MCP server, the real librarian tools, and
the real content index against a git repository on disk, with no GitHub account, no Cloudflare
account, and no tokens. Point it at a folder of markdown (an Obsidian vault works) and connect
a local MCP host:

```sh
pnpm try ~/Documents/notes
claude mcp add --transport http isomorphic-local http://127.0.0.1:8788/mcp
```

If the folder is not a git repo it becomes one, and what is already in it is committed. Writes
land as commits. [`docs/architecture.md`](docs/architecture.md) covers what it leaves out.

To run the Worker against a **GitHub-hosted** brain, you need one credential and not the whole
GitHub App: a fine-grained personal access token scoped to a single repo, with Contents and
Pull requests write. Put it in `.dev.vars` as `GITHUB_TOKEN`, name the repo with
`BRAIN_REPO_OWNER` and `BRAIN_REPO_NAME`, set `MCP_BEARER_TOKEN` to anything random, then
`pnpm db:migrate && pnpm worker:dev`. `pnpm bootstrap` and a GitHub organization are only
needed for a multi-user deployment. Full detail in
[`docs/self-hosting.md`](docs/self-hosting.md).

## Read this before your first non-trivial change

[`CLAUDE.md`](CLAUDE.md) and the path-scoped files in [`.claude/rules/`](.claude/rules/) are
the architecture documents. Maintainers keep them current because coding agents read them.
`CLAUDE.md` covers the runtime split and the invariants that hold everywhere; each rules file
covers one subsystem (the content index, derived views, OKF conformance, folder notes, and so
on) and says _why_ the design is what it is. Read the one covering your area before you change
it. The most common failure is a change that is locally correct and violates an invariant
documented there.

[`docs/references.md`](docs/references.md) lists the authoritative external sources (the MCP
Apps spec, the MCP SDK, Claude host design guidelines, ProseMirror, Cloudflare limits) plus
verified facts about them. Read the primary source rather than trusting memory or an LLM; that
surface moves fast.

## The three rules that will bite you

Each of these has broken a deploy.

**1. `src/lib/` runs on Cloudflare Workers. No `node:*` imports.** The repo ships three programs
from one `src/`: a Workers MCP server, a Node local runtime, and a Node bootstrap server.
`src/lib/` is imported by all three, and the Worker is the constraint. `pnpm typecheck` runs
four tsconfigs (node, worker, app, tests) to catch a leak, so run it before you push. Node-only code belongs in
`src/local/`, `src/bootstrap.ts`, or a Node-only sibling.

**2. Generated files are committed and CI checks they are fresh.** After editing anything in
`app/` or anything under `src/lib/` that the app imports, run `pnpm gen:app`. After editing
anything under `brain-template/`, run `pnpm gen:templates`. Commit the regenerated
`src/lib/*.generated.ts`. If you forget, CI fails with a diff; if CI were skipped the deployed
bundle would go stale with no error at all.

**3. The Open Knowledge Format is a contract.** OKF is the markdown format every brain repo is
written in. A change to how pages are parsed or written has to keep working for every existing
brain, including ones edited entirely outside this codebase (on github.com, by another agent, by
an ETL). Changing the writer without checking the readers is the recurring failure.
`pnpm test:structure` and `pnpm test:roundtrip` exist to catch it; add cases to them rather than
only testing your new path.

## Tests

**Every feature and every fix ships with tests, in the same pull request.** Not a follow-up
issue, not "covered by typecheck", not a manual check described in the PR body. If a change
has no test, the reason belongs in the pull request and it should be a reason, not an
apology. Expect a review comment otherwise.

Two things this means in practice, both learned the hard way:

- **A green suite proves nothing unless it touches the changed code.** Before claiming a
  change is tested, break it on purpose and watch the test fail. A test that passes against
  the old behavior and the new one is testing neither.
- **Cover the thing that decides, not the thing that is easy to reach.** Where the logic
  lives is a choice: if a rule is buried somewhere no test can call (a private method on the
  Worker, say), move the rule rather than skipping the test. Most of the pure functions in
  `src/lib/` are there for exactly that reason.

The batteries are golden tests: no network, all fast, one `test:*` script each in
`package.json`, each running a `scripts/test-*.ts` file whose header says what it covers.
`pnpm test` runs every one of them. Run the one for your area while you work and the whole
suite before you push.

```sh
pnpm test               # every battery, offline
pnpm test:structure     # one battery, e.g. OKF conformance
pnpm typecheck          # all four tsconfigs (node, worker, app, tests)
pnpm format             # prettier, run before pushing
```

`pnpm test:ui` is the one battery that needs a browser (Playwright and Chromium); it skips,
loudly, when Chromium is absent. [`dev/README.md`](dev/README.md) covers it.

Adding a test means adding it in **both** `package.json`'s `test` script and
`.github/workflows/ci.yml`, or it runs in exactly one place. `pnpm test:wiring` enforces that.
Either CI job counts: it reads the whole workflow file.

Golden tests compare against expected strings inline in the test file. When you change behavior
deliberately, update the expectation in the same commit and say in the pull request why the old
expectation was wrong. Expect a review comment on a golden updated without one.

Two of those batteries are **end to end**: they drive the real MCP tool handlers, through a
real content index on SQLite, against a real brain.

```sh
pnpm test:e2e-librarian    # the librarian write tools
pnpm test:e2e-import       # the bulk importer
```

They run offline against a git repo in a temp directory, so they are part of `pnpm test` and
gate your pull request like everything else. If you change a write tool, these are the tests
that catch you.

The same two also run against **real GitHub**, the only coverage of the GitHub half of the
storage layer. That mode needs platform GitHub App credentials in `.dev.vars`, so it is a
maintainer step rather than a merge requirement:

```sh
pnpm exec tsx scripts/e2e-librarian.ts --github
```

It creates a disposable `brain-*-e2e-*` scratch repo, auto-deletes it, and never touches a real
brain. The assertions are identical in both modes.

## This repository is public

**No customer, client, or personal names, and no real deployment details, anywhere.** That
means code, comments, tests, fixtures, error strings, docs, commit messages, pull request titles
and descriptions, and branch names. Deployment details are hostnames, Worker names, App slugs,
account logins, installation and resource ids, version ids, and the names of real brains or
repositories. When a comment or a test needs a realistic example, including a retelling of a
real incident, use a neutral name: `Acme`, `Northwind`, `example-org`. Real infrastructure
belongs in generated config, environment variables, or the gitignored `/ops/` folder.

## Making a change

1. **Open an issue first for anything with a design decision in it.** Bug fixes, test additions,
   and documentation do not need one. A new MCP tool, a change to OKF, a change to the index
   schema, or anything that adds a dependency does. Ten minutes on the shape beats rejecting a
   finished branch.
2. **Branch from `main`.** Naming is not policed; `fix/…` and `feat/…` are common.
3. **Keep the change one thing.** A pull request that fixes a bug and also reformats a file is
   two pull requests.
4. **Match the surrounding code.** Comment density, naming, and idiom vary by file, and the
   local convention wins over any global preference. The codebase comments _why_, not _what_.
   Write the current fact, not the story: a comment or doc says what the code does now, plus
   at most a line on why the obvious alternative is not used. How it got that way (the first
   version, the incident, the issue number) goes in the commit message and the pull request.
5. **Fix the sentences your change makes false, in the same pull request.** That includes
   `CLAUDE.md`, the `.claude/rules/` files (CI lists the ones that describe the files you
   touched), the docs, and comments. `pnpm test:docs` fails on paths, symbols, tools and
   constants the prose names that no longer exist.
6. **Run `pnpm typecheck && pnpm test && pnpm format`** before pushing.
7. **Open the pull request.** Fill in the template. CI runs on pull requests from forks and
   needs no secrets. Sign the CLA when the bot asks.

## What we will and will not merge

**Very likely merged:** bug fixes with a test; documentation and comment corrections; additional
golden-test cases, especially ones that currently fail; accessibility and keyboard fixes in the
app UI; performance work with a number attached; better error messages, particularly ones an LLM
will read; support for an OKF construct the spec allows and we mishandle.

**Discuss first:** new MCP tools. The tool surface was cut from 42 to 30 deliberately and
stands at 36 today, and every tool costs context in every conversation with every user. The bar is high and the reasoning is
in `CLAUDE.md`. Also: new dependencies, schema migrations, and anything that changes what gets
written into a brain repo.

**Unlikely merged:** reintroducing a fixed entity-type taxonomy (removed on purpose; `CLAUDE.md`
explains why); speculative abstraction for a use case that does not exist yet; large refactors
that move code without changing behavior; new dependencies under a copyleft license; anything
that makes the Worker bundle meaningfully bigger for a feature most brains will not use.

If we decline a change we will say why. If a pull request sits for a week with no response,
ping it.

## Where decisions get made

See [`GOVERNANCE.md`](GOVERNANCE.md). Design discussion happens in public issues, and
[`docs/roadmap.md`](docs/roadmap.md) is what is planned.

## Reporting security problems

Do not open an issue. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies to every space the project uses.
