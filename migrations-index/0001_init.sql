-- The content index, in its own database (the INDEX_DB binding).
--
-- Everything here is derived from a brain's git repository and can be rebuilt from it,
-- so this database needs no export and no backup. It holds no org or user rows.
-- The four tables match the ones in the platform database, which the index uses when
-- INDEX_DB is not bound. One difference: brain_pages has an integer key, which a
-- full-text table over it needs (an implicit rowid can be renumbered by VACUUM).

CREATE TABLE brain_index_meta (
  brain_id            TEXT PRIMARY KEY,
  indexed_commit_sha  TEXT,
  truncated           INTEGER DEFAULT 0,
  updated_at          INTEGER,
  schema_version      INTEGER NOT NULL DEFAULT 0,
  rebuild_cursor      TEXT
);

CREATE TABLE brain_pages (
  id        INTEGER PRIMARY KEY,
  brain_id  TEXT NOT NULL,
  path      TEXT NOT NULL,
  title     TEXT,
  blob_sha  TEXT NOT NULL,
  content   TEXT NOT NULL,
  UNIQUE (brain_id, path)
);

CREATE TABLE brain_links (
  brain_id    TEXT NOT NULL,
  source      TEXT NOT NULL,
  raw_target  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  cnt         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (brain_id, source, raw_target, kind)
);

CREATE TABLE brain_page_fields (
  brain_id  TEXT NOT NULL,
  path      TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  value_num REAL,
  PRIMARY KEY (brain_id, path, key, value)
);
CREATE INDEX brain_page_fields_query_idx ON brain_page_fields (brain_id, key, value);
