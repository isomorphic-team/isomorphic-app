# Building with Claude Code

Most of this repository was written by Claude Code, with a person reviewing every change. This
page shows the setup that makes that work: what Claude reads, what it is prevented from doing,
and how the repository checks that its own instructions are still true. Each section points at
real files, so you can open them alongside.

It is written for two readers. If you are deciding how your team should work with coding
agents, the first two sections and [Try it](#try-it) are enough. If you will set this up in a
repository of your own, read the whole page.

A few terms:

- **Claude Code** is Anthropic's coding agent. It reads files, runs commands and edits code in a
  repository, in a terminal or an IDE.
- **Context** is everything the model has in front of it for a task. It is limited, and the
  model gets less reliable as it fills up, so what goes in it is a design decision.
- **MCP** (Model Context Protocol) is how an AI client talks to a tool server. Isomorphic itself
  is an MCP server, which matters in [the last section](#writing-for-a-model).

## The idea: five layers, from advice to enforcement

An instruction in a document is advice. The model weighs it against everything else in its
context, and usually follows it. Some rules cannot depend on "usually". So the setup is layered,
and each rule lives on the lowest layer that makes it reliable:

| Layer                | Where                       | Loaded                           | Holds                                         |
| -------------------- | --------------------------- | -------------------------------- | --------------------------------------------- |
| Project instructions | `CLAUDE.md`                 | Every session                    | Facts every task needs                        |
| Path-scoped rules    | `.claude/rules/*.md`        | When Claude touches those files  | How one subsystem works, and why              |
| Skills               | `.claude/skills/*/SKILL.md` | When the task matches, or on `/` | Multi-step procedures                         |
| Hooks                | `.claude/settings.json`     | Run on every matching action     | Rules that must never be skipped              |
| Tests                | `scripts/test-*.ts`, in CI  | On every pull request            | Proof that the four layers above are accurate |

The rest of this page walks through each layer.

## 1. `CLAUDE.md`: what every session needs

[`CLAUDE.md`](../CLAUDE.md) is loaded at the start of every Claude Code session in this
repository. It holds the commands, the testing policy, the shape of the system, and the
invariants that apply everywhere. For example:

> **Anything imported by `worker.ts` runs on Workers and cannot use `node:*`.**

Because it is loaded every time, every line costs context in every conversation. Anthropic's
guidance is to keep it under about 200 lines and to cut any line whose removal would not cause
a mistake. This repository enforces that limit: `pnpm test:docs` fails if the file passes 200
lines.

## 2. Rules that load with the files they describe

Most knowledge only matters when you touch a particular part of the code. It lives in
[`.claude/rules/`](../.claude/rules/), one file per subsystem, and each file declares the paths
it covers:

```markdown
---
paths:
  - 'src/tools/librarian.ts'
  - 'src/lib/{page-write,page-patch,change-record,write-target,write-dedupe,write-dedupe-store,brain-policy}.ts'
  - 'app/views/{PageView,EditView}.tsx'
---

# The write path (`write_page`, `move_page`, `delete_page`)
```

Claude Code loads this file the first time a session reads one of those paths, and not before.
A session fixing the search ranking never pays for the write path's detail.

On every pull request, CI lists the rules files that cover the changed files
(`scripts/rules-for-change.ts`), so the reviewer knows which ones might now be out of date.

## 3. Skills for procedures

Some tasks are a sequence of steps that is easy to get partly right. Adding a tool to the MCP
server means registering it, classifying it for analytics, deciding whether it has a web
address, testing it, and updating the docs. Missing any one step fails the build, but only
after the fact.

A skill packages that sequence. [`.claude/skills/add-tool/SKILL.md`](../.claude/skills/add-tool/SKILL.md)
opens by asking whether the tool should exist at all:

> Every advertised tool costs context in every conversation. Before adding one: extend an
> existing tool when this is a variant of one.

Claude uses a skill when a task matches its description, or you invoke it by name (for example
`/add-tool`). This repository has five: `add-tool`, `add-battery` (a new test suite),
`new-migration` (a database change), and two that only a person can start, `regen-pr` and
`ui-baselines`, because they push code or accept visual changes.

## 4. Hooks for what must always hold

A hook is a command Claude Code runs before or after an action, and it can refuse that action.
The hooks here are wired in [`.claude/settings.json`](../.claude/settings.json):

```json
"PreToolUse": [
  {
    "matcher": "Edit|Write|MultiEdit|NotebookEdit",
    "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/scripts/agent-hooks.ts pre-edit" }]
  },
  {
    "matcher": "Bash",
    "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/scripts/agent-hooks.ts pre-bash" }]
  }
]
```

The logic is in [`scripts/agent-hooks.ts`](../scripts/agent-hooks.ts). When Claude tries to
apply a database migration to production by hand, the command never runs, and Claude reads:

```text
Remote D1 writes run only in deploy.yml, before the code that needs them ships. Apply locally
with `pnpm db:migrate`; production gets the migration on merge.
```

The refusal says what to do instead, so Claude changes course and does not retry the same
command. The hooks here:

- refuse edits to generated files and to database migrations that are already committed;
- refuse remote database writes, and refuse committing files that hold secrets;
- when Claude finishes a turn, rerun the code generators if their sources changed, and hand
  the turn back if that changed a file.

A useful test for which layer a rule belongs on: if breaking it once is expensive, or a model
has missed it twice, it becomes a hook.

## 5. Tests that keep the instructions true

Everything above is only useful while it is accurate. When the code changes and a document
does not, an agent reads the stale sentence and acts on it with confidence. Three test suites
guard against that:

- **`pnpm test:docs`** reads `CLAUDE.md`, the rules, the skills and the docs, and checks every
  file path, function name, tool name and constant they mention against the code. Renaming a
  function without updating the prose fails the build:

  ```text
  ✗ .claude/skills/add-tool/SKILL.md:
      :81 `planPageWriteNope` is not in the code
  ```

- **`pnpm test:hooks`** checks each hook refuses what it should and allows its everyday
  neighbour (a local migration passes, a remote one is refused). It also checks that the
  settings file still wires every hook.
- **`pnpm test:wiring`** fails if a test suite exists but CI does not run it.

The testing policy in `CLAUDE.md` asks one more thing of every change: break the new code on
purpose and watch its test fail before calling it tested. A test that stays green against
broken code proves nothing.

## Writing for a model

Isomorphic is itself used by a model. When Claude connects to it, Claude reads two kinds of
text: each tool's description, and the server's instructions
([`src/lib/server-instructions.ts`](../src/lib/server-instructions.ts)). The same discipline
applies to both:

- **Each tool description stands alone.** A host's tool search ranks tools by their
  descriptions, so a description that mentions another tool can outrank it. That happened here:
  `view_page` once said "prefer this over `read_page`", a search for `read_page` returned
  `view_page`, and the agent concluded it could not read pages.
- **Guidance across tools goes in the server instructions**, which the host loads once:

  > Use `read_page` (not `view_page`) only when YOU need the raw content to reason over it; use
  > `view_page` when the goal is for the USER to see it.

- **Fewer tools beat more.** Moving and deleting attachments reuse `move_page` and
  `delete_page` and do not get tools of their own.

## Try it

You need Node 24 or newer, pnpm, and [Claude Code](https://code.claude.com/docs/en/quickstart).

```sh
git clone https://github.com/isomorphic-team/isomorphic-app.git
cd isomorphic-app
pnpm install
claude
```

Then try these, in order:

1. Ask: _"What does the write path do when two edits race?"_ Watch Claude open
   `src/tools/librarian.ts` and load `.claude/rules/write-path.md` along with it.
2. Ask Claude to edit `src/lib/app-bundle.generated.ts`. The hook refuses, and Claude edits the
   source under `app/` instead.
3. Type `/add-battery` and describe a small check. Read the plan it follows before it writes
   anything.
4. Rename a function mentioned in `CLAUDE.md`, run `pnpm test:docs`, and read the failure.
   Then undo it.

To run the product itself with no accounts, `pnpm try <folder>` serves any git repository of
markdown as a brain; see [Getting started](getting-started.md).

## Read the history

Every change arrives as a pull request whose description records what was decided and why. A
few that show the approach:

| Pull request                                                       | Shows                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| [#110](https://github.com/isomorphic-team/isomorphic-app/pull/110) | Moving a decision into a pure function so a test can reach it |
| [#112](https://github.com/isomorphic-team/isomorphic-app/pull/112) | Finding stale docs, and adding a test that stops it recurring |
| [#105](https://github.com/isomorphic-team/isomorphic-app/pull/105) | Migrating to a new protocol version with the tests as a guide |
| [#115](https://github.com/isomorphic-team/isomorphic-app/pull/115) | Collapsing two code paths into one                            |
| [#120](https://github.com/isomorphic-team/isomorphic-app/pull/120) | The layered setup this page describes                         |

## Further reading

- [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- [Memory and rules](https://code.claude.com/docs/en/memory),
  [Skills](https://code.claude.com/docs/en/skills),
  [Hooks](https://code.claude.com/docs/en/hooks-guide)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [`docs/architecture.md`](architecture.md), for how a tool call travels through the system
