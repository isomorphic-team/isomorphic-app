-- 0007_connections: a connection is a shared working surface between two
-- organizations, stored as an ordinary brain that neither of them owns.
-- Design: docs/design/brain-seams.md.
--
-- WHY THIS IS PLATFORM STATE AND NOT REPO CONFIG. Two reasons, both structural.
-- The brain list is built purely from D1 (listAccessibleBrains -> brainRows) and
-- is fetched on every widget open, so putting a connection's name in a repo
-- would cost one readFile per connection on every one of those calls. And a
-- connection describes a relationship NEITHER repository owns; access grants are
-- already carved out of "the repo is the source of truth" for exactly that
-- reason, and a connection is the reason those grants exist.
--
-- WHY TWO TABLES AND NOT org_a / org_b COLUMNS. A parties table makes a third
-- party a data change; two columns make it a migration. It also makes "every
-- connection this organization is in" one indexed lookup rather than an OR.
--
-- ACCESS IS DERIVED, NOT GRANTED, which is why anchor_brain_id is here and is
-- load-bearing rather than decorative. Each side joins a connection to one of
-- its OWN brains; whoever can reach that anchor can reach the connection. So
-- each party governs its own audience by governing its own brain, no one
-- administers people in an organization they cannot see, and revocation is the
-- same statement that removes someone from the anchor. There is deliberately no
-- brain_memberships row for the far side: a grant that hangs off nothing has no
-- teardown path (deleteUserBrainGrantsInOrg is scoped by brains.org_id, so a
-- person removed from their own org would silently keep the client room).
--
-- Additive: nothing deployed today reads or writes any of this, so the running
-- code is unaffected during the deploy window.

CREATE TABLE IF NOT EXISTS connections (
  connection_id TEXT PRIMARY KEY,
  -- The brain that stores this connection's pages, in the system organization
  -- (see ensureConnectionsOrg). UNIQUE: one brain is at most one connection's
  -- storage, so connectionForBrain is a lookup rather than a judgement.
  brain_id      TEXT NOT NULL UNIQUE REFERENCES brains(brain_id),
  name          TEXT NOT NULL,
  -- pending -> live -> ending -> ended. NOT a boolean, because ending a
  -- connection is a multi-step sequence that must survive being interrupted:
  -- access stops in the first request, and the mirror copy is unbounded work
  -- that resumes. 'ending' is what a resume path looks for. 'pending' is a
  -- connection whose far side has not joined yet, and which therefore nobody
  -- there can reach.
  state         TEXT NOT NULL DEFAULT 'pending',
  created_by    TEXT,                                   -- app_users.user_id, audit only
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_by      TEXT,
  ended_at      TEXT
);

CREATE TABLE IF NOT EXISTS connection_parties (
  -- Surrogate key. org_id is NULL until a side joins, and SQLite treats NULLs in
  -- a PRIMARY KEY as DISTINCT, so a natural key of (connection_id, org_id) would
  -- silently stop constraining anything for exactly the rows that need it most.
  -- Same trap 0006_usage_daily documents for its own empty-string column.
  party_id        TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL REFERENCES connections(connection_id),
  org_id          TEXT REFERENCES orgs(org_id),         -- NULL until this side joins
  invited_email   TEXT,                                 -- set iff org_id IS NULL
  invited_at      TEXT,
  expires_at      TEXT,                                 -- a pending invite goes stale
  -- The party's OWN brain this connection hangs off. It is both the access key
  -- (reach the anchor, reach the connection) and the scope key (a connection is
  -- in scope when you are in the brain it is joined to). NULL while pending, and
  -- set to NULL again when the connection ends, which is what stops access.
  anchor_brain_id TEXT REFERENCES brains(brain_id),
  -- The read-only copy this party keeps when the connection ends. NULL until it
  -- has actually been written, so a NULL on an 'ending' connection IS the retry
  -- queue.
  mirror_brain_id TEXT REFERENCES brains(brain_id),
  copy_cursor     TEXT,                                 -- resumable mirror copy
  joined_at       TEXT
);

CREATE INDEX IF NOT EXISTS connection_parties_anchor_idx ON connection_parties (anchor_brain_id);
CREATE INDEX IF NOT EXISTS connection_parties_org_idx    ON connection_parties (org_id);
CREATE INDEX IF NOT EXISTS connection_parties_conn_idx   ON connection_parties (connection_id);
CREATE INDEX IF NOT EXISTS connection_parties_email_idx  ON connection_parties (invited_email);

-- One row per organization per connection. Note this does NOT constrain the
-- pending rows, since NULL org_ids are distinct to a UNIQUE index as well; only
-- one pending party is ever created per connection, and joining fills the org in.
CREATE UNIQUE INDEX IF NOT EXISTS connection_parties_uniq
  ON connection_parties (connection_id, org_id);

-- Brain lifecycle, on the row every consumer already reads.
--
-- archived_at is EXISTENCE, not policy: listAccessibleBrains filters on it in SQL
-- rather than threading it through effectiveBrainRole, because "this brain is
-- gone" is not a question about who you are, and expressing it in the pure rule
-- would double that function's input space to say so.
ALTER TABLE brains ADD COLUMN archived_at TEXT;

-- read_only IS policy, and it caps the resolved role at viewer. A mirror cannot
-- be made inert with a viewer grant instead: effectiveBrainRole's org-admin floor
-- hands any admin of the receiving organization their own role straight back, and
-- an org-visible mirror hands every member theirs. With the cap, every existing
-- `requires: 'editor'` gate refuses with the message it already has and nothing
-- else in the codebase learns a new concept.
ALTER TABLE brains ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;

-- Provenance: which connection this brain is the mirror of. Never a foreign key
-- to connections, because a mirror must outlive the row that explains it.
ALTER TABLE brains ADD COLUMN mirror_of TEXT;
