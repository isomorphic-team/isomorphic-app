-- TEMPLATE: connect an existing personal repo as a brain under the platform org,
-- reachable by a specific product identity. Replace the <PLACEHOLDERS> before applying.
--
-- Context: wire a private repo (e.g. a personal notes vault) into the platform org
-- so a signed-in user reaches it. NOTE: listAccessibleBrains has no per-brain
-- visibility filter, so every member of the platform org sees this brain — prefer
-- identity linking (see seed-founder-linking.sql) over a shared-org membership when
-- the brain is personal.
--
-- Idempotent (INSERT OR IGNORE). Apply:
--   wrangler d1 execute platform-db --local  --file src/db/seed-personal-brain.sql
--   wrangler d1 execute platform-db --remote --file src/db/seed-personal-brain.sql

-- The user joins the platform org as owner.
INSERT OR IGNORE INTO memberships (org_id, user_id, role)
VALUES ('org-platform', '<USER_ID>', 'owner');

-- The vault repo becomes a brain under that org.
INSERT OR IGNORE INTO brains (brain_id, org_id, repo_owner, repo_name, visibility)
VALUES ('brain-personal', 'org-platform', '<GITHUB_ORG>', '<PERSONAL_REPO>', 'org');
