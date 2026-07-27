-- Multi-tenant routing for the MCP server.
--
-- Apply locally: wrangler d1 execute platform-db --local --file src/db/schema.sql
-- Apply remote:  wrangler d1 execute platform-db --remote --file src/db/schema.sql

CREATE TABLE IF NOT EXISTS tenants (
  -- Primary key: the GitHub user ID surfaced via OAuth (`props.gh_user_id`).
  -- One brain per user for now; multi-brain-per-user is a later concern.
  gh_user_id INTEGER PRIMARY KEY,

  -- Identifies the GitHub App installation on the user's org/account. Used to
  -- mint an installation token via @octokit/auth-app for repo operations.
  installation_id INTEGER NOT NULL,

  -- The brain repo this user's tools target.
  brain_owner TEXT NOT NULL,
  brain_repo TEXT NOT NULL,

  -- Cached login for logging / display only — not authoritative.
  gh_login TEXT,

  -- Lifecycle timestamps. suspended_at is set when the GitHub App is suspended
  -- or uninstalled (via the `installation` webhook, future work).
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  suspended_at TEXT
);

-- Reverse lookup: when an `installation` webhook fires (suspend, uninstall,
-- permission update), we get the installation_id and need to find the tenant.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_installation_id_idx
  ON tenants (installation_id);
