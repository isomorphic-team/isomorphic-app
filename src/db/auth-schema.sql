-- Product-native identity + org/role model (IDENTITY_MODE=authjs).
--
-- Apply locally: wrangler d1 execute platform-db --local  --file src/db/auth-schema.sql
-- Apply remote:  wrangler d1 execute platform-db --remote --file src/db/auth-schema.sql
--
-- NOTE: Auth.js's OWN tables (users, accounts, sessions, verification_tokens)
-- are created/managed by @auth/d1-adapter's `up()` migration — do NOT redefine
-- them here. These are the APP-LEVEL tables layered on top. See
-- docs/design/org-roles-permissions.md.
--
-- Phase status: schema defined; population (orgs/memberships/brains) is Phase 2.

-- A customer organization, or an individual's implicit personal org.
CREATE TABLE IF NOT EXISTS orgs (
  org_id           TEXT PRIMARY KEY,          -- our uuid, NOT a GitHub id
  name             TEXT NOT NULL,
  model            TEXT NOT NULL,             -- 'platform' (Model A) | 'customer' (Model B)
  installation_id  INTEGER NOT NULL,          -- platform install (A) or customer install (B)
  brain_owner      TEXT NOT NULL,             -- GitHub org/login that holds the repos
  github_org_login TEXT,                      -- customer's GitHub org (Model B only)
  created_by       TEXT NOT NULL,             -- app_users.user_id of the owner
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at     TEXT
);

-- App-level projection of the Auth.js user (user_id == Auth.js user id). Kept
-- separate from the adapter's `users` table so app columns don't collide with it.
CREATE TABLE IF NOT EXISTS app_users (
  user_id      TEXT PRIMARY KEY,              -- Auth.js user id
  email        TEXT UNIQUE NOT NULL,
  name         TEXT,
  github_login TEXT,                          -- set ONLY for GitHub-connected owners
  person_id    TEXT,                          -- identity-linking equivalence class (NULL = solo)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_users_person_idx ON app_users (person_id);

-- Bridges a legacy GitHub identity (props.gh_user_id) to a product identity, so a
-- GitHub-mode connection resolves into its owner's linked person. Many GitHub
-- accounts can map to one person. See src/db/migrations/2026-07-15-identity-linking.sql.
CREATE TABLE IF NOT EXISTS github_links (
  github_user_id INTEGER PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES app_users(user_id),
  github_login   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS github_links_user_idx ON github_links (user_id);

-- Membership + role: which users belong to which org.
CREATE TABLE IF NOT EXISTS memberships (
  org_id   TEXT NOT NULL REFERENCES orgs(org_id),
  user_id  TEXT NOT NULL REFERENCES app_users(user_id),
  role     TEXT NOT NULL,                     -- owner | admin | editor | viewer
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

-- Brains owned by an org (supersedes tenants.brain_*; supports >1 brain/org).
CREATE TABLE IF NOT EXISTS brains (
  brain_id   TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(org_id),
  repo_owner TEXT NOT NULL,
  repo_name  TEXT NOT NULL,              -- immutable slug (the GitHub repo name)
  name       TEXT,                       -- human display name (user-given); NULL = derive from repo
  created_by TEXT,                       -- app_users.user_id of the creator (audit)
  visibility TEXT NOT NULL DEFAULT 'org',     -- 'org' (all members) | 'private' | future ACL
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_owner, repo_name)
);

-- Pending email invitations (accepted → membership row).
CREATE TABLE IF NOT EXISTS invitations (
  invite_id   TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  invited_by  TEXT NOT NULL,
  token_hash  TEXT NOT NULL,                  -- store a hash, never the raw token
  invited_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (email);
