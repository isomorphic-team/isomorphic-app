-- 0013_org_default_connection: an org names the storage connection its new
-- brains are created on.
--
-- Until now the org carried the installation itself (installation_id,
-- brain_owner, github_org_login). The connection already records both the
-- credential and the account, so the org points at it instead, and nothing reads
-- those three columns after this. They stay, NOT NULL and still written, until a
-- later migration drops them, so the code before this one keeps running.
-- docs/design/storage-and-tenancy.md, step 6.
ALTER TABLE orgs ADD COLUMN default_connection_id TEXT
  REFERENCES storage_connections(connection_id);

-- An org created after 0010 that has not created a brain yet may have no
-- recorded connection: record it exactly as 0010 did. A token deployment's org
-- (installation 0) is skipped; its connection is its brain's, below.
INSERT OR IGNORE INTO storage_connections
  (connection_id, provider, kind, external_id, account, owner_org_id)
SELECT 'github-app:' || installation_id, 'github', 'github-app-installation',
       CAST(installation_id AS TEXT), brain_owner,
       CASE WHEN model = 'customer' THEN org_id ELSE NULL END
  FROM orgs
 WHERE installation_id > 0
   AND NOT EXISTS (SELECT 1 FROM brains b
                    JOIN storage_connections c ON c.connection_id = b.storage_connection_id
                   WHERE b.org_id = orgs.org_id AND c.kind = 'github-token')
 ORDER BY created_at ASC, org_id ASC;

-- Every org whose installation is a recorded connection.
UPDATE orgs
   SET default_connection_id = 'github-app:' || installation_id
 WHERE default_connection_id IS NULL
   AND EXISTS (SELECT 1 FROM storage_connections c
                WHERE c.connection_id = 'github-app:' || orgs.installation_id);

-- A single-user deployment reading through GITHUB_TOKEN has no installation: its
-- org's storage is the connection its brain is bound to.
UPDATE orgs
   SET default_connection_id = (SELECT b.storage_connection_id FROM brains b
                                 WHERE b.org_id = orgs.org_id
                                   AND b.storage_connection_id IS NOT NULL
                                 ORDER BY b.created_at LIMIT 1)
 WHERE default_connection_id IS NULL;

-- The per-user tenants of GitHub sign-in, which was removed. Nothing has read
-- this table since that change deployed.
DROP TABLE IF EXISTS tenants;
