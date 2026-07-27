-- 0002_page_fields — queryable frontmatter for the content index (FR-2 of the
-- derived-views PRD, docs/design/derived-views-and-sync-prd.md).
--
-- Adds brain_page_fields: one row per (page, frontmatter key, value), populated
-- during the same incremental reindex pass that fills brain_pages/brain_links.
-- List-valued frontmatter (roles: [CEO, CFO]) gets one row per element so views
-- can filter element-wise. value_num is populated when the value parses as a
-- number, so numeric fields (rank) sort/compare numerically.
--
-- Also adds brain_index_meta.schema_version so brains indexed before this
-- migration lazily backfill their fields table on the next read, from the page
-- content already stored in brain_pages (no GitHub refetch needed).
--
-- Additive and backward-compatible: old code ignores both.

CREATE TABLE IF NOT EXISTS brain_page_fields (
  brain_id  TEXT NOT NULL,
  path      TEXT NOT NULL,   -- page the field is on
  key       TEXT NOT NULL,   -- frontmatter key
  value     TEXT NOT NULL,   -- one scalar value (list fields: one row per element)
  value_num REAL,            -- numeric interpretation when the value parses as a number
  PRIMARY KEY (brain_id, path, key, value)
);
CREATE INDEX IF NOT EXISTS brain_page_fields_query_idx
  ON brain_page_fields (brain_id, key, value);

ALTER TABLE brain_index_meta ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0;
