-- TEMPLATE: connect an existing personal repo as a brain under the platform org,
-- reachable by a specific product identity. Replace the <PLACEHOLDERS> before applying.
--
-- Context: wire a private repo (e.g. a personal notes vault) into the platform org
-- so a signed-in user reaches it. The brain is 'private', so other members of the
-- platform org do not see it; the org's owners and admins still do (the org-admin
-- floor in effectiveBrainRole). Where that is too wide, prefer identity linking
-- (seed-founder-linking.sql) over a shared-org membership.
--
-- These are DATA rows, not schema: the tables come from `migrations/`. Apply with
-- `wrangler d1 execute platform-db --local|--remote --file <this file>` after
-- filling in the placeholders.
-- Idempotent (INSERT OR IGNORE).

-- The user joins the platform org as owner.
INSERT OR IGNORE INTO memberships (org_id, user_id, role)
VALUES ('org-platform', '<USER_ID>', 'owner');

-- The vault repo becomes a brain under that org.
INSERT OR IGNORE INTO brains (brain_id, org_id, repo_owner, repo_name, visibility)
VALUES ('brain-personal', 'org-platform', '<GITHUB_ORG>', '<PERSONAL_REPO>', 'private');
