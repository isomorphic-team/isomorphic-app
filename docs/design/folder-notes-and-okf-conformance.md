# PRD: Folder Notes and OKF Conformance (splitting the listing from the overview)

- Status: Draft, not started. Written 2026-08-11.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-11
- Audience: the engineering session picking this up in `isomorphic-app`
- Related: `docs/design/records-tables-prd.md` (surfaced this; §10 there), `CLAUDE.md`
  (Folder notes, Derived views, Open Knowledge Format)

## 1. Summary

A folder note (`index.md`, or `README.md` as fallback) currently does two jobs in one file:

- it holds an **authored overview** of the folder, with frontmatter, a type, and narrative
- it holds a **generated listing**, an `okf-view` directive plus its regenerated snapshot

OKF forbids the combination, because `index.md` is a reserved name that "MUST NOT be used for
concept documents" and may not carry frontmatter outside a bundle-root `okf_version`. But the
conflation is worth undoing even setting conformance aside: the two halves have different
owners, different lifecycles, and, most concretely, they share a git history that should be two.

This PRD splits them. The authored overview moves to a non-reserved filename and keeps the view
directive; `index.md` becomes a tool-maintained materialization of that directive. Nothing
changes about what a reader sees when they click a folder.

## 2. Background

### What OKF requires

> The following filenames have defined meaning at any level of the hierarchy and MUST NOT be
> used for concept documents: `index.md` (Directory listing) and `log.md` (Update history).

`index.md` "may appear in any directory to enumerate contents for progressive disclosure, using
sections with linked entries and descriptions." A bundle-root `index.md` may carry
`okf_version`, "the sole exception permitting frontmatter in index files." Both files are
optional.

So OKF's `index.md` is navigation. Isomorphic's folder note is a concept: the page that *is*
the folder, which the app opens on folder click and which `kind: folders` views link to.
Different things wearing one filename.

### What the code actually does (verified)

- **`FOLDER_NOTE_NAMES = ['index.md', 'README.md']`** (`src/lib/view-directives.ts:20`), with
  `isFolderNoteName` re-exported to the app (`app/core/util.ts:6`). Nine call sites across
  `views.ts`, `wiki.ts`, `custom-tools.ts`, `librarian.ts`, `Breadcrumb.tsx`, `actions.ts`, and
  `Browse.tsx`, all funnelling through that one constant. The concept is centralized, which is
  what makes this tractable.
- **Existing brains are mostly fine.** In a real ~3,900-page brain, the folder notes carry no
  frontmatter at all: an `# H1`, a sentence, an `okf-view` fence and its snapshot. That is
  conformant. The bundle-root `index.md` carries only `okf_version`, which is the permitted
  exception. That brain was produced by an external ETL and got it right.
- **The platform is what introduces violations.** `updatePageWrite`
  (`src/tools/librarian.ts:744`) sets `manageFm` only when the page already has frontmatter or
  the caller passes `title`/`type`/`description`/`status`/`fields`; otherwise it writes the body
  as-is. That is correct. But `folderNoteSeed` (`app/views/Browse.tsx:150`) returns a `title`,
  and both call sites (`:597`, `:646`) pass it into `write_page`. **Every folder note created
  through the app is therefore born with `title:` and `updated:` frontmatter in `index.md`**,
  and once a page has frontmatter, `updated:` is re-stamped on every subsequent write.
- **That `title` is redundant.** `pageTitle` (`src/lib/wiki.ts:228`) already resolves declared
  `title:` → first `# H1` → filename, with an explicit folder-note case (`:235`) returning the
  *folder's* name. Seeding an `# H1` instead of passing `title` produces an identical
  user-visible result from a conformant file.
- **Reserved names are indexed as ordinary concepts.** `src/lib/brain-index.ts` has no exclusion
  for `index.md` or `log.md`. They are listed by `list_pages`, returned by `search_pages`,
  resolvable as wikilink targets by title, and counted against `MAX_SCAN_PAGES`.
- **`brain-template/` scaffolds no `index.md`**, so nothing is inherited at brain creation.
  Folder notes come from the app's "Add folder note" affordance and from agents writing them.

### The problem that is not about OKF

Regenerating the listing rewrites the file that holds the prose. Adding one page under
`vendors/` regenerates `vendors/index.md`'s snapshot, so that file shows a diff although nobody
edited a word of it. Every listing regeneration dirties the authored document, and `git log` on
a folder note is mostly noise about pages appearing elsewhere.

Split, and a prose edit and a listing regeneration are separate files with separate diffs. This
is the strongest argument for the change and it stands on its own.

## 3. Goals / non-goals

**Goals**

- The platform stops creating non-conformant files.
- An authored folder overview can carry frontmatter, a type, and narrative, legally.
- `index.md` becomes a conformant directory listing, tool-maintained.
- What a reader sees on folder click is unchanged.
- Migration of existing brains is advisory, never forced.

**Non-goals**

- Dropping `index.md` as a folder note. It is load-bearing for click-to-open, the tree, and
  `kind: folders`, and it is what people reach for.
- A fleet-wide rewrite of existing brains.
- Resolving the `README.md` divergence (a folder note in a non-reserved name is legal under OKF;
  it merely owes a `type`). Out of scope, noted in `CLAUDE.md` already.
- Changing `log.md`, which is already tool-maintained and already conformant.

## 4. Design

### FR-1: The authored overview moves to a non-reserved name

Extend `FOLDER_NOTE_NAMES` to `['overview.md', 'index.md', 'README.md']`, with `overview.md`
taking priority. Purely additive: no existing brain changes behavior, because a folder with only
`index.md` still resolves exactly as it does now.

`overview.md` is the recommended name because `folderNoteSuggestions` (`src/tools/librarian.ts`)
already treats `overview|about|home|summary|start-here` as overview-shaped filenames when it
suggests promoting a page to a folder note. The vocabulary exists in the codebase.

**Rejected alternative: a sibling concept document** (`vendors.md` beside `vendors/`, which is
what the records PRD does for table declarations). It is the most conformant option, but it puts
the concept outside the subtree, so `move_page` and `delete_page` on a folder would have to
reach outside the folder they are operating on. Keeping the note inside the folder leaves both
untouched.

### FR-2: The directive stays in the authored file; `index.md` materializes it

This is the load-bearing decision. The `okf-view` directive lives in `overview.md`, exactly
where it lives today, and `index.md` is generated from it.

`vendors/overview.md`:

````markdown
---
type: Area
title: Vendors
description: How we evaluate and track vendor relationships
---

# Vendors

We track a vendor here once it reaches contract review. Anything earlier lives in
the sales pipeline, not the brain.

## Current vendors

```okf-view
kind: pages
under: vendors/
group-by: status
describe: description
```

## How to add one

Create the page, set `type: Vendor`, and link the signed contract.
````

`vendors/index.md`, generated, no frontmatter:

```markdown
# Vendors

## Active
- [Acme](acme.md) - Payments processor
- [Northwind](northwind.md) - Data warehouse

## In review
- [Contoso](contoso.md) - Identity provider
```

Consequences worth stating:

- **Composition needs no new machinery.** A page containing a view is what pages already are.
  The viewer renders `overview.md` with the listing computed live in place.
- **Placement is author-controlled**, for free. The listing goes wherever the fence goes: above
  the prose, below it, twice with different groupings. No convention to memorize, no config.
- **The two files cannot disagree**, because they derive from one directive.

### FR-3: `index.md` becomes tool-maintained

Add it to `isToolMaintained` alongside the changelog, so `write_page` refuses direct writes with
a pointer to the overview. Regeneration happens on save of the folder note, in the same
`commitFiles` bundle, so the pair moves atomically.

This restores a property `index.md` had before the taxonomy removal in 2026-07, when it was
tool-maintained and was demoted because regeneration clobbered human edits. Giving humans their
own file is what makes it safe this time.

### FR-4: Reserved names leave the concept index

`index.md` and `log.md` stop being indexed as pages: not in `list_pages`, not in
`search_pages`, not resolvable as wikilink targets, not counted against `MAX_SCAN_PAGES`.

Without this, generating a listing into every folder creates a duplicate shadow page per folder
that pollutes search and competes for `[[Vendors]]`. With it, the rule is principled rather than
a special case: OKF says reserved names are not concept documents, so they do not belong in a
concept index. It also slightly *reduces* page count, which is a small assist to the ceiling
discussed in the records PRD.

**This step is only safe after FR-1 and a migration**, because today `index.md` legitimately
holds concepts. Doing it early silently removes real content from search. See §5.

### FR-5: Stop stamping frontmatter into `index.md`

Drop `title` from `folderNoteSeed` and emit an `# H1` in the seeded content instead. Roughly
three lines, no migration, no format change, no existing brain touched, and it stands alone:
worth doing even if nothing else in this PRD ships, because the platform manufacturing its own
violations is a different problem from tolerating inherited ones.

### FR-6: `validate` advises, and never blocks

`folderNoteSuggestions` already flags a note-less folder holding an overview-shaped page and
names the `move_page` that fixes it. Point the same mechanism the other way: a **concept-shaped
`index.md`** (frontmatter present, or prose beyond a listing) gets an advisory naming the
`move_page` to `overview.md`. Same code shape, opposite direction, same advisory-never-blocking
posture every other OKF check has.

### FR-7: Tell the model in the usual three places

`SERVER_INSTRUCTIONS`, `write_page`'s `path` description, and `brain-template/AGENTS.md`. This
is the established pattern for conventions with no in-band signal, and it is how folder notes
and OKF granularity are already communicated.

## 5. Sequencing (the order is forced)

| # | Step | Safe today? |
|---|---|---|
| 1 | FR-5: stop stamping frontmatter | Yes. Additive, no migration. |
| 2 | FR-1: add `overview.md` to the folder-note names | Yes. Purely additive. |
| 3 | FR-2 + FR-3: generate `index.md`, mark it tool-maintained | After 1 and 2 |
| 4 | FR-6: the inverse `validate` advisory | After 2 |
| 5 | Migration: brains move authored content to `overview.md` | Advisory, ongoing |
| 6 | FR-4: reserved names leave the concept index | **Only after 5** |

Step 6 done early is the failure mode: it removes real, authored content from search and from
wikilink resolution in every brain that still keeps its overview in `index.md`.

Steps 1 and 2 are worth landing independently of whether the rest is ever built.

## 6. Migration

Advisory, never forced, consistent with every other OKF rule in this codebase.

The mechanical part is a single `move_page` per folder (`index.md` → `overview.md`), which
already repoints inbound links across the brain. FR-6's advisory names it. A brain that never
migrates keeps working: `index.md` remains a valid folder note in `FOLDER_NOTE_NAMES`, it simply
stays non-conformant and keeps its entangled git history.

For brains with many folders, this is a natural fit for the fleet-wide schema migration work
already on the roadmap rather than a bespoke tool.

## 7. Risks

- **Two files per folder reads as clutter.** Mitigated by hiding the generated `index.md` in the
  tree the way the folder note's own row is already hidden as a redundant sibling. It remains
  visible on github.com, which is its whole purpose.
- **Write amplification.** Saving an overview also writes `index.md`. One extra blob in the same
  atomic bundle; negligible next to the read path.
- **Conformance nobody is checking.** No OKF consumer reads these brains today, and a strict one
  encountering a prose-heavy `index.md` would degrade rather than break. This is a milder
  divergence than `[[wikilinks]]`, which is accepted as deliberate. The honest case for this
  work rests on the git-history argument in §2 and on FR-5's three-line fix, not on conformance
  for its own sake.
- **Name churn.** `index.md` is what people and agents reach for. FR-1 keeps it working, so the
  cost is a convention to teach (FR-7) rather than a breakage.

## 8. Open questions

1. **A folder with no overview, or an overview with no directory view.** Generate a default
   listing so external readers always get progressive disclosure, or generate nothing? Leaning
   toward nothing: OKF makes both index and log optional, and a file that appears without anyone
   asking for it gets deleted repeatedly and then reported as a bug.
2. **Should `overview.md` outrank `README.md`?** Proposed order puts `README.md` last, so an
   Obsidian-style vault that already uses it is unaffected unless it adds an overview.
3. **Does the generated `index.md` belong in `view_activity`?** It will produce a commit entry
   per listing change. Probably filter it, for the same reason it is hidden in the tree.
4. **Wider reserved-name handling.** FR-4 excludes `index.md` and `log.md` from the concept
   index. `tools/` pages have a similar "not really content" character and are explicitly still
   listed as ordinary pages (`CLAUDE.md` → User-defined tools, "Not built"). Worth deciding
   whether these are one mechanism or two.
