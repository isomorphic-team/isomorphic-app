# Design: search relevance

Status: **proposed**. Nothing here is built.

`search_pages` is the highest-frequency read on the tool surface and the one an agent
reaches for when it does not already know a path. It currently cannot answer a
question, cannot rank, and can hide most of a brain behind a single page. This
document is the spec for fixing all three.

## What `searchIndex` does today

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

## Proposed work, in order

### S1. Cap hits per page

Independent of everything else, small, and the only change here that needs no schema
work. Cap lines returned per page (3 is a reasonable start) so breadth survives the
budget, and report when the cap elided matches rather than truncating silently.

Ship this first. It is a strict improvement under the current ordering and does not
depend on how S2 lands.

### S2. Tokenized matching with relevance ordering

**Verify first, then choose.** Confirm whether D1 (the Cloudflare product) supports
FTS5 virtual tables against Cloudflare's current documentation rather than from model
memory, and record the answer in [`docs/references.md`](../references.md) either way.
That page exists for exactly this class of fast-moving external fact.

- **If FTS5 is available:** an FTS table over `brain_pages.content` with BM25 ordering.
- **If not:** tokenize the query, `AND` the terms in SQL, rank by term coverage with a
  title match boosted. Worse than BM25, still transformative next to substring
  matching.

Either way the ranking must be computed, deterministic, and explainable from the row
data. No inference, and no ordering the caller cannot reproduce.

**If a derived structure is added**, it is subject to the rules that already govern
derived state in this codebase:

- Bump `INDEX_SCHEMA_VERSION`, because existing rows predate it.
- Build it through the budget/cursor/advance-the-marker-only-when-done shape that
  `rebuildDerivedFromStore` already uses. A whole-brain pass that runs to completion
  inline is how a large brain becomes permanently unreadable: the work exceeds the
  host's tool timeout, nothing is written, and the next read restarts it forever.
- Keep the migration additive and backward-compatible with the still-running previous
  version for the deploy window. A rollback reverts code, never schema.

## Contract to preserve

- `search_pages` returns matching **lines with line numbers**. Ranking may reorder
  results; it must not change that shape.
- The **text block stays the source of truth** for chat and agent consumers;
  `structuredContent.hits` rides along for UI consumers.
- Case-insensitive matching.
- `escapeLike` behaviour: a query containing `%` or `_` still matches literally.

## Tests

A new golden battery, pure, offline, pinning at minimum:

- A sentence-shaped query that matches nothing today returns the right page after S2.
- Given a constructed corpus, the better match ranks above the weaker one.
- One page with many matching lines no longer starves the rest of the result set (S1),
  asserted on the number of distinct pages represented.
- The existing output shape is unchanged: line numbers present, text block parseable,
  `structuredContent.hits` populated.
- A query containing `%` or `_` still matches literally.

Assert the failing direction too: a test that passes against both the old and new
behaviour is testing neither. Break the ranking deliberately and confirm the test goes
red before believing it.

Adding a battery means adding it to **both** `package.json`'s `test` script and
`.github/workflows/ci.yml`, or `pnpm test:wiring` fails the build.

## Risks

- **This is the read path.** `search_pages` is called constantly by agents and by the
  app's own navigation. A regression is felt everywhere at once.
- **Migrations are the half a rollback cannot undo**, which is what makes the additive
  rule above load-bearing rather than tidy.
- **Ranking is a product decision disguised as a technical one.** A scheme that favours
  title matches too heavily rewards keyword-stuffed titles; one that favours body
  frequency buries short authoritative pages under long rambling ones. Pin whichever is
  chosen with a test over a constructed corpus so the trade is visible and can be
  changed deliberately.

## Open questions

- Does D1 support FTS5 virtual tables, and at what cost in database size? This decides
  S2 entirely.
- Should ranking consider structure the index already holds (title match, `type:`,
  inbound link count) or only text? Inbound-link count is available and is a reasonable
  authority signal, but it biases toward well-linked pages, which is exactly the
  property a brain drifting out of shape lacks.
- Should the response say when results were capped? Today it says nothing, so a caller
  cannot distinguish "these are all the matches" from "these are the first 50".
