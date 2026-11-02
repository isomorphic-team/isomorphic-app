---
paths:
  - "ee/**"
  - "scripts/{test-ee,entitle,consolidate-report}.ts"
  - "migrations/0016_org_entitlements.sql"
---

# Enterprise features (`ee/`)

Licensed under `ee/LICENSE`, not the AGPL. Placement rule and history:
`docs/design/open-source-boundary.md`. `pnpm test:ee`.

- **The core never calls into `ee/` to do its own job.** `ee/` imports from `src/lib/`, not the
  other way round, except where the Worker wires an `ee/` feature in. An org with no
  entitlement must run the core unchanged.
- **Every feature checks the one `enterprise` entitlement** (`FEATURES.enterprise`,
  `hasFeature` / `getEntitlement` in `ee/entitlements.ts`). Rows are written only by
  `pnpm entitle` (or billing outside the repo), never by the Worker. No row or an expired one
  means off.
- **Every model request goes through `ee/review/gateway.ts`.** Text goes to Claude Haiku first
  (`ANTHROPIC_API_KEY`, the official SDK) and falls back to Luna (`OPENROUTER_API_KEY`) on a
  refusal, 429, 402 or 529. Every OpenRouter request carries `ZDR_PROVIDER` (`zdr: true`,
  `data_collection: 'deny'`); GPT-6 Luna is zero-retention only on Azure, so without it content
  reaches OpenAI's own endpoint. Anthropic requests get the operator's Anthropic retention.
  `pnpm test:ee` pins both on the wire; never build a request elsewhere.
- **The spend cap is re-checked before every call** from `model_usage_monthly`, per org per UTC
  month, counted from the `usage.cost` OpenRouter reports or from Haiku's tokens at list price
  (`haikuCostUsd`), credits included. An entitlement's `monthly_cap_usd` beats
  `DEFAULT_MONTHLY_CAP_USD`.
- **The consolidation pass** (`ee/review/consolidation.ts`, run state in `brain_passes` through `src/lib/brain-pass.ts`) is the
  Worker's `consolidate` on the brain context, wired only when a model key is set, and run by
  `review_brain` with `check: "contradictions"`. Each step stops starting batches after
  `STEP_TIME_MS` (the first batch always runs) and resumes from a cursor that never passes an
  unchecked pair; a gateway refusal stops it as `stopped`, and asking again resumes. Each
  checked pair is remembered in `brain_pass_items` with a fingerprint of both pages' blob shas
  and the check's own version (prompts, gates, models), so a later pass skips a pair whose
  fingerprint is unchanged and keeps its findings as they were; `fresh` starts a pass that
  ignores the memory. A page with a
  high-severity detection never reaches the gateway. With an OpenRouter key, Jev screens each
  pair first at a 0.3 conflict score (`passesScreen`); a screen error lets the pair through. Claims are kept only when their quotes and
  values are on the pages word for word and, with Jev, that it scores 0.4 or more on whether a
  reader would be misled; a patch must also keep the page's block structure (`blockShape`).
  Nothing is written to the brain.
- **No outside contributions**, and no customer names here either: the public-repo hygiene rules
  apply to `ee/` exactly as to the core.
