---
paths:
  - "src/lib/{search,probe,brain-index}.ts"
  - "scripts/{test-search,test-probe,probe-report}.ts"
  - "app/views/SearchView.tsx"
  - "tests/ui/search.spec.ts"
---

# Search (`search_pages`)

Design record: `docs/design/search-relevance.md`.

`searchIndex` (`brain-index.ts`) runs in TWO PHASES: **SQL narrows, it never orders.** Phase 1
asks D1 only, per page, whether it holds each query term and the whole query verbatim. Phase 2
fetches content for the top `MAX_SEARCH_CANDIDATES` (25) and extracts lines. Everything that
ORDERS or DROPS a result is in the pure `src/lib/search.ts` (`pnpm test:search`).

- **Terms are ORed, not ANDed.** Partial matches are worse matches, not non-matches; ANDing in
  SQL returns nothing for question-shaped queries.
- **Coverage dominates the score.** Title and path matches only break ties within a coverage
  band; frequency SATURATES. Ties break on path, so results are stable between reads.
- **Proximity has two lanes that never stack:** `1` for the whole query verbatim, else the
  fraction of the query's BIGRAMS present. Bigrams come from the RAW query (stopword removal
  destroys adjacency), and neither word may be a function word (`NON_COLLOCATING`, which
  deliberately excludes prepositions and light verbs). `scoreLines` uses the same signal.
- **`%` and `_` stay inside the token** and never act as LIKE wildcards at either layer; a lone
  one survives the minimum length (`isUsableTerm`). `-` splits, so "fine grained" answers
  `fine-grained`.
- **The response says what it left out** (`elisionNote`) and which terms it searched.
- **FTS5 is available in D1 and deliberately not used:** a virtual table disables
  `wrangler d1 export` for the whole database (which holds org and user rows), and BM25 cannot
  be pinned by a pure test. Read `docs/references.md` before reopening it. Swapping phase 1 for
  FTS5 would touch neither ranking nor its tests.
- **Probe against a real brain before believing a ranking change.** `pnpm probe:report <folder>
  <probes.json>` runs probes through the real `searchIndex` offline; a constructed corpus only
  confirms what its author intended. `search_pages` also takes `expect` (a path), which reports
  where that page ranked and what beat it (`scoreProbe` in `src/lib/probe.ts`,
  `pnpm test:probe`). A probe that hits the budget is inconclusive, not failed.

## Across brains

`scope: 'all'` on `search_pages` fans out: `searchBrains` runs `searchIndex` per brain and
`mergeBrainResults` (`search.ts`) folds them. `searchTargets` (`librarian.ts`) picks the brains.

- **Ranking stays per brain**: a score is relative to its corpus.
- **Only the ACTIVE brain keeps the freshness guarantee**; the others are served from what is
  indexed and the result says so.
- **The hit cap is per brain, filled round-robin**, never one global cap (which starves every
  brain after the first). With one brain the merge is the identity.
- **Every result names its brain.** Fan-out is opt-in per call, never ambient; a WRITE never
  fans out and reports the brain it `landed` in.
- `find_inbound_links` is deliberately not fanned out.
