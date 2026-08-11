# PRD: Records Tables (dated activity against a brain's concepts)

- Status: Draft, not started. Written 2026-08-11.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-11
- Audience: the engineering session picking this up in `isomorphic-app`
- Related: `docs/design/derived-views-and-sync-prd.md` (the views engine and `sync_records`
  this builds on), `CLAUDE.md` (Brain model, Content index, Derived views, OKF)

## 1. Summary

A brain has exactly one content primitive: the **page**, which models a *concept*. There is
no home for a **record**: a dated occurrence that points at concepts. This PRD asks for one.

Concepts are stable and few. Activity against them is dated, high-volume, and unbounded.
Forcing the second into the first is the failure this fixes: a page per event evicts concept
data from the index, and the alternative that teams reach for instead (a free-text notes field
in some other system) is unqueryable by construction.

Four capabilities:

1. **Records tables**: brain-defined, arbitrary-schema tables whose rows link to pages, stored
   in the repo, indexed into D1, queryable through `okf-view`.
2. **Aggregation over records** in the views engine: group by any field or link, count, and
   filter by a date window.
3. **A proposal and approval ledger**: an agent proposes rows from an external signal, a human
   admits them per item, and declines are durable.
4. **Attested counts** (optional layer): provenance, period close, and an audit trail, for
   deployments where a count is consequential outside the system.

## 2. The general shape

Across every use case surveyed in §3, an activity record has the same four roles:

| Role | What it is | In the brain |
|---|---|---|
| **Subject** | the concept the activity is *about* | an existing page |
| **Actor** | who did it, on our side | an existing page (a person) |
| **Work unit** | what the activity serves, and the axis it groups by | a page, **often missing today** |
| **Record** | the dated occurrence: when, what kind, what outcome, what was said | new |

The work unit is the interesting one. Teams consistently track activity against *entities*,
because the systems they use are entity-shaped, and consistently fail to track it against *the
work*, because there is no field for it. That is where the value concentrates: "who is
outstanding on this piece", "which candidates are still in this req", "what happened during
this incident" are all work-unit questions and none of them are answerable from an
entity-keyed notes field.

It is nonetheless **optional**. Personal relationship tracking has no work unit and is still a
valid instantiation.

## 3. Use cases

| Domain | Subject | Actor | Work unit | Record | Count that matters |
|---|---|---|---|---|---|
| Editorial | source | reporter | story | outreach, response, interview | touches per contributor |
| Recruiting | candidate | interviewer | requisition | screen, interview, reference | panel load, time in stage |
| User research | participant | researcher | study | session | participants per study; over-research |
| Sales / BD | account contact | rep | opportunity | conversation | activity per rep, stage aging |
| Legal | matter party | attorney | matter | activity | **billable hours, which get invoiced** |
| Incident response | service | responder | incident | timeline event | incidents per service |
| Grantmaking | grantee | program officer | grant | site visit, report | reporting compliance |
| Personal | person | (the owner) | *(none)* | interaction | who has gone cold |

The variation across these rows is **entirely in the schema**, which is why the schema has to
be brain-defined rather than shipped. The mechanics (dated rows, links into the page graph,
group-and-count, date windows, propose-and-approve) are identical in all eight.

Two rows are worth calling out. **Legal** is the strongest form of §6's FR-4: billable hours
become invoices, so a wrong count is a billing error with client and regulatory consequences,
which is a harder bar than any internal metric. **Personal** is the weakest form and proves the
work unit optional; it also matters because a personal brain is a real user of this platform,
not a hypothetical.

## 4. Why the existing primitives do not cover it

- **Page per record** blows the index. A brain at ~4,000 concept pages taking on even 12,000
  records a year crosses `MAX_SCAN_PAGES` (5,000) within months, at which point event data
  evicts concept data and *the concepts themselves* become unfindable. It also breaks the
  human-review premise: nobody reviews a diff of 200 machine-written files.
- **Frontmatter on the subject page** holds a summary (`last_contact`, `contact_count`) but
  not the history, and `MAX_FIELD_KEYS_PER_PAGE` (24) bounds how much summary fits.
- **`sync_records`** is the right *shape* (upsert by key, source-owned fields, human edits
  sacred, no-resurrection ledger) but its target is pages, so it inherits the page problem.
- **A markdown table inside a page** works up to a few hundred rows and then stops: it is not
  queryable by `okf-view`, and a cell cannot hold a payload with newlines.

### Root cause

The same shape as the derived-views PRD's root cause, one level down. There, one primitive
(the static page) was doing two jobs (authored content and derived views). Here, the page is
being asked to do a third job it is structurally wrong for: holding an unbounded, append-only,
machine-generated series of dated events.

## 5. Goals / non-goals

**Goals**

- A records primitive: brain-defined tables, arbitrary schema, rows that link to pages.
- Records live in the repo as the source of truth and index into D1 as a derived cache, with
  the same rebuild-from-content property pages have.
- `okf-view` can group and count records, and filter them by a date window.
- Agent-proposed, human-admitted capture, with durable declines.
- Counting defensible enough to underwrite a consequential number, where a deployment needs it.

**Non-goals**

- A general database. See §9 for where the line sits and why it matters.
- Cross-table joins, or aggregation beyond count and sum.
- A records authoring UI beyond rendering views in the app.
- Fully automatic capture with no approval step.
- Shipping any domain's schema. The platform ships the primitive; brains define tables.

## 6. Functional requirements

### FR-1: Records tables

**FR-1a: A table is declared by a page.** The folder note of a records folder carries the
schema in a fenced `okf-table` block, following the precedent set by `okf-view` and `tool`:
a small line grammar, not YAML, so it survives the flat frontmatter parser and ProseMirror
round-trips.

````markdown
---
type: Record Table
title: Interactions
---

# Interactions

Every substantive contact between our staff and a tracked source. One row per
conversation, not per message in a thread. A row is valid with only a date, a
subject, and a kind; everything else is optional.

```okf-table
key:   id (string) source-derived dedupe key
field: occurred_at (date, required)
field: kind (enum: outreach|response|interview|briefing)
field: outcome (enum: asked|responded|declined|no_response|delivered)
link:  subject (page[], under: people/) who it was with
link:  actor (page, under: people/) our side
link:  unit (page, under: stories/) what it was for
field: gist (text) one line
```
````

The body matters as much as the fence. The definition of what counts sits beside the schema,
written by whoever owns it, and it is what an agent reads before proposing rows. Schema and
documentation cannot drift because they are the same file.

**FR-1b: Rows are stored record-per-section, not row-per-line.** A markdown table cannot hold
a payload with newlines, and a record's prose field has to tolerate a paragraph. Each record is
one H2 section: a heading carrying the key, a list of scalar and link fields, then free prose.

```markdown
## mail:CAF%3D9x2k...@example.com
- occurred_at: 2026-08-07
- kind: response
- outcome: responded
- subject: [[people/jane-doe]]
- actor: [[people/alex-example]]
- unit: [[stories/example-piece]]

Free prose, newlines and all, as long as it needs to be.
```

Rationale: diffs cleanly (a new record is a contiguous added block), holds arbitrary prose,
stays hand-editable, renders on github.com, and the parse layer is close to the one that
already exists for pages.

**FR-1c: Shard by period.** `records/<table>/YYYY-MM.md`. The binding reason is indexing cost:
the indexer finds changed content by diffing blob shas, so a single file means every append
re-parses every record ever written, a per-write cost that grows with table age and never comes
down. Sharded, only the current shard's sha moves and closed shards are indexed exactly once.
This is the same "no unbounded work in one read" rule that governs `rebuildDerivedFromStore`.

Sharding does **not** solve concurrent appends; two people writing the same shard still
collide. That needs optimistic retry on a stale sha, which `commitFiles`'s atomicity already
makes safe: a conflicting write fails cleanly rather than half-applying, and the caller retries
against the new head. Build it in from v1; it appears the first week two people use a table.

**FR-1d: `link:` fields join the existing link graph.** A link field's value is a wikilink, and
the indexer writes it into the link graph. This is the central design decision of the PRD: **do
not invent a foreign key.** Making the reference an ordinary link means backlinks,
`find_inbound_links`, `validate`'s broken-link report, the graph view, and `move_page`'s
inbound repointing all cover records with no new machinery. A record pointing at a deleted page
becomes a broken link, reported by the tooling that already reports broken links.

`page[]` (a list) carries multi-participant records without duplicating the row. This matters
more than it looks: in every entity-keyed notes field examined, the observable defect was the
same record pasted onto each participant, because there was no way to express one occurrence
with several subjects. The duplicates *are* the missing many-to-many.

**FR-1e: Records index into D1 as a derived cache.** New tables (`brain_records`,
`brain_record_links`), populated by the same `ensureFresh` path pages use, rebuilt lazily from
stored content on a schema-version bump, budgeted and resumable. Records are never the D1 row
of record; the repo is. A brain must survive a full index wipe.

**FR-1f: `validate` reports records.** Schema violations (unknown field, bad enum value,
malformed date), duplicate keys within a table, and links to nonexistent pages. Advisory, never
blocking, consistent with every other `validate` check.

### FR-2: Aggregation in `okf-view`

**FR-2a: `kind: records` as a view source**, with `of: <table>`, `where`, `group-by`, `sort`,
`columns`, and `as: list|table|count`, matching the existing directive vocabulary.

**FR-2b: Group by a link field.** Grouping records by `unit` is what produces a work-unit
pipeline; grouping by `actor` is what produces per-person activity. Both are the same
operation over a link column.

**FR-2c: Date-window predicates.** `filter` is a frontmatter equality match today. Every
consequential view here needs `occurred_at` compared against a window: relative
(`current_quarter`, `last_90_days`, `current_month`) and explicit ranges. This is the one
genuinely new expression the engine needs. It belongs in the pure `view-directives.ts` layer
with golden coverage, like every other directive.

**FR-2d: A count is always explorable.** Any rendering that shows a number must have a
corresponding table view listing the rows behind it. Under FR-4 this stops being a UX
preference and becomes the dispute path.

### FR-3: Capture (propose and admit)

The signal varies by domain (mail, calendar, commits, CI runs, ticket systems, forms). The
invariants do not.

**FR-3a: Nothing is written without per-item human approval.** A false record corrupts every
view built on it, and under FR-4 it corrupts a number someone is accountable for. This is a
standing requirement, not a v1 conservatism.

**FR-3b: The review artifact should be independently worth having.** This is the adoption
requirement. A review that reads as a status report of the person's own week gets run; one that
reads as data entry does not. Where the source signal permits it, cluster proposals by work
unit so the review answers a question the reviewer already had.

**FR-3c: Dedupe keys are deterministic and source-derived**, never an LLM sameness judgment.
Every external signal has a stable identifier (a calendar `iCalUID`, a mail thread id, a commit
sha, a ticket id). Re-running a review over the same window must produce zero new rows.

Where two signals plausibly describe one occurrence (a meeting and the thread that arranged
it), link them rather than auto-collapsing. Over-merging destroys evidence invisibly;
under-merging is visible and fixable.

**FR-3d: Declines are durable, in three states.** If a review re-proposes the same declined
items every run, it will be abandoned inside a month.

| Reviewer says | Row written | Key remembered | Payload kept |
|---|---|---|---|
| Yes | yes | yes (it is the row) | yes |
| Not a record | no | yes | no |
| Excluded | no | yes | **no** |

The third state suppresses re-proposal without recording what the occurrence was. Domains that
need it: journalism (source protection), HR and legal (privilege), health (consent). The
tombstone list lives at `records/<table>/.suppressed` and is the same shape as `sync_records`'s
no-resurrection ledger.

**FR-3e: Store the derived record, not the source artifact.** Retain enough to verify a
disputed row (source key, timestamp, counterparty) and nothing more. Scanning someone's mail to
build a record they are measured on is a meaningful step; keeping bodies out of it removes the
largest part of the objection and no view in FR-2 needs them.

### FR-4: Attested counts (optional layer)

Some counts are **consequential**: wrong, they cause harm outside the system. Billable hours
become invoices. Activity counts feed compensation. Evidence counts satisfy an auditor. A
deployment with no such count can ignore this section; nothing here is on by default.

**FR-4a: The counting rule is configuration, stated in the table's own page and versioned with
the repo.** This is the requirement most often skipped and most expensive to skip. The first
time a number is disputed, the definition is what gets argued about, and it needs to have been
written down *before* the dispute, by the person accountable for it.

The rule is also an incentive design, not just a measurement one. Whether a single outreach to
fifteen people counts as fifteen events or one changes behavior toward the metric, and the
naive choice usually rewards volume over quality. Counting **distinct (subject, work unit)
pairs** rather than raw events is the general form that resists this: it rewards breadth
without rewarding repeat-contacting the same list.

**FR-4b: Provenance per row.** Whether a record was detected from a source artifact or asserted
by hand. Detected is stronger evidence precisely because it is not self-reported, which is an
integrity argument for automated capture rather than merely a convenience one.

**FR-4c: Periods close.** Once a period closes its number must not move. Closing is an explicit
action writing a dated page holding the final table, committed to git with a sha and timestamp.

Deliberately **not** reusing the `okf-view` snapshot mechanism, even though it fits
mechanically. Snapshots are documented as cosmetic, allowed to go stale, and regenerated on any
save of their page (`CLAUDE.md` → Derived views). Making one load-bearing would quietly invert
that contract.

**FR-4d: Migration must deduplicate before computing a baseline.** Historical activity imported
from an entity-keyed notes field carries the duplication described in FR-1d. Counting it as-is
inflates whoever had the most participants per occurrence.

## 7. What is deliberately NOT a platform feature

**Work-unit pages are just pages.** A story, a requisition, a matter, an incident: each is a
page with a `type`, some frontmatter, a body used as a working document, and an `okf-view`
showing its records. Zero platform work. The grouping happens because a records table declares
a `link:` field pointing at that folder, and FR-2b groups by it.

This is worth stating explicitly because it is the easiest requirement to invent by mistake.
Any single domain, described on its own, makes its work unit look like a page type the platform
should know about. None of them are. What the platform owes is the records primitive,
aggregation, and the ability for a row to point at any page. The domain shapes itself.

**Schemas are not shipped.** No built-in "interactions" or "activities" table. The moment the
platform ships one domain's schema it inherits every other domain's request to extend it.

## 8. Platform changes required

| # | Change | Size | Notes |
|---|---|---|---|
| 1 | `okf-table` parse layer | S | Pure, mirrors `view-directives.ts`, golden-tested |
| 2 | Record storage format, shard convention, append path | S | Reuses `write_page` append and `commitFiles` |
| 3 | Record indexing into D1 + freshness | M | Reuses `ensureFresh`, budget/cursor pattern |
| 4 | `kind: records` source in `okf-view` | M | |
| 5 | Group-by on a link column | S | |
| 6 | Date-window predicates (FR-2c) | M | New expression in the directive grammar |
| 7 | Record→page links in the graph | S | Extends existing link resolution |
| 8 | Propose/admit tools + tombstone ledger | M | `sync_records`'s ledger is the template |
| 9 | Attested counts (FR-4) | S | Only where a deployment needs it |
| 10 | App rendering of record views | M | No existing surface |
| 11 | `validate` integration | S | |
| 12 | **Raise `MAX_SCAN_PAGES`** | S code, M verification | Below; independent of records but unblocked here |

### 8.1 On `MAX_SCAN_PAGES`

The 5,000 ceiling (`src/lib/brain-repo.ts`) is a sanity bound, not a limit derived from any
platform constraint. Records do not consume it (they are rows in a handful of files), but
work-unit pages do, and a brain that tracks work accumulates them.

The mechanisms that actually make a large brain workable are already in place and are the
resumable budgets, not the ceiling: `fetchPages` batches blob reads through GraphQL at 100 per
request, `REBUILD_PAGE_BUDGET` (300) and `REINDEX_PAGE_BUDGET` (600) bound per-request work,
and both advance their marker only on completion.

What raising it costs, and what needs verifying before it ships:

- **First-index convergence takes more reads.** A 20,000-page brain converges over roughly 30
  to 60 reads instead of a handful. Correct at every step and never blocking, but "the first
  hour on a very large brain returns partial results" must be a stated behavior, not a surprise.
- **`listTree` returns one large payload.** 20,000 entries is a few MB of JSON in Worker memory
  (128MB limit). Needs measuring, not assuming.
- **`truncated` stops being the backstop.** Today, exceeding the ceiling sets a flag. If the
  ceiling moves far out, something else must catch a pathological brain.
- **D1 row counts scale linearly**: 20,000 pages at ~10 indexed field keys each is ~200k rows
  in `brain_page_fields`. Within D1's envelope; confirm query plans hold.

## 9. Boundary: when this is the wrong tool

Records serve **views over a brain's own concepts**. The pressure to grow them into a general
database will be constant and should be refused at a stated line:

| Belongs in records | Belongs in a warehouse |
|---|---|
| "Who is outstanding on this work unit" | Cross-source joins |
| "When did we last contact this subject" | Aggregation beyond count and sum |
| "How many events per actor this quarter" | Anything spanning systems the brain does not own |
| Anything answerable by filtering one table and following links | Anything needing a second table joined to the first |

A useful heuristic: **a records table should have at least one `link:` field.** A table that
references nothing in the brain is a spreadsheet, and the brain is the wrong home for it. The
value of putting records here at all is that they join the concept graph.

## 10. Phasing

**Phase 0: Characterize an existing corpus. No platform work.**
Before designing a schema, run an extraction pass over whatever the target team records today.
It yields the field list empirically instead of by guess, the duplication rate (FR-4d), and
critically **the fraction of records naming a subject the brain can resolve**. Everything
downstream is capped by that last number, and it is cheap to measure and expensive to assume.

**Phase 1: Records layer, read-only.** Items 1 to 7 and 11. Rows land by hand or by script;
views work. Proves storage, indexing, and query design without depending on capture adoption.

**Phase 2: Capture.** Items 8 and 10, FR-3 end to end, with one or two people. This is where
the risky assumption lives: whether anyone runs the review. Test it before building anything
that depends on it.

**Phase 3: Attested counts.** Items 9, only once a counting rule is decided (FR-4a) and Phase 2
has produced enough periods to sanity-check against whatever the count is replacing.

## 11. Risks

- **The review does not get run.** The whole capture design assumes a human cadence. Mitigation
  is FR-3b; the test is Phase 2, deliberately sequenced before anything expensive depends on it.
- **Goodhart on any consequential count.** Making a number consequential changes behavior
  toward it, and the naive counting rule usually rewards volume over quality. FR-4a treats the
  rule as incentive design rather than measurement, which is the only mitigation that works.
- **Scope creep toward a database.** §9 is the line. It will be tested by the second use case.
- **Subject resolution rate.** If records cannot be matched to pages, they carry no graph value
  and every view degrades. Phase 0 measures it first.
- **Person-level activity data.** Per-actor counts are a record of what a colleague did with
  their time. The reasoning that gates the analytics people-table on `orgRole` (`CLAUDE.md` →
  Usage analytics) applies, and applies harder wherever FR-4 is in use. Decide the visibility
  rule before the first period closes; retrofitting it is painful.

## 12. Open questions

1. **Records referencing records.** Out of scope for v1, but several domains want it (an action
   item belonging to an incident, a follow-up belonging to a conversation). The storage format
   should not preclude it.
2. **Table-level access control.** A records table may warrant different visibility than the
   brain around it, and this is sharper than for pages: activity data is more sensitive than the
   concepts it points at. Not needed for v1; decide before the format sets.
3. **Shard period.** Monthly is assumed. High-volume tables may want weekly, low-volume tables
   yearly. Configurable in `okf-table`, or inferred from row rate?
4. **Sum as an aggregate.** Count covers most of §3, but amounts, durations, and hours all want
   sum. Cheap to add with count; deferred only to keep v1 narrow.
5. **Who sees per-actor counts.** See §11. Likely mirrors the existing `orgRole` gate.
