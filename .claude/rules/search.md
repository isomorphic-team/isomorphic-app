---
paths:
  - "src/lib/{search,search-fts,search-fts-index,search-engine,probe,brain-index}.ts"
  - "scripts/{test-search,test-probe,probe-report}.ts"
  - "app/views/SearchView.tsx"
  - "tests/ui/search.spec.ts"
---

# Search (`search_pages`)

Design record: `docs/design/brain-index-storage.md`.

`searchIndexFts` (`src/lib/search-fts-index.ts`) answers every search from SQLite FTS5 in the
index database. SQL computes the signals; the order is decided in the pure `rankFtsPages`
(`src/lib/search-fts.ts`): coverage, then the whole phrase, then `bm25()` with title and path
weighted, then path. `pnpm test:search` pins it on real FTS5 in `node:sqlite`.

- **Terms are ORed, not ANDed.** Partial matches are worse matches, not non-matches. Coverage
  (how many of the query's terms a page holds) dominates; ties break on path, so results are
  stable between reads.
- **The query is tokenized by `tokenizeQuery` (`src/lib/search.ts`):** filler words dropped, at
  most six terms. Each term is quoted (`ftsQuote`), so query text is never read as FTS5 syntax.
- **What matches.** Porter stemming (`fees` finds "fee"). Whole words: a match in the middle of
  a word does not count. A search no page matches as words is retried with every term as a
  prefix (`config` alone finds "configuration"), at the cost of one more round trip.
  Punctuation inside a term is dropped (`50%` searches `50`), and a query of symbols alone
  finds nothing.
- **The full-text table lives only in the index database** (`migrations-index/0002_pages_fts.sql`),
  never the platform one: a virtual table disables `wrangler d1 export` for its database
  (`docs/references.md`). It is an external-content table over `brain_pages`, kept current by
  triggers, so no write path names it. `pnpm test:index` drives the real write paths and
  checks it with FTS5's integrity check.
- **A search's cost on D1 is its round trips, not its queries.** The ranking statements (any
  term with `bm25()`, each term, the phrase) go as one `db.batch` and the lines as a second
  statement: two round trips (three on the prefix retry), pinned by `pnpm test:index`. A new
  statement in a search goes in a batch.
- **The response says what it left out** (`elisionNote`) and which terms it searched.
- **Each search logs one `search` JSON line** (`timedSearch`, `src/lib/search-engine.ts`):
  terms, pages matched, milliseconds. Never a query, a path or a brain.
- **`scorePage`, `rankPages` and `signalsFromContent` in `search.ts` are not the search
  engine.** They rank pages held in memory, and the consolidation pass uses them to find a
  page's neighbours.
- **Probe against a real brain before believing a ranking change.** `pnpm probe:report <folder>
  <probes.json>` runs probes through the real `searchIndexFts` offline and reports how many
  landed in the top band and the mean reciprocal rank (`summarizeProbes`), the numbers to
  compare two runs by; a constructed corpus only confirms what its author intended.
  `search_pages` also takes `expect` (a path), which reports where that page ranked and what
  beat it (`scoreProbe` in `src/lib/probe.ts`, `pnpm test:probe`). A probe that hits the
  budget is inconclusive, not failed.

## Across brains

`scope: 'all'` on `search_pages` fans out: `searchBrains` runs each brain's `index.search` and
`mergeBrainResults` (`search.ts`) folds them. `searchTargets` (`librarian.ts`) picks the brains.

- **Ranking stays per brain**: a score is relative to its corpus.
- **Only the ACTIVE brain keeps the freshness guarantee**; the others are served from what is
  indexed and the result says so.
- **The hit cap is per brain, filled round-robin**, never one global cap (which starves every
  brain after the first). With one brain the merge is the identity.
- **Every result names its brain.** Fan-out is opt-in per call, never ambient; a WRITE never
  fans out and reports the brain it `landed` in.
- `find_inbound_links` is deliberately not fanned out.
