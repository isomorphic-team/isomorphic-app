# Design: consistency checks

Status: **proposed** (2026-10-13). C1 and C2 are built; the rest is not.

This is the consolidation half of the roadmap's "brain review" (steps 2 and 5).

- **Part 1** adds two computed checks to the core consolidation engine in `src/lib/consolidate.ts`.
- **Part 2** is model-powered consolidation in `ee/`, through the model gateway.
- **Part 3** covers consolidation findings in the unified findings queue and the Review screen.

Related:

- [`consolidation-loop.md`](./consolidation-loop.md): tensions, `validate`, `resolve`, and the invariants this design keeps.
- [`open-source-boundary.md`](./open-source-boundary.md): what goes in `ee/`, and the rule for sending content to a model provider.
- The companion [`privacy-checks.md`](./privacy-checks.md): the data-policy guard, and what consolidation may send to a model and write into a finding.

## The problem

The consolidation loop finds structural drift: islands, orphans, hollow folder notes and copy-paste near-duplicates. It does not find what goes wrong once several people, agents and scripts write to one brain:

1. **Contradictions.** Two pages state different facts about the same thing, or one page does against itself: a price, a rate, a date, a status, an owner, a title, the spelling of a name. The usual cause is a living page (an overview, a tracker, a profile, a reference table) that was not updated after a later dated record settled or changed the fact.
2. **Entity duplicates.** Two pages about the same person or thing, created by different writers under different names.

Contradictions are the common problem and the one this design is mostly about. Duplicates turned up in one brain in three.

## What was measured

Three private team brains, each from a local snapshot. Nothing was written to any of them.

|                       | Brain A                                                 | Brain B                     | Brain C                           |
| --------------------- | ------------------------------------------------------- | --------------------------- | --------------------------------- |
| Shape                 | 1,100 pages, adopted from a pre-existing knowledge base | 173 pages, event operations | 82 pages, a consulting engagement |
| Candidate pairs       | 3,212                                                   | 752                         | 306                               |
| `near-duplicate` hits | 14,725 in one folder, all template noise                | 6, all template             | 1, a meeting note and its profile |
| Entity duplicates     | 3                                                       | 0                           | 0                                 |
| Contradictions        | ~300 (9%, weighted sample)                              | at least 44 (6%)            | at least 35 (11%)                 |

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

| Detector                                   | B         | C         |
| ------------------------------------------ | --------- | --------- |
| Decision model `conflict` ≥ 0.3            | 40% / 59% | 55% / 66% |
| Small LLM conflict flag                    | 67% / 59% | 53% / 26% |
| **Decision model ≥ 0.2 OR small LLM flag** | 29% / 84% | 35% / 91% |

- **Asking the decision model extra questions did not help.** "Is one page stale against the other" and "do they give different values for the same thing" both scored lower than the plain conflict question, alone or combined.
- **Detection's lever is the threshold and the union of two cheap judges.** Low precision here is acceptable, because triage removes the false alarms.

**Triage.** Scored against the frontier model's grades, on the pairs it graded.

| Triage                                                                                  | B         | C         |
| --------------------------------------------------------------------------------------- | --------- | --------- |
| Small LLM, one issue per pair                                                           | 82% / 78% | 91% / 68% |
| Small LLM, every disagreement listed, then each decided                                 | 70% / 98% | 74% / 90% |
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
- **The verify questions are specific to the proposal's shape.** They held on proposals that state the correct fact and why it wins. On claim-by-claim proposals, which carry quotes instead, the same four questions scored good edits lower than bad ones. Of those edits, 88% were graded good, as good as the one-issue-per-pair proposer's 85%. Retargeted questions separated them on the graded sample:
  - Is the replaced text misleading?
  - Does the new text keep every still-true fact?
  - Is every new fact on the pages?

  That gate was chosen on the sample it was scored on, so it still needs a held-out check.

- **Claim-by-claim annotations were poor** (3 of 8 graded good).
- **Mechanical failures seen:**
  - Edits that name text not occurring exactly once on the page (a quarter of edits in brain A, near zero in B and C).
  - Annotations inserted between the rows of a markdown table. Instructing the model not to do this removed it in the second prompt.

## Decisions

### Part 1: two computed checks in the core

These are pure and stay in the AGPL core. They keep invariant 1 of the consolidation loop (computed, never generated) and report through the existing tension, finding and dismissal machinery.

**1a. A template-aware `near-duplicate`.** The existing check is noise on any brain with templated pages.

- Before comparing, drop from each page's shingle set every bigram held by at least a quarter of the pages in its folder, and by at least `MIN_TEMPLATE_HOLDERS` (4) pages. What remains is what the page says, not the shape it shares.
- The share is a quarter, not half, because folders mix stubs built from a template with full pages. On a 242-page private brain with a 44-page people folder, half left 54 false pairs in that folder and a quarter left 5. The holder floor keeps a few pages telling one story from being read as a template.
- A page left with too little to compare is dropped.
- This also permits scaling past the old 400-page limit. An inverted index, blocking pairs on bigrams held by at most `MAX_BLOCKING_PAGES` pages, replaces the all-pairs pass, and `MAX_DUP_PAGES` is 2,000. `validate` loads bodies in one call, so a brain past that still skips the check and a budgeted pass waits for C6.
- **Tests:**
  - a folder of templated pages about different entities: no tension
  - two pages telling the same story inside that folder: still flagged
  - the existing golden pairs: unchanged

  `DUP_THRESHOLD` stays pinned in both directions.

**1b. A `same-identifier` tension kind.** Two or more content pages whose frontmatter carries the same value for an identity field describe one entity. It is cheap and exact where a brain records identifiers, and silent where it does not.

- **Identity fields** are `email` by default. A brain adds its own in `.isomorphic.json` with `"review": {"identityFields": [...]}`, for example a CRM record ID. The list is data; the only field-specific rule is `email`'s normalization. A brain that restricts `index.fields` must keep these keys indexed.
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

### Part 2: model-powered consolidation in `ee/`

Contradictions need a model. Since 2026-09-30, model use has a home: `ee/`, behind the `review-models` entitlement, with every request through `ee/review/gateway.ts`.

- **Zero retention:** `ZDR_PROVIDER` routes only to zero-data-retention endpoints.
- **Entitled orgs only:** a brain whose org has no entitlement runs the core unchanged.
- **Spend cap:** a monthly cap per org, counted from the cost each response reports.

It uses two kinds of model:

- **The decision model** (Jev, through OpenRouter) for every yes/no judgment. Every gate below is a calibrated probability from it, so it is not swapped.
- **The small LLM** wherever text must be written. **Claude Haiku 5.5 comes first**, called on the Anthropic API with the operator's Anthropic key. Luna, through OpenRouter, is the fallback.

No frontier model is called.

**Why Haiku first.**

- It costs the same per token as Luna ($0.10 / $0.50 per million for prompts up to 100K tokens), and an operator holding Anthropic API credits pays nothing for it until they run out.
- It has a 1M-token context, so a pair of long pages never needs cutting.

**Haiku first is a gateway rule, not a consolidation rule.** The same order serves the data-policy guard's model stages (roadmap step 3): its structured-output stage writes text, so it gets Haiku first too. Its typed-decision gate stays on Jev, as consolidation's does, because the guard's severity gates are calibrated probabilities as well.

**How the gateway falls back.** The gateway gains an Anthropic adapter beside the OpenRouter one, and tries Haiku first for every text-writing request. It moves a request to Luna when:

- the deployment has no Anthropic key
- the Anthropic org is not configured for zero data retention
- Haiku returns `stop_reason: "refusal"` (it has no server-side fallback)
- the Anthropic side reports a rate limit or exhausted credits

The run summary records which model served each request.

**Zero retention still holds on both paths.** OpenRouter requests keep `ZDR_PROVIDER`. An Anthropic request is allowed only when the operator declares that their Anthropic organization has a zero-data-retention arrangement. There is no per-request flag to send, so the declaration is configuration, and without it the gateway skips Haiku.

**The measurements are Luna's.** Haiku's triage recall, proposal quality and verify behavior are unmeasured. Under the rule that changing the proposal format or model means re-grading the verify gate, the auto tier stays off for Haiku-written proposals until a graded sample exists.

1. **Candidates.** Per run:
   - Pages changed since the last run, each paired with its top five search hits.
   - The Part 1 tensions.

   A full pass is admin-requested and budgeted.

2. **Pre-scan.** Every candidate page is checked against the guard's detectors before anything reaches the gateway. A page with a high-severity detection (a private key, an API token, a card number) is never sent. Skipped pairs are counted in the run summary, so a gap never reads as clean ([`privacy-checks.md`](./privacy-checks.md)).
3. **Detect.** Both models judge each pair. A pair continues if either says so: the decision model's conflict probability is at least 0.2, or the LLM flags a conflict. This is tuned for recall, and precision is triage's job.
4. **Triage, claim by claim.**
   - The LLM lists every point where the pages, or one page against itself, disagree about the same thing. It quotes both sides and says whether dates, scope or an existing note explain the difference.
   - For each claim it names the version that stands, using generic authority rules derived from `type:` and date fields:
     - A dated record outranks a summary of it.
     - The later dated record wins where facts changed.
     - A dated record that was accurate on its date is annotated, never rewritten.
   - It proposes one action per claim: a patch in `write_page`'s patch vocabulary, a dated note, or "needs a person".
   - The decision model then scores each claim: would a reader of the current pages be misled? Claims below 0.4 are dropped.
5. **Cluster.** Claims about the same fact are grouped across pairs, so a fact stale on five pages is one finding with five pages, not five findings. A cluster is the unit of review.
6. **Verify.**
   - The decision model answers verify questions written for the proposal's shape. For claim-by-claim patches, that means the three retargeted questions (misleading, keeps facts, supported).
   - Mechanical checks confirm that each patch applies exactly once, and that the result still parses as the same markdown structure (no table split, no broken list or fence).
7. **Tier.**
   - **Auto:** off by default. An admin enables it per brain (roadmap step 5). When enabled, it covers patch actions that clear a gate graded for that proposal shape and pass the mechanical checks.
   - **Review:** everything else with a concrete proposal, including every annotation, merge and archive.
   - **Person:** claims the pages cannot settle.
   - **Dropped:** claims triage or the claim filter rejected.

**Writes.**

- An approved or auto fix lands through the `write_page` path, so it passes through `guardStore` like any other write and through the brain's configured write mode.
- Each carries a `log.md` entry naming the finding key. Consolidation-loop invariant 7 holds: every move is reversible and logged.

**Cost.**

- Measured: under $1 per 1,000 candidate pairs to detect, and about $0.40 per 100 flagged pairs to triage.
- A full pass over a 1,000-page brain costs a few dollars. An incremental run costs cents.
- Both fit inside `DEFAULT_MONTHLY_CAP_USD`. The gateway refuses a call once the org's cap is spent, and the run records where it stopped so the next one resumes.
- **Cost on the Anthropic path.** It is computed from the response's token usage and the model's list price, because the Anthropic API reports tokens, not dollars. Haiku 5.5's tokenizer counts about 30% more tokens than its predecessor for the same text, so estimates use its own counts. Spend paid from credits still counts toward the cap, so the cap means the same thing whichever provider served the call.

**When it runs.**

- **Incrementally:** on the push webhook (roadmap step 4), for pages changed since the last run.
- **In full:** on an admin's request.

The Worker has no Durable Object and no cron trigger, so a pass is a cursor in D1 that each invocation advances within its budget, under the whole-brain pass rule.

### Part 3: consolidation findings in the unified queue

Roadmap step 2 extends the `validate` / `resolve` pattern into one findings queue in D1, with a finding `kind` and visibility per kind. The queue lives in the core; this design adds the consolidation kinds to it.

- **Kinds:** `conflict` and `duplicate`, beside the computed tensions.
- **Visibility:** consolidation findings are visible to editors. Policy findings stay visible to the author and admins only.
- **A row carries:**
  - key, kind and paths
  - headline and evidence (the quoted lines that disagree, scrubbed through the detectors before they are stored)
  - the proposal and the scores
  - the blob SHA of each page at check time
  - the run that produced it
- **Keys** follow invariant 3: kind plus the sorted paths of the cluster, never wording.
- **Dismissals stay in the brain** (`.isomorphic/review.json`, invariant 4), so they survive a redeploy or a move to another deployment. The queue is derived state; the dismissal is the decision.
- **`validate`** counts open consolidation findings and drops dismissed ones through `filterDismissed`. A finding whose page SHAs no longer match is reported as stale, not as open.
- **`resolve`** dismisses one by key, like any other. No new tool.
- **The Review screen** gains a consolidation section for editors, beside the admin-only policy section. Each item shows:
  - the headline
  - the pages in the cluster, with the disagreeing lines marked
  - the proposed change per page

  Approve applies it through the `write_page` path, and dismiss goes through `resolve`. Review is where most of the value lands: in the measurements, review and person items outnumbered auto items by more than five to one.

## Invariants

- **Unchanged:** the consolidation loop's invariants 3, 4, 7 and 8.
- **Invariant 1 is scoped to the core.**
  - Everything the core returns stays computed.
  - Model output comes only from `ee/`, through the gateway, for an entitled org, to zero-data-retention endpoints. That is processing on the operator's behalf ([`open-source-boundary.md`](./open-source-boundary.md)).
  - [`consolidation-loop.md`](./consolidation-loop.md) states the scope.
- **New:**
  - An auto-tier change requires a passing verify on the proposal itself, not a confident detection or the proposing model's own confidence.
  - Changing the proposal format means re-grading the verify gate.
  - A page with a high-severity detection never reaches the gateway.

## Not in scope

- **A generated-page marker.** Detecting pages that lag the records they summarize without a model needs a field saying a page is generated and from what. OKF does not have one. The checker finds the resulting contradictions claim by claim, which is the same pattern as a hand-written page that fell behind.
- **Auto-applying merges, archives or annotations.** They always go to review.
- **A frontier model in the pipeline.** One graded the measurements; the product runs on the two cheap models only.

## Work items

| Item | What                                                                                                       | Where                    | Surface                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| C1   | Built: template-aware `near-duplicate`, scaling to `MAX_DUP_PAGES`                                         | core                     | `consolidate.ts`, tests                                                       |
| C2   | Built: `same-identifier` tension                                                                           | core                     | `consolidate.ts`, config field, tests                                         |
| C3   | Consolidation kinds in the unified findings queue, staleness, `validate` and `resolve`                     | core (roadmap step 2)    | D1 migration, findings, tests                                                 |
| C4   | Pipeline: candidates, pre-scan, detect, claim triage, verify, tier, through the gateway                    | `ee/` (roadmap step 5)   | `ee/review/`, tests with a stubbed gateway                                    |
| C4a  | Anthropic adapter in the gateway: Haiku first, Luna fallback, zero-retention declaration, cost from tokens | `ee/`                    | `ee/review/gateway.ts`, tests pinning the fallback order and the refusal path |
| C5   | Claim clustering across pairs                                                                              | `ee/`                    | pipeline, tests with a stubbed gateway                                        |
| C6   | Runs: webhook-triggered incremental pass, admin full pass, D1 cursor                                       | core trigger, `ee/` work | webhook (roadmap step 4), tests                                               |
| C7   | Consolidation section of the Review screen, approve and dismiss                                            | core                     | `ReviewView.tsx`, browser tests                                               |

C1 and C2 stand alone and ship first. C3 is shared with the guard's own findings and belongs to roadmap step 2. C4 and C5 are the model work. C7 is where the value lands for people, because the review tier carries most of the work.

## Open questions

- **Is Haiku as good a triager as Luna?** The claim-by-claim prompt, the claim filter and the verify gate were all measured with Luna. One graded run of Haiku on the same flagged sets settles it; until then the auto tier stays off for its proposals.
- **Should credits count toward the cap?** Counting them keeps the cap's meaning stable. Not counting them lets an operator spend credits freely and keeps the cap for real money.
- **The gates** (0.2 to detect, 0.4 per claim, the auto gate) come from three brains graded by a model whose own first pass misses real issues. They need a person-labelled sample before any default is trusted.
- **The auto gate for claim-by-claim patches is a hypothesis.** The three retargeted questions at 0.5 passed 22 of 52 graded edits, all good. The gate was chosen on those same edits, so it needs a held-out sample before auto-apply is offered for them.
- **How should claims be clustered?** Options: by the decision model on claim pairs, by a normalized subject key the LLM emits, or both. Clusters change as pages change. Is the finding key the sorted union of the cluster's paths, or one key per page pair, grouped only for display?
- **Do contradictions inside one page need their own single-page pass,** or is the pairwise pass enough in practice?
- **Is a D1 cursor enough** for a full pass on a large brain within Worker limits, or does a full pass need a queue?
