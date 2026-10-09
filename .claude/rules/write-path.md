---
paths:
  - "src/tools/librarian.ts"
  - "src/lib/{page-write,page-patch,change-record,write-target,write-dedupe,write-dedupe-store,brain-policy}.ts"
  - "app/views/{PageView,EditView}.tsx"
  - "src/lib/{policy-guard,policy-detectors,policy-store}.ts"
  - "scripts/{test-page-write,test-record,test-policy,test-dedupe,test-guard,test-pending-pr,e2e-librarian}.ts"
---

# The write path (`write_page`, `move_page`, `delete_page`)

## What `write_page` decides is pure

- **`src/lib/page-write.ts`** (`pnpm test:page-write`): `checkPageWrite` answers refusals that need
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
- **A brain has at most one open Isomorphic PR at a time** (`pnpm test:pending-pr`). Every
  write plans against `store.writeHead`, never `getHead`, and pins its reads to that head:
  with an `isomorphic/` PR open (not `isomorphic/configure`, not reported as conflicting),
  that is the PR's branch, and `commitOrPR` fast-forwards it, retitles it
  (`coalescedPrText`), updates it when it is behind the default branch, and arms auto-merge
  if needed. `edit_page` opens from the same head so the editor's sha matches. Reads,
  search and the index stay on the default branch.

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
  `isUsableFieldKey` from the write path rather than copying the rules, and never edits
  `sources` or `updated`. It is read-only in the viewer and editable only in `EditView`, as a
  draft that Save sends in the same `write_page` call as the body (`propertyWriteArgs`), so a
  page's properties and body land in one commit against one sha.

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

Coverage: `pnpm test:page-write` pins every refusal `checkPageWrite`, `planPageWrite` and
`applyFieldPatch` make, with its message. `pnpm test:e2e-librarian` drives every write tool
against a real brain (offline by default) and takes one refusal per deciding function through
its tool, proving nothing was committed; `pnpm test:scope` asserts the content writes gate on
the BRAIN role at `editor`.

## The data-policy guard

`guardStore` (`src/lib/policy-guard.ts`) wraps the `BrainStore` the Worker and the local
runtime hand to every tool, so it sees every write that reaches `commitOrPR` or `commitFiles`.
`pnpm test:guard`. Roadmap: "brain review".

- **On for every brain by default, and never blocking** (`shadow`, an internal name nothing
  user-facing shows). Only `"review": {"policy": {"mode": "off"}}` in `.isomorphic.json`
  turns it off; any other value keeps it on, and off returns the store untouched.
- **Shadow never blocks.** It scans the text writes (`encoding: 'base64'` is skipped), lets the
  write land, then records detections through `policy-store.ts` (D1 `policy_detections`,
  migration 0015). A failing recorder is swallowed; a failed write records nothing.
- **Detections carry offsets, never the matched text,** and the table has no column that could
  hold it. Keep it that way: copying a leaked secret into D1 makes the leak worse.
- **Admins read detections in `validate`** (`detectionSection`): the last
  `REPORT_WINDOW_DAYS` of rows as pages and kinds with counts. Brain admin and owner only,
  since a path plus a kind already says where sensitive data sits; editors and viewers get no
  section.
- **The app's Review screen** (`view_review` in `src/tools/apps.ts`, `app/views/ReviewView.tsx`)
  shows the same rows through `groupDetections`, the one ordering both surfaces use. The tool
  refuses below brain admin, and More offers Review (never the rail) only when the active
  brain's row says `canShare` (`activeBrainIsAdmin`), or on a single-user deployment, whose
  operator owns it.
- **The detectors (`policy-detectors.ts`) favor precision.** Emails and phone numbers are
  deliberately not detected, and PHI detectors fire only on labelled values. Add a negative case
  to the battery with any new detector.
