---
paths:
  - "app/**"
  - "src/lib/{tool-payloads,browse}.ts"
  - "src/tools/apps.ts"
  - "scripts/{test-payloads,test-policy,gen-app,app-dev}.ts"
  - "dev/**"
  - "tests/ui/**"
---

# The MCP App widget

The UI in `app/` is bundled by `pnpm gen:app` into `src/lib/app-bundle.generated.ts` and served
as the `ui://` resource (and as the web app). **After editing `app/` or any `src/lib/` file it
imports, run `pnpm gen:app`**, or the served bundle is stale with no error; CI's "generated
artifacts in sync" step catches a forgotten one. `app/views/registry.generated.ts` is generated
too.

- **`src/lib/tool-payloads.ts` is the wire contract read from the widget's side**
  (`pnpm test:payloads`). Every tool result the app renders goes through one of its parsers.
  Two rules: a missing or malformed field degrades to an empty value, never a throw; and an
  `isError` result is refused before any field is read (`payloadOf`), because parsing an
  error's empty payload reads as "zero brains" or "no pages". `app/core/types.ts` re-exports
  its types. Add new structured fields here, not ad hoc in a view.
- **One wire type per payload ties the two sides together** (`ListPagesWire`, `BrainsWire`,
  ...). The server's `structuredContent` literal `satisfies` it, and the parser reads through
  `wire<T>(sc)`, which exposes the type's field names with every value `unknown`. A field
  renamed on either side fails typecheck on the other. A new payload field goes in its wire
  type first.
- **The brain a RESULT names beats the active-brain pointer** (`pickShownBrain` in
  `app/core/store.ts`, `pnpm test:policy`, the `#other-brain` UI route). The pointer wins only
  on the self-boot (the widget has no brain yet) or when the result declares `switched`
  (`switch_brain`, `create_brain`). `setActiveBrain` is the single seam, and it drops the cached
  tree and path policy of the brain being left. Every widget call passes `brain` explicitly.
- **The nav learns what exists from `features` on the `brains` payload** (`analytics`,
  `webBase`), because a widget cannot list the host's tools. Never offer a destination whose
  click is refused. Destination lists and scopes: `app/core/nav.ts`.
- **`browse_brain` returns a SUMMARY** (`src/lib/browse.ts`): the brain's shape as text, and the
  tree inline only under `MAX_INLINE_TREE_CHARS` (measured on the serialized payload). Above it
  the widget fetches the tree with `list_pages`, which the conversation never pays for. Large
  trees once exceeded the host's tool-result limit.
- **Add-shaped actions are pushed flows** (`app/ui/Flow.tsx`), e.g. `ShareBrainView`,
  `InviteMemberView`.
- **Iterate with `pnpm app:dev`** (the real `ui://` bytes over the official AppBridge host and
  stubbed fixtures from `dev/`). It exercises the UI, not the write path; for that use
  `pnpm try` (or `pnpm worker:dev` plus a local MCP host such as Inspector at
  `http://localhost:8787/mcp`). Both it and the web
  host seed from `dev/seed.ts`; never add a second fixture set or server
  (`dev/README.md`).
