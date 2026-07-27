# Contributing to Isomorphic

Outside contributions are wanted, not tolerated. This file is written so that you can get a
change merged without needing to ask us anything first.

Two things to know before you start:

1. The project is **open source under [AGPL-3.0-only](LICENSE)**, an OSI-approved license.
   [`docs/licensing.md`](docs/licensing.md) explains what that asks of you if you self-host a
   modified copy, and what it does not reach.
2. Contributors sign a [CLA](CLA.md). It is one bot comment on your first pull request and it
   does not take your copyright. It exists so we can also license Isomorphic commercially to
   organizations that cannot ship copyleft, and in exchange it binds us to keep your
   contribution under an OSI-approved open source license permanently. The full reasoning,
   including the asymmetry it creates, is in
   [the licensing doc](docs/licensing.md#the-cla-and-what-commercialize-later-means).

Typo and documentation fixes need no CLA. Everything else does.

## Get it running in about ten minutes

You need Node 24+, `pnpm`, and a GitHub account. You do **not** need a Cloudflare account, a
GitHub App, or an email provider to work on most of the codebase.

```sh
git clone https://github.com/isomorphic-team/isomorphic-app
cd isomorphic-app
pnpm install
pnpm setup:config       # writes wrangler.jsonc for local-only development
pnpm test               # eight golden tests, no network, should be green
```

That is the whole loop for the parts of the project most changes touch. From there:

| You want to work on                          | Run               | What you get                                                                              |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| The in-client app UI (viewer, editor, graph) | `pnpm app:dev`    | `http://localhost:5175`, real `ui://` bytes over stub fixtures, live reload, no auth      |
| Markdown / OKF / view engine logic           | `pnpm test:*`     | Pure golden tests, instant, no network                                                    |
| MCP tools end to end                         | `pnpm worker:dev` | `http://localhost:8787/mcp`, needs `.dev.vars` (see [self-hosting](docs/self-hosting.md)) |
| The one-time GitHub App setup flow           | `pnpm bootstrap`  | `http://localhost:3000`, needs a GitHub org you control                                   |

`pnpm app:dev` is the highest-leverage entry point and needs no credentials at all. If you
are unsure where to start, start there.

## Read this before your first non-trivial change

[`CLAUDE.md`](CLAUDE.md) is the architecture document. It is long, and it is the real one:
maintainers keep it current because coding agents read it. It explains the two-runtime split,
the content index, the derived-views engine, OKF conformance, and the folder-note convention,
and each section says _why_ the design is what it is. Skim the section that covers your area
before you change it. The failure mode we see most often is a change that is locally correct
and violates an invariant documented there.

[`docs/references.md`](docs/references.md) lists the authoritative external sources (the MCP
Apps spec, the MCP SDK, Claude host design guidelines, ProseMirror, Cloudflare limits) plus
verified facts about them. Read the primary source rather than trusting memory or an LLM;
that surface moves fast, and several of the entries exist because someone got burned.

## The three rules that will bite you

These are not style preferences. Each one has broken a deploy.

**1. `src/lib/` runs on Cloudflare Workers. No `node:*` imports.** The repo ships two
programs from one `src/`: a Node bootstrap server and a Workers MCP server. Anything in
`src/lib/` is imported by both. `pnpm typecheck` runs three tsconfigs to catch a leak, so run
it before you push. Node-only code belongs in `src/bootstrap.ts` or a Node-only sibling.

**2. Generated files are committed and CI checks they are fresh.** After editing anything in
`app/` or anything under `src/lib/` that the app imports, run `pnpm gen:app`. After editing
anything under `brain-template/`, run `pnpm gen:templates`. Commit the regenerated
`src/lib/*.generated.ts`. If you forget, CI fails with a diff, and if CI were skipped the
deployed bundle would go stale with no error at all.

**3. The Open Knowledge Format is a contract, not an implementation detail.** OKF is the
markdown format every brain repo is written in. A change to how pages are parsed or written
has to keep working for every existing brain, including ones edited outside this codebase
entirely (on github.com, by another agent, by an ETL). Changing the writer without checking
the readers is the recurring failure. `pnpm test:structure` and `pnpm test:roundtrip` exist to
catch it; add cases to them rather than only testing your new path.

## Tests

Eight pure golden tests, no network, all fast. `pnpm test` runs them all.

```sh
pnpm test:roundtrip     # editor markdown round-trip (ProseMirror in, identical markdown out)
pnpm test:views         # derived-views (okf-view) engine
pnpm test:import        # bulk-import planner
pnpm test:tools         # brain-authored (user-defined) tool parsing
pnpm test:patch         # write_page append/edits
pnpm test:structure     # OKF conformance: granularity, type:, nested frontmatter
pnpm typecheck          # all three tsconfigs (node, worker, app)
pnpm format             # prettier, run before pushing
```

Golden tests compare against expected strings inline in the test file. When you change
behavior deliberately, update the expectation in the same commit and say in the pull request
why the old expectation was wrong. A silently-updated golden is the one review comment you
will definitely get.

Two further batteries hit **real GitHub** and are not in CI, because they need platform
GitHub App credentials in `.dev.vars`:

```sh
pnpm exec tsx scripts/e2e-librarian.ts   # the librarian write tools
pnpm exec tsx scripts/e2e-import.ts      # the bulk importer
```

Both create a disposable `brain-*-e2e-*` scratch repo, auto-delete it, and never touch a real
brain. Maintainers run `e2e-librarian` for any change to a write tool. You are not expected
to run these to get a pull request merged; say in the PR that you could not, and a maintainer
will run them.

## Making a change

1. **Open an issue first for anything with a design decision in it.** Bug fixes, test
   additions, and documentation do not need one. A new MCP tool, a change to OKF, a change to
   the index schema, or anything that adds a dependency does. We would rather discuss the
   shape for ten minutes than reject a finished branch, and we will tell you honestly and
   early if something is not a direction we want.
2. **Branch from `main`.** Naming is not policed; `fix/…` and `feat/…` are common.
3. **Keep the change one thing.** A pull request that fixes a bug and also reformats a file
   is two pull requests.
4. **Match the surrounding code.** Comment density, naming, and idiom vary by file, and the
   local convention wins over any global preference. The codebase comments _why_, not _what_;
   a comment explaining a non-obvious constraint is welcome, a comment restating the line
   below it is not.
5. **Update `CLAUDE.md` when you change an invariant.** If your change makes a sentence in
   there wrong, fix the sentence in the same pull request. This is the single most valuable
   non-code contribution you can make.
6. **Run `pnpm typecheck && pnpm test && pnpm format`** before pushing.
7. **Open the pull request.** Fill in the template. CI runs on pull requests from forks and
   needs no secrets. Sign the CLA when the bot asks.

## What we will and will not merge

**Very likely merged:** bug fixes with a test; documentation and comment corrections;
additional golden-test cases, especially ones that currently fail; accessibility and keyboard
fixes in the app UI; performance work with a number attached; better error messages,
particularly ones an LLM will read; support for an OKF construct the spec allows and we
mishandle.

**Discuss first:** new MCP tools. The tool surface went from 42 to 30 deliberately, and every
tool costs context in every conversation with every user. The bar is high and the reasoning is
in `CLAUDE.md`. Also: new dependencies, schema migrations, and anything that changes what gets
written into a brain repo.

**Unlikely merged:** reintroducing a fixed entity-type taxonomy (this was removed on purpose,
and `CLAUDE.md` explains why); speculative abstraction for a use case that does not exist yet;
large refactors that move code without changing behavior; new dependencies under a copyleft
license; anything that makes the Worker bundle meaningfully bigger for a feature most brains
will not use.

If we decline your change, we will say why in a sentence rather than letting it rot. If a pull
request of yours has sat for a week with no response, ping it. That is us dropping the ball,
not a signal.

## Where decisions get made

See [`GOVERNANCE.md`](GOVERNANCE.md). Short version: Isomorphic maintains the project, design
discussion happens in public issues, and there is no private roadmap that contradicts the
public one. [`docs/roadmap.md`](docs/roadmap.md) is what we are actually planning to build.

## Reporting security problems

Do not open an issue. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies to every space the project uses.
