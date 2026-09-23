---
paths:
  - "src/lib/{usage,usage-store,registered-tools}.ts"
  - "src/tools/analytics.ts"
  - "app/views/AnalyticsView.tsx"
  - "scripts/test-usage.ts"
  - "tests/ui/analytics.spec.ts"
---

# Usage analytics (the org Analytics tab)

`analytics` (`src/tools/analytics.ts` + pure `src/lib/usage.ts` + D1 `src/lib/usage-store.ts`,
`pnpm test:usage`) answers whether an org uses its brains: active members, reads vs edits per
day, per brain, per person. UI: `app/views/AnalyticsView.tsx`, an ORG-scope destination.

- **Per-day counters, not an event log** (`usage_daily`). One UPSERT per tool call at grain
  (day, org, brain, user, tool). **`brain_id` is `''`, never NULL**, for org-scope calls:
  SQLite treats PK NULLs as distinct and the upsert would append forever.
- **`USAGE_ANALYTICS === 'true'` (and `hasOrgModel`) gates BOTH recording and registration.**
  Absent means off; the generated config defaults it on.
- **Recording is `McpSession.instrument()`**, which wraps every registration after
  `buildServer` via `wrapToolHandler`. It writes through `ctx.waitUntil` after the result,
  swallows its own failures, counts `isError` results as errors, and clears `_resolvedScope`
  first so a call that resolves no org records nothing. The wrapping logic is `countedCall` in
  the pure lib: a mistake there breaks every tool, not a chart.
- **Two scopes:** org totals and per-brain rows are viewer+; the PEOPLE table is admin+ and is
  **withheld from the payload**, not hidden by the widget. Authorization reads `ctx.orgRole`.
- **It measures the product, not the repository.** Edits made outside our tools are invisible
  (`FOOTNOTE` says so). Do not fold commits in; `view_activity` is the repo-history surface.
- **`TOOL_KINDS` needs an entry for every new tool.** Unknown names fall back to `read`, which
  is wrong for a new write tool; `pnpm test:usage` scans `src/tools/*.ts` and `src/worker.ts`
  and fails on any unclassified name.
- **The chart is two small multiples** (reads, edits), each on its own scale, because edits
  would be sub-pixel on a shared one. Single series in `--c-accent`, no legend.
- The nav learns the tab exists from `features.analytics` on the `brains` payload; a picker
  never offers a destination whose tool is not registered (`pnpm test:policy`,
  `tests/ui/analytics.spec.ts`).
- **No telemetry:** counters stay in the deployment's own D1. Sending any of it anywhere is
  forbidden.
- **Not built:** retention/pruning, CSV export, per-brain analytics, sessions.
