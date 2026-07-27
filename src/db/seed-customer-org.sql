-- TEMPLATE: onboard a customer as a Model-B (customer-owned) org, ADOPTING their
-- existing knowledge-base repo rather than scaffolding a fresh brain. Replace the
-- <PLACEHOLDERS> before applying.
--
-- Values to fill in:
--   <CUSTOMER_INSTALLATION_ID>  the numeric App installation id created when the
--                               isomorphic-mind App is installed on the customer's
--                               GitHub org, scoped to their KB repo.
--   <GITHUB_ORG> / <KB_REPO>    the customer's GitHub org and knowledge-base repo.
--   <CUSTOMER_OWNER_EMAIL>      the email the customer owner signs into Claude with.
--
-- created_by / invited_by resolve to the founding operator's Auth.js user id by
-- email, so no id needs hand-editing. Idempotent: INSERT OR IGNORE throughout.
--
-- Apply remote: wrangler d1 execute platform-db --remote --file src/db/seed-customer-org.sql
-- (apply --local too if the authjs tables exist locally).

-- The customer org. brain_owner + github_org_login are the customer's GitHub org;
-- installation_id is the App install on THAT org (Model B uses the customer's
-- installation token, not the platform's).
INSERT OR IGNORE INTO orgs
  (org_id, name, model, installation_id, brain_owner, github_org_login, created_by)
  SELECT 'org-acme', 'Acme', 'customer', <CUSTOMER_INSTALLATION_ID>,
         '<GITHUB_ORG>', '<GITHUB_ORG>', id
    FROM users
   WHERE email = 'owner@example.com';

-- Adopt the existing KB repo as the org's brain (no scaffold).
INSERT OR IGNORE INTO brains (brain_id, org_id, repo_owner, repo_name, visibility)
  VALUES ('brain-acme-kb', 'org-acme', '<GITHUB_ORG>', '<KB_REPO>', 'org');

-- Pre-invite the owner by email. On their first magic-link sign-in, the
-- invite-adoption path (provisionOrgForUser) joins them to org-acme as owner
-- instead of auto-provisioning a personal brain. token_hash unused for the
-- email-match path; expires_at set far out so it stays pending until claimed.
INSERT OR IGNORE INTO invitations
  (invite_id, org_id, email, role, invited_by, token_hash, expires_at)
  SELECT 'inv-acme-owner', 'org-acme', '<CUSTOMER_OWNER_EMAIL>', 'owner', id, '',
         '2099-12-31 00:00:00'
    FROM users
   WHERE email = 'owner@example.com';
