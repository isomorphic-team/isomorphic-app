# Design: privacy checks

Status: **proposed** (2026-09-25). Nothing below is built.

This is the companion to [`consistency-checks.md`](./consistency-checks.md). That doc asks whether a brain agrees with itself. This one asks what a brain holds that it should not, and who can reach it.

Related:
- [`consolidation-loop.md`](./consolidation-loop.md): findings, keys and invariants.
- [`brain-level-permissions.md`](./brain-level-permissions.md) and [`guest-access.md`](./guest-access.md): who can read a brain.
- [`link-sharing-and-the-web-app.md`](./link-sharing-and-the-web-app.md) and [`brain-seams.md`](./brain-seams.md): surfaces that carry pages to new audiences.

## The problem

A brain's real audience is larger than its access list. It is every person who can read the brain, plus every assistant those people use, plus every surface that carries a page onward. In Isomorphic, every read is a crossing by construction:

- `read_page` and `search_pages` put page text into the reader's model context, which in practice runs in a cloud provider.
- The web app renders pages in a browser.
- A guest is someone outside the organization.
- The consistency checker in the companion doc sends page text to the operator's model providers.

Two different questions follow:

1. **Is something here that should not be anywhere?** A private key, a connection string with a password, a government identifier or a card number. The answer is to remove it, and to rotate any credential first.
2. **Who can reach what is sensitive here?** This is a join of three facts: the content, the grants on it, and where each grant's output goes. Each fact is easy to check on its own. The exposure is in the combination, which no single system owns.

Isomorphic answers neither today. `validate` reports structure and consolidation findings. Nothing looks at what a page contains, and nothing relates a page's sensitivity to who can read it.

## Prior art: okf-privacy-scan

An open-source scanner (MIT), okf-privacy-scan, answers both questions for a knowledge base on one person's machine. It checks what is in the files, which agent was granted the directory, and where that agent's output goes. The design choices below carry over directly.

- **High-precision content detectors.**
  - Government identifiers, checked for structural validity.
  - Payment cards: a real network prefix plus Luhn. Luhn alone passes one random digit string in ten.
  - Private key blocks.
  - Connection strings with an inline password.
  - Frontmatter that declares a file sensitive: `visibility: sensitive` or `processing: controlled`.
- **A finding never carries the value that produced it.** It carries a salted fingerprint, which is enough to count how many places hold one identifier and useless to anyone reading the report.
- **Sensitivity from location.** A path configured for git-crypt is a path its owner considers sensitive. Transparent encryption decrypts in the working tree, so plaintext in such a path is exactly the copy an agent can open. Declared globs cover sensitive paths that are not encrypted.
  - On the knowledge base it was built against, nearly half the records in encrypted paths carried no identifier and no declaration.
  - Exports beside the markdown (spreadsheets, text, XML) had nowhere to put a declaration, and 135 of 137 said nothing.
- **The scan's own output is a crossing.** A summary mode emits counts and nothing that locates a record, because a path can name a person. An agent running the scan never opens a flagged file: verifying a finding by reading it is the disclosure the scan exists to detect.
- **Unknown is not clean.** A config it could not read is reported as a gap, and the report never says clean on partial coverage.
- **Stated limits:**
  - It cannot see identity in prose.
  - It sees a sensitive location only if someone declared or encrypted it.
  - It skips binaries, including PDFs and images.

## What was measured

The scanner ran in summary mode over the three brains the companion doc measured (A: 1,143 files, B: 192, C: 84). No paths or values were read.

| | Brain A | Brain B | Brain C |
|---|---|---|---|
| Files flagged | 2 | 0 | 0 |
| Detections | connection string (2), private key, government id, card number | none | none |
| Declared sensitive (frontmatter or path) | 0 | 0 | 0 |
| Encrypted paths | 0 | 0 | 0 |

- **Pattern detectors catch the rare, severe item.** Brain A has two files with credential-shaped strings and identifiers. The scanner cannot say whether they are live, and checking by reading them is the disclosure. Either way they are in the working tree and in git history.
- **They miss the common case entirely.** Brains B and C are confidential under client agreements: prices, contract terms, headcounts, personnel notes. None of it has a pattern. Nothing in either brain declares anything, so the scanner reports them clean.
- **Declarations are the only lever for business-confidential prose.** Without them, no computed check can tell a pricing page from a meeting note.
- **The companion checker is already a crossing.** Running it on B and C sent every candidate page pair to three model providers. That was acceptable for a measurement run on a local snapshot. It is not a default.

## Why the join belongs in Isomorphic

On a laptop, the scanner has to infer grants from agent config files. It cannot see a directory passed on a command line, and it is blind to agents it has no adapter for.

The hosted service knows its grants exactly. Who can read a brain is `effectiveBrainRole` over explicit shares, the brain's org visibility and guest access. Every reader's assistant is a cloud model, so reach equals access. Isomorphic can compute the join precisely, and can compute it again when access changes, which is when it matters.

What stays on the operator's machine stays with the scanner: local checkouts of a brain, shell history, agent session transcripts, sync folders. Isomorphic does not reimplement that. Its docs point to the scanner for anyone running `pnpm try` or keeping a local checkout.

## Decisions

### Part 1: a `sensitive-content` finding in `validate`

A pure module in `src/lib/` scans page bodies with the scanner's detectors: government identifier, payment card (prefix plus Luhn), private key header, and connection string with an inline password. Results report through the existing finding, key and dismissal machinery, and keep consolidation-loop invariant 1: computed, never generated.

- **The finding never carries the value, the matched line or a fingerprint.** It carries the path, the detector name and a hint ("payment card, 16 digits, network prefix and Luhn"). A test serializes every finding and asserts that the fixture's values are absent.
- **Keys** are kind plus path (invariant 3), so no fingerprint is ever stored and there is no salt to manage. The number of pages holding one identifier is computed in the pass and reported as a count.
- **Credentials come first.** A private key or connection string finding says to rotate the credential before editing, and that removing the text does not remove it from git history.
- **The tool never reads a flagged page to confirm it.** `validate`'s description and `SERVER_INSTRUCTIONS` say so, in the descending-reach pattern the findings rules already use.
- **Tests:** each detector's positive and negative cases, invalid identifier areas, Luhn-valid numbers without a network prefix, and value absence in every serialized finding.

### Part 2: declared sensitivity

Sensitivity is declared in two places, and one declaration serves Isomorphic and the scanner alike.

- **Frontmatter:** the scanner's two declarations, `visibility: sensitive` and `processing: controlled`, recognized as they are. Both are optional fields, which OKF readers already tolerate, so nothing changes for existing brains. The indexed frontmatter table makes them queryable without reading bodies.
- **Paths:** an optional `sensitive` list of globs in `.isomorphic.json`. It is kept separate from the `paths` role map, because sensitivity is orthogonal to whether a path is content, source or system. It covers source-root exports, which have nowhere to put frontmatter.
- **Encrypted paths.** A git-crypt file read through the GitHub API is ciphertext. Nothing in the code recognizes the git-crypt header today, so an encrypted `.md` would likely be indexed as a page of noise.
  - The store should recognize the header, keep the file out of the index and renderer, and count it as encrypted.
  - The local runtime sees plaintext, so it treats git-crypt-attributed paths as declared sensitive, using `git check-attr` as the scanner does. That logic is Node-only and lives in `src/local/`.

### Part 3: reach, computed

For each brain, `validate` reports a count-only reach summary:

- sensitive pages (detected, or declared by field or path)
- the people who can read them, by role, with guests counted separately
- the surfaces they travel on

For example: "7 sensitive pages, readable by 12 people (2 guests), through their assistants and the web app." It carries counts, not paths, because `validate`'s reply goes to a model.

**The join runs again when the audience changes.**
- **`share_brain`:** adding a guest, or flipping a brain to org visibility, states the sensitive count in its reply before and after.
- **This is advisory:** nothing advisory blocks a save (the findings rule), and the person sharing may know the page is fine.

**Surfaces that widen the audience enforce declarations.** None of the following is built yet, which is why deciding it now is cheap:

- **Share links** (link-sharing phases 1 and 2): a declared-sensitive page cannot get a link for someone without access.
- **Publications** ([`brain-seams.md`](./brain-seams.md)): a declared-sensitive page does not cross into another brain.
- **The consistency checker** (next part).

### Part 4: what this changes in the consistency checker

- **Pre-scan before any model call.** The checker never sends a page with a credential detection to a model provider. It sends declared or detected sensitive pages only when the operator opts in per provider in the checker's config, for example for a provider with zero retention. A skipped pair is counted in the run summary, so a gap never reads as clean.
- **Scrub evidence.** Findings quote the lines that disagree, and the findings file lives in git permanently. Every quote runs through the detectors, and a detected value is replaced by its hint before the file is written. The review queue shows the same scrubbed text.
- **Privacy findings come from `validate`, not the checker.** They need no model, so they do not go into the checker's findings file.

## Invariants

- **Unchanged:** consolidation-loop invariants 1, 3 and 8.
  - Privacy findings are computed, keyed by kind plus path, and never reported outside the deployment.
  - The reach summary counts into nothing but the reply.
- **New:**
  - A privacy finding never carries the matched value, the matched line or a fingerprint of it.
  - A surface that widens a page's audience beyond the brain's access list enforces declarations. Every other surface only advises.
  - A pass that could not cover something (an encrypted file, a binary, an unreadable config) reports the gap, and never reports clean on partial coverage.

## Not in scope

- **Classifying prose with a model.** A model could score a page for personnel or financial detail, but sending the page is itself the crossing. If it is ever offered, it belongs in the operator-run checker, on the operator's key, off by default.
- **A roster of names on the hosted service.** A list of real people is sensitive in its own right and must not live in the brain or the deployment. The scanner keeps it on the operator's machine.
- **Rewriting git history.** Removing a credential from history is a person's decision with consequences for every clone. The finding says that history retains the value. It does not act on it.
- **Binaries.** PDFs, images and spreadsheets are not scanned. Attachments are counted as unscanned in the reach summary.

## Work items

| Item | What | Surface |
|---|---|---|
| P1 | `sensitive-content` finding, detectors ported, value-absence tests | a pure module in `src/lib/`, `validate`, a battery |
| P2 | Declarations: the two frontmatter fields, and `sensitive` globs in `.isomorphic.json` | brain config, findings |
| P3 | Recognize git-crypt files through the store; local runtime reads git attributes | `BrainStore`, content index, `src/local/` |
| P4 | Reach summary in `validate`; sensitive counts in `share_brain` replies | findings, `share_brain` |
| P5 | Checker pre-scan and evidence scrubbing | companion checker (its W3) |
| P6 | Enforcement on share links and publications, built with those features | link sharing, brain seams |

P1 stands alone and ships first: it would have flagged brain A's two files today. P2 and P4 together are the join. P5 is a precondition for the companion checker's W3, not a follow-up to it.

## Open questions

- **Should `share_brain` block** a guest share on a brain with credential detections, or only warn?
- **Is a page path disclosure in `validate`'s reply?** The scanner treats paths as disclosure. In a brain, the reader's model can already list every path, so paths add nothing new within the access boundary. The value and the line still do.
- **Frontmatter vocabulary.** Should Isomorphic adopt the scanner's two fields, or define its own `sensitivity:` field and recognize both? Adopting them keeps one declaration working for both tools.
- **Business-confidential prose.** Declarations are the only computed lever. Is a per-brain default ("everything in this brain is client-confidential") enough, stated once in `.isomorphic.json` and applied by every widening surface?
