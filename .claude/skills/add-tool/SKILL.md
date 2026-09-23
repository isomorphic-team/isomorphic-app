---
name: add-tool
description: Add a first-party MCP tool to the Isomorphic server, or change what an existing tool accepts or returns. Use before registering any new tool name in src/tools/ or worker.ts.
argument-hint: "<tool_name> <what it does>"
---

# Add an MCP tool

Tool to add: $ARGUMENTS

## 0. Decide whether it should be a new tool

Every advertised tool costs context in every conversation. Before adding one:

- **Extend an existing tool when this is a variant of one.** Media move and delete are
  `move_page` / `delete_page`; import decisions and finding dismissals share `resolve`.
- **Never re-add `update_brain`, a `manage_*` tool, or `set_fields`** without reading
  `docs/design/storage-and-tenancy.md` §6 and `docs/roadmap.md`.
- **Apply the overlap test.** If a person could not say which of two tools fits a request,
  a model cannot either. Merge them or sharpen both descriptions.

If it survives that, say in one line why it is a new tool, then continue.

## 1. Put the deciding logic where a test can call it

The handler is thin wiring. What the tool DECIDES (validation, planning a write, who may
call it) goes in a pure or db-only function in `src/lib/` (compare `planPageWrite`,
`effectiveBrainRole`). No `node:*` imports there: `src/lib/` runs on Workers.

## 2. Register it

- In the matching `src/tools/*.ts` file: `server.registerTool(...)` for a quiet tool, or
  `registerAppTool(...)` when its result opens the MCP App widget.
- `McpSession.buildServer()` in `src/worker.ts` calls that file's `register*Tools`. A content
  tool the local runtime should also serve is registered in `src/local.ts` too.
- **Gating.** A tool that only means something when other people can sign in registers under
  `multiUser`; see `.claude/rules/mcp-request-path-and-tool-surface.md` §Registration. An
  unavailable tool is not registered, rather than registered and refusing.
- Content reads and writes go through `BrainStore`, never octokit. Changelog, commit and
  reply wording comes from `src/lib/change-record.ts`.

## 3. Write the description for a model that has only this description

- It stands alone and names itself. It never steers toward another tool by name: a host's
  tool search ranks by description text, and a mention can outrank the tool it mentions.
- Cross-tool steering ("use X before Y") goes in `SERVER_INSTRUCTIONS`
  (`src/lib/server-instructions.ts`). A convention the model cannot infer is stated there, in
  the tool's own description or argument, and in `brain-template/AGENTS.md`.
- Argument descriptions say what a valid value looks like, with an example.

## 4. The tables that fail the build when a tool is missing

- `TOOL_KINDS` in `src/lib/usage.ts`: `read`, `write`, or `admin`. `pnpm test:usage` fails on
  an unclassified tool.
- If it is a widget tool: a `WEB_TOOL_ROUTING` entry in `src/lib/web-app.ts`, either an
  address or `{ kind: 'none', why }`. `pnpm test:web` fails otherwise.

## 5. Tests, in the same change

- A battery that calls the deciding function from step 1, both the allowed and the refused
  cases. Extend the battery that owns the area; a new one follows the `add-battery` skill.
- Write-path or org-scope behavior: extend `scripts/e2e-librarian.ts` or
  `scripts/e2e-import.ts`, which drive the real handlers over a real git brain.
- Break the new logic on purpose and watch the test go red before calling it tested.

## 6. Docs and generated files

- `CLAUDE.md` states the tool count under "Brain model"; update it. `pnpm test:docs` fails on
  any `verb_noun` name in the docs that is not a registered tool.
- Reread the rules file for the area (CI lists it on the pull request) and fix any sentence
  the change made false.
- A widget tool whose view lives in `app/`: `pnpm gen:app` (the Stop hook also runs it).

## 7. Verify

```sh
pnpm typecheck && pnpm test:usage && pnpm test:web && pnpm test:docs
```

Then the battery from step 5, and `pnpm test` before opening the pull request.
