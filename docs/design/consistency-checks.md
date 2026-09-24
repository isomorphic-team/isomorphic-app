# Design: consistency checks

Status: **proposed** (2026-09-24). Nothing below is built.

- **Part 1** extends the consolidation engine in `src/lib/consolidate.ts`.
- **Part 2** adds a checker that runs outside the platform.
- **Part 3** adds the platform surfaces that read the checker's output.

Related: [`consolidation-loop.md`](./consolidation-loop.md) (tensions, `validate`, `resolve`, and the invariants this design keeps), [`brain-seams.md`](./brain-seams.md).

## The problem

The consolidation loop finds structural drift: islands, orphans, hollow folder notes and copy-paste near-duplicates. It does not find what goes wrong once several people, agents and scripts write to one brain:

1. **Contradictions.** Two pages state different facts about the same thing, or one page does against itself: a price, a rate, a date, a status, an owner, a title, the spelling of a name. The usual cause is a living page (an overview, a tracker, a profile, a reference table) that was not updated after a later dated record settled or changed the fact.
2. **Entity duplicates.** Two pages about the same person or thing, created by different writers under different names.

Contradictions are the common problem and the one this design is mostly about. Duplicates turned up in one brain in three.

## What was measured

Three private team brains, each from a local snapshot. Nothing was written to any of them.

| | Brain A | Brain B | Brain C |
|---|---|---|---|
| Shape | 1,100 pages, adopted from a pre-existing knowledge base | 173 pages, event operations | 82 pages, a consulting engagement |
| Candidate pairs | 3,212 | 752 | 306 |
| `near-duplicate` hits | 14,725 in one folder, all template noise | 6, all template | 1, a meeting note and its profile |
| Entity duplicates | 3 | 0 | 0 |
| Contradictions | ~300 (9%, weighted sample) | at least 44 (6%) | at least 35 (11%) |

**Method.**

- **Candidates.** Each page's title was run through `search_pages`, keeping the top hits. The built-in `near-duplicate` pairs were added.
- **Judges.** Every pair went to two cheap judges:
  - **A decision model** (TypeSafe's Jev 1.13). It returns calibrated probabilities for typed questions and never generates text. About $0.23 per 1,000 pairs.
  - **A small LLM** (GPT-6 Luna). About $0.72 per 1,000 pairs.
- **Reference.** A frontier model (Claude Opus 5.5) read every pair in B and C, and a stratified sample of 164 in A.
- **Remediation.** The small LLM proposed fixes, the decision model checked them, and the frontier model graded them.

**Findings:**

- **The reference is itself incomplete.** When the frontier model graded a proposal, it called 30 pairs real that its own first pass over the same pair had marked clean. The contradiction counts are floors. Every rate below is a model's judgment, not a person's.
- **Contradictions cluster by fact.** In B, one billing rate was stale on four pages against the reconciliation that settled it. In C, one correction (which platform a team uses) was missing from five pages. Pairwise checking reports each cluster four or five times.
- **Some contradictions sit inside one page.** A later section supersedes an earlier one that nobody edited. A pair containing that page can surface it, but pairwise checking does not target it.
- **Entity duplicates appeared only in brain A, and a computation finds all of them.** Its three duplicate person pages each share an `email` value, and no other pair of pages does. B and C carry no identity field on content pages. In B, two bookkeeping pages outside the content root share an email and are not duplicates.
- **`near-duplicate` is template noise where pages are templated.** In A, all 527 high-overlap pairs (bigram 0.6 or more) were templated pages about different entities. In B and C there is almost nothing to find.

**Detection.** Precision and recall against the reference pair labels:

| Detector | B | C |
|---|---|---|
| Decision model `conflict` ≥ 0.3 | 40% / 59% | 55% / 66% |
| Small LLM conflict flag | 67% / 59% | 53% / 26% |
| **Decision model ≥ 0.2 OR small LLM flag** | 29% / 84% | 35% / 91% |

- **Asking the decision model extra questions did not help.** "Is one page stale against the other" and "do they give different values for the same thing" both scored lower than the plain conflict question, alone or combined.
- **Detection's lever is the threshold and the union of two cheap judges.** Low precision here is acceptable, because triage removes the false alarms.

**Triage.** Scored against the frontier model's grades, on the pairs it graded.

| Triage | B | C |
|---|---|---|
| Small LLM, one issue per pair | 82% / 78% | 91% / 68% |
| Small LLM, every disagreement listed, then each decided | 70% / 98% | 74% / 90% |
| The same, keeping claims the decision model scores ≥ 0.4 on "would a reader be misled?" | 71% / 93% | 79% / 84% |

- **One issue per pair was the main source of misses.** The LLM checked one candidate difference, found it explained, and dismissed the pair while a second contradiction sat elsewhere on the pages.
- **Listing every disagreement first fixes that,** at about $0.37 per 100 flagged pairs including the decision-model filter.
- **The LLM's own confidence on a claim carries no signal.**

**Applying fixes.** Every fix passed the decision model's verify check, which asks four yes/no questions:

1. Is every fact the fix writes stated in the two pages?
2. Does it keep the more authoritative source?
3. Can the two pages alone settle it?
4. Does it leave dated records as they were?

Results:

- **Across all three brains, a 0.8 gate on the minimum of the four answers auto-applied 14 fixes, all graded good.** The LLM's self-reported confidence on the harmful proposals was 0.84 to 0.98, so it is not a gate.
- **Relaxing the gate for annotations is not safe.** Annotations score low on questions 2 and 3 by design, so gating them on 1 and 4 alone is tempting. It added good fixes in one brain and bad ones in another.
- **Mechanical failures seen:**
  - Edits that name text not occurring exactly once on the page (a quarter of edits in brain A, near zero in B and C).
  - Annotations inserted between the rows of a markdown table. Instructing the model not to do this removed it in the second prompt.

## Decisions

### Part 1: computed checks in `validate`

These are pure, keep invariant 1 of the consolidation loop (computed, never generated), and report through the existing tension, finding and dismissal machinery.

**1a. A template-aware `near-duplicate`.** The existing check is noise on any brain with templated pages.

- Before comparing, drop from each page's shingle set every bigram that occurs on at least half the pages in its folder, when the folder holds enough pages to have a template. What remains is what the page says, not the shape it shares.
- This also permits scaling past `MAX_DUP_PAGES`. An inverted index, blocking pairs on shared rare bigrams, replaces the all-pairs pass. Bodies are still loaded through the index, under the budgeted and resumable rule for whole-brain passes.
- **Tests:**
  - a folder of templated pages about different entities: no tension
  - two pages telling the same story inside that folder: still flagged
  - the existing golden pairs: unchanged

  `DUP_THRESHOLD` stays pinned in both directions.

**1b. A `same-identifier` tension kind.** Two or more content pages whose frontmatter carries the same value for an identity field describe one entity. Cheap and exact where a brain records identifiers, silent where it does not.

- **Identity fields** are `email` by default. A brain adds its own in `.isomorphic.json` with an optional list of frontmatter keys, for example a CRM record ID. The list is data; no field name is special-cased in code.
- **Scope:** content pages under the brain's content roots only. Folder notes and tool-maintained pages are excluded.
- **Normalization:** trim, then lowercase for `email`. Other fields compare exactly.
- **Source:** `fieldsByPath`, which `validate` already loads from the queryable frontmatter table. No page bodies, so no page-count cap.
- **One tension per group**, keyed by kind plus the sorted paths.
- **Move:** merge into the fuller page, then `move_page` the other onto it so inbound links follow.
- **Tests** in `pnpm test:consolidate`:
  - two pages sharing an email: one tension
  - three pages sharing one: one tension
  - a list-valued field
  - case and whitespace differences
  - a field declared in config
  - a folder note or a page outside the content roots with the same email: no tension

### Part 2: a consistency checker outside the platform

Contradictions need a model. The platform does not run inference (consolidation-loop invariant 1), and per-tenant model keys are not a platform concern (roadmap). So the checker is a program the brain's operator runs with the operator's own key, locally or as a scheduled job in the brain repo. It ships in this repo and is open source like everything else. It reads a git checkout through `openFolderAsBrain` (`scripts/local-brain.ts`), so it uses the real content index and search.

It uses two cheap models: a decision model for every yes/no judgment, and a small LLM wherever text must be written. Providers are configuration: an OpenAI-compatible chat endpoint and a decisions endpoint, each with a model name. Nothing assumes a vendor. A deployment that configures no decision model runs its questions on the LLM, at higher cost. The pipeline never calls a frontier model.

1. **Candidates.** A full pass on request, otherwise pages changed since the last run:
   - Each page paired with its top five search hits.
   - The Part 1 tensions.
2. **Detect.** Both models judge each pair. A pair continues if either says so: the decision model's conflict probability is at least 0.2, or the LLM flags a conflict. This is tuned for recall, and precision is triage's job.
3. **Triage, claim by claim.**
   - The LLM lists every point where the pages, or one page against itself, disagree about the same thing. It quotes both sides and says whether dates, scope or an existing note explain the difference.
   - For each claim it names the version that stands, using generic authority rules derived from `type:` and date fields:
     - A dated record outranks a summary of it.
     - The later dated record wins where facts changed.
     - A dated record that was accurate on its date is annotated, never rewritten.
   - It proposes one action per claim: a patch in `write_page`'s patch vocabulary, a dated note, or "needs a person".
   - The decision model then scores each claim: would a reader of the current pages be misled? Claims below 0.4 are dropped.
4. **Cluster.** Claims about the same fact are grouped across pairs, so a fact stale on five pages is one finding with five pages, not five findings. A cluster is the unit of review.
5. **Verify.**
   - The decision model answers the four questions above for each proposed patch.
   - Mechanical checks confirm that each patch applies exactly once, and that the result still parses as the same markdown structure (no table split, no broken list or fence).
6. **Tier.**
   - **Auto:** patch actions whose four verify answers are all at least 0.8 and that pass the mechanical checks.
   - **Review:** everything else with a concrete proposal, including every annotation, merge and archive.
   - **Person:** claims the pages cannot settle.
   - **Dropped:** claims triage or the claim filter rejected.

**Cost:** under $1 per 1,000 candidate pairs to detect, and about $0.40 per 100 flagged pairs to triage. A full pass over a 1,000-page brain costs a few dollars. An incremental run costs cents.

**Output, written into the brain and nowhere else:**

- **`.isomorphic/findings.json`**, one entry per open finding:
  - key, kind (`conflict` or `duplicate`) and paths
  - headline and evidence (the quoted lines that disagree)
  - the proposal and the scores
  - the blob SHA of each page at check time
  - the checker version

  Keys follow invariant 3: kind plus sorted paths, never wording.
- **Auto-tier changes** land through the brain's configured write mode, direct commit or pull request. Each carries a `log.md` entry naming the finding key. Invariant 7 holds: every move is reversible and logged.

### Part 3: the platform reads the findings

- **`validate`** reads `.isomorphic/findings.json` beside its computed findings. It counts them and drops dismissed ones through `filterDismissed`. A finding whose page SHAs no longer match is reported as stale, not as open.
- **`resolve`** dismisses a checker finding by key, like any other. No new tool.
- **The web app** gets a review queue. Each item shows:
  - the headline
  - the pages in the cluster, with the disagreeing lines marked
  - the proposed change per page

  Approve applies the proposal through the `write_page` path. Dismiss goes through `resolve`. Review is where most of the value lands: in the measurements, review and person items outnumbered auto items by more than five to one.

## Invariants

- **Unchanged:** the consolidation loop's invariants 1, 3, 4, 7 and 8.
  - The platform still generates nothing. Model calls happen only in the operator-run checker, on the operator's key.
  - Findings and dismissals live in the brain repo.
  - Nothing is reported outward.
- **New:** an auto-tier change requires a passing verify on the proposal itself, not a confident detection or the proposing model's own confidence.

## Not in scope

- **A generated-page marker.** Detecting pages that lag the records they summarize without a model needs a field saying a page is generated and from what. OKF does not have one. The checker finds the resulting contradictions claim by claim, which is the same pattern as a hand-written page that fell behind.
- **Server-side inference, or a platform-held model key.** Either reverses consolidation-loop invariant 1. That is a one-way decision that needs its own design.
- **Auto-applying merges, archives or annotations.** They always go to review.

## Work items

| Item | What | Model | Surface |
|---|---|---|---|
| W1 | Template-aware `near-duplicate`, scaling past `MAX_DUP_PAGES` | No | `consolidate.ts`, tests |
| W2 | `same-identifier` tension | No | `consolidate.ts`, config field, tests |
| W3 | Checker: candidates, detect, claim triage, verify, tier, as a local command | Yes, operator key | `scripts/`, tests with stubbed providers |
| W4 | Claim clustering across pairs | Yes, operator key | checker, tests with stubbed providers |
| W5 | `validate` and `resolve` read `.isomorphic/findings.json`, with staleness | No | `validate`, findings, tests |
| W6 | Review queue in the web app | No | `/b/` app, browser tests |
| W7 | Example scheduled workflow for a brain repo | Yes, operator key | docs, brain template |

W1 and W2 stand alone and ship first; W1 matters on any templated brain, and W2 on a brain that records identifiers. W3 and W5 together make the checker useful. W4 is what keeps the queue short enough for people. W6 is where the value lands.

## Open questions

- **The gates** (0.2 to detect, 0.4 per claim, 0.8 to auto-apply) come from three brains graded by a model whose own first pass misses real issues. They need a person-labelled sample before any default is trusted.
- **Proposal quality from claim-by-claim triage is not yet graded.** Its detection is measured; its patches are not. Until they are, the auto tier could be limited to the one-issue-per-pair proposer, which is graded.
- **How should claims be clustered?** Options: by the decision model on claim pairs, by a normalized subject key the LLM emits, or both. Clusters change as pages change. Is the finding key the sorted union of the cluster's paths, or one key per page pair, grouped only for display?
- **Do contradictions inside one page need their own single-page pass,** or is the pairwise pass enough in practice?
- Should auto-tier changes default to a pull request for every brain, whatever its write mode?
- Findings go stale when a page changes. Should the checker re-verify stale findings on its next run, or drop them and re-detect?
