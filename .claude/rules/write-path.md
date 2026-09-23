---
paths:
  - "src/tools/librarian.ts"
  - "src/lib/{page-write,page-patch,change-record,write-target,write-dedupe,write-dedupe-store,brain-policy}.ts"
  - "app/views/{PageView,EditView}.tsx"
  - "scripts/{test-page-patch,test-record,test-policy,test-dedupe,e2e-librarian}.ts"
---

# The write path (`write_page`, `move_page`, `delete_page`)

## What `write_page` decides is pure

- **`src/lib/page-write.ts`** (`pnpm test:patch`): `checkPageWrite` answers refusals that need
  no page; `planPageWrite` picks create, update or refusal from the page as the branch holds it
  (clobber guard, the editor's sha guard, "nothing to update", a patch aimed at a missing
  page); `composeCreate` / `composeUpdate` build the file. The tool keeps only the IO.
- **Partial edits** (`src/lib/page-patch.ts`): `edits` are exact find/replace pairs applied in
  order to the BODY; `append` adds at the end; `content` replaces the whole body and reports the
  size it replaced. **An anchor must match exactly once** (else the whole call aborts, so a
  batch is never half-applied), and **an anchor inside an `okf-view` snapshot is refused**.
  Patched bodies go through `composeUpdate`'s `rawBody` so a body starting with `---` is not
  re-parsed as frontmatter.
- **`src/lib/write-target.ts`** (`pnpm test:policy`) is the one set of path rules every write
  tool shares: normalization, then source-is-immutable, tool-maintained-is-the-tools', and
  must-be-editable-content, for pages and whole folders. Do not re-derive these in a tool.
  The underlying path policy is `src/lib/brain-policy.ts` (`roleOf`, `isToolMaintained`),
  shared with the app (`isEditablePath` in `app/core/store.ts`).
- **`src/lib/change-record.ts`** (`pnpm test:record`) is what a write SAYS about itself: the
  changelog bullet, commit message, PR text, both replies (landed vs PR), the "still linked"
  note, and `toolRosterNote`. The changelog is a file people read, so its wording is a
  contract: compose it here, never inline in a tool. `commitOpts` is the shared commit
  preamble (also used by the importer and media).
- Only `wiki/log.md` is tool-maintained. Writes to a protected branch become a PR, which
  merges itself on green only when auto-merge could be armed (`writes.autoMerge`, default true,
  and a repo that allows it). Never tell a caller a PR "will merge" unconditionally.

## Frontmatter: `fields` and the properties panel

- **`fields` is JSON Merge Patch** (RFC 7386): present sets, `null` removes, absent is
  untouched; the body is kept verbatim. Engine: `applyFieldPatch` (`page-patch.ts`).
- **Three refusals, each forced by the codebase:** key names must match `FM_KEY_RE`
  (`[A-Za-z0-9_-]`), since our parser skips lines it cannot read; managed keys (`title`, `type`,
  `description`, `status`) go through their own arguments (a `title` via `fields` would skip
  the inbound-link repoint); a key holding a nested `FrontmatterBlock` cannot be set or removed.
- `write_page` warns past `MAX_FIELD_KEYS_PER_PAGE` (24), where the indexer stops reading keys.
- **Per page by design.** A fields-only batch tool (`set_fields`) was built and cut; the
  reasoning is in `docs/roadmap.md`. **Do not re-add one without reading that item.**
- **The properties panel** (`PageProperties` in `app/views/PageView.tsx`) imports
  `isUsableFieldKey` from the write path rather than copying the rules, never edits `sources`
  or `updated`, and is offered in the viewer only, never in `EditView` (it would race the
  unsaved body).

## Retried writes: the write-attempt ledger

A gateway error on a write says nothing about whether the commit landed, and both wrong
guesses are silent (a retried `append` duplicates; a retried `mode: "create"` claims the page
exists). `guardedWrite` in `librarian.ts` wraps `write_page` / `move_page` / `delete_page`
through `src/lib/write-dedupe.ts` (pure) + `write-dedupe-store.ts` (D1, migration 0007),
`pnpm test:dedupe`.

- **Keyed on the CALL, never the commit:** SHA-256 over (actor, tool, canonicalized args),
  `brain` excluded. An append's bundle differs across a retry, so content fingerprints miss it.
- **The claim is taken BEFORE the handler and given back on any non-landing exit** (a refusal
  is deterministic; a leftover claim blocks the write for minutes).
- **It wraps the whole handler, not `commitBundle`**: the create case never reaches a commit.
- **Two windows:** `IN_FLIGHT_GRACE_MS` (2 min, then a claim is taken over) and `DONE_TTL_MS`
  (10 min replay). Rows are pruned by the next claim on the same brain; no prune job.
- **Fail open twice:** an unreachable ledger runs the handler as before, and bookkeeping after
  the write never changes the answer.
- **Accepted trade-off:** a deliberate identical write inside the done window is reported as
  already applied, and says so. `sync_records` has its own idempotency; editor saves are
  sha-guarded.

Coverage: `pnpm test:e2e-librarian` drives every write tool against a real brain (offline by
default), including every refusal proving nothing was written; `pnpm test:scope` asserts the
content writes gate on the BRAIN role at `editor`.
