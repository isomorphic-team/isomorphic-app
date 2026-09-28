---
paths:
  - "src/lib/{brain-index,brain-repo,brain-config,brain-policy,links,wiki}.ts"
  - "src/local/**"
  - "src/db/index-schema.sql"
  - "scripts/test-{index,links}.ts"
  - "scripts/e2e-librarian.ts"
---

# BrainStore and the content index

## `BrainStore`: the storage seam

`src/lib/brain-repo.ts` exports `BrainStore`, the only interface between tools and a brain's
storage, plus `githubStore(octokit)`; `src/local/brain-store-fs.ts` is the git-on-disk twin.

- **Eleven operations:** `getHead`, `branchCommitSha`, `repoWritePolicy`, `listTree`,
  `fetchPages`, `readFile`, `readBinary`, `findOpenConfigPr`, `listCommits`, `commitFiles`,
  `commitOrPR`. It is what the tools do, not a general storage abstraction.
- **If you reach for `ctx.octokit` while touching a brain's CONTENT, it belongs on the store.**
  A raw octokit call in a content path compiles and fails at runtime on the fs backend.
  `octokit` stays on the context (optional) only for GitHub-as-platform calls in
  `src/tools/brains.ts` behind `githubClient(ctx)`: create a repo, list an installation's repos,
  check a repo exists.
- **`commitFiles` atomicity is load-bearing.** "An edit batch is never half-applied" rests on
  the ref not moving unless the whole bundle committed, which is why a local brain is a git repo.
- `listTree` defaults to `.md` files; pass an extension filter deliberately.
- `pnpm test:index` wraps its octokit stub in the REAL `githubStore` (so `fetchPages`'s GraphQL
  batching is covered). `pnpm test:e2e-librarian --github` is the only coverage of the GitHub
  adapter against real GitHub: run it when `githubStore` changes.

## The content index (read-path backend)

`search_pages`, `find_inbound_links`, `validate`, `view_graph` and custom-tool discovery query
a derived index in D1 (`src/lib/brain-index.ts`, schema in `migrations/`).

- **The index is a derived cache, NEVER the source of truth.** Every read calls
  `ensureFresh(db, store, repo, brainId, config)`, which compares the branch head to
  `brain_index_meta.indexed_commit_sha` and reindexes changed pages (diffing blob shas) before
  serving. Edits made outside our tools are therefore never missed. There is deliberately no
  webhook: the read-time guard is the correctness mechanism.
- **Keyed by `brainId`, the brain's primary key (`brains.brain_id`), never by where it is
  stored or what it is called.** `brainRefs` (`src/lib/orgs.ts`) sets it; the handle a tool
  or the app passes is `activeBrain.id`, a separate name. The write-retry ledger and usage
  use the same key. The local runtime keys each folder's own index `local/<folder>`.
- **Links are stored raw and resolved at QUERY time** (`loadResolvedGraph`). What a markdown
  link MEANS is one pure rule in `src/lib/links.ts` (page, non-page file, broken, or
  unresolved), shared by the index and the dev harness so they cannot drift. Non-page content
  files (images, PDFs) are real references, kept apart from page edges.
- **Wikilinks: three lanes, one key** (`wikilinkKey`, `buildWikilinkIndex`, `resolveWikilink`
  in `wiki.ts`). The table and the lookup use the same key function, in order: path (every
  multi-segment suffix) → filename → title; ties go to the first page in path order. The app
  viewer calls the same functions, because a link the viewer refuses must be one `validate`
  reports.
- **Link extraction skips code** (`maskCode`): `[[Name]]` in a fence or backticks is an example.
- **`fetchPages` (GraphQL, 100 per request) is the indexer's fetch engine.** `MAX_SCAN_PAGES`
  (5000, `brain-repo.ts`) is a memory/time bound.
- **The write path finds affected pages through the index** (`backlinksTo`, via
  `fetchInboundLinkersForPaths` / `inboundRefs` in `librarian.ts`), then fetches those blobs
  fresh. Bounded by inbound links, not brain size. `backlinksTo` returns one `count`: use it,
  not `mdCount + wikiCount`.
- **Writes are WRITE-THROUGH.** A successful direct commit upserts rows for exactly the pages it
  touched (`writeThroughIndex`, called from `commitBundle`) and advances `indexed_commit_sha`,
  in ONE conditional D1 transaction that no-ops if the index moved. Bundles over the
  40-statement budget, PR writes, and the fs backend skip it and reconcile on the next read.
  Failures are swallowed: the commit is the fact. Blob shas via Web Crypto (`gitBlobSha`).
- **Queryable frontmatter** (`brain_page_fields`): every scalar or list-of-scalar key, capped
  per page (`MAX_FIELD_KEYS_PER_PAGE`); optional `indexedFields` in `.isomorphic.json`
  restricts. Nested frontmatter blocks are not indexed.
- **`INDEX_SCHEMA_VERSION` (4) bumps trigger a lazy rebuild from stored content**
  (`rebuildDerivedFromStore`: titles, fields and links, no refetch). Bump it when stored rows
  would be wrong under new derivation rules.
- **No unbounded work in one read.** `rebuildDerivedFromStore` walks `REBUILD_PAGE_BUDGET`
  pages per request from `rebuild_cursor` and advances `schema_version` only at the end;
  `incrementalReindex` fetches at most `REINDEX_PAGE_BUDGET` pages and leaves
  `indexed_commit_sha` alone if unfinished. An over-long pass does not degrade to slow, it
  degrades to a brain that can never be read (it hits the host's tool timeout and restarts
  forever). **Any new whole-brain pass: budget, cursor, advance the marker only when done.**
- The local runtime's `getHead` reports a digest of the working tree; `listCommits` reports
  git shas.
