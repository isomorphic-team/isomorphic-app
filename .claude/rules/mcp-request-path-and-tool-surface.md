---
paths:
  - "src/worker.ts"
  - "src/local.ts"
  - "src/lib/{mcp-serve,mcp-preamble,registered-tools,server-instructions}.ts"
  - "src/tools/{core,apps,shared}.ts"
  - "scripts/{test-protocol,test-preamble,test-app-resource}.ts"
---

# The `/mcp` request path and the tool surface

## Two protocol eras (`src/lib/mcp-serve.ts`, `pnpm test:protocol`)

`serveMcp` is the one path the Worker and the local runtime share. A request carrying the
2026-07-28 per-request envelope goes to the SDK's `createMcpHandler`; everything else goes to
`WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,
enableJsonResponse: true })`. The split uses the SDK's own `isLegacyRequest`.

- **Why not `createMcpHandler`'s built-in 2025 fallback:** it omits `enableJsonResponse`, which
  would move every existing client onto SSE replies. Both legs answer with JSON, no session.
- **`listChanged: false` in both eras.** A 2026 client seeing `true` holds a
  `subscriptions/listen` stream open that a per-request server can never send on.
- MCP SDK v2 (`@modelcontextprotocol/server` / `/client` / `/core`). The 2026-07-28 facts
  (`server/discover` replaces `initialize`, no `ping`, required headers) are in
  `docs/references.md`.
- Non-POST `/mcp` returns 405.

## The preamble (`src/lib/mcp-preamble.ts`, `pnpm test:preamble`)

- **A throw before the transport must still answer.** `loadActiveBrain`, `buildServer` and
  `connect` run outside any tool handler and outside the OAuth provider's error handling, so
  an uncaught throw reaches the user as a bare gateway error. The handler answers with a
  JSON-RPC error carrying the reason and the CF ray id: 200 when the request id is known, 500
  only when no reply can be addressed.
- **`needsBrainPreamble`** skips brain resolution for `initialize`, `server/discover`, `ping`
  and notifications, and is conservative for anything unknown. **`tools/list` still resolves**
  (a brain's own tools belong in it).
- `loadActiveBrain` and `loadCustomTools` fail open.
- **`describeRequest` logs** any `/mcp` answer at 4xx or over 5s: methods, message SHAPES (key
  names only, never values), protocol era, status, duration, transport error. A slow call
  reaches the user as the edge's 502, not ours, so only this log can name the tool. Read with
  Workers Logs or `wrangler tail --status error` (macOS has no `timeout`: background it and
  `kill`).
- A 502 whose body names `zone: api.anthropic.com` was generated in front of Anthropic's API,
  not by this Worker. Check the zone and the Worker's own logs before assuming the origin.

## Registration

`McpSession.buildServer()` in `worker.ts` registers everything per request. Brain-authored
tools register LAST (a `tool_` name cannot shadow a built-in), then every registration is
wrapped for usage counting. **The only way to replace a registered handler is
`wrapToolHandler` (`src/lib/registered-tools.ts`)**: SDK 2 dispatches through a prebuilt
`executor`, so assigning `tool.handler` is a silent no-op. `pnpm test:usage` drives a real
`tools/call` through it.

Gated registrations: `multiUser` (`AUTH_MODE === 'oauth'`: anyone besides the operator can
sign in) gates members, `brain_access`/`share_brain`, connected accounts, `create_org`, and the
brain tools that add, move, remove or switch (`switch_brain`, `create_brain`, `connect_brain`,
`disconnect_brain`); `USAGE_ANALYTICS` + `multiUser` gate `analytics`; `FEEDBACK_REPO` gates
`submit_feedback`. Every deployment runs the org model, so this is the only mode difference a
tool sees. `whoami` (in `worker.ts`) reports email, role and active brain when signed in, and
the operator's role and brain in static mode; the app's settings card reads its
`structuredContent`.

The ui:// resource's host contract (`prefersBorder: false`, every widget tool's
`resourceUri` naming a served resource) is pinned by `pnpm test:appmeta`.

## Tool descriptions

**Each tool's description stands alone and names itself; cross-tool steering lives in
`SERVER_INSTRUCTIONS`** (hosts load it wholesale). A convention the model cannot infer is stated
in three places, in descending reach: server instructions, the tool's own description or
argument, and `brain-template/AGENTS.md`. A host's tool search ranks by description text, so a
description that mentions another tool by name can outrank that tool: `view_page` once said
"prefer this over read_page" and a search for `read_page` returned `view_page`, and the agent
concluded it could not read pages. A tool an agent will hunt for mid-task gets a
full description, not one terse line. The comments on those descriptions say so; do not tidy
them back.

**`read_page` and `view_page` stay separate.** `read_page` is the app's own navigation channel
and the high-frequency quiet read; merging would put `_meta.ui` on the widget's internal calls
and make every read render a widget. Merges that did happen (`members`, `brains`) were
once-per-conversation surfaces.
