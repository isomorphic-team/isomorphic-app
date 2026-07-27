-- Brain content index — the read-path backend for search / graph / backlinks /
-- validate. It is a DERIVED CACHE, never the source of truth: the GitHub repo is.
-- The index is reconciled against the repo HEAD on every read (see ensureFresh in
-- src/lib/brain-index.ts) — if HEAD moved since indexed_commit_sha, the changed
-- pages are reindexed before the read is served, so a query can never return
-- content that is stale relative to the branch it claims to reflect.
--
-- Why it exists: the old read path fetched + parsed every page from GitHub on each
-- call, which capped scans at ~40 pages (Worker subrequest budget) and cost
-- hundreds of ms. Querying this index is one or two local D1 statements instead —
-- unbounded by page count and an order of magnitude faster.
--
-- Keyed by brain_id = "owner/repo" (universal across all identity modes — authjs
-- orgs, the github/static legacy paths — so it needs nothing from the org tables).
--
-- Apply to local D1:
--   pnpm exec wrangler d1 execute platform-db --local  --file=src/db/index-schema.sql
-- Apply to prod D1 (gated — do before deploying the index-backed read tools):
--   pnpm exec wrangler d1 execute platform-db --remote --file=src/db/index-schema.sql

-- One row per indexed brain: the commit the index currently reflects, plus whether
-- the last build hit the page ceiling (MAX_SCAN_PAGES) so reads can still say so.
CREATE TABLE IF NOT EXISTS brain_index_meta (
  brain_id            TEXT PRIMARY KEY,   -- "owner/repo"
  indexed_commit_sha  TEXT,               -- HEAD commit the index reflects; NULL = never built
  truncated           INTEGER DEFAULT 0,  -- 1 if the brain exceeded MAX_SCAN_PAGES at build time
  updated_at          INTEGER,            -- ms epoch of the last (re)index
  schema_version      INTEGER NOT NULL DEFAULT 0,  -- INDEX_SCHEMA_VERSION the rows were built with
  rebuild_cursor      TEXT                -- mid-rebuild resume point (last path done); NULL = not mid-rebuild
);

-- One row per content page. `content` is the full file text (incl. frontmatter),
-- so search matches lines exactly as the old live scan did. `blob_sha` is the git
-- blob sha, used to detect which pages changed for incremental reindexing.
CREATE TABLE IF NOT EXISTS brain_pages (
  brain_id  TEXT NOT NULL,
  path      TEXT NOT NULL,
  title     TEXT,
  blob_sha  TEXT NOT NULL,
  content   TEXT NOT NULL,
  PRIMARY KEY (brain_id, path)
);
CREATE INDEX IF NOT EXISTS brain_pages_brain_idx ON brain_pages (brain_id);

-- One row per DISTINCT link written in a page (markdown link or [[wikilink]]),
-- with an occurrence count. Links are stored RAW (as written) and resolved to a
-- target page at QUERY time against the current brain_pages set — so adding or
-- removing a page automatically fixes/breaks inbound links without reprocessing
-- the pages that point at it. That keeps incremental reindexing correct without a
-- whole-brain re-resolve on every change.
CREATE TABLE IF NOT EXISTS brain_links (
  brain_id    TEXT NOT NULL,
  source      TEXT NOT NULL,   -- page path the link is written in
  raw_target  TEXT NOT NULL,   -- link as written (md href, or wikilink text)
  kind        TEXT NOT NULL,   -- 'md' | 'wiki'
  cnt         INTEGER NOT NULL DEFAULT 1,  -- occurrences in that page (preserves backlink counts)
  PRIMARY KEY (brain_id, source, raw_target, kind)
);
CREATE INDEX IF NOT EXISTS brain_links_brain_idx ON brain_links (brain_id);

-- Queryable frontmatter (FR-2, derived-views PRD): one row per (page, key, value).
-- ALL scalar and list-of-scalar keys are indexed by default (hard caps in
-- brain-index.ts bound rows per page); `indexedFields` in .isomorphic.json can
-- optionally restrict the set. List fields get one row per element so views can
-- filter element-wise. value_num is set when the value parses as a number.
CREATE TABLE IF NOT EXISTS brain_page_fields (
  brain_id  TEXT NOT NULL,
  path      TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  value_num REAL,
  PRIMARY KEY (brain_id, path, key, value)
);
CREATE INDEX IF NOT EXISTS brain_page_fields_query_idx
  ON brain_page_fields (brain_id, key, value);
