-- TEMPLATE: seed the founding operator's org from an existing Auth.js user,
-- ADOPTING an existing brain repo rather than auto-provisioning a fresh one.
-- Replace the <PLACEHOLDERS> before applying.
--
-- Why this exists: the generic auto-provision path (provisionOrgForUser) would
-- create a NEW brain-<email-slug> repo for a first-seen Auth.js user. If the
-- operator already has a populated brain (e.g. from the GitHub-identity era), map
-- their product identity onto it explicitly, once.
--
-- Environment-agnostic: resolves the operator's user_id by email from Auth.js's
-- own `users` table, so the same file seeds local and remote without editing an
-- id. Idempotent: INSERT OR IGNORE across the board.
--
-- Apply local:  wrangler d1 execute platform-db --local  --file src/db/seed-operator-org.sql
-- Apply remote: wrangler d1 execute platform-db --remote --file src/db/seed-operator-org.sql

INSERT OR IGNORE INTO app_users (user_id, email, name, github_login)
  SELECT id, email, name, '<OPERATOR_GITHUB_LOGIN>'
    FROM users
   WHERE email = 'owner@example.com';

INSERT OR IGNORE INTO orgs (org_id, name, model, installation_id, brain_owner, created_by)
  SELECT 'org-platform', 'Your Platform', 'platform', <PLATFORM_INSTALLATION_ID>, '<GITHUB_ORG>', id
    FROM users
   WHERE email = 'owner@example.com';

INSERT OR IGNORE INTO memberships (org_id, user_id, role)
  SELECT 'org-platform', id, 'owner'
    FROM users
   WHERE email = 'owner@example.com';

INSERT OR IGNORE INTO brains (brain_id, org_id, repo_owner, repo_name, visibility)
  VALUES ('brain-platform', 'org-platform', '<GITHUB_ORG>', '<BRAIN_REPO>', 'org');
