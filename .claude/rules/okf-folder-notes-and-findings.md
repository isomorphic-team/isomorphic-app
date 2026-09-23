---
paths:
  - "src/lib/{advisories,findings,consolidate,probe,wiki,view-directives,server-instructions}.ts"
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
handshake (`initialize`, or `server/discover` on 2026-07-28), so it cannot be per brain: it
would go stale on `switch_brain`.

## `validate` and `resolve`: defects vs findings

`validate` reports two things. **Defects** (broken links, `brokenLinkReport`) have one right
answer, carry no key, and cannot be silenced. **Findings** are advisory, carry a stable
`[key]`, and can be answered with `resolve` (editor+, in `src/tools/importer.ts`). Nothing
advisory blocks a save.

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
- **`src/lib/consolidate.ts`** (pure, `pnpm test:consolidate`) detects where a brain's cheap
  surface disagrees with its content: islands, orphans, note-less and hollow folder notes,
  mixed conventions, folder-echo pages, near-duplicates (bigram Jaccard, skipped above
  `MAX_DUP_PAGES`, and the report says so). Computed, never generated: deciding costs tokens
  in the caller's session. `pnpm consolidate:report <folder>` runs it offline.
- `resolve` actions: `dismiss` / `undismiss` for structure and consolidation findings;
  `delete` / `alias` / `suppress` / `recreate` for import findings.
- Design: `docs/design/consolidation-loop.md`, `docs/design/folder-notes-and-okf-conformance.md`.
