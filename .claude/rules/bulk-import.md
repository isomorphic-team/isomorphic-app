---
paths:
  - "src/lib/brain-import.ts"
  - "src/tools/importer.ts"
  - "scripts/{test-import,e2e-import}.ts"
---

# Bulk import (`sync_records`) and import decisions (`resolve`)

Non-destructive upsert-by-key from an external source (spreadsheet, CRM). Planner:
`src/lib/brain-import.ts` (pure, `pnpm test:import`); tools: `src/tools/importer.ts`. Spec:
`docs/design/derived-views-and-sync-prd.md` (Phase 3).

Invariants, in order:

1. **Human edits are sacred.** Only declared `source_owned` frontmatter is written; the body
   only at create.
2. **Deletions are PROPOSED, never applied**, and only when the call passes the full key
   `manifest`.
3. **No resurrection.** A per-source ledger at `.isomorphic/imports/<source>.json` records
   every key ever imported; a key whose page a human removed becomes a question, not a create.
4. **Idempotent.** An unchanged run makes no commit.

- Pages bind to keys via `source_key`; curators alias a duplicate's key onto the surviving page
  via `source_keys`. Discovery is one `brain_page_fields` query, but diffs run on
  authoritative blobs, never index values.
- At most 200 records per call (`MAX_RECORDS_PER_CALL`); one `commitOrPR` bundle (pages +
  ledger + changelog).
- A create aimed at an existing page ERRORS unless `adopt_existing: true`, which binds the
  unclaimed page (field merge + `source_key`, body untouched).
- **Open questions persist in the ledger's `pending` list** (merged chunk-safely: a call speaks
  only for its own keys; only manifest calls replace absence proposals) and `validate` lists
  them until answered.
- **Answers go through `resolve`** (`delete` / `alias` / `suppress` / `recreate`), the same tool
  that dismisses other findings. The tool was once `resolve_import`; user-facing strings must
  name `resolve`.
- `sourceOfTruth` config is parsed ('app' default; 'source' is reserved and refused).
- `pnpm test:e2e-import` runs the importer end to end offline in CI; `--github` runs it against
  a scratch repo.
- **Not built:** a reconciliation widget.
