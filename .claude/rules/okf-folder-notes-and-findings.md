---
paths:
  - "src/lib/{advisories,findings,consolidate,probe,wiki,view-directives,server-instructions,review-checks}.ts"
  - "src/tools/{librarian,importer}.ts"
  - "brain-template/**"
  - "app/core/util.ts"
  - "app/views/Browse.tsx"
  - "scripts/{test-structure,test-consolidate,test-links,consolidate-report}.ts"
---

# OKF conformance, folder notes, and the findings loop

## Open Knowledge Format

Brains target Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(OKF v0.2). **Read the spec before asserting anything about it**: it postdates most training
data, and `okf-view` is OUR directive syntax, not part of OKF. OKF constrains: every concept is
its own `.md` file; `type:` is the one required frontmatter field (a free-form string, not a
taxonomy); `index.md` / `log.md` are reserved for listing and history; links are ordinary
markdown; consumers tolerate missing fields, unknown types and broken links.

- **One page = one concept.** A concept is the recurring named thing; a record is a dated
  occurrence. Concepts written as sections inside a folder note have no path, so they are
  unlinkable, untypeable and invisible to search and views.
- **`write_page` takes a `type` argument** (a schema slot beats prose the model may not read),
  writes it first in generated frontmatter, and falls back to a `type` in the content's own
  frontmatter.
- **Nested frontmatter is preserved verbatim** (`FrontmatterBlock` in `wiki.ts`): replayed byte
  for byte, never interpreted, not indexed, and treated as never-equal by the importer. The
  flat parser once destroyed provenance (`generated:`, `sources:`) on first save.
- **One title resolver** (`pageTitle` in `wiki.ts`): `title:` > first body `# H1` > filename,
  or the folder's name for a folder note. Wikilinks resolve by title, so widening this widens
  what `[[Foo]]` finds. Never write a second fallback.
- **Accepted divergences:** `[[wikilinks]]` are an Isomorphic extension; `README.md` as a
  folder note is not an OKF reserved name.

## Folder notes

A folder with a direct child `index.md` (preferred) or `README.md` IS that page. Names live in
`FOLDER_NOTE_NAMES` (`src/lib/view-directives.ts`), re-exported by `app/core/util.ts`, so the
tree, the trail and the view engine cannot disagree.

- **File tree:** clicking a folder opens its note, and the note's own row is hidden; a
  note-less folder expands, and hovering offers "Add folder note" (writes `index.md` seeded
  with a directory view). **The trail does not do this:** a folder crumb always opens the tree
  at that folder, so one control never does two different things.
- `README.md` is accepted for Obsidian/GitHub-convention vaults; `index.md` is what we write.

## Telling the model (the descending-reach pattern)

A convention with no in-band signal is stated in three places, in order of reach:
`SERVER_INSTRUCTIONS` (`src/lib/server-instructions.ts`; reaches every brain, including
adopted repos with no `AGENTS.md`), the tool's own description or argument (the point of
decision), and `brain-template/AGENTS.md` (scaffolded brains). Folder notes, one-concept pages,
and "metadata is a field write" all follow it. `instructions` is sent once per connection
handshake (`initialize`, or `server/discover` on 2026-07-28), so conventions in it cannot be
per brain: they would go stale on `switch_brain`. The per-caller section the Worker appends
(`composeInstructions`) lists brains only, as a snapshot that says so.

## `validate` and `resolve`: defects vs findings

`validate` reports two things. **Defects** (broken links, `brokenLinkReport`) have one right
answer, carry no key, and cannot be silenced. **Findings** are advisory, carry a stable
`[key]`, and can be answered with `resolve` (editor+, in `src/tools/importer.ts`). Nothing
advisory blocks a save. A third section, shown to brain admins only, counts open policy findings and
states the guard's coverage (`detectionSection`, see `write-path.md`); the findings themselves
are in the list, with keys.

- **`src/lib/findings.ts`** owns the `Finding` type, keys, and the dismissal ledger at
  `.isomorphic/review.json` in the brain. **Keys are an interface:** derived from kind plus
  the paths involved, never from the headline, so rewording or retitling never resurrects a
  dismissal. Import findings route to the importer's per-source ledger instead.
- **`src/lib/advisories.ts`** (pure) produces the structure findings: `folderNoteSuggestions`
  (a note-less folder holding an overview-shaped page; silent otherwise),
  `inlinedConceptSuggestions` (a folder note with 4+ prose sections that should be pages,
  tuned against false positives), `typeFieldSuggestions` (inconsistency, not absence),
  `ambiguousTitleSuggestions`, `wikilinkPortabilityNote`, plus `brokenLinkReport`. Anything
  needing a `BrainContext` belongs back in the tool.
- **`predictionDueFindings`** (`advisories.ts`, pure) lists a concept page whose check date
  is on or before today and that has no non-empty `outcome`. `checkDateOf` reads the date: the
  first `check_at` (via `datePart`; unparseable values are ignored), else the first dated `due`,
  unless the page has `source_key` or `source_keys` or a closed `status`,
  `state` or `stage` (`CLOSED_STATUSES`, which includes `lost` and `won`). A page's `check_at` closes only on `outcome`. A follow-up date gets a neutral line
  ("due D (from `due`), nothing recorded") offering an outcome or a new date. `RECORD_VIEW` still lists `check_at` pages only. The line quotes `expected`. Key
  `prediction-due:<path>@<date>`, so a dismissal covers that date and re-dating raises it again. Computed on each `validate` call
  and never queued (the queue is for findings that take work to produce). It reads indexed
  fields, so a brain whose `indexedFields` omits `check_at` (or `due`), or a page whose `check_at` sits
  past `MAX_FIELD_KEYS_PER_PAGE`, is never raised. The Review screen (`view_review`) shows only
  policy findings, so this appears in `validate` alone.
  **`comingDueLines`** is the same read for a check date after today and within
  `COMING_DUE_DAYS` (7): an unkeyed list opening the `validate` result (earliest first,
  at most `MAX_COMING_DUE_LINES`; `dueBlock` prints one line when nothing is due, so a person is
  never told nothing else is due while a date sits in a field it does not read), not a finding, so there is nothing to
  dismiss, and a page is never in it and in `prediction-due`. The `write_page` reply carries
  `expectationNote` (`change-record.ts`), at most one per write: for a new Decision or
  Commitment page with no check date or `outcome`, for an update that set `expected` on a page
  with no check date, or, on a page of another type with no check date or `outcome`, when the
  text the write added matches `hasDeadlinePhrase` (by, before, until or due, then a weekday,
  month, ISO date or "next week").
- **`otherDueLines`** (`advisories.ts`, pure) lists, unkeyed and after the due block, the dates
  kept under any other deadline-named key (`DUE_KEY` in `view-directives.ts`, shared with the
  `display` rendering; never `check_at` or a `FOLLOW_UP_DATE_KEYS` key) that are today, past or
  within `COMING_DUE_DAYS`, on a concept page with no `outcome`, `source_key` or closed value.
  Next days first, then the most recently passed; `MAX_OTHER_DUE_LINES` (8), then a tail line
  naming the oldest date. Not a finding: these dates recur, so an outcome does not fit. Both
  lists share `capLines`.
- **`undatedCommitmentFindings`** (`advisories.ts`, pure) is the absence half of a commitment:
  a concept page whose first `type` matches `COMMITMENT_TYPE_RE` (decision or commitment),
  that says it is open (a `state` value, or a `status` value that is neither closed nor one of
  `OKF_PAGE_STATUSES`, which describe the page, not the commitment) and has no closed value in
  either key, with no `checkDateOf` date,
  no non-empty `outcome` or `revisit`, and no `source_key` or `source_keys`. A page with no
  status field raises nothing, because a brain whose decisions are records would otherwise be
  flooded. Key `undated-commitment:<path>` (the path alone, so a dismissal survives edits),
  weight 2, below `prediction-due`. The headline names the key and value the page uses and,
  when present, its `raised` date as found; nothing is computed from it. `updated` is not shown:
  it is stamped on every save. No per-kind cap: `renderFindings`' limit is the only one.
- **`src/lib/consolidate.ts`** (pure, `pnpm test:consolidate`) detects where a brain's cheap
  surface disagrees with its content: islands, orphans, note-less and hollow folder notes,
  mixed conventions, folder-echo pages, near-duplicates (bigram Jaccard with each folder's
  template removed, paired through an inverted index, skipped above `MAX_DUP_PAGES`, and the
  report says so), and `same-identifier` (pages sharing a value in `identityFields`: `email`
  plus `"review": {"identityFields": [...]}`). Computed, never generated: deciding costs tokens
  in the caller's session. `pnpm consolidate:report <folder>` runs it offline.
- **`src/lib/review-queue.ts`** (`pnpm test:consolidate`) is the findings queue: D1
  `review_findings` (migration 0019), for findings that take work to produce. It is derived
  state, and a decision stays a dismissal in the ledger. Visibility is per kind
  (`canSeeFinding`), a row whose page shas no longer match is stale and only counted, and
  `upsertFindings` scrubs every row through the detectors. A conflict's key is the page pair
  plus a fingerprint of the disputed values (`conflictKey`), never the cluster. A cluster is a
  fact label for display (`clusterFindings` groups two or more in `validate`); `cluster:<label>`
  in `resolve` expands to one decision per member (`expandClusterDecisions`). A finding
  between two brains sits in the queue of the brain the check ran from, with that brain's page
  in `paths` and the other brain's in `other`. It quotes both, so `queueReport` shows it only
  to a viewer who can open the other brain (`reachableBrains` in `librarian.ts`), a change to
  either page makes it stale, its key names the other page by a digest (`otherPageRef`), and
  it is never clustered. It is listed ahead of a brain's own conflict findings
  (`ACROSS_WEIGHT`), so both copies fall inside `validate`'s cap and can be compared.
- **`review_brain` runs the deep passes; `validate` only reports.** Separate tools because
  hosts approve per tool and `validate` is a free read they run unasked, while a pass takes
  minutes and, for `contradictions`, model credits. What may run and `validate`'s line about
  the contradictions pass (admins only, where it can run) are `src/lib/review-checks.ts`: the
  line covers the brain's own pass and, when there is one, its pass against the
  organization's other brains (`readContradictionPassAcross`), which the organization's
  checks also advance.
  `against` on `review_brain` compares the brain with another in the same organization
  (`againstRefusal`); the caller needs admin on the first and any access to the second.
  `against: "all"` compares it with every other brain of its organization the caller can open
  (`brainsToCompare`), and names in its reply any it could not open (`resolveComparison`).
  The same pass runs on a schedule between the brains of an organization that take part
  (`BrainConfig.orgChecks`, set by `configure_brain` with `org_checks`), and at once with
  `against: "organization"` (`orgChecksRefusal`), which gates on the ORG role
  (`requiresOrg: 'admin'`, `pnpm test:scope`): see `ee.md`. A finding between two brains is
  in both queues, and `resolve` carries a dismissal to the copy (`answerLinkedFindings`).
  `configure_brain` still accepts the old `baseline_scan` / `consolidate` arguments only to
  answer with a pointer: dropped from the schema, they would make the call a layout write.
- `resolve` actions: `dismiss` / `undismiss` for structure, consolidation and policy findings
  (policy dismissals go to D1, see `write-path.md`);
  `delete` / `alias` / `suppress` / `recreate` for import findings.
- Design: `docs/design/consolidation-loop.md`, `docs/design/folder-notes-and-okf-conformance.md`.
