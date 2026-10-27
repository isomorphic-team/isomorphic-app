-- TEMPLATE: connect an existing personal repo as a brain under the platform org,
-- reachable by a specific product identity. Replace the <PLACEHOLDERS> before applying.
--
-- Context: wire a private repo (e.g. a personal notes vault) into the platform org
-- so a signed-in user reaches it. The brain is 'private' and the user holds an admin
-- grant on it, so other members of the platform org cannot open it. Its owners and
-- admins can see that it exists and can share it with themselves, which the user sees
-- on its sharing list.
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

-- The user's grant: on a private brain, the only way in.
INSERT OR IGNORE INTO brain_memberships (brain_id, user_id, role, granted_by)
VALUES ('brain-personal', '<USER_ID>', 'admin', '<USER_ID>');
