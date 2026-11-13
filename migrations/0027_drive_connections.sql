-- 0027_drive_connections: what a brain kept in Google Drive needs on record.
--
-- `storage_credentials` holds the secret a storage connection reads its storage with (a
-- Google refresh token), sealed with a key the database never holds
-- (src/lib/drive-connection.ts). A GitHub connection has no row: its credential is the
-- App's key or a token in the environment.
--
-- `brains.storage_root` is where a brain's files start within its connection's storage
-- (a Drive folder id). NULL for a brain addressed by repo_owner and repo_name alone.
--
-- Additive: one new empty table and one nullable column, no rows written.

CREATE TABLE IF NOT EXISTS storage_credentials (
  connection_id TEXT PRIMARY KEY REFERENCES storage_connections(connection_id),
  sealed        TEXT NOT NULL,              -- ciphertext; never the secret itself
  connected_by  TEXT,                       -- app_users.user_id of who connected it
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE brains ADD COLUMN storage_root TEXT;
