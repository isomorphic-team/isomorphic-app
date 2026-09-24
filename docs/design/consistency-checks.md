# Design: consistency checks

Status: **proposed** (2026-09-24). Nothing below is built. Part 1 extends the consolidation
engine in `src/lib/consolidate.ts`. Parts 2 and 3 add a checker that runs outside the
platform, plus the platform surfaces that read its output.

Related: [`consolidation-loop.md`](./consolidation-loop.md) (tensions, `validate`,
`resolve`, and the invariants this design keeps), [`brain-seams.md`](./brain-seams.md).

## The problem

The consolidation loop finds structural drift: islands, orphans, hollow folder notes and
copy-paste near-duplicates. It does not find the two problems that matter most once a brain
is large and written by several agents and scripts:

1. **Entity duplicates.** Two pages about the same person or thing, created by different
   writers under different names.
2. **Contradictions.** Two pages that state different facts about the same thing: a price, a
   date, a status, a headcount, a title.

The `near-duplicate` tension misses both. Bigram overlap cannot see two differently written
pages about one entity, and on templated pages it fires on the shared template instead.

## What was measured

Everything below comes from one private team brain of about 1,100 pages. It was adopted into
Isomorphic from a knowledge base that predates it, so it carries conventions of its own; the
design below keys off none of them. The run used a local snapshot, and nothing was written
to the brain.

**Candidate pairs.** 3,212 pairs:

- 761 from `near-duplicate`, run per folder, because the whole brain exceeds `MAX_DUP_PAGES`.
- 2,486 from search: each page's title through `search_pages`, keeping the top 3 hits.

**Judges.** Every pair went to two models:

- **A decision model** (TypeSafe's Jev 1.13). It returns calibrated probabilities for typed
  questions and never generates text. About $0.25 per 1,000 pairs, 200 ms per pair.
- **A small LLM** (GPT-6 Luna). About $0.78 per 1,000 pairs, 800 ms per pair.

A frontier model (Claude Opus 5.5) graded a stratified sample of 164 pairs as the reference.
Rates are reweighted to the full population.

Findings:

- **`near-duplicate` was noise on this brain.** One folder of person pages produced 14,725
  near-duplicate tensions. Every high-overlap pair (bigram 0.6 or more, 527 pairs) was judged
  keep-both by both models: templated pages about different people, events or coaches.
- **True entity duplicates were rare, and a computation finds all of them.** The reference
  found three duplicate person pages. Each pair shares an `email` value, and no other pair of
  person pages does. Grouping pages by identifier finds exactly the three, with no model.
- **Contradictions were common.** An estimated 300 of the 3,212 pairs contradict each other.
  Examples: a price stated as two figures, a credit balance, a data-retention term, an
  attendee count, a person's title. The interval is wide: the unflagged stratum rests on 85
  sampled pairs.
- **The decision model is a usable conflict detector.**

  | Detector | Pairs flagged | Precision | Recall |
  |---|---|---|---|
  | Decision model at 0.5 | 292 | 63% | 56% |
  | Small LLM | 269 | 58% | 52% |
  | Decision model at 0.3 | 691 | 35% | 81% |

  At 0.5 the decision model matches the LLM at a third of the cost and four times the speed.
  Its confidence behaved as calibrated: agreement with the LLM rose from 91% below 0.4 to
  100% above 0.9.
- **A second decision-model pass is the right gate for applying fixes.** The small LLM
  proposed a fix for each flagged pair. The decision model then checked each fix with four
  yes/no questions:
  - Is every fact the fix writes stated in the two pages?
  - Does the fix keep the more authoritative source?
  - Can the two pages alone settle it?
  - Does the fix leave dated records as they were?

  All five fixes the reference graded harmful scored below 0.8 on this check. The LLM's own
  confidence on those five was 0.82 to 0.98. At a 0.8 gate, 7 of the 72 real issues in the
  sample were applied without review and none was wrong. 53 had a concrete fix waiting for
  approval, and 16 needed a person.
- **Raw find/replace is the wrong edit format.** 25 of 59 proposed edits named text that did
  not occur exactly once on the page. The `write_page` patch path should do the applying,
  not string replacement.
- **Most contradictions were stale derived pages.** Summaries written by the brain's own
  ingest scripts had fallen behind the records they summarize. A fix applied to such a page
  is overwritten on the next regeneration. This is a property of that brain's scripts, and
  the design does not model it; see "Not in scope".

## Decisions

### Part 1: two computed checks in `validate`

These are pure, keep invariant 1 of the consolidation loop (computed, never generated), and
report through the existing tension, finding and dismissal machinery.

**1a. A new `same-identifier` tension kind.** Two or more content pages whose frontmatter
carries the same value for an identity field describe one entity.

- **Identity fields** are `email` by default. A brain adds its own in `.isomorphic.json` with
  an optional list of frontmatter keys, for example a CRM record ID or an employee number. The
  list is data; no field name is special-cased in code.
- **Normalization:** trim, then lowercase for `email`. Other fields compare exactly.
- **Source:** `fieldsByPath`, which `validate` already loads from the queryable frontmatter
  table. No page bodies, so no page-count cap.
- **One tension per group**, keyed by kind plus the sorted paths. Folder notes and
  tool-maintained pages are excluded.
- **Move:** merge into the fuller page, then `move_page` the other onto it so inbound links
  follow.
- **Tests** in `pnpm test:consolidate`:
  - two pages sharing an email: one tension
  - three pages sharing one email: one tension, not three
  - a list-valued field
  - case and whitespace differences
  - an identity field declared in config
  - a folder note carrying the same email: no tension

**1b. A template-aware `near-duplicate`.**

- Before comparing, drop from each page's shingle set every bigram that occurs on at least
  half the pages in its folder, when the folder holds enough pages to have a template. What
  remains is what the page says, not the shape it shares.
- This also permits scaling past `MAX_DUP_PAGES`. Blocking pairs on shared rare bigrams, an
  inverted index, replaces the all-pairs pass. Bodies are still loaded through the index,
  under the budgeted and resumable rule for whole-brain passes.
- **Tests:**
  - a folder of templated pages about different entities: no tension
  - two pages telling the same story inside that folder: still flagged
  - the existing golden pairs: unchanged

  `DUP_THRESHOLD` stays pinned in both directions.

### Part 2: a consistency checker outside the platform

Contradictions need a model. The platform does not run inference (consolidation-loop
invariant 1), and per-tenant model keys are not a platform concern (roadmap). So the checker
is a program the brain's operator runs with the operator's own key: locally, or as a
scheduled job in the brain repo. It ships in this repo and is open source like everything
else. It reads a git checkout through `openFolderAsBrain` (`scripts/local-brain.ts`), so it
uses the real content index and search.

Pipeline:

1. **Candidates.**
   - Pages changed since the last run, each paired with its top search hits.
   - The Part 1 tensions.
   - A full pass on request.
2. **Detect.** The decision model scores each pair: does it conflict, and is it a duplicate
   or does one page subsume the other. Pairs below the detection gate (0.3 as measured) stop
   here.
3. **Propose.** An LLM decides whether the issue is real and proposes one action:
   - a patch, in `write_page`'s patch vocabulary
   - a dated note
   - merge or archive (through `move_page` and `status: archived`)
   - no action
   - needs a person

   Its authority rules are generic, derived from `type:` and date fields:
   - A dated record outranks a summary of it.
   - The later dated record wins where facts changed.
   - A dated record that was accurate on its date is annotated, never rewritten.
4. **Verify.**
   - The decision model answers the four questions above.
   - A mechanical check confirms the patch applies cleanly.
5. **Tier.**
   - **Auto:** patch or note actions whose minimum verify score clears the auto gate (0.8 as
     measured) and that apply cleanly.
   - **Review:** everything else with a concrete proposal, plus every merge and archive.
   - **Person:** needs a person.
   - **Dismissed:** no action.

Providers are configuration: an OpenAI-compatible chat endpoint and a decisions endpoint, each
with a model name. Nothing in the pipeline assumes a vendor. A deployment that configures no
decision model can run detect and verify on the LLM, at higher cost.

**Output, written into the brain and nowhere else:**

- **`.isomorphic/findings.json`**, one entry per open finding:
  - key, kind (`conflict` or `duplicate`) and paths
  - headline and evidence (the quoted lines that disagree)
  - the proposal and the scores
  - the blob SHA of each page at check time
  - the checker version

  Keys follow invariant 3: kind plus paths, never wording.
- **Auto-tier changes** land through the brain's configured write mode, direct commit or pull
  request. Each carries a `log.md` entry naming the finding key. Invariant 7 holds: every
  move is reversible and logged.

### Part 3: the platform reads the findings

- **`validate`** reads `.isomorphic/findings.json` beside its computed findings. It counts
  them and drops dismissed ones through `filterDismissed`. A finding whose page SHAs no
  longer match is reported as stale, not as open.
- **`resolve`** dismisses a checker finding by key, like any other. No new tool.
- **The web app** gets a review queue. Each item shows the headline, the two pages side by
  side with the disagreeing lines marked, and the proposed change. Approve applies the
  proposal through the `write_page` path. Dismiss goes through `resolve`.

## Invariants

- **Unchanged:** the consolidation loop's invariants 1, 3, 4, 7 and 8.
  - The platform still generates nothing. Model calls happen only in the operator-run
    checker, on the operator's key.
  - Findings and dismissals live in the brain repo.
  - Nothing is reported outward.
- **New:** an auto-tier change requires a passing verify on the proposal itself, not only a
  confident detection. The measurement above is the reason.

## Not in scope

- **Pages that lag the records they summarize.** Detecting these without a model needs a
  marker saying a page is generated and from what, which OKF does not have. An optional
  `generated_by` field would be additive, but one brain is not enough reason to change the
  format. The checker finds the resulting contradictions page by page.
- **Server-side inference, or a platform-held model key.** Either reverses consolidation-loop
  invariant 1, which is a one-way decision that needs its own design.
- **Auto-applying merges or archives.** They always go to review.

## Work items

| Item | What | Model | Surface |
|---|---|---|---|
| W1 | `same-identifier` tension | No | `consolidate.ts`, config field, tests |
| W2 | Template-aware `near-duplicate`, scaling past `MAX_DUP_PAGES` | No | `consolidate.ts`, tests |
| W3 | Checker as a local command over a checkout | Yes, operator key | `scripts/`, tests with stubbed providers |
| W4 | `validate` and `resolve` read `.isomorphic/findings.json`, with staleness | No | `validate`, findings, tests |
| W5 | Review queue in the web app | No | `/b/` app, browser tests |
| W6 | Example scheduled workflow for a brain repo | Yes, operator key | docs, brain template |

W1 and W2 stand alone and ship first. W3 and W4 together make the checker useful. W5 is
where most of the value lands for people, because the review tier carries most of the work.

## Open questions

- Which identity fields beyond `email` are common enough to recognize by default, if any?
- The gates (0.3 to detect, 0.8 to auto-apply) come from one brain graded by a model, not a
  person. They need a person-labelled sample, and a second brain, before any default is
  trusted.
- Should auto-tier changes default to a pull request for every brain, whatever its write mode?
- Findings go stale when either page changes. Should the checker re-verify stale findings on
  its next run, or drop them and re-detect?
