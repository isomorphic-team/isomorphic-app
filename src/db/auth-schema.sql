-- Product-native identity + org/role model.
--
-- REFERENCE ONLY: the current shape, gathered in one place for reading. The
-- canonical schema is `migrations/` (wrangler's migrations framework): apply it
-- locally with `pnpm db:migrate`; the deploy workflow applies it to the remote
-- database. Never apply this file to a database.
--
-- NOTE: Auth.js's OWN tables (users, accounts, sessions, verification_tokens) are
-- in src/db/authjs-schema.sql; these are the APP-LEVEL tables layered on top. See
-- docs/design/org-roles-permissions.md.

-- An organization: a personal org minted at first sign-in ('platform', Model A), a
-- customer's own GitHub org ('customer', Model B), or a named team org created on
-- the platform installation by create_org ('hosted').
CREATE TABLE IF NOT EXISTS orgs (
  org_id           TEXT PRIMARY KEY,          -- our uuid, NOT a GitHub id
  name             TEXT NOT NULL,
  model            TEXT NOT NULL,             -- 'platform' | 'customer' | 'hosted'
  installation_id  INTEGER NOT NULL,          -- unread; dropped by a later migration
  brain_owner      TEXT NOT NULL,             -- unread; dropped by a later migration
  github_org_login TEXT,                      -- unread; dropped by a later migration
  default_connection_id TEXT,                 -- storage_connections: where its brains live
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

-- Unread since GitHub sign-in was removed; dropped by a later migration.
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

-- A storage credential (migration 0010): today one GitHub App installation. A brain's
-- token is minted from its binding, not from its org, so a brain moved between orgs
-- keeps the credential its repo is reachable by. owner_org_id NULL = platform-owned;
-- otherwise it decides which org may list and adopt repos through it.
CREATE TABLE IF NOT EXISTS storage_connections (
  connection_id TEXT PRIMARY KEY,           -- e.g. 'github-app:<installation id>'
  provider      TEXT NOT NULL,              -- 'github'
  kind          TEXT NOT NULL,              -- 'github-app-installation'
  external_id   TEXT NOT NULL,              -- the provider's id (installation id)
  account       TEXT NOT NULL,              -- the account it reaches (GitHub login)
  owner_org_id  TEXT REFERENCES orgs(org_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, kind, external_id)
);

-- Brains owned by an org (more than one per org).
CREATE TABLE IF NOT EXISTS brains (
  brain_id   TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(org_id),
  repo_owner TEXT NOT NULL,
  repo_name  TEXT NOT NULL,              -- immutable slug (the GitHub repo name)
  name       TEXT,                       -- human display name (user-given); NULL = derive from repo
  created_by TEXT,                       -- app_users.user_id of the creator (audit)
  visibility TEXT NOT NULL DEFAULT 'org',     -- 'org' (every org member) | 'private' (grants only);
                                              -- create_brain / connect_brain write 'private'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,                      -- set = gone from every listing (existence, not policy)
  read_only  INTEGER NOT NULL DEFAULT 0, -- caps the resolved role at viewer, for everyone
  storage_connection_id TEXT REFERENCES storage_connections(connection_id),
                                         -- the credential for this brain; NULL = use the org's
  UNIQUE (repo_owner, repo_name)
);

-- Per-brain access grants: the access authority for a 'private' brain, and an
-- additive override on an 'org' one. Separate from `memberships`: that is the
-- ORG role (manage members, create/connect brains), this is the BRAIN role
-- (read, write, configure, share). effectiveBrainRole() in src/lib/orgs.ts is
-- the single resolution rule. 'owner' is not a brain role: an org owner/admin
-- floors to admin on every brain in the org instead.
CREATE TABLE IF NOT EXISTS brain_memberships (
  brain_id   TEXT NOT NULL REFERENCES brains(brain_id),
  user_id    TEXT NOT NULL REFERENCES app_users(user_id),
  role       TEXT NOT NULL,                  -- viewer | editor | admin
  granted_by TEXT,                           -- app_users.user_id (audit)
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brain_id, user_id)
);

CREATE INDEX IF NOT EXISTS brain_memberships_user_idx ON brain_memberships (user_id);

-- Pending email invitations, claimed by claimPendingInvites (src/lib/invites.ts).
-- brain_id NULL = an org invite (claimed as a membership); set = a brain invite
-- (claimed as a brain_memberships grant, never a membership; org_id is the brain's org).
CREATE TABLE IF NOT EXISTS invitations (
  invite_id   TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id),
  brain_id    TEXT REFERENCES brains(brain_id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  invited_by  TEXT NOT NULL,
  token_hash  TEXT NOT NULL,                  -- store a hash, never the raw token
  invited_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (email);
