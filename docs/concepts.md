# Concepts

Every concept the product has, with its one meaning and where it lives. A design or a change
names the rows it uses. A change that needs a new concept adds a row in the same pull request
and says why no existing row does the job. Changing what a row means is a product decision for
the maintainer, not a refactor.

State is **built**, **designed** (a design exists, no code) or **proposed** (part of the
vision, not yet designed in detail). **Built in part** means the row's "Lives in" says which part.

## Content

| Concept       | Means                                                                     | Lives in                                                       | State    |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| Brain         | A tree of markdown files in one store                                     | `BrainStore`, `src/lib/brain-repo.ts`                          | Built    |
| Page          | One markdown file that models one concept, with a `type:` in frontmatter  | `src/lib/wiki.ts`                                              | Built    |
| Folder note   | A folder's overview page, `index.md`                                      | `FOLDER_NOTE_NAMES`, `src/lib/view-directives.ts`              | Built    |
| Content index | A derived cache of pages, links and fields, never the source of truth     | `BrainIndex`, `src/lib/brain-index.ts`                         | Built    |
| Live view     | A listing or count computed from the index where an `okf-view` fence sits | `src/lib/views.ts`                                             | Built    |
| Import        | Pages kept in step with an outside source by key, through `sync_records`  | `src/lib/brain-import.ts`                                      | Built    |
| Record        | A dated occurrence that points at pages through wikilinks                 | [`design/records-tables-prd.md`](design/records-tables-prd.md) | Designed |
| Publication   | A declared one-way copy into a brain its reader can open                  | [`design/brain-seams.md`](design/brain-seams.md)               | Designed |

## People and access

| Concept      | Means                                                      | Lives in                                | State |
| ------------ | ---------------------------------------------------------- | --------------------------------------- | ----- |
| Organization | A permission grouping of members and brains                | `src/lib/orgs.ts`                       | Built |
| Member role  | What a person may do: viewer, editor, admin or owner       | `effectiveBrainRole`, `src/lib/orgs.ts` | Built |
| Sharing      | Access to one brain, separate from organization membership | `share_brain`                           | Built |
| Entitlement  | An organization's right to an enterprise feature           | `hasFeature`, `src/lib/entitlements.ts` | Built |

## Keeping brains true

| Concept           | Means                                                                         | Lives in                                       | State |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | ----- |
| Defect            | Something wrong with one right answer, such as a broken link. Never dismissed | `validate`                                     | Built |
| Finding           | Something a person decides about, with a stable key and a recorded answer     | `src/lib/findings.ts`, `resolve`               | Built |
| Tension           | A finding computed from structure alone, with no model                        | `computeTensions`, `src/lib/consolidate.ts`    | Built |
| Review queue      | Findings stored in D1, by kind, with visibility per kind                      | `QueueKind`, `src/lib/review-queue.ts`         | Built |
| Pass              | A budgeted, resumable sweep over content that produces findings               | `src/lib/brain-pass.ts`                        | Built |
| Organization pass | A scheduled pass across an organization's brains, run as the organization     | `src/lib/org-pass.ts`, `ee/review/org-pass.ts` | Built |
| Consolidation     | The pass that finds pages contradicting or duplicating each other             | `ee/review/consolidation.ts`                   | Built |
| Guard             | The check on every write against the brain's data policy                      | `guardStore`, `src/lib/policy-guard.ts`        | Built |
| Model gateway     | The only path from a pass to a model provider                                 | `ee/review/gateway.ts`                         | Built |

## Roles, the org view and the self

From [`design/roles-self-and-world-model.md`](design/roles-self-and-world-model.md) and
[`design/self-and-executive.md`](design/self-and-executive.md).

| Concept          | Means                                                                           | Lives in                                                                                                                                                                                                                                                                                                                                                                                      | State         |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Brain role       | What a brain is for: the facts it owns, the brains it watches, its stance       |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Role declaration | Where a brain states its role, in `.isomorphic.json`                            | `charter.orgChecks`, `src/lib/brain-config.ts`. Owns and watches are not built                                                                                                                                                                                                                                                                                                                | Built in part |
| Org view         | A view computed over an organization's brains. It holds facts and writes none   |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Self             | A boundary of intent declared over brains, outside any brain and organization   |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Inside, sensed   | A brain within a self's boundary, or one the self reads without owning          |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Charter          | A self's values, intent and set points, written by its authors                  |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Executive        | An agent on the client side that senses, records and drafts for a self          |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Observation      | A dated, sourced record of what a source showed                                 |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |
| Expectation      | A dated record of what is expected, when to check, and what happened            | Page frontmatter `expected`, `check_at`, `outcome` and the `prediction-due` finding (`predictionDueFindings`, `src/lib/advisories.ts`). The check date is `check_at`, or a dated `due` or `revisit` when `check_at` is absent (`checkDateOf`). A claim's page shows its record through `RECORD_VIEW` (`src/lib/view-directives.ts`), which lists pages with `check_at`. Not built as a record | Built in part |
| Provenance       | Whether a record is inferred, observed or confirmed. Inferred is never evidence |                                                                                                                                                                                                                                                                                                                                                                                               | Proposed      |

Two lines hold the rest in place. The platform reads no outside source: sensing and acting
belong to the executive. A pass reads only what brains hold and writes only findings.

## Words with more than one meaning

Each of these is used for more than one thing today. Use the qualified form.

| Word     | Meanings                                                                                                                                             | Say                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Role     | A person's permission (`Role` in `src/lib/orgs.ts`), a path's kind (`PathRole` in `src/lib/brain-policy.ts`), and what a brain is for                | Member role, path role, brain role                 |
| Charter  | A self's values, intent and set points, and the `charter` key in `.isomorphic.json` that holds a brain's `orgChecks` (`src/lib/brain-config.ts`)     | Charter for the self; role declaration for a brain |
| Item     | The designs say "open item" and "item"; the code and the tools say finding                                                                           | Finding                                            |
| Record   | A row `sync_records` imports as a page, and a dated row in a records table                                                                           | Imported page; record                              |
| Source   | A `source/` area of a brain, the outside system an import follows (`source_key`), and what an observation cites                                      | Source area, import source, cited source           |
| Proposal | A change to a protected brain waiting as a pull request, a fix a consolidation finding suggests, and a row waiting to be admitted to a records table | Proposed change, proposed fix, proposed row        |
| Self     | Only the declared boundary. The computed view over an organization is the org view                                                                   | Self; org view                                     |
