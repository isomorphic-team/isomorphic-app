-- Legacy GitHub-identity routing (IDENTITY_MODE=github): one brain per GitHub user.
-- The authjs org model (auth-schema.sql) supersedes it for product identities.
--
-- REFERENCE ONLY: the current shape, gathered in one place for reading. The
-- canonical schema is `migrations/` (wrangler's migrations framework): apply it
-- locally with `pnpm db:migrate`; the deploy workflow applies it to the remote
-- database. Never apply this file to a database.

CREATE TABLE IF NOT EXISTS tenants (
  -- Primary key: the GitHub user ID surfaced via OAuth (`props.gh_user_id`).
  -- One brain per user by design; a GitHub id that needs more links to a product
  -- identity (github_links) and resolves through the org model instead.
  gh_user_id INTEGER PRIMARY KEY,

  -- Identifies the GitHub App installation on the user's org/account. Used to
  -- mint an installation token via @octokit/auth-app for repo operations.
  installation_id INTEGER NOT NULL,

  -- The brain repo this user's tools target.
  brain_owner TEXT NOT NULL,
  brain_repo TEXT NOT NULL,

  -- Cached login for logging / display only — not authoritative.
  gh_login TEXT,

  -- Lifecycle timestamps. suspended_at is meant to be set when the GitHub App is
  -- suspended or uninstalled; nothing writes it yet (no webhook receiver).
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  suspended_at TEXT
);

-- Reverse lookup from an installation_id to its tenant, for an `installation`
-- webhook (suspend, uninstall, permission update) once one exists.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_installation_id_idx
  ON tenants (installation_id);
