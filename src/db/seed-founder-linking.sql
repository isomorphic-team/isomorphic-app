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
-- The `link_identity` tool does this through a verified sign-in; this template is
-- for an operator doing it by hand.
--
-- These are DATA rows, not schema: the tables come from `migrations/`. Apply with
-- `wrangler d1 execute platform-db --local|--remote --file <this file>` after
-- filling in the placeholders.
-- Idempotent. Run the DESTRUCTIVE cleanup (step 3) only after the union is verified.

-- 1. One person over both email identities.
UPDATE app_users SET person_id = 'person-1'
 WHERE user_id IN ('<PRIMARY_USER_ID>',     -- primary
                   '<SECONDARY_USER_ID>');  -- secondary

-- 2. Bridge GitHub accounts onto the primary identity (its account email).
INSERT OR IGNORE INTO github_links (github_user_id, user_id, github_login) VALUES
 (<GITHUB_USER_ID_1>, '<PRIMARY_USER_ID>', '<GITHUB_LOGIN_1>'),
 (<GITHUB_USER_ID_2>, '<PRIMARY_USER_ID>', '<GITHUB_LOGIN_2>');

-- 3. DESTRUCTIVE, run separately after verification. Removes a direct OWNER
--    membership the secondary identity holds in the primary's org, which linking
--    makes redundant (the person reaches the org through the primary's
--    membership). Safe to skip.
-- DELETE FROM memberships
--  WHERE org_id = 'org-platform' AND user_id = '<SECONDARY_USER_ID>';
