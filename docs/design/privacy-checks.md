# Design: privacy checks

Status: **proposed** (2026-10-13). Nothing below is built. What it builds on, the data-policy guard, is.

This is the companion to [`consistency-checks.md`](./consistency-checks.md), and the privacy half of the roadmap's "brain review". The guard answers one question: did a write put sensitive data into a brain? This doc covers what the guard leaves open:
- what was already in the brain before the guard
- what no pattern can see
- who can reach what is sensitive
- what consolidation may send to a model

Related:
- The guard: `src/lib/policy-guard.ts`, and the write-path rules.
- [`open-source-boundary.md`](./open-source-boundary.md): the deterministic detectors stay in the core; model stages go in `ee/`.
- [`brain-level-permissions.md`](./brain-level-permissions.md) and [`guest-access.md`](./guest-access.md): who can read a brain.
- [`link-sharing-and-the-web-app.md`](./link-sharing-and-the-web-app.md) and [`brain-seams.md`](./brain-seams.md): surfaces that carry pages to new audiences.

## What is built

The data-policy guard, roadmap "brain review" step 1:

- **`guardStore` wraps the store** the Worker and the local runtime hand to every tool, so it sees every write that reaches `commitOrPR` or `commitFiles`: page writes, moves, media, the importer, config.
- **Deterministic detectors** (`src/lib/policy-detectors.ts`), tuned for precision:
  - private keys, API tokens, card numbers (Luhn), US Social Security numbers
  - labelled medical record numbers and dates of birth

  Emails and phone numbers are deliberately not detected.
- **Shadow mode on every brain.** A write is never blocked. Detections are recorded in D1 `policy_detections` as offsets, and the table has no column that could hold the matched text.
- **Admins see detections.** `validate` lists them for brain admins (`detectionSection`), and the Review screen (`view_review`) shows the same rows, grouped by page and kind, over `REPORT_WINDOW_DAYS`.
- **Forward-only by decision.** No backfill scan of existing content.

Steps 3 and 4 of the roadmap add the rest of the guard:
- a rulebook page
- model stages behind the gateway
- tiered outcomes and quarantine in D1
- a push webhook that scans writes made outside Isomorphic

## What was measured

An open-source scanner, okf-privacy-scan (MIT), ran in summary mode over the three brains the companion doc measured (A: 1,143 files, B: 192, C: 84). Its detectors overlap the guard's closely: government identifiers with structural checks, cards by network prefix plus Luhn, private keys, and connection strings with an inline password. No paths or values were read.

| | Brain A | Brain B | Brain C |
|---|---|---|---|
| Files flagged | 2 | 0 | 0 |
| Detections | connection string (2), private key, government id, card number | none | none |
| Declared sensitive (frontmatter or path) | 0 | 0 | 0 |
| Encrypted paths | 0 | 0 | 0 |

- **The severe items were already there.** Both of brain A's flagged files predate any guard, and a forward-only guard never sees them. On this brain it would report nothing while a private key sits in the working tree and in history.
- **Patterns miss the common case.** Brains B and C are confidential under client agreements: prices, contract terms, headcounts, personnel notes. None of it has a pattern, and nothing in either brain declares anything, so every deterministic check reports them clean. The roadmap's model stages exist for this, and its own caveat applies: recall on well-edited prose is limited.
- **Declarations are the only computed lever for business-confidential prose.**

## Decisions

### Part 1: say what the guard has not seen

A detective control that reports clean on partial coverage is worse than one that says nothing.
- **What the guard covers.** The Review screen and `validate`'s admin section state it: "writes since \<date the guard first ran on this brain\>". That date is the earliest row, or the brain's connection date.
- **The baseline scan.** An admin can run a deterministic scan of the brain as it stands, once. It uses the same detectors, records to the same table, and is budgeted and resumable under the whole-brain pass rule.
- **The roadmap trade-off.** This narrows the roadmap's "forward-only" decision rather than reversing it:
  - The baseline uses no model, so it costs nothing per page.
  - It runs only when an admin asks.
  - Model stages stay forward-only.

### Part 2: declared sensitivity

The roadmap puts policy in `.isomorphic.json` (detector toggles, entity lists, severity per clause) plus a rulebook page. Declarations belong in the same place, and one declaration should serve Isomorphic and the scanner alike.

- **Frontmatter:** the scanner's two declarations, `visibility: sensitive` and `processing: controlled`, recognized as they are. Both are optional fields, which OKF readers already tolerate, so nothing changes for existing brains. The indexed frontmatter table makes them queryable without reading bodies.
- **Paths:** an optional list of sensitive globs under the `review.policy` block of `.isomorphic.json`. It covers source-root exports, which have nowhere to put frontmatter.
- **A brain-wide default:** the same block can declare the whole brain confidential, for a brain that is confidential by contract. Every widening surface (Part 4) then treats every page as declared.
- **Encrypted paths.** A git-crypt file read through the GitHub API is ciphertext. Nothing in the code recognizes the git-crypt header today, so an encrypted `.md` would likely be indexed as a page of noise.
  - The store should recognize the header, keep the file out of the index and renderer, and count it as encrypted.
  - The local runtime sees plaintext, so it treats git-crypt-attributed paths as declared sensitive, using `git check-attr` as the scanner does. That logic is Node-only and lives in `src/local/`.

### Part 3: reach, computed

On a laptop, the scanner infers who can reach a file from agent config files, and cannot see a directory passed on a command line. The hosted service knows exactly: who can read a brain is `effectiveBrainRole` over explicit shares, org visibility and guest access, and every reader's assistant is a cloud model, so reach equals access.

- **The reach summary.** `validate`'s admin section and the Review screen add a count-only line:
  - sensitive pages (detected, or declared by field, path or brain default)
  - the people who can read them, by role, with guests counted separately

  For example: "7 sensitive pages, readable by 12 people (2 guests)." It is admin-only, like the rest of the policy section.
- **When the audience changes.** `share_brain`, when adding a guest or flipping a brain to org visibility, states the sensitive count in its reply. This is advisory: nothing advisory blocks a save, and the person sharing may know the page is fine.

### Part 4: surfaces that widen the audience enforce declarations

None of the following is built yet, which is why deciding it now is cheap.
- **Share links** (link-sharing phases 1 and 2): a declared-sensitive page cannot get a link for someone without access.
- **Publications** ([`brain-seams.md`](./brain-seams.md)): a declared-sensitive page does not cross into another brain.
- **Consolidation:**
  - **Pre-scan.** A page with a high-severity detection never reaches the gateway. A declared-sensitive page reaches it only if the brain's policy allows model review of declared pages.
  - **Every provider path is zero-retention.** OpenRouter requests carry `ZDR_PROVIDER`. The Anthropic path, which serves Haiku first, is used only when the operator declares a zero-data-retention arrangement for their Anthropic organization ([`consistency-checks.md`](./consistency-checks.md), Part 2).
  - **Evidence.** Quotes are scrubbed through the detectors before they are stored in the findings queue or shown on the Review screen ([`consistency-checks.md`](./consistency-checks.md), Parts 2 and 3).

### Part 5: what stays outside Isomorphic

The operator's machine is the scanner's job, not the platform's:
- local checkouts of a brain
- shell history and agent session transcripts
- sync folders

Isomorphic's docs point to it for anyone running `pnpm try` or keeping a checkout. A roster of real names to detect stays there too: it is sensitive in its own right and must not live in a brain or a deployment.

## Invariants

- **Unchanged from the guard:**
  - Detections carry offsets, never the matched text.
  - Policy findings are visible to admins only.
  - Nothing advisory blocks a write.
- **New:**
  - A privacy report states its coverage, and never reports clean on partial coverage.
  - A surface that widens a page's audience beyond the brain's access list enforces declarations. Every other surface only advises.
  - A page with a high-severity detection never reaches a model.

## Not in scope

- **Rewriting git history.** Removing a credential from history is a person's decision with consequences for every clone. The finding says that history retains the value, and that a credential is rotated before anything else.
- **Binaries.** PDFs, images and spreadsheets are skipped, as the guard already skips base64 writes. The coverage line counts them.
- **The guard's model stages, rulebook, tiers and quarantine.** These are roadmap step 3, and this design does not change them.

## Work items

| Item | What | Where | Surface |
|---|---|---|---|
| P1 | Coverage line, and the admin-run deterministic baseline scan | core | guard, `validate`, Review screen, tests |
| P2 | Declarations: frontmatter fields, sensitive globs, brain-wide default | core | `.isomorphic.json` policy block, tests |
| P3 | Recognize git-crypt files through the store; local runtime reads git attributes | core | `BrainStore`, content index, `src/local/` |
| P4 | Reach summary; sensitive counts in `share_brain` replies | core | `validate`, Review screen, `share_brain` |
| P5 | Consolidation pre-scan and evidence scrubbing | `ee/` and the findings queue | [`consistency-checks.md`](./consistency-checks.md) C3, C4 |
| P6 | Enforcement on share links and publications, built with those features | core | link sharing, brain seams |

P1 ships first: it would have surfaced brain A's two files. P2 and P4 together are the join. P5 is a precondition for model consolidation, not a follow-up to it.

## Open questions

- **Should the guard's `validate` section keep telling an admin to read a flagged page?** The scanner treats reading a flagged file as the disclosure it exists to detect. In a brain, an admin's assistant can read the page anyway, so the read stays inside the access boundary. It still copies the value into a model context that did not need it.
- **Should `share_brain` block** a guest share on a brain with credential detections, or only warn?
- **Frontmatter vocabulary.** Should Isomorphic adopt the scanner's two fields, or define its own and recognize both? Adopting them keeps one declaration working for both tools.
- **Does the baseline scan belong in the roadmap's step 1** ("turn it on for real brains and measure false positives"), since measuring false positives needs content to measure?
