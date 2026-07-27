-- 0001_init — baseline schema for the wrangler D1 migrations framework.
--
-- This is the single source of truth for building a FRESH platform-db, applied via
-- `wrangler d1 migrations apply` (locally by devs, on prod by CI — see deploy.yml).
-- It is a snapshot of the full CURRENT schema, folding in the historical ad-hoc
-- migrations (member→editor rename, identity-linking, brain-naming).
--
-- Every statement is CREATE ... IF NOT EXISTS, so applying this to the EXISTING prod
-- DB (which already has all of it) is a safe no-op — wrangler simply records the
-- baseline as applied. That's why no manual "mark as applied" step is needed: the
-- first `migrations apply` on prod no-ops and records it; migration 0002+ then apply
-- for real. Future schema changes: `wrangler d1 migrations create platform-db <name>`.

-- ============================================================================
-- Auth.js (@auth/d1-adapter) tables — vendored DDL (keep in sync with the adapter
-- version). The adapter's `users` table is distinct from our app-level `app_users`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "accounts" (
    "id" text NOT NULL,
    "userId" text NOT NULL DEFAULT NULL,
    "type" text NOT NULL DEFAULT NULL,
    "provider" text NOT NULL DEFAULT NULL,
    "providerAccountId" text NOT NULL DEFAULT NULL,
    "refresh_token" text DEFAULT NULL,
    "access_token" text DEFAULT NULL,
    "expires_at" number DEFAULT NULL,
    "token_type" text DEFAULT NULL,
    "scope" text DEFAULT NULL,
    "id_token" text DEFAULT NULL,
    "session_state" text DEFAULT NULL,
    "oauth_token_secret" text DEFAULT NULL,
    "oauth_token" text DEFAULT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "sessions" (
    "id" text NOT NULL,
    "sessionToken" text NOT NULL,
    "userId" text NOT NULL DEFAULT NULL,
    "expires" datetime NOT NULL DEFAULT NULL,
    PRIMARY KEY (sessionToken)
);

CREATE TABLE IF NOT EXISTS "users" (
    "id" text NOT NULL DEFAULT '',
    "name" text DEFAULT NULL,
    "email" text DEFAULT NULL,
    "emailVerified" datetime DEFAULT NULL,
    "image" text DEFAULT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "verification_tokens" (
    "identifier" text NOT NULL,
    "token" text NOT NULL DEFAULT NULL,
    "expires" datetime NOT NULL DEFAULT NULL,
    PRIMARY KEY (token)
);

-- ============================================================================
-- Legacy multi-tenant routing (github/static identity path). gh_user_id → brain.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  gh_user_id      INTEGER PRIMARY KEY,   -- GitHub user id from props.gh_user_id
  installation_id INTEGER NOT NULL,
  brain_owner     TEXT NOT NULL,
  brain_repo      TEXT NOT NULL,
  gh_login        TEXT,                  -- display/logging only
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,
  suspended_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_installation_id_idx ON tenants (installation_id);

-- ============================================================================
-- Product-native identity + org/role model (IDENTITY_MODE=authjs). App-level tables
-- layered on top of Auth.js. See docs/design/org-roles-permissions.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS orgs (
  org_id           TEXT PRIMARY KEY,          -- our uuid, NOT a GitHub id
  name             TEXT NOT NULL,
  model            TEXT NOT NULL,             -- 'platform' (Model A) | 'customer' (Model B)
  installation_id  INTEGER NOT NULL,
  brain_owner      TEXT NOT NULL,             -- GitHub org/login that holds the repos
  github_org_login TEXT,                      -- customer's GitHub org (Model B only)
  created_by       TEXT NOT NULL,             -- app_users.user_id of the owner
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at     TEXT
);

CREATE TABLE IF NOT EXISTS app_users (
  user_id      TEXT PRIMARY KEY,              -- Auth.js user id
  email        TEXT UNIQUE NOT NULL,
  name         TEXT,
  github_login TEXT,                          -- set ONLY for GitHub-connected owners
  person_id    TEXT,                          -- identity-linking equivalence class (NULL = solo)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS app_users_person_idx ON app_users (person_id);

CREATE TABLE IF NOT EXISTS github_links (
  github_user_id INTEGER PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES app_users(user_id),
  github_login   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS github_links_user_idx ON github_links (user_id);

CREATE TABLE IF NOT EXISTS memberships (
  org_id   TEXT NOT NULL REFERENCES orgs(org_id),
  user_id  TEXT NOT NULL REFERENCES app_users(user_id),
  role     TEXT NOT NULL,                     -- owner | admin | editor | viewer
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

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

-- ============================================================================
-- Brain content index — derived read-path cache (search / graph / backlinks /
-- validate). Never the source of truth; reconciled against repo HEAD on read.
-- See src/lib/brain-index.ts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS brain_index_meta (
  brain_id            TEXT PRIMARY KEY,   -- "owner/repo"
  indexed_commit_sha  TEXT,
  truncated           INTEGER DEFAULT 0,
  updated_at          INTEGER
);

CREATE TABLE IF NOT EXISTS brain_pages (
  brain_id  TEXT NOT NULL,
  path      TEXT NOT NULL,
  title     TEXT,
  blob_sha  TEXT NOT NULL,
  content   TEXT NOT NULL,
  PRIMARY KEY (brain_id, path)
);
CREATE INDEX IF NOT EXISTS brain_pages_brain_idx ON brain_pages (brain_id);

CREATE TABLE IF NOT EXISTS brain_links (
  brain_id    TEXT NOT NULL,
  source      TEXT NOT NULL,
  raw_target  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  cnt         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (brain_id, source, raw_target, kind)
);
CREATE INDEX IF NOT EXISTS brain_links_brain_idx ON brain_links (brain_id);
