-- 0021_policy_dismissals: decisions about policy findings.
--
-- Other dismissals live in the brain's .isomorphic/review.json. These do not: a path
-- plus a detection kind says where sensitive data sits, and repository readers are not
-- the audience for that. Moving a brain to another deployment re-raises them, which is
-- the safe direction.
--
-- A dismissal covers the values someone looked at, not the path and kind, so a new or
-- swapped value reopens the finding. `fingerprints` holds an HMAC of each value, keyed
-- from a deployment secret and bound to the brain, because a plain hash of a Social
-- Security number can be reversed by trying every number. NO VALUES are stored.
--
-- Additive: a new empty table, so the migration writes no existing rows.

CREATE TABLE IF NOT EXISTS policy_dismissals (
  brain_id     TEXT NOT NULL,
  key          TEXT NOT NULL,      -- the finding's key
  fingerprints TEXT NOT NULL,      -- JSON array of hex HMACs
  file_sha     TEXT NOT NULL,      -- the file as dismissed; unchanged means nothing to recheck
  why          TEXT NOT NULL DEFAULT '',
  dismissed_by TEXT,               -- NULL in the local runtime
  dismissed_at INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (brain_id, key)
);
