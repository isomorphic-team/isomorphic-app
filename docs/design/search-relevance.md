# Design: search relevance

Status: **built** (S1 and S2 together). Engine: `src/lib/search.ts` (pure) wired into
`searchIndex` in `src/lib/brain-index.ts`. Tests: `pnpm test:search`. No schema change.

`search_pages` is the highest-frequency read on the tool surface and the one an agent
reaches for when it does not already know a path. It could not answer a question,
could not rank, and could hide most of a brain behind a single page. This document is
the spec for all three, and now the record of how they were fixed.

## What `searchIndex` did before this change

`searchIndex` in [`src/lib/brain-index.ts`](../../src/lib/brain-index.ts) is a literal
substring `LIKE` over the whole query string, rows returned `ORDER BY path`, with a
50-hit budget applied by the caller (`MAX_HITS` in `src/tools/librarian.ts`).

```sql
SELECT path, content FROM brain_pages
WHERE brain_id = ?1 AND content LIKE ?2 ESCAPE '\'
ORDER BY path
```

then, per row:

```ts
for (const r of rows.results) {
  const lines = r.content.split('\n');
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    if (lines[i].toLowerCase().includes(needle)) hits.push({ path: r.path, line: i + 1, ... });
  }
  if (hits.length >= max) break;
}
```

Three defects follow directly from those two fragments.

### D1. No tokenization: a question matches nothing

The query is one opaque needle. A multi-word query matches only where that exact
string appears in a line, so any question-shaped input fails regardless of whether the
brain answers it.

### D2. No relevance ordering

`ORDER BY path` is alphabetical. There is no notion of a better match, so the caller
cannot tell "the page that owns this" from "a page that mentions it," and neither can
the model reading the result. Any consumer that wants to know whether the right page
came back first is asking a question this engine does not answer.

### D3. No per-page hit cap

The inner loop is bounded only by the global budget, so **one page can consume all 50
hits**. Combined with `ORDER BY path`, a common term on a large brain returns 50 lines
from whichever page sorts earliest and every other page is invisible, with nothing in
the response indicating that truncation happened.

## Evidence

Measured against a real 28-page brain (private, not in this repo), by running 34
retrieval probes: a query plus the page expected to own it, checking what came back.

- **Every sentence-shaped query returned nothing.** All 6 of them, on a brain that
  demonstrably contains the answers. Shapes like `what is our <X> fee`,
  `who owns the <Y>`, `how do <Z> get paid`.
- **27 of the 28 term-shaped queries matched at least one page.** The one that did not
  was a genuine vocabulary gap: the brain used a different name for the concept.
- So on that brain, **absence tracked query shape, not brain content**.
- **Ranking could not be assessed at all**, because position in the result set is
  alphabetical. A page "won" its own query when it happened to sort before the pages
  that also matched.
- **Truncation never fired** (0 of 34 probes exhausted the budget), so D3 is latent at
  this size rather than live. Single pages did return 17 and 15 matching lines for one
  query, which is most of the budget from one file.

D1 is the defect an agent actually hits. It is invisible in normal use because a model
that gets no results silently rephrases or gives up, and the transcript shows a model
that "could not find" something rather than a search that could not match it.

## Who is affected

- **`search_pages`**, for agents and for the MCP App, which parses the text block for
  the path list.
- **Anything downstream that assumes search order means something.** Nothing does today,
  which is itself a consequence of there being no order worth assuming.
- **Not** `find_inbound_links`, `validate`, or `view_graph`: those query the link and
  page tables directly rather than going through `searchIndex`.

## What was built

S1 and S2 shipped together, because S2 turned out to need no schema work either and
splitting them would have meant two passes over the same forty lines.

### The shape: SQL narrows, pure code ranks

`searchIndex` runs in two phases, and the split is the load-bearing decision.

**Phase 1** asks SQL only what is cheap: for each page, does it contain each query
term, and does it contain the whole query verbatim. The rows are path, title, and a
handful of booleans, so the answer stays small however large the brain or common the
term. **Phase 2** fetches content for the top-ranked candidates (`MAX_SEARCH_CANDIDATES`, 25) and extracts their lines.

SQL narrows; it never orders. Everything that decides what ranks above what, or what
gets dropped, lives in the pure [`src/lib/search.ts`](../../src/lib/search.ts) — so the
rule is testable without a database, which is what let the two ranking failure modes in
Risks below become actual test cases rather than intentions.

This is also, incidentally, a large reduction in D1-to-Worker traffic. The old query
selected full `content` for every matching row, then discarded all but 50 lines of it.

### S1. Cap hits per page

Three lines per page (`perPage`), best lines rather than first three: a line matching
more of the query outranks one matching less, the phrase breaks the tie, earliest wins
after that, and the kept lines are then restored to reading order. `elisionNote` reports
what the cap and the budget left out, so a caller can finally tell "these are all the
matches" from "these are the first 50".

### S2. Tokenized matching with relevance ordering

**FTS5 was verified as available and deliberately not used.** Cloudflare's docs list the
FTS5 module under supported SQLite extensions, so availability was never the constraint.
Four things decided against it, recorded in full in
[`docs/references.md`](../references.md):

1. **Export is not supported for databases containing virtual tables** — the whole
   database, not the table. `platform-db` holds `orgs`, `memberships`, `app_users`,
   `invitations` and `feedback_reports`; an FTS index over a derived cache would put a
   manual destructive step (drop, export, recreate) into the backup path for the
   platform's system of record.
2. **It would be a cache of a cache with three writers** (`writeThroughIndex`,
   `incrementalReindex`, `rebuildDerivedFromStore`), and a desync fails silently: search
   goes stale while `read_page` returns the truth. That is the failure the read-time HEAD
   guard exists to make impossible.
3. **BM25 cannot satisfy this document's own requirement** that ranking be computed,
   deterministic, and explainable from the row data. It is computed inside SQLite from
   corpus statistics: not reproducible from a row, not testable without a database, and
   not tunable against the two failure modes named under Risks.
4. **Migration risk on the read path, for no measured win.** FTS5 needs a migration, an
   `INDEX_SCHEMA_VERSION` bump, and a budgeted whole-brain backfill. The diagnosed defect
   was never speed — it was that a question matched nothing.

So the tokenized path shipped, with one deviation from the sketch above: terms are
**OR**ed in SQL, not ANDed. ANDing would reintroduce the defect being fixed — a page
holding some of the terms is a worse match, not a non-match, and the scorer is what
decides how much worse.

**Tokenization.** Split on every character that is not a letter, digit, `%` or `_`, then
drop stopwords, but only when something survives ("how to" is a real query). `%` and `_`
stay inside the token: the escaping contract below requires it, and it makes an
identifier (`write_page`, `50%`) one precise term instead of two loose ones. `-` is not
held, so a brain writing "fine grained" still answers `fine-grained`.

**Scoring** is a weighted sum over signals every caller can recompute: term coverage
(dominant), terms present in the title, terms present in the path, whether the whole
query appears verbatim, and a saturating frequency term. Ties break on path, so the same
query never disagrees with itself between reads. The weights and their two failure modes
are commented at the constants and pinned by `pnpm test:search`.

**No derived structure was added**, so none of the rules governing derived state applied:
no `INDEX_SCHEMA_VERSION` bump, no migration, no backfill, nothing for a rollback to be
unable to undo. The change is code only.

## Contract preserved

All of this held, and each item has a check in `pnpm test:search`:

- `search_pages` returns matching **lines with line numbers**, in the same
  `path:line: text` form. Ranking reordered the results and changed nothing else.
- The **text block stays the source of truth** for chat and agent consumers;
  `structuredContent.hits` rides along for UI consumers (`SearchView` reads it, and did
  not change). `terms` and `pagesMatched` were added beside `hits`.
- Case-insensitive matching.
- `escapeLike` behaviour: a query containing `%` or `_` still matches literally, at both
  layers. SQL escapes them per term, and the tokenizer keeps them inside the token
  rather than splitting on them — which is a stronger guarantee than before, since
  `source_key` is now one literal term instead of a substring of a longer needle.

One thing the header now says that it did not before: how many pages the hits came from,
which terms were searched after stopword removal, and what was left out. A model that
gets a bare no-match rephrases blindly; one that can see its question was reduced to two
terms can tell which of them missed.

## Tests

`pnpm test:search` (`scripts/test-search.ts`), wired into both `package.json`'s `test`
script and `.github/workflows/ci.yml`. Two halves: the ranking runs on a corpus written
by hand, and the SQL narrowing runs through the real `searchIndex` against D1 shimmed
over `node:sqlite`. Everything the spec asked for is pinned, plus the failing direction
in each case, because a check that passes against the old engine too is testing neither:

- The sentence-shaped query is asserted to appear verbatim on **no page**, so the
  section proving it now works is not vacuous.
- Ranking is asserted to differ from the alphabetical order the old engine produced —
  the corpus is deliberately built so `ORDER BY path` puts the wrong page first.
- The per-page cap's effect is asserted twice: five pages represented with the cap on,
  and exactly one page with it lifted, so the cap is demonstrably what produces the
  breadth.
- Frequency is asserted both to separate otherwise identical pages **and** to be
  bounded, so the saturation is real rather than the signal being switched off.
- `%` and `_` are asserted not to behave as wildcards: a bare `%` matches only the page
  containing one, where a wildcard would match every page.
- `escapeLike` is pinned **directly**, as a function, which is the only way it can be
  pinned at all — see below.

Every check was verified to go red by breaking the code it covers. Zeroing the coverage
weight, removing the frequency saturation, and lifting the per-page cap each fail the
checks written for them (five and six respectively for the latter two).

**Deleting `escapeLike` entirely failed nothing**, which is worth knowing rather than
papering over. `searchCorpus` re-verifies every candidate against the content it fetched,
so a `%` passed through to SQL as a live wildcard would make phase 1 match the entire
brain and still return exactly the right hits — after scanning and fetching far more than
it had any reason to. The escaping bounds the WORK; the re-verification guarantees the
ANSWER. No result-shaped assertion can see the difference, so the function is now
exported and asserted on its own, and the defense-in-depth property (an over-matching
candidate never becomes a wrong hit) is asserted separately.

The first run found a real defect rather than confirming an intention: a lone `_` was
being dropped by the tokenizer's minimum term length, silently losing the literal-match
contract. That is why `isUsableTerm` exists.

**Not covered**, consistent with the rest of the repo: the app layer. `SearchView`
consumes `structuredContent.hits`, whose shape is pinned here, but nothing drives the
widget.

## Risks

- **This is the read path.** `search_pages` is called constantly by agents and by the
  app's own navigation. A regression is felt everywhere at once. What bounds the blast
  radius here is that the change is code only: a rollback returns the previous engine
  whole, because there is no schema half for it to fail to undo.
- **Ranking is a product decision disguised as a technical one.** A scheme that favours
  title matches too heavily rewards keyword-stuffed titles; one that favours body
  frequency buries short authoritative pages under long rambling ones. Both are test
  cases now — a keyword-stuffed title losing to real coverage, and a sixty-line
  repetitive page losing to a one-line authoritative one — so the trade is visible at
  the weights and changing it turns a check red rather than going unnoticed.
- **Recall widened, so precision fell.** Tokenizing means a query returns pages holding
  only some of its terms. Those rank below full-coverage pages and the per-page cap
  keeps the tail short, but a result set that used to be empty or exact is now longer
  and graded. That is the intended trade; it is still a trade.

## Open questions

Answered by this change:

- ~~Does D1 support FTS5?~~ **Yes**, and it is deliberately not used. See
  [`docs/references.md`](../references.md) and "What was built" above.
- ~~Should the response say when results were capped?~~ **Yes**, it does now
  (`elisionNote`): lines elided by the per-page cap, and pages that matched but were
  not shown.

Still open:

- **Should ranking read structure beyond text?** Title and path are in; `type:` and
  inbound-link count are not. Inbound-link count is available (`backlinksTo`) and is a
  reasonable authority signal, but it biases toward well-linked pages, which is exactly
  the property a brain drifting out of shape lacks.
- **No stemming.** Matching is substring, so `fee` finds "fees" but `fees` does not find
  "fee", and `owns` does not find "owner". A stemmer would help question-shaped queries
  most, which is the shape this change was for.
- **Case-insensitivity is ASCII-only, and always was.** SQLite's `LIKE` folds ASCII case
  only, and SQL is the narrowing phase, so a page is never a candidate for a query that
  differs from it by a non-ASCII case fold (`CAFÉ` for `café`). The Worker's own
  `toLowerCase` is fully Unicode-aware and therefore strictly wider than the filter
  feeding it, which is the safe direction but means the extra width is unreachable. This
  predates the change; it is recorded here because the two-phase shape is what makes it
  legible.
- **Should partial-coverage pages be dropped when full-coverage ones exist?** A floor
  would raise precision on common terms at the cost of the recall just gained. Deferred
  because it needs measurement on a real brain, not a constructed corpus.
- **`MAX_SEARCH_CANDIDATES` (25) is unmeasured.** It bounds how many pages' content one
  search pulls into the isolate. Ranking runs before the cut, so it drops the worst
  matches rather than the alphabetically-latest, but nobody has profiled where the real
  ceiling is.
