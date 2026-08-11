# PRD: Records Tables & Story Pages (editorial interaction tracking)

- Status: Draft, not started. Written 2026-08-11 from a newsroom customer's use case.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-11
- Audience: the engineering session picking this up in `isomorphic-app`
- Related: `docs/design/derived-views-and-sync-prd.md` (the views engine and `sync_records`
  this builds on), `CLAUDE.md` (Brain model, Content index, Derived views, OKF)

## 1. Summary

A brain has exactly one content primitive: the **page**, which models a *concept*. There is
no home for a **record**: a dated occurrence that points at concepts. This PRD asks for one.

The gap is not theoretical. A newsroom customer needs to track every contact between its
reporters and the executives they source from: who was asked, who answered, what they said,
which story it was for. Today that lives in a CRM's free-text note field, where it is
unqueryable, silently duplicated, and structurally unable to answer the three questions the
business actually has.

Two capabilities are requested:

1. **Records tables**: brain-defined, arbitrary-schema tables whose rows link to pages,
   stored in the repo, indexed into D1, queryable through `okf-view`.
2. **Story pages**: a first-class concept page for the piece of content an editorial
   interaction serves, which is the entity that makes the records cohere.

Plus one property that constrains the whole design: **the touch counts these tables produce
are used to compute contributor compensation.** See FR-5 and §7. That is what separates this from a
reporting nicety.

## 2. Background & motivating use case

`example-org/contacts-brain` (the brain described in §2 of the derived-views PRD) now holds
~3,900 pages: ~2,950 people, ~930 organizations, ~20 role directories. It is a well-formed
OKF concept store and it works.

What it cannot hold is the *work*. The customer's reporters interact with those contacts
constantly, and those interactions are recorded in a CRM as free text. A representative
sample of that field, lightly paraphrased:

```
CFO of a health system (responded to my email when I reached out about his
resignation, saying he will stay in the role until Sept. 30)

CHRO of a health system (shared response for my article on parents of Gen Zers.
He said it happens on the rare occasion and is likely related to today's
difficult job market.)

Interview on 8/7 for a pharmacy profile
Email response 08/07
outreach 8.10
```

### What the corpus reveals

Four observations from reading several hundred of these, each of which drives a requirement:

**(a) Editorial interactions cluster by story, and the story is not recorded.** Seven separate
notes in one week's sample were responses to a single article. Nothing connects them. The
reporter's actual working question ("who is outstanding on this piece?") is unanswerable,
and so is the editor's governance question ("are we quoting the same six people every month?").

**(b) The same interaction is duplicated across contacts.** One interview appears verbatim
three times; several notes appear twice. This is not sloppiness. It is a missing many-to-many
surfacing as copy-paste: one interview with several participants, no way to attach it to more
than one contact, so it was pasted onto each. **Under a touch-count compensation scheme, that
triplicate is three touches for one interview.** Any migration of historical notes must
deduplicate before computing a baseline (§7).

**(c) Only successes are recorded.** Every note documents a response, a recording, a
confirmation. Nobody writes a note saying "I emailed fifteen people." So response rate, source
fatigue, and live per-story pipeline are all uncomputable today. Capturing the *ask* is the
single largest new capability here, and it is the main argument for automated capture over
better manual forms.

**(d) The notes are terse by default.** "outreach 8.10" is twelve characters, written under no
time pressure. Any flow requiring a well-formed record will be abandoned. A row must be valid
with nothing but a date, a person, and a kind.

### Why the existing primitives do not cover it

- **Page per interaction** blows the index. At even a modest 12,000 interactions/year against
  a brain already at ~3,900 pages, event data evicts concept data from the index and *contacts*
  become unfindable. It also breaks the human-review premise: nobody reviews a diff of 200
  machine-written files.
- **Frontmatter on the person page** holds a summary (`last_interaction`, `interactions_count`)
  but not the history, and `MAX_FIELD_KEYS_PER_PAGE` (24) bounds how much summary fits.
- **`sync_records`** is the right *shape* (upsert by key, source-owned fields, human edits
  sacred, no-resurrection ledger) but its target is pages, so it inherits the page problem.

### Root cause

Same shape as the derived-views PRD's root cause, one level down. There, one primitive (the
static page) was doing two jobs (authored content and derived views). Here, the page is being
asked to do a third job it is structurally wrong for: holding an unbounded, append-only,
machine-generated series of dated events.

## 3. Goals / non-goals

**Goals**

- A records primitive: brain-defined tables, arbitrary schema, rows that link to pages.
- Records live in the repo as the source of truth and index into D1 as a derived cache, with
  the same rebuild-from-content property pages have.
- `story` as a first-class page type, so the piece of content is a concept with a working doc.
- Editor-in-the-loop capture: Claude proposes interactions from calendar and mail; a human
  approves per item; declines are durable.
- `okf-view` can aggregate records over a date window, which is what the compensation view needs.
- Counting is defensible enough to underwrite compensation (§7).

**Non-goals**

- CRM/pipeline/deal tracking. Explicitly out of scope. The same customer has a sales-side
  use case with different entities, a different source system, and different rollups; it does
  not share a schema with this one and must not share a table.
- Call-recording ingestion.
- Fully automatic capture with no approval step.
- A dedicated records UI beyond rendering views in the app.
- Batch field-setting across many pages (still deferred; see `docs/roadmap.md`).

## 4. Users and jobs

| Who | Job | Frequency |
|---|---|---|
| Reporter | "Before I pitch this person, have we talked to them? Did they answer last time? What did they say?" | Per pitch, latency-sensitive |
| Reporter | "Who is still outstanding on this story?" | Daily while a story is live |
| Reporter | "How many touches am I at this quarter?" | Weekly, and it affects their pay |
| Editor | "Are we quoting the same people repeatedly?" | Monthly |
| Editor | "Which contacts has nobody touched in six months?" | Quarterly |
| Ops | "What is the final, defensible touch count for the period?" | Per comp period |

## 5. The model

**Concepts (pages, unchanged mechanics)**

- `people/`: sources and staff. Already exists.
- `organizations/`: already exists.
- `stories/`: **new**. One page per piece of content: article, podcast episode, panel, column.

**Records (rows, new)**

- `records/interactions/`: one row per contact between a staff member and a source.

The discriminator that makes one table sufficient here: **every editorial interaction exists in
service of a piece of content.** Article sourcing, podcast recording, panel recruitment, and
byline management all share (piece, person, staffer, date, outcome, gist) with a `kind` field
separating them. That is why editorial gets one table where editorial-plus-sales would have
needed two.

## 6. Functional requirements

### FR-1: Record tables

**FR-1a: A table is declared by a page.** The folder note of a records folder carries the
schema in a fenced `okf-table` block, following the precedent set by `okf-view` and `tool`:
a small line grammar, not YAML, so it survives the flat frontmatter parser and ProseMirror
round-trips.

`records/interactions/index.md`:

````markdown
---
type: Record Table
title: Interactions
---

# Interactions

Every substantive contact between editorial staff and a tracked source. One row per
conversation, not per email in a thread. A row is valid with only a date, a person,
and a kind; everything else is optional.

```okf-table
key:   id (string) source-derived dedupe key
field: occurred_at (date, required)
field: kind (enum: outreach|response|interview|podcast|panel|column)
field: outcome (enum: asked|responded|declined|no_response|delivered)
link:  source (page[], under: people/) usually one; several for a panel
link:  staff (page, under: people/) our side
link:  story (page, under: stories/) what it was for
field: gist (text) one line: what they actually said
```
````

The body matters as much as the fence. The definition of what counts sits beside the schema,
written by the person who owns it, and it is what an agent reads before proposing rows.
Schema and documentation cannot drift because they are the same file.

**FR-1b: Rows are stored record-per-section, not row-per-line.** A markdown table cannot hold
a payload with newlines, and `gist` needs to tolerate a paragraph. Each record is one H2
section: a heading carrying the key, a list of scalar and link fields, then free prose.

`records/interactions/2026-08.md`:

```markdown
## mail:CAF%3D9x2k...@mail.gmail.com
- occurred_at: 2026-08-07
- kind: response
- outcome: responded
- source: [[people/jane-doe]]
- staff: [[people/alex-reporter]]
- story: [[stories/parents-in-the-workplace]]

Said it happens on rare occasions and is likely related to today's difficult
job market.
```

Rationale: diffs cleanly (a new record is a contiguous added block), holds arbitrary prose,
stays hand-editable, renders on github.com, and the parse layer is close to the one that
already exists for pages.

**FR-1c: Shard by month.** `records/<table>/YYYY-MM.md`. The binding reason is indexing
cost: the indexer finds changed content by diffing blob shas, so a single file means every
append re-parses every record ever written, a per-write cost that grows with table age and
never comes down. Sharded, only the current month's sha moves and closed months are indexed
exactly once. This is the same "no unbounded work in one read" rule that governs
`rebuildDerivedFromStore`.

Sharding does **not** solve concurrent appends (two people writing the same month still
collide). That needs optimistic retry on a stale sha, which `commitFiles`'s atomicity already
makes safe: a conflicting write fails cleanly rather than half-applying, and the caller
retries against the new head. Build it in from v1; it appears the first week two people use it.

**FR-1d: `link:` fields join the existing link graph.** A link field's value is a wikilink,
and the indexer writes it into `brain_links` (or a parallel table with the same resolution
path). This is the central design decision of the PRD: **do not invent a foreign key.** Making
the reference an ordinary link means backlinks, `find_inbound_links`, `validate`'s broken-link
report, the graph view, and `move_page`'s inbound repointing all cover records with no new
machinery. A record pointing at a deleted page becomes a broken link reported by the tooling
that already reports broken links.

`page[]` (a list) is what carries multi-participant interactions without duplicating the row,
which is the defect observed in (b) above.

**FR-1e: Records index into D1 as a derived cache.** New tables (`brain_records`,
`brain_record_links`), populated by the same `ensureFresh` path pages use, rebuilt lazily from
stored content on a schema-version bump, budgeted and resumable. Records are never the D1 row
of record; the repo is. A brain must survive a full index wipe.

**FR-1f: `validate` reports records.** Schema violations (unknown field, bad enum value,
malformed date), duplicate keys within a table, and links to nonexistent pages. Advisory, never
blocking, consistent with every other `validate` check.

### FR-2: Story pages

**FR-2a: A story is a page**, under `stories/`, with:

```yaml
type: Story
title: Parents of Gen Zers in the workplace
status: pitching | drafting | published | killed
staff: alex-reporter
published_at: 2026-08-12
url: https://…
```

The body is a working document: the angle, the ask that went out, quotes gathered, what is
still missing. That is why this is a page and not a grouping key. The reporter needs somewhere
to *work*, and a records row has no room for it.

**FR-2b: The story page carries its own pipeline view** (see FR-4a), so opening it answers
"who is outstanding" without a query.

**FR-2c: Volume.** A story page per sourced piece is real page growth. This is acceptable
only because `MAX_SCAN_PAGES` is being raised (§8); at the current 5,000 the brain has ~1,100
pages of headroom total and story pages would consume it in roughly two years.

### FR-3: Capture (editor in the loop)

**FR-3a: Nothing is written without per-item human approval.** The frontend is Claude. A
staff member runs the review on their own cadence (weekly is expected) and confirms in
conversation. This is a hard requirement, not a v1 conservatism: a false interaction corrupts
both the coverage view and, under §7, someone's compensation.

**FR-3b: The review is a status report, not a data-entry chore.** This is the adoption
requirement and it drives the clustering in FR-3c. The output should be something the reporter
would want even if it wrote nothing:

```
This week you pitched 3 stories:
  Parents of Gen Zers          15 asked,  7 responded,  8 outstanding
  CMS 2027 proposed rule        6 asked,  1 responded,  5 outstanding
  Top 20 hospitals follow-up    4 asked,  2 responded,  2 outstanding

Plus 4 podcast recordings, 2 panel recruits.

Confirm, or tell me what to drop.
```

**FR-3c: A mass pitch clusters into one story automatically.** N near-identical sends inside
a short window, or one send to N recipients, is a story-level ask. This is a high-confidence
structural signal requiring no judgment, and it is what creates most story pages with no
authoring effort. It is also what makes capturing the *ask* (observation (c)) cheap.

**FR-3d: Dedupe keys are deterministic and source-derived**, never an LLM sameness judgment:

| Source | Key |
|---|---|
| Calendar | `iCalUID` (stable across edits and identical in every attendee's copy) |
| Mail | **thread** id, not message id, so a six-message exchange is one interaction |
| Manual | generated at write time |

Re-running a review over the same week must produce zero new rows.

Do **not** auto-collapse a calendar event with the mail thread that arranged it. Link them and
let counting decide (§7.2). Over-merging destroys evidence invisibly; under-merging is visible
and fixable.

**FR-3e: Declines are durable, in three states.** If the review re-proposes the same declined
items every week, it will be abandoned inside a month.

| Reviewer says | Row written | Key remembered | Payload kept |
|---|---|---|---|
| Yes | yes | yes (it is the row) | yes |
| Not an interaction | no | yes | no |
| Off the record | no | yes | **no** |

The third state is what a newsroom requires: suppressing re-proposal without recording what
the interaction was. The tombstone list lives at `records/<table>/.suppressed` and is the
same shape as `sync_records`'s no-resurrection ledger.

**FR-3f: Store the derived record, not the message body.** Retain enough to verify a disputed
row (source key, timestamp, counterparty) and nothing more. Scanning staff mail to build a
record that feeds compensation is a meaningful step; keeping the bodies out of it removes the
largest part of the objection and is not needed for any view in FR-4.

### FR-4: Views

**FR-4a: Per-story pipeline** (on the story page):

````markdown
```okf-view
kind: records
of: interactions
where: story = this
group-by: outcome
as: count
```
````

**FR-4b: Per-source history and fatigue** (on a person page): the last N interactions as a
table, plus asked/responded counts over a trailing window. This is the highest-frequency read
in the system: it fires every time a reporter is about to make contact.

**FR-4c: Per-staffer touch count** (on a staff page and an org-level summary). This is the
compensation view and the reason FR-5 exists:

````markdown
```okf-view
kind: records
of: interactions
where: staff = this and occurred_at in current_quarter
group-by: kind
as: count
```
````

**FR-4d: New engine capability: date-window predicates.** `okf-view`'s `filter` is a
frontmatter equality match today. FR-4b and FR-4c both need `occurred_at` compared against a
window. Required: relative windows (`current_quarter`, `last_90_days`, `current_month`) and
explicit ranges. This is the one genuinely new expression the views engine needs, and it should
be added to the pure `view-directives.ts` layer with golden coverage, like every other directive.

**FR-4e: A count must always be explorable.** Any tile showing a number must have a
corresponding table view listing the rows behind it. Under §7 this is not a UX preference: it
is the dispute path.

### FR-5: Compensation-grade counting

Contributor compensation at the motivating customer includes a bonus component driven by the
number of outreach touches. This makes the count a payroll input, and it changes several
requirements that would otherwise be judgment calls. Newsrooms that do not do this can ignore
this section; nothing here is on by default.

**FR-5a: The definition of a touch is configuration, not a constant.** It must be stated in
the table's own page and versioned with the repo.

**FR-5b: The count is auditable.** Every counted row retains its source key, timestamp, and
the approval that admitted it. "Why is my number 41 and not 44" must be answerable by listing
rows, which is FR-4e.

**FR-5c: Periods close.** Once a comp period closes, its number must not move. Closing writes
a dated page under `stories/`-adjacent reporting (e.g. `records/interactions/closed/2026-Q3.md`)
holding the final table, committed to git with a sha and timestamp.

Deliberately **not** reusing the `okf-view` snapshot mechanism for this. Snapshots are
documented as cosmetic, allowed to go stale, and regenerated on any save of their page
(`CLAUDE.md` → Derived views). Making one load-bearing for payroll would quietly invert that
contract. Period close is an explicit action producing an explicit artifact.

**FR-5d: Detected beats self-reported.** A touch derived from a sent message is stronger
evidence than a typed note, precisely because it is not self-asserted. This is an integrity
argument for automated capture, not merely a convenience one, and it should be preserved in
the record: rows should carry whether they were detected or hand-entered.

## 7. Open decision: what counts as one touch

**This is the most consequential open question in the PRD and it is a business decision, not
an engineering one.** A mass pitch to fifteen people is either fifteen touches or one, and
that is a fifteen-fold difference in someone's bonus. Each option creates a different incentive:

| Option | A 15-person pitch counts as | What it incentivizes |
|---|---|---|
| A. Every outbound ask | 15 | Bigger blast lists. Degrades source relationships, which is backwards from the intent. |
| B. One per story-level ask | 1 | More small stories. Under-rewards genuine breadth. |
| C. Weighted by outcome (ask 0.25, response 1, interview/podcast/panel 2) | ~3.75 + earned | Landing the quote, which is the thing that produces journalism. Needs a weight table someone owns. |
| D. Distinct (person, story) pairs | 15, but re-asking the same list on a new story still counts, and re-asking on the *same* story does not | Breadth without rewarding repeat-blasting one list. |

**Recommendation: D as the base, with C's outcome weighting layered on.** Count distinct
(person, story) pairs so breadth is rewarded and duplicate asks are not, and weight a response
above an ask so the metric tracks the work that produces published journalism rather than
volume of mail sent.

Whatever is chosen, it must be written into the table's page (FR-5a), because the first time a
bonus comes in short, the definition is what gets argued about.

**Migration caveat.** If a historical baseline is computed from the existing CRM notes, it must
be deduplicated first. The observed triplicates (observation (b)) would otherwise inflate some
historical counts threefold.

## 8. Platform changes required

| # | Change | Size | Notes |
|---|---|---|---|
| 1 | `okf-table` parse layer | S | Pure, mirrors `view-directives.ts`, golden-tested |
| 2 | Record storage format, shard convention, append path | S | Reuses `write_page`'s append and `commitFiles` |
| 3 | Record indexing into D1 + freshness | M | Reuses `ensureFresh`, budget/cursor pattern |
| 4 | `kind: records` source in `okf-view` | M | |
| 5 | Date-window predicates (FR-4d) | M | New expression in the directive grammar |
| 6 | Record→page links in the graph | S | Extends existing link resolution |
| 7 | Propose/approve tools + tombstone ledger | M | `sync_records`'s ledger is the template |
| 8 | Period close (FR-5c) | S | Only if a deployment uses FR-5 |
| 9 | App rendering of record views | M | No existing surface |
| 10 | `validate` integration | S | |
| 11 | **Raise `MAX_SCAN_PAGES`** | S code, M verification | Below |

### 8.1 On `MAX_SCAN_PAGES`

The 5,000 ceiling (`src/lib/brain-repo.ts`) is a sanity bound, not a hard limit derived from
any platform constraint, and story pages (FR-2c) need it raised. The real mechanisms that make
a large brain workable are already in place and are the resumable budgets, not the ceiling:
`fetchPages` batches blob reads through GraphQL at 100 per request, `REBUILD_PAGE_BUDGET` (300)
and `REINDEX_PAGE_BUDGET` (600) bound per-request work, and both advance their marker only on
completion.

What raising it actually costs, and what needs verifying before it ships:

- **First-index convergence takes more reads.** A 20,000-page brain converges over roughly 30
  to 60 reads instead of a handful. It is correct at every step and never blocks, but "the first
  hour on a huge brain returns partial results" needs to be a stated behavior rather than a
  surprise.
- **`listTree` returns one large payload.** 20,000 entries is a few MB of JSON in Worker memory
  (128MB limit). Needs measuring, not assuming.
- **`truncated` stops being the backstop.** Today exceeding the ceiling sets a flag; if the
  ceiling moves far out, something else must catch a pathological brain.
- **D1 row counts scale linearly**: 20,000 pages at ~10 indexed field keys each is ~200k rows
  in `brain_page_fields`. Within D1's envelope, worth confirming query plans hold.

Records themselves do **not** consume this budget, since they are rows in a handful of files.
That asymmetry is the main structural argument for the records layer over page-per-record, and
it survives the ceiling being raised.

## 9. Phasing

**Phase 0: Extraction pass over the existing corpus. No platform work.**
Run an LLM extraction over the customer's existing editorial notes to derive the schema
empirically rather than guessing: the real distribution of `kind`, how often a note clusters
into a story, and critically **what fraction of notes name a person the brain can resolve**.
The sample contains entries identifying a source only as a first name, so the match rate is a
real unknown and everything downstream depends on it. Zero adoption risk, immediate value,
and it produces the historical baseline for §7.

**Phase 1: Records layer, read-only.** Items 1 to 6 and 10. Rows land by hand or by script;
views work. Proves the storage, indexing, and query design without depending on capture
adoption.

**Phase 2: Capture.** Items 7 and 9, and FR-3 end to end with one or two reporters. This is
where the risky assumption lives: whether staff will actually run the weekly review. Test it
before building anything that depends on it.

**Phase 3: Compensation.** FR-5 and item 8, only once §7 is decided and Phase 2 has produced
a few periods of data to sanity-check against the existing manual counts.

## 10. Risks

- **The review does not get run.** The whole design assumes a human-in-the-loop cadence. The
  mitigation is FR-3b (make the artifact independently worth having), and the test is Phase 2,
  deliberately sequenced before anything expensive depends on it.
- **Goodhart on the touch count.** Making a metric compensable changes behavior toward it.
  §7's options are an incentive-design choice more than a measurement one, and option A in
  particular has a failure mode (blast lists) that actively damages the relationships the brain
  exists to track.
- **Records become a general database.** The pressure to add joins, aggregates, and a second
  table type will be constant. The line this PRD draws: records serve *views over a brain's own
  concepts*. When a question needs cross-source joins or true aggregation, it belongs in a
  warehouse, and the answer is to say so rather than to grow the engine toward one.
- **Match rate against existing pages.** If Phase 0 shows a low resolution rate from notes to
  person pages, capture quality is capped regardless of how good the rest is.
- **Person-level activity data.** Per-staffer counts are a record of what a colleague did with
  their week. The same reasoning that gates the analytics people-table on `orgRole`
  (`CLAUDE.md` → Usage analytics) applies, and here it is stronger, since these numbers feed
  compensation. Decide the visibility rule before the first period closes; retrofitting it is
  painful.

## 11. Open questions

1. **§7's touch definition.** Blocking for Phase 3, not for Phases 0 to 2.
2. **Story page volume.** How many pieces per month actually involve source outreach? Phase 0
   answers it, and it determines how far `MAX_SCAN_PAGES` needs to move.
3. **Records referencing records.** Out of scope here (editorial has no need), but the sales
   use case that was split off does, and the storage format should not preclude it.
4. **Who sees per-staffer counts.** See §10. Needs a decision, likely mirroring the existing
   `orgRole` gate.
5. **Table-level access control.** A records table may warrant different visibility than the
   brain around it. Not needed for v1; note it before the format sets.
