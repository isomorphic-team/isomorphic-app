-- 0010_storage_connections: a brain names the credential that reads it.
--
-- Until now a brain was read through its ORG's installation, so moving a brain
-- to another org changed which credential read it. A connection is a credential
-- to one provider account; a brain's storage_connection_id binds it to one.
-- docs/design/storage-and-tenancy.md is the model.
--
-- owner_org_id is the org that administers the connection (lists and adopts
-- through it). NULL is platform-owned: hosted storage, which no org may list or
-- adopt through.
--
-- Additive. A brain whose binding is NULL falls back to its org's installation,
-- which is how every brain resolved before this, so the old code in the deploy
-- window and a code rollback both read the same credential they always did.
CREATE TABLE IF NOT EXISTS storage_connections (
  connection_id TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,              -- 'github'
  kind          TEXT NOT NULL,              -- 'github-app-installation'
  external_id   TEXT NOT NULL,              -- the provider's id (installation id)
  account       TEXT NOT NULL,              -- the account it reaches (GitHub login)
  owner_org_id  TEXT REFERENCES orgs(org_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, kind, external_id)
);

ALTER TABLE brains ADD COLUMN storage_connection_id TEXT
  REFERENCES storage_connections(connection_id);

-- One connection per installation. A customer installation is owned by the
-- oldest org using it; the platform installation (shared by every personal org)
-- is owned by none. Oldest first, so INSERT OR IGNORE keeps the oldest owner.
INSERT OR IGNORE INTO storage_connections
  (connection_id, provider, kind, external_id, account, owner_org_id)
SELECT 'github-app:' || installation_id, 'github', 'github-app-installation',
       CAST(installation_id AS TEXT), brain_owner,
       CASE WHEN model = 'customer' THEN org_id ELSE NULL END
  FROM orgs
 ORDER BY created_at ASC, org_id ASC;

UPDATE brains
   SET storage_connection_id = (
         SELECT 'github-app:' || o.installation_id FROM orgs o WHERE o.org_id = brains.org_id)
 WHERE storage_connection_id IS NULL;
