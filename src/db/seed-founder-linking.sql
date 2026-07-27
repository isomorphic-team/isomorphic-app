-- TEMPLATE: link two sign-in identities into one person ("Connected accounts"),
-- and optionally bridge GitHub logins onto that person. Replace <PLACEHOLDERS>.
--
-- Example identities:
--   primary    owner@example.com      app_user <PRIMARY_USER_ID>   (owner org-platform)
--   secondary  owner.alt@example.com  app_user <SECONDARY_USER_ID> (owner org-acme)
--   github     two GitHub logins bridged onto the primary identity
--
-- After this, from ANY of these logins, listAccessibleBrains over the person's id
-- set returns the UNION of both identities' brains.
--
-- Idempotent. Apply the LINK steps to local + remote; run the DESTRUCTIVE cleanup
-- (step 3) ONLY after the code is deployed and the union is verified.
--   wrangler d1 execute platform-db --local  --file src/db/seed-founder-linking.sql
--   wrangler d1 execute platform-db --remote --file src/db/seed-founder-linking.sql

-- 1. One person over both email identities.
UPDATE app_users SET person_id = 'person-1'
 WHERE user_id IN ('<PRIMARY_USER_ID>',     -- primary
                   '<SECONDARY_USER_ID>');  -- secondary

-- 2. Bridge GitHub accounts onto the primary identity (its account email).
INSERT OR IGNORE INTO github_links (github_user_id, user_id, github_login) VALUES
 (<GITHUB_USER_ID_1>, '<PRIMARY_USER_ID>', '<GITHUB_LOGIN_1>'),
 (<GITHUB_USER_ID_2>, '<PRIMARY_USER_ID>', '<GITHUB_LOGIN_2>');

-- 3. DESTRUCTIVE — run separately, AFTER deploy + verification. Reverts an earlier
--    co-mingling shortcut where a secondary identity was given a direct OWNER
--    membership in the primary's org; that membership is now redundant because
--    linking reaches the org's brains via the primary owner membership. Safe to skip.
-- DELETE FROM memberships
--  WHERE org_id = 'org-platform' AND user_id = '<SECONDARY_USER_ID>';
