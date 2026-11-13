# Design: code mode

Status: **proposed** (2026-11-13). Phase 0, a read-only `run_script`, is built on the
experimental `code-mode` branch (draft pull request #211) and pinned by `pnpm test:code-mode`
there; nothing is on `main`. Phase 1 decides whether the rest goes ahead.

## The problem

Three things get worse as the platform grows, and each new feature has so far made them worse:

1. **Multi-step reads cost the model its context.** Walking links, scanning a folder or
   joining pages by frontmatter takes one tool call per page, and every page's text passes
   through the model to decide the next call. `find_inbound_links` alone is called about as
   often as `list_pages`, mostly inside such loops.
2. **The tool surface only grows.** Every capability so far has arrived as a tool, and every
   tool's description is loaded into every conversation. A long tail of them is almost never
   called by the model.
3. **Bulk edits are not atomic.** An agent restructuring a folder makes dozens of
   `write_page` and `move_page` calls. A failure halfway leaves the brain half changed, and
   a retried call cannot tell what landed.

Usage on one production deployment over its first hundred days, as evidence for the scope
below:

| Group                                                                                                        | Calls                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| All first-party tools                                                                                        | about 28,000             |
| `read_page`, `write_page`, `search_pages`, `brains`, `list_pages`                                            | about 25,000             |
| `find_inbound_links`                                                                                         | about 1,000 (10% errors) |
| `create_org`, `unlink_identity`, `view_review`                                                               | 0                        |
| `disconnect_brain`, `remove_member`, `link_identity`, `set_member_role`, and `create_org` under its old name | 2 to 3 each              |
| Brain-authored `tool_*` tools                                                                                | 1, ever                  |

## The idea

Give the model one tool that runs a script against typed `brain` and `org` APIs inside a
Dynamic Worker, and route both rare actions and multi-step work through it:

- **Reads** run in the script and only what it logs or returns reaches the model.
- **Writes** are staged by the script into a change set, never committed by it. A separate
  destructive tool applies a change set atomically, after the person approves a summary the
  server wrote.
- **Brain-authored tools** become saved scripts in the brain, run by name, instead of one
  MCP tool per page.
- **Rare tools leave the model's tool list** but stay callable by the app, which still
  needs them for its own buttons.

The pattern is Cloudflare's Code Mode (https://blog.cloudflare.com/code-mode). The runtime
facts it rests on are in `docs/references.md` under Dynamic Workers.

## Phase 0: read-only `run_script` (built on the `code-mode` branch)

`src/lib/code-mode.ts`, `src/tools/code-mode.ts`, `.claude/rules/code-mode.md`.

- The model writes the body of an async function against `brain` (`search`, `read`,
  `list`, `inbound`). The declaration it writes against is in the tool description.
- The script runs in a Dynamic Worker with `globalOutbound: null`, no `env`, CPU and
  subrequest limits. `brain` crosses Workers RPC as a plain object whose functions are stubs
  into the MCP Worker, built from the caller's resolved brain context. Authorization never
  runs in the sandbox.
- A call meter type-checks every argument and caps calls per run. A wall clock bounds the
  run, and output is cut at a fixed size.
- Registered only where the deployment binds a Worker Loader (`CODE_MODE`, Workers Paid).
- Verified end to end through the local MCP Worker against a real brain: a script making 11
  brain calls returned only its totals; `fetch` is blocked; a throw reaches the caller with
  the lines logged before it.

## Phase 1: measure before building more

On a deployed instance with a real host, run three tasks with and without `run_script`:

1. Follow inbound links two hops from a page and summarize what links to it.
2. Find every page under a folder whose frontmatter matches a condition, grouped by a field.
3. A question that needs one page, to check that the model still takes `read_page` for it.

Record per task: tool calls, input tokens, wall time, correctness, and whether the model
chose `run_script` unprompted. **The rest of this design goes ahead only if tasks 1 and 2
improve on calls and tokens with no loss of correctness, and task 3 does not regress.**

The server instructions gain one line before the measurement: questions that need many reads
are a script.

## Phase 2: saved scripts replace brain-authored tools

A brain-authored tool is a page under `tools/` declaring one of three kinds in a
` ```tool ` block. Each maps onto something that already exists:

| Kind     | Today                              | After                                              |
| -------- | ---------------------------------- | -------------------------------------------------- |
| `op`     | one whitelisted read, interpolated | a saved script                                     |
| `prompt` | returns its instructions           | a page the model reads                             |
| `view`   | renders one `okf-view`             | `view_page` on a page holding the `okf-view` block |

- A saved script is a page under `tools/` holding a ` ```js ` block, with its description
  and arguments in frontmatter. `brain.scripts()` lists them; `run_script` takes `script`
  and `args` in place of `code`.
- The handshake instructions, which already list the caller's brains, also list the active
  brain's saved scripts by name and description, within the instructions limit.
- Nothing is registered per brain, so the per-request discovery pass before `buildServer`
  goes away, with the line grammar, `MAX_CUSTOM_TOOLS` and the custom-tools engine.
- `validate` reports a ` ```tool ` block as a finding with the equivalent script, so the
  one existing use converts.

This is a format change to brain content, so it follows the OKF contract: the old block is
reported, never silently ignored.

## Phase 3: staged writes and `apply_changes`

### In the script

`brain.write`, `brain.move` and `brain.delete` stage operations. They take the same arguments
as `write_page`, `move_page` and `delete_page` and run the same pure checks
(`checkPageWrite`, `planPageWrite`, `write-target.ts`) at staging time, so a refusal reaches
the script as an error it can handle. Nothing is committed.

When the run ends with staged operations, `run_script` persists the change set and returns:

- its id and an expiry;
- a **summary composed by the server** (`change-record.ts`): every path created, edited,
  moved or deleted, links repointed, and the brain it lands in;
- the base revision and each touched file's version tag.

`run_script` stays read-only in its annotations: staging changes nothing a person can see.

### Applying

`apply_changes({ change_set, summary })` is the one destructive tool.

- **`summary` must equal the server's summary exactly**, or the call is refused. Hosts show a
  tool's arguments in the approval prompt, so this puts the server's own text in front of the
  person, and a model cannot describe a change as something else.
- It re-checks every gate with fresh roles (brain `editor` for content), then checks each
  file's version tag against the branch. Any file changed since staging refuses the whole
  set, like the editor's sha guard, and the model re-runs the script.
- Content lands as ONE bundle through `commitOrPR`: one commit, or the brain's open pull
  request in pull-request mode. A failure leaves nothing applied.
- **The change-set id is the idempotency key.** A set moves from `staged` to `applied` with
  its outcome stored; a retried call returns the stored outcome instead of writing twice.
  This replaces the call-keyed retry ledger for scripted writes.
- Caps: `MAX_STAGED_OPS` operations per set, and the existing `MAX_BUNDLE_BYTES`.

### Where a change set lives

The transport is stateless, so a change set needs storage between the two calls. It is too
large to round-trip through the model (that would undo the context saving), so it lives in
D1: a `staged_changes` table keyed by id, holding the actor, brain, org, base revision,
operations, summary, state, outcome and expiry, pruned by the next staging on the same
brain. One row written per staged set, so the D1 write cost is small.

`write_page`, `move_page` and `delete_page` stay as named tools. A single write is one direct
call and should remain one.

## Phase 4: `org` methods, and the model's tool list shrinks

### Admin actions as staged `org` methods

`org.setRole`, `org.removeMember`, `org.invite`, `org.linkIdentity`, `org.unlinkIdentity`,
`org.disconnectBrain` and `org.create` stage operations the same way, checked by the same
guardrails the tools enforce today (`members.ts`, `effectiveBrainRole`, `sharingAuthority`),
with the gate read from the org role, never the brain role.

- A change set is either content or org, never both. Git and D1 cannot commit together, and
  a mixed set could half apply.
- An org set applies as one D1 batch.
- Org methods exist only where the org-scope tools register today (`multiUser`).

### App-only tools

MCP Apps lets a tool declare `_meta.ui.visibility: ["app"]`: callable by the app, hidden from
the model (`McpUiToolVisibility` in `@modelcontextprotocol/ext-apps`). The app's own screens
call `set_member_role`, `remove_member`, `disconnect_brain`, `link_identity`,
`unlink_identity` and `find_inbound_links`, so these become app-only rather than removed.
`create_org` (whose GitHub path was once a separate `connect_github_org` tool) has no app caller and is removed.

### The model's tool list

|                                 | Model-visible tools |
| ------------------------------- | ------------------- |
| Today                           | 38                  |
| Phase 0 (`run_script` added)    | 39                  |
| Phase 3 (`apply_changes` added) | 40                  |
| Phase 4 (7 app-only or removed) | 33                  |

The count is the smaller gain. The larger ones are that new read and admin capabilities become
methods (one declaration line each) rather than tools, and bulk edits become atomic.

## Prerequisite: code mode is always on

Phase 4 takes capabilities off the model's tool list, so every deployment must have
`run_script`. Today it is opt-in. Making it core means:

- **Self-hosting requires the Workers Paid plan** for the Worker Loader. The template's
  `code-mode` block becomes unconditional.
- **The local runtime needs a sandbox.** Options: `node:vm`, acceptable because `pnpm try` is
  loopback-only and single-user, so the script's author is the operator; or running the script
  in workerd through Miniflare, which matches production but adds a process. Recommendation:
  `node:vm`, with the same `brain` object and call meter, and the battery run against both.

Phases 0 to 3 do not need this; Phase 4 does.

## API discovery

The model learns the API from, in order:

1. **The tool description**, which carries the declaration while it fits the 4,096-character
   description limit (about 15 methods).
2. **`brain.help(name?)`** inside the sandbox, returning declarations, once it no longer fits.
   The description then holds the core methods and the pointer.
3. **Self-describing errors.** A call to a method that does not exist answers with the list of
   real methods and their signatures.
4. **The data itself.** `brain.fields()` returns the frontmatter keys this brain uses with
   sample values, so the model can query by `status` or `owner` without guessing.
   `brain.scripts()` lists saved scripts.

## Security

- The sandbox holds no credential, no `env` and no network. Every capability is a method on an
  object the Worker built for this caller.
- Every argument from the sandbox is untrusted: typed at the meter, checked again by the same
  pure functions the tools use.
- Staging is not authorization. `apply_changes` re-resolves roles; a role removed between
  staging and applying refuses the set.
- The approval text is the server's summary, enforced by exact match, never text from the
  script or the model.
- Saved scripts run with the caller's rights, never the author's. A script page grants nothing.

## Testing

Each phase keeps the deciding logic pure in `src/lib/` and ships its tests with it:

- `pnpm test:code-mode`: the sandbox in workerd (built); later, staging refusals and the
  local `node:vm` sandbox against the same scripts.
- `pnpm test:page-write` covers the staged checks, since they are the same functions.
- `pnpm test:e2e-librarian`: stage, apply, conflict on a changed file, idempotent retry,
  pull-request mode, over a real brain.
- `pnpm test:scope`: org methods gate on the org role; content methods on the brain role.
- `pnpm test:annotations`: `apply_changes` is destructive, `run_script` read-only, app-only
  tools carry `visibility: ["app"]`.
- A new migration for `staged_changes`, through the `new-migration` skill.

## Open questions

1. **Do hosts honor `visibility: ["app"]`?** Claude, ChatGPT and the web app host each need
   checking. A host that ignores it shows the tool to the model, which is no worse than today.
2. **Do hosts show tool arguments in the approval prompt?** The `summary` check relies on it.
   Where they do not, MCP elicitation (a server-written confirmation) is the alternative.
3. **Does Cloudflare enforce `cpuMs` as documented?** Local workerd does not, so only a
   deployment can show a runaway script stopped.
4. **Workers Paid as a self-hosting requirement.** A product decision, needed before Phase 4.
