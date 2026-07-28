-- 0004_brain_memberships: per-brain access control.
--
-- Until now `brains.visibility` existed but was read by NOTHING: access to a
-- brain was exactly org membership, and the caller's ORG role applied to every
-- brain in the org. That is fine for a solo/personal org and wrong for a shared
-- one: every brain anyone creates is immediately visible to the whole org, and
-- an Editor cannot share their brain with a teammate read-only.
--
-- This table is the access authority for a brain. A row grants ONE user access
-- to ONE brain at a brain-scoped role, independent of their org role. See
-- effectiveBrainRole() in src/lib/orgs.ts for the resolution rule; it is the
-- single place that decides, and it is pure so `pnpm test:access` can pin it.
--
-- Two roles, two scopes, deliberately separate:
--   • ORG role:   invite/remove members, set roles, connect the GitHub org,
--                create brains, connect/disconnect brains.
--   • BRAIN role: read, write, move/delete pages, configure, share.
--
-- Backward-compatible by construction: every EXISTING brain keeps
-- visibility='org', which still resolves to "all org members at their org role",
-- the exact behavior they have today, so nobody loses access on deploy. Only
-- newly CREATED brains default to 'private' (see create_brain), and they get an
-- admin grant for their creator in the same call.
--
-- `role` is one of viewer | editor | admin. 'owner' is deliberately NOT a brain
-- role: ownership is an ORG concept (the anti-lockout anchor), and an org
-- owner/admin already floors to admin on every brain in their org.

CREATE TABLE IF NOT EXISTS brain_memberships (
  brain_id  TEXT NOT NULL REFERENCES brains(brain_id),
  user_id   TEXT NOT NULL REFERENCES app_users(user_id),
  role      TEXT NOT NULL,                        -- viewer | editor | admin
  granted_by TEXT,                                -- app_users.user_id (audit)
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brain_id, user_id)
);

-- The hot lookup is "which brains can this person reach", joined from the user
-- side across all their linked identities (listAccessibleBrains).
CREATE INDEX IF NOT EXISTS brain_memberships_user_idx ON brain_memberships (user_id);
