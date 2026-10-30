-- 0019_review_findings: the unified findings queue for brain review.
--
-- Findings that take work to produce, so they are stored rather than computed on each
-- `validate` (docs/design/consistency-checks.md, Part 3). Computed tensions stay
-- computed. `kind` decides who may see a row (src/lib/review-queue.ts).
--
-- DERIVED STATE. A decision about a finding lives in the brain, in
-- .isomorphic/review.json, so it survives a redeploy or a move to another deployment.
-- Whether a row is stale is computed from page_shas, never stored.
--
-- Text is scrubbed through the policy detectors before it is written, so a value the
-- guard would flag is never copied here.
--
-- Additive: a new empty table, so the migration writes no existing rows.

CREATE TABLE IF NOT EXISTS review_findings (
  brain_id       TEXT NOT NULL,
  key            TEXT NOT NULL,          -- the key `resolve` answers; see src/lib/review-queue.ts
  kind           TEXT NOT NULL,          -- 'conflict' | 'duplicate' | 'policy'
  paths          TEXT NOT NULL,          -- JSON array
  headline       TEXT NOT NULL,
  evidence       TEXT NOT NULL,          -- JSON array of lines
  proposal       TEXT,                   -- JSON; NULL when there is nothing to apply
  scores         TEXT,                   -- JSON; NULL for a computed finding
  page_shas      TEXT NOT NULL,          -- JSON object: path to blob sha at check time
  run_id         TEXT NOT NULL,
  cluster_id     TEXT,                   -- groups findings about one fact, for display only
  author_user_id TEXT,                   -- for policy findings, who wrote the content
  created_at     INTEGER NOT NULL,       -- epoch ms
  updated_at     INTEGER NOT NULL,       -- epoch ms
  PRIMARY KEY (brain_id, key)
);
