---
paths:
  - "src/lib/code-mode.ts"
  - "src/tools/code-mode.ts"
  - "scripts/test-code-mode.ts"
  - "scripts/workers/code-mode-caller.ts"
---

# Code mode (`run_script`)

`run_script` takes a JavaScript function body the model writes against a typed `brain` API
and runs it in a Dynamic Worker. Only what the script logs or returns reaches the model.
Engine: `src/lib/code-mode.ts` (pure); the `brain` over a `BrainContext` and the
registration: `src/tools/code-mode.ts`. Status: a spike, not yet measured against the plain
tools on a real host.

- **Registered only where `env.LOADER` exists.** `pnpm setup:config` keeps the template's
  `code-mode` block (`worker_loaders`) only when `CODE_MODE` is set, because Dynamic Workers
  need the Workers Paid plan. The local runtime (`pnpm try`) has no Worker Loader and does not
  register it.
- **The sandbox holds nothing.** `globalOutbound: null` (fetch and connect throw), no `env`,
  `SANDBOX_LIMITS` on CPU and subrequests. `brain` crosses Workers RPC as a plain object whose
  functions are stubs into the MCP Worker, built from the caller's already-resolved context, so
  authorization never runs in the sandbox and needs no props.
- **Read-only, mirroring the brain-tool op whitelist** (`BRAIN_API_METHODS`: search, read,
  list, inbound). Writes are not in it. Adding one goes through `planPageWrite` and the
  change record like any other write, never a store call from the API.
- **`BRAIN_API_DECLARATION` is what the model reads**, in the tool description; `pnpm
  test:code-mode` checks it names exactly `BRAIN_API_METHODS`. Change both together.
- **Every argument from the sandbox is untrusted.** `meteredApi` type-checks each one, caps
  `search`'s limit, and counts calls (`MAX_API_CALLS`); `runScript` adds a wall clock
  (`SCRIPT_WALL_MS`) and `formatScriptResult` cuts output at `OUTPUT_MAX_CHARS`.
- **The worker id is a hash of the modules**, so one script reuses a warm isolate and counts
  once toward the billed daily total of Dynamic Workers. Output is collected per run by a
  `console` the harness passes in, so two runs in one isolate never mix lines.
- **Local workerd does not enforce `cpuMs`**: a busy loop hangs the caller. The battery pins
  only that every load passes `SANDBOX_LIMITS`; the enforcement is Cloudflare's.

Coverage: `pnpm test:code-mode` (pure checks, then real scripts in workerd through
`scripts/workers/code-mode-caller.ts`); `pnpm test:e2e-librarian` drives `brainApi` over a
real brain.
