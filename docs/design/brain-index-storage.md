# Design: where the derived index lives, and full-text search

Status: **in implementation** (2026-11-09). Steps 1 to 3 of the order of work are built: full-text search runs in shadow.

Related: [`search-relevance.md`](search-relevance.md) (today's ranking),
[`storage-and-tenancy.md`](storage-and-tenancy.md) (derived state keyed by `brain_id`),
[`brain-disconnect-retention.md`](brain-disconnect-retention.md) (what a disconnect deletes),
[`preview-environments.md`](preview-environments.md).

## 1. Summary

The platform database holds two kinds of state with opposite needs. Orgs, users, memberships,
grants and the brains registry are the system of record: they need backups, exports and careful
migrations. The content index (`brain_pages`, `brain_links`, `brain_page_fields`,
`brain_index_meta`) and the state built from it are a cache of git: they need speed, a schema
that can change freely, and virtual tables. Sharing one database makes each constrain the other.

Proposed:

1. **The system of record stays in D1** (`PLATFORM_DB`), unchanged.
2. **Each brain's derived index moves to its own SQLite-backed Durable Object,** keyed by
   `brain_id`, implemented in the objects Worker that this Worker binds to.
3. **Index access goes through one interface in `src/lib/`,** as content access goes through
   `BrainStore`, so the storage behind it can change and the local runtime keeps `node:sqlite`.
4. **Search moves to SQLite FTS5 inside that object,** after running in shadow next to the
   current engine.

The ranking rule changes from "SQL narrows, pure code ranks" to **"SQL may compute signals;
pure code decides the order"**. BM25 becomes one signal; the ordering stays in a pure module a
golden test pins.

## 2. Why now

- **Search cost grows with the brain.** Phase 1 of `searchIndex` runs `LIKE '%term%'` over every
  page's content on every query.
- **Ranking has no stemming and no notion of a rare word.** `fees` does not find a page that
  only says "fee", and "project" counts as much as a product name.
- **FTS5 was ruled out for a reason that belongs to the database, not to search:** a virtual
  table blocks `d1 export` for the whole database it sits in
  ([`references.md`](../references.md)), and the platform database holds the org tables.
- **One database, one size limit and one write budget for every brain.** A bulk import in one
  brain spends the budget the org tables share.

## 3. What was measured

### Full-text search prototype

An FTS5 engine answering the `searchIndex` contract, built from `brain_pages`: coverage first
(the page holding more of the query's terms wins, as today), then the whole phrase, then
`bm25()` with title weighted 4 and path 2 against the body's 1, then path. Porter stemming.
Lines come from FTS5's `highlight()`, so a line matches exactly when the tokenizer says so.

130 probe questions over four real brains (a personal brain, a company knowledge base, a
coaching field guide, a partner wiki), each paired with the page that should answer it: a third
phrased as questions, a third as keywords, a third in words that differ from the page's.

|                | top 1 | top 3 | found |   MRR |
| :------------- | ----: | ----: | ----: | ----: |
| `searchIndex`  |    86 |   113 |   127 | 0.771 |
| FTS5 prototype |   103 |   121 |   130 | 0.865 |

The expected page moved up on 32 questions and down on 10. The largest loss (#1 to #14) holds
two of the question's four terms and answers in other words ("renamed" for "called before"), so
it ties on coverage with every page holding the two filler words and BM25 prefers those. The
questions were written by a model that had read the target pages.

Tried and dropped: weighting coverage by each term's rarity. It lowered top 1 from 103 to 97
and did not fix that case.

Speed, on `node:sqlite` locally, not on D1 or in a Durable Object:

| brain                     | pages | `searchIndex` mean / p95 | FTS5 mean / p95 |
| :------------------------ | ----: | -----------------------: | --------------: |
| knowledge base            |   538 |            6.9 / 12.7 ms |    3.6 / 7.8 ms |
| knowledge base, 10 copies | 5,380 |           50.7 / 91.7 ms |  15.0 / 37.2 ms |
| editorial brain           | 3,902 |            7.9 / 16.2 ms |   5.8 / 34.0 ms |

On D1 a statement sent alone is a round trip, and round trips, not query time, set the cost
of a search. Measured in shadow on a deployment, 137 searches, each engine timed alone: sending
its nine statements one by one, FTS5 took a median 510 ms against `searchIndex`'s 189 ms (two
or three statements), and passed one second on 31% of searches. `searchIndexFts` now sends
eight of them as one batch, so a search is two round trips.

### Durable Objects and preview URLs

The deploy pipeline's pre-promotion smoke needs version URLs, which Cloudflare withholds from a
Worker that implements a Durable Object. Tested on 2026-11-09: a Worker that only binds to a
class implemented in another Worker (`script_name`) keeps its version URLs and its Worker
Previews, and reaches the object over RPC, where FTS5 with the porter tokenizer runs. Detail in
[`references.md`](../references.md).

### Related pages

Also prototyped: listing, after the hits, pages one link from the strong matches that hold none
of the query's words, with links declared in frontmatter (`depends: [[Billing]]`) first. On the
same brains, following every body link surfaced attendees, changelogs and daily-note neighbours
on most queries. With strict rules (only matches holding every term are followed; a body-linked
page needs two matches touching it; folder notes and pages writing over 30 links pass declared
relations only) 19 of 23 queries listed nothing and the rest listed a declared relation or a page
several matches share. It reads only `brain_links` and needs none of the storage change.

## 4. Options

| option                                                                        | verdict                                                                                                                                                                                                                                                              |
| :---------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FTS5 in the platform database, dropping and recreating it around every export | Rejected: puts a destructive manual step in the backup path of the system of record.                                                                                                                                                                                 |
| A second D1 database for every derived table                                  | Workable fallback. Keeps one transaction for the index and FTS. Still one size limit and one write budget for every brain, and search stays a round trip per statement.                                                                                              |
| **A Durable Object per brain, in a separate Worker**                          | **Proposed.**                                                                                                                                                                                                                                                        |
| A Durable Object per org                                                      | Rejected: one object serves one request at a time, so a reindex in one brain queues every brain in the org; one storage limit for the org's brains; a brain moving between orgs would copy its index. Cross-brain search already spans orgs, so it saves no fan-out. |
| An external search service                                                    | Rejected: sends brain content to a third party, and self-hosting stays Cloudflare-only.                                                                                                                                                                              |

## 5. The proposed shape

- **One object per brain, named by `brain_id`.** Freshness, write-through, the review passes
  and access are all per brain today; moving a brain between orgs (`brain-move.ts`) leaves its
  object alone.
- **Everything in the object is rebuildable from git and the platform database.** A test drops
  the index and checks that reads after a rebuild return the same results. A schema change in the
  object is a version bump and a rebuild, not a hand-written migration.
- **One freshness marker per brain, in the object,** covering every derived table, so
  write-through, the index and FTS commit together.
- **Purge is `deleteAll()`,** atomic, run before the brains row goes, so a repository connected
  again (same `brain_id`) starts empty.
- **Whole-brain passes run on alarms,** still budgeted and resumable, instead of inside a read.
- **The object's class lives in the objects Worker** (`src/objects/worker.ts`, built for the
  write coordinator); this Worker binds to it with `script_name` and
  never implements one, keeping version URLs and the smoke (`CLAUDE.md`).
- **Data residency:** an object can be created in a jurisdiction. If that holds, residency becomes
  an org setting applied when a brain's object is created. Not verified.

## 6. Order of work

Each step is its own pull request and can be reverted alone. Full-text search does not wait for
the Durable Object: it ships first in a second D1 database (the fallback in section 4), and
because the index is rebuildable, moving it into objects later is a backfill.

1. **The index interface** in `src/lib/`, with today's D1 tables behind it. No behaviour change.
   Built: `BrainIndex` and `d1Index` in `src/lib/brain-index.ts`.
2. **The index in its own D1 database,** `INDEX_DB`, optional per deployment. Built:
   `migrations-index/`, `indexDatabase`. A deployment that binds it starts with an empty index,
   which each brain refills on its next read; estimate the rows written before binding it.
3. **FTS5 in shadow** in `INDEX_DB`: built alongside, disagreements with `searchIndex` logged,
   latency measured on the real deployment. Built: `migrations-index/0002_pages_fts.sql`,
   `shadowSearch`. Read the `search-shadow` lines in Workers Logs before step 4.
4. **Switch `search_pages`,** keeping `expect` able to explain a rank.
5. **Drop the index tables from the platform database,** once every deployment binds `INDEX_DB`.
6. **The per-brain index object, in the objects Worker,** when a limit calls for it: a brain near D1's size
   cap, write budget contention between brains, or data residency. Measure `scope: "all"` over a
   few dozen objects first.

Related pages ships independently of all of this.

## 7. Open questions

- **Cross-brain search becomes one call per brain.** Measure `scope: "all"` over a few dozen
  objects before step 2.
- **`%` and `_`.** The FTS5 tokenizer drops them, so `50%` searches for `50`; `searchIndex`
  matches them literally.
- **Explaining a rank.** `expect` can say why a page outranked another under `searchIndex`; a
  BM25 score is harder to explain.
- **Questions across brains** (admin views, "which brains mention X") need their own index or a
  fan-out.
- **The per-object storage limit,** against the largest brain a customer is likely to connect.
