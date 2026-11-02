-- 0022_consolidation_runs: where a brain's model-powered consolidation pass stands.
--
-- One row per brain, read and written by ee/review/consolidation.ts. A pass is budgeted, so
-- each call checks a window of page pairs and moves `cursor` (the last source page whose
-- pairs were all checked). `stopped` is a pass the gateway halted (cap spent, rate limit,
-- credits gone); asking again resumes it. A `done` pass is replaced by asking again.
--
-- Findings go to review_findings; this table only says how far the pass got and what it
-- cost. Additive: nothing before this reads it.

CREATE TABLE IF NOT EXISTS consolidation_runs (
  brain_id       TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  status         TEXT NOT NULL,            -- 'running' | 'stopped' | 'done'
  cursor         TEXT,                     -- last source page fully checked; NULL at the start
  pairs_checked  INTEGER NOT NULL DEFAULT 0,
  pairs_skipped  INTEGER NOT NULL DEFAULT 0, -- sensitive data, too long, or refused
  pairs_screened INTEGER NOT NULL DEFAULT 0, -- checked pairs the decision model cleared
  findings       INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  served         TEXT NOT NULL DEFAULT '{}', -- JSON: model id -> requests it answered
  stopped_reason TEXT,
  started_by     TEXT,
  started_at     INTEGER NOT NULL,          -- epoch ms
  updated_at     INTEGER NOT NULL
);
