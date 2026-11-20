---
paths:
  - "ee/**"
  - "scripts/{test-ee,entitle,consolidate-report}.ts"
  - "src/lib/entitlements.ts"
  - "migrations/0016_org_entitlements.sql"
---

# Enterprise features (`ee/`)

Licensed under `ee/LICENSE`, not the AGPL. Placement rule and history:
`docs/design/open-source-boundary.md`. `pnpm test:ee`.

- **The core never calls into `ee/` to do its own job.** `ee/` imports from `src/lib/`, not the
  other way round, except where the Worker wires an `ee/` feature in. An org with no
  entitlement must run the core unchanged.
- **Every feature checks the one `enterprise` entitlement** (`FEATURES.enterprise`,
  `hasFeature` / `getEntitlement` in `src/lib/entitlements.ts`). Rows are written only by
  `pnpm entitle` (or billing outside the repo), never by the Worker. No row or an expired one
  means off.
- **An enterprise feature does not have to live in `ee/`** (2026-11-05,
  `docs/design/open-source-boundary.md`). The entitlement read is in the core, under the AGPL,
  so core code can check it without calling into `ee/`. The grant tooling (`entitlementSql`)
  stays in `ee/entitlements.ts`. Enterprise identity is the one core feature that checks it
  (`resolveSignInRoute` in `src/lib/sso.ts`, and the directory callback in
  `src/auth/config.ts`).
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
  high-severity detection never reaches the gateway. A page whose `status` field is
  `deprecated` (`isDeprecated`) is left out and counted in the reply: an old copy is expected
  to disagree with what replaced it. With an OpenRouter key, Jev screens each
  pair first at a 0.3 conflict score (`passesScreen`); a screen error lets the pair through. Claims are kept only when their quotes and
  values are on the pages word for word and, with Jev, that it scores 0.4 or more on whether a
  reader would be misled; a patch must also keep the page's block structure (`blockShape`).
  Nothing is written to the brain.
- **With `against`, the same pass runs between a brain and others** of its organization: one
  named brain (`againstRefusal` in `src/lib/review-checks.ts`), or every other one the caller
  can open for `AGAINST_ALL` (`brainsToCompare`); `resolveComparison` turns what the caller
  passed into the brains to compare. Every brain's pages go in one list (`comparablePages`,
  `pageTexts`), another brain's as an `otherPage` carrying its brain and its path there, and `planStep` pairs a page of the first
  brain only with pages of the others that hold every word of its title, and the reverse.
  Two other brains are never paired. Run state and pair memory are per scope (kind
  `consolidation:<brain id>` or `consolidation:all`), each pass row and remembered pair names
  the other brain it is about in `other_brain_id`, all brains together stay under
  `MAX_DUP_PAGES`, and a finding carries no patch. The other brain's pages go to the model under the first brain's
  organization's entitlement and cap, which is why both must be in that organization.
- **The scheduled organization pass** (`runOrgPass`, `ee/review/org-pass.ts`; what it covers
  and in what order is pure, `src/lib/org-pass.ts`) is the Worker's `scheduled` handler, on
  the cron in `wrangler.template.jsonc`. For each entitled organization (`listEntitledOrgs`)
  it opens every brain by its storage binding (`listStoredBrainsInOrg`), keeps those whose
  config has `orgChecks` (`"charter": {"orgChecks": true}`, parsed by `parseOrgChecks`, off
  unless exactly `true`), and advances each one's `AGAINST_ALL` pass against the others. It
  runs as the organization: no person's access decides what it reads, no actor is recorded,
  and a brain that does not take part has only its config read. Visibility plays no part;
  the opt-in is the brain admin's. One run takes `ORG_PASS_STEPS_PER_RUN` steps, a finished
  pass stands for `ORG_PASS_EVERY_MS`, and a stopped pass ends its organization's run.
  Findings land in each brain's own queue, so a pair is checked from both sides. The run
  logs counts and brain ids, never content.
- **No outside contributions**, and no customer names here either: the public-repo hygiene rules
  apply to `ee/` exactly as to the core.
