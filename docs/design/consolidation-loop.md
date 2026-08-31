# Design: the consolidation loop

> **Update (2026-08-31): this shipped as ZERO new tools, not two.**
>
> The plan below proposed a `consolidate` tool and a `probe` tool. Both were cut on
> review, and the capabilities landed inside the surface that already existed:
>
> - **Findings go in `validate`.** The distinction this document draws, that validate
>   is for provable defects and consolidation is for judgment, does not match the code:
>   validate already emitted five advisory sections that are pure judgment. Consolidation
>   tensions are the same species and belong beside them. Broken links remain the one
>   class that carries no key and cannot be silenced, which is the real line.
> - **Dismissal generalised `resolve_import` into `resolve`.** One rename, not one
>   addition. Every finding carries a namespaced `[key]`; `resolve` records a decision
>   about any of them, keeping the import actions and adding `dismiss`/`undismiss`.
>   This also fixed a standing wart: advisories nobody could silence.
> - **Probe became an `expect` argument on `search_pages`.** Measurement belongs to the
>   read that already runs the search. An advertised tool costs context in every
>   conversation; this costs an optional argument.
>
> The work items below still describe the reasoning; read W2 and W5 as history rather
> than as a plan.

Status: **partly built**. The two pure engines and their offline runners exist on
branch `worktree-consolidate-loop` with golden tests wired into CI. Nothing is
registered as an MCP tool, `validate` does not point at any of it, and the dismissal
ledger is not persisted to a repo yet. This document is the spec for finishing it.

Related: [`folder-notes-and-okf-conformance.md`](./folder-notes-and-okf-conformance.md)
(the advisories `validate` already emits), [`brain-seams.md`](./brain-seams.md) (the
`BrainStore` seam every write goes through).

## The problem

A brain has two surfaces.

The **cheap surface** is everything a reader gets before anyone reasons: page titles,
`type:` and other frontmatter, folder placement, folder notes, the link graph, and
what `search_pages` returns first. The **expensive surface** is the full text plus a
model reading and deriving over it.

Every read tool answers from the cheap surface. Nothing in the product checks that
surface against what the expensive one would conclude, and no tool's output is "the
cheap surface now agrees with a full read." So a brain drifts: pages accumulate, the
folder note stops listing them, two pages start telling one story, a page keeps a name
nobody searches with. Each of those is invisible to `validate`, because none of them
is a defect that can be proven from the content alone.

The loop that closes this gap is deliberately **not** an autonomous cleanup. The
platform detects and measures; a model decides and edits. That division is the cost
model as much as the design: detection is SQL over an index we already maintain,
judgment is tokens in the caller's own session.

## What was measured

Run against a real 28-page brain (private, not in this repo; regenerate the numbers
with the runners below rather than trusting these):

- **`validate` reported the brain clean.** 78 resolved links, **0 broken**.
- **The structural detector found 12 tensions** on that same brain.
- **34 retrieval probes returned 15 owned, 4 contested, 8 answered by the wrong page,
  7 absent.**

Three findings shaped this design.

**1. Folder notes list their pages in ways nothing can traverse.** The largest folder
note in that brain named its two sibling pages inside a fenced code block, and
referenced other pages in inline backticks. `maskCode` correctly refuses to read
either as a link (a syntax example is not a link), so the note linked to nothing and
both siblings were islands: zero inbound, zero outbound, reachable only by full-text
search. A human reading that page sees a listing. The machine sees a dead end.

**2. The same page was also outcompeting the pages it failed to link.** It answered to
15 other pages' questions, more than twice the next page. The structural check and the
retrieval check converged on one file from different directions, and neither says that
alone.

**3. `search_pages` cannot answer a question.** All six natural-language probes
returned nothing. `searchIndex` (`src/lib/brain-index.ts`) is a literal substring
`LIKE` over the whole query, rows `ORDER BY path`, capped at 50 hits. Absence tracked
**query shape, not brain content**: every phrase-shaped probe found something, every
question-shaped one found nothing, on a brain that demonstrably contains the answers.

That third finding is why search relevance is W1 below rather than a later
improvement. It is also the reason probe cannot currently measure the thing it exists
to measure: with `ORDER BY path`, "did the right page come back first" has no answer,
because position is alphabetical.

## What is already built

**On branch `worktree-consolidate-loop`, not on `main`.** If you are reading this from
`main`, none of the files in this table exist yet; check the branch out first. All
pure, all offline, all covered by golden tests wired into `package.json` and `ci.yml`.

| File                            | Exports                                                                                                                              | Test                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `src/lib/consolidate.ts`        | `computeTensions`, `parseReviewLedger`, `serializeReviewLedger`, `filterDismissed`, `dismiss`, `REVIEW_LEDGER_PATH`, `MAX_DUP_PAGES` | `pnpm test:consolidate` (34 checks) |
| `src/lib/probe.ts`              | `scoreProbe`, `summarizeProbes`, `diffProbeRuns`, `stripDeclaredProbes`                                                              | `pnpm test:probe`                   |
| `scripts/local-brain.ts`        | `openFolderAsBrain`                                                                                                                  | exercised by both runners           |
| `scripts/consolidate-report.ts` | `pnpm consolidate:report <folder>`                                                                                                   |                                     |
| `scripts/probe-report.ts`       | `pnpm probe:report <folder> <probes.json> [--baseline <run.json>] [--json]`                                                          |                                     |

Both runners copy a folder of markdown into a temp git repo, index it through the
**real** content index on `node:sqlite`, and run the real engines. No network, no
credentials, and the source folder is never written to. Use them to iterate: they are
the fastest way to see what a change does to a real brain.

`computeTensions` returns seven kinds, ranked by weight, each carrying a stable `key`,
the paths involved, evidence, and the suggested move:

`island` · `orphan` · `note-less-folder` · `hollow-folder-note` ·
`folder-note-convention` · `folder-echo-page` · `near-duplicate`

`scoreProbe` returns five verdicts plus a truncation guard, keyed on the expected
page's RANK: `owned` (first) · `outranked` (top band, beaten) · `buried` (present,
below the band) · `elsewhere` (absent, others answered) · `absent` · `inconclusive`.
`diffProbeRuns` compares two runs by rank, which is the only number that means the
same thing on both sides.

An earlier version keyed the verdicts on how many other pages matched. That was right
while search took the whole query as one substring, because matching many pages meant
a vague query and there was no order to read. Once search tokenized, matching many
pages became ordinary and ranking became the thing that resolves it: on a real brain
the old thresholds called 30 of 34 probes "contested" on a run that put the right page
first 21 times. The same correction applies to the intruder list, which now counts
pages that OUTRANK the page a question belongs to rather than pages that merely
co-occur with it.

## Work items, in order

| #   | Item                                           | Blocking?                       | Risk                                        |
| --- | ---------------------------------------------- | ------------------------------- | ------------------------------------------- |
| W1  | Search relevance (own spec, own branch)        | Yes, for probe to mean anything | High: changes the read path every tool uses |
| W2  | `consolidate` as an MCP tool                   | No                              | Low                                         |
| W3  | `validate` pointer line                        | Depends on W2                   | Low                                         |
| W4  | Persist the review ledger                      | Depends on W2                   | Low                                         |
| W5  | `probe` as an MCP tool, `answers:` frontmatter | Depends on W1                   | Medium                                      |
| W6  | Reconsolidation signal                         | No                              | Medium: schema                              |
| W7  | The practice page in `brain-template/`         | No                              | None                                        |

### W1. Search relevance

**Specified separately in [`search-relevance.md`](./search-relevance.md).** It is a
defect in the read path in its own right, affects every agent whether or not this loop
exists, and is being tracked on its own.

It is W1 here because it blocks W5. Probe's most valuable measurement is rank, and
`searchIndex` returns rows `ORDER BY path`, so until that changes probe can report
findability and competition but not whether a fix helped. The probe run that produced
the evidence in this document is also what surfaced those defects.

### W2. `consolidate` as an MCP tool

**Why.** The engine currently only runs offline.

**Shape.** One verb with modes, following `share_brain`'s precedent rather than adding
several tools:

- default: return **one** tension, the highest-weighted undismissed one, with its
  evidence and suggested move.
- `dismiss: <key>` plus a required `why`: record a durable decision (W4).

**Return one item, not a report.** A 40-item audit invites one shallow pass over
everything; one tension with exactly the material needed to judge it produces a fix,
and it makes the loop resumable across sessions, which matters because this is slow by
construction.

**Where.** New `src/tools/consolidate.ts`, registered in `buildServer` (`src/worker.ts`)
after the first-party tools. Brain scope: reads gate on `role` at `viewer`, the
dismissal write at `editor`. Not `sticky` (v1 returns data, opens no widget).

**Do not forget.** `TOOL_KINDS` needs an entry or `pnpm test:usage` fails, by design:
it scans the tool sources so a new tool cannot land unclassified. The dismissal mode
is an `edit`.

**Tests.** `pnpm test:scope` for the authorization, in both directions, with the
throwing `store`/`octokit` Proxies in place.

### W3. `validate` pointer line

**Why.** The model already runs `validate` to ask "does anything need attention." The
open-tension count belongs there. The findings themselves do not.

**Validate reports the COUNT and names the verb. It must never print the tensions.**
Validate's authority rests on every hard finding being provably true; a broken link is
a fact. Judgment calls in the same blob teach a reader to skim both, and the
broken-link report is the thing that loses. The codebase already made this call once:
`folderNoteSuggestions` is deliberately silent on note-less folders, because "this
folder has no note" is not a defect.

**Shape.** In the `validate` handler (`src/tools/librarian.ts`), run `computeTensions`
**without** `contents`, which skips near-duplicate detection and keeps it index-only
and cheap. Emit one line: `N consolidation tension(s) open (M dismissed) — run
consolidate.` Wrap it in its own try/catch like every other advisory section there;
link validation stands alone.

**Precedent to copy exactly.** The pending-import block in that same handler: another
tool owns a durable queue in `.isomorphic/`, validate reads it, reports the count, and
names the verb that answers it.

### W4. Persist the review ledger

**Why.** Without durable dismissals the queue re-raises the same judgment call every
run and the practice dies in two weeks. This is the same failure as an advisory nobody
can silence, and it is a live problem today: a brain deliberately using `README.md`
folder notes, or deliberately Obsidian-first, gets the same advisory forever.

**Shape.** `.isomorphic/review.json`, mirroring `.isomorphic/imports/<source>.json`.
`parseReviewLedger` / `serializeReviewLedger` / `dismiss` already exist and are tested.
Write it through `commitFiles` on the `BrainStore`, never a raw octokit call.

**Follow-on worth doing.** Give `validate`'s own advisories keys and filter them
through the same ledger. That improves what already exists rather than only serving the
new feature, and it is the strongest argument for building the ledger at all.

**Key stability is load-bearing.** Tension keys derive from kind plus paths, never from
the wording of a headline, so a retitle does not resurrect a dismissed tension. Pinned
directly in `test:consolidate`, and the ledger test depends on it: breaking key
stability turns both red.

### W5. `probe` as an MCP tool, and where questions live

**Blocked on W1.** Until search ranks, probe can report findability and competition but
not rank, so "did my retitle help" has no answer beyond binary.

**Shape.** `probe({ questions, expect })` runs each question through `searchIndex` and
returns `scoreProbe`'s verdict per question plus the summary. The model writes the
questions; the platform runs one statement each.

**Keep `absent` and `elsewhere` distinct.** `absent` means no page answered, which is a
content gap no structural check can ever find. `elsewhere` means the question is
answered by a page that does not own it, which is the competition case lexical
similarity cannot see. The first implementation collapsed both into one verdict and
reported "nothing matched" for queries that had in fact matched another page. That is
worse than no measurement, because it hides the finding probes exist to produce.

**Where questions live.** Recommended: a frontmatter list on the page itself
(`answers:`), written through the `fields` path that already exists and indexed for
free by `brain_page_fields`. Durable, versioned with the content, human-editable, and
it makes the page declare its own job.

**The trap that silently invalidates the instrument.** Questions stored on a page are
indexed like any other content, so the page matches its own probe because the probe is
printed on it, and the number then measures whether the question was written down.
`stripDeclaredProbes` exists for this and is tested; wiring it in is mandatory, not
optional, and it is the first thing to test.

**Second guard.** Probe rewards rank, and the degenerate way to raise rank is keyword
stuffing. Constrain the move set to retitle, describe, link, split, merge, and let
`log.md` record each one so the drift stays auditable.

### W6. Reconsolidation signal

**Why.** Agents append. Pages rot into changelogs because nothing ever re-derives them.
A page at many appends and no whole-body rewrite is the clearest staleness signal
available, and "rewrite this from scratch as if today, then diff" is a pure
model-token operation.

**Shape.** The write mode is already known at the `commitBundle` chokepoint in
`src/tools/librarian.ts`. Count appends and `edits` since the last whole-body `content`
write, per page, as a column on the index row. Additive migration. Surface it as a new
tension kind.

**Not measurable on an unmanaged brain.** A brain never written through our tools has
no history to count, which is why this is not W1 despite being conceptually central.

### W7. The practice page

Ship `brain-template/tools/consolidate.md` as a `prompt`-kind brain-authored tool
encoding the loop: pick a page, generate the questions it should own, probe, fix,
re-probe, log. Zero platform surface, editable per brain, and it puts the method where
each brain's owner can tune it. Run `pnpm gen:templates` after adding it.

## Invariants

Do not reverse these without reading the reasoning above.

1. **Everything the platform returns is computed, never generated.** No server-side
   inference anywhere in this loop. Judgment costs tokens in the caller's session.
2. **`validate` reports the count, never the findings.**
3. **Tension keys derive from kind plus paths, never from headline wording.**
4. **Dismissals are durable, in the repo, and filter both queues.**
5. **`absent` and `elsewhere` stay distinct verdicts.**
6. **Probe strips a page's declared questions before searching it.**
7. **Consolidation moves are reversible.** Demote (`status: archived` via `fields`)
   rather than delete; merge via `move_page` so inbound links repoint; every edit lands
   in `log.md` with a reason.
8. **No telemetry.** Counts, ledgers, and indexes stay in the deployment's own D1 and
   repo. Nothing about this loop may report anything outward.

## Deferred, and open questions

- **Conceptual duplicates.** `near-duplicate` is bigram Jaccard, which catches
  copy-paste drift only. On the measured brain the highest pair scored 0.09, well under
  the 0.2 floor, and zero was the correct answer there. The conceptual case needs
  probe's competition signal (W5) or a model, not a better threshold.
- **Thresholds are calibrated on synthetic pairs plus one real brain**, not a corpus:
  `MIN_FOLDER_PAGES_FOR_NOTE = 3`, `DUP_THRESHOLD = 0.2`, `CONTESTED_AT = 3`. Revisit
  once several brains have been measured.
- **Friction capture.** The platform cannot tell whether a search was useful; only the
  model knows it just read five pages to answer something that should have been one
  fact. Letting it deposit that observation mid-task, nudged by a line appended to a
  search that returned nothing (the `toolRosterNote` precedent), is the highest-value
  unbuilt input to the queue.
- **No per-page read counts.** `usage_daily` has no path grain, so "unread and useless"
  and "unread and load-bearing" are indistinguishable, which is what pruning needs. A
  coarse per-page weekly counter with no user attribution would fix it and sidesteps
  the privacy question the analytics design is careful about.
- **The app layer is uncovered**, as everywhere else.
