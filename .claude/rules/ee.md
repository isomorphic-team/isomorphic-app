---
paths:
  - "ee/**"
  - "scripts/{test-ee,entitle}.ts"
  - "migrations/0016_org_entitlements.sql"
---

# Enterprise features (`ee/`)

Licensed under `ee/LICENSE`, not the AGPL. Placement rule and history:
`docs/design/open-source-boundary.md`. `pnpm test:ee`.

- **The core never calls into `ee/` to do its own job.** `ee/` imports from `src/lib/`, not the
  other way round, except where the Worker wires an `ee/` feature in. An org with no
  entitlement must run the core unchanged.
- **Every feature checks an entitlement** (`hasFeature` / `getEntitlement` in
  `ee/entitlements.ts`). Rows are written only by `pnpm entitle` (or billing outside the repo),
  never by the Worker. No row or an expired one means off.
- **Every model request goes through `ee/review/gateway.ts`,** which carries `ZDR_PROVIDER`
  (`zdr: true`, `data_collection: 'deny'`) on every request. GPT-6 Luna is zero-retention only
  on Azure, so without it content reaches OpenAI's own endpoint. `pnpm test:ee` pins the field on
  the wire; never build a request elsewhere.
- **The spend cap is re-checked before every call** from `model_usage_monthly`, per org per UTC
  month, counted from the `usage.cost` the provider reports. An entitlement's
  `monthly_cap_usd` beats `DEFAULT_MONTHLY_CAP_USD`.
- **No outside contributions**, and no customer names here either: the public-repo hygiene rules
  apply to `ee/` exactly as to the core.
