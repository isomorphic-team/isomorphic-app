---
paths:
  - "src/lib/{views,view-directives}.ts"
  - "scripts/test-views.ts"
---

# Derived views (`okf-view`)

Spec: `docs/design/derived-views-and-sync-prd.md`. A page declares a computed view as a fenced
` ```okf-view ` block. Engine: `src/lib/views.ts` (index-coupled) + `src/lib/view-directives.ts`
(pure parse/segment/snapshot layer, safe for the app bundle). `pnpm test:views`.

Grammar: `kind` is the SOURCE (`backlinks` of `of`/this page; `pages`, optionally `under:
<prefix>`; `folders` = direct sub-folders of `under`, each represented by its folder note,
`under` defaulting to the page's own directory). `as` is the RENDERING (`list|table|count`).
Plus `filter`, `group-by`, `columns`, `describe`, `sort`/`order`, `label`. `kind: count` is
backlinks + `as: count`. A directory index is `kind: pages` + `under` + `group-by`.
A `filter` value is equality (one value or any of a list, case-insensitive) unless it starts
with an operator: `<`, `<=`, `>`, `>=` take a number, `YYYY-MM-DD`, `today` or a day offset
(`-30d`, `+7d`, UTC); `!=` also takes text. A missing or non-comparable field never matches an
operator, `!=` included. Parsed into `ViewSpec.conditions` and matched by `matchesCondition`
(pure); `ViewContext.today` pins the date in tests.

Rendering: column headers and lowercase group values are humanized (`next_step_due` becomes
"Next step due"); `group-by` on a key that is also a list filter orders groups by that list,
otherwise alphabetically, with "(none)" last. In `display` only, `YYYY-MM-DD` cells read
"Oct 16 · in 12 days" (or "N days overdue" under a `due` / `*_due` / `*_due_date` key); the
snapshot keeps the raw value so a saved file does not change from day to day.
`FOLDER_NOTE_NAMES` lives here as the single source of truth.

- **Three renderings from one source.** `display` (fence replaced by the live result; what
  `view_page` serves), `snapshotted` (fence + cached rendering between `okf-view:snapshot`
  markers; what is written to the file and what `read_page` serves), `stripSnapshots` (what
  `edit_page` sends the editor, so generated content never round-trips ProseMirror).
- **The snapshot is cosmetic fallback only**, for github.com and raw OKF readers. It refreshes
  only when its own page is written through our tools. Executing consumers compute live from
  the index, after `ensureFresh`.
- **Fail open everywhere:** a view failure falls back to raw content and never blocks a read or
  a save. Malformed directives render a visible note.
- `write_page` edits aimed inside a snapshot region are refused (that text regenerates on save).
