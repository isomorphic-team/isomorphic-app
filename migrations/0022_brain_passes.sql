-- 0022_brain_passes: where each budgeted, resumable whole-brain pass stands.
--
-- One row per brain per kind of pass, read and written through src/lib/brain-pass.ts. A
-- pass advances a step per call and moves `cursor`; `stopped` is a pass something halted
-- (a spent model cap, a rate limit), which asking again resumes; a `done` pass is replaced
-- by asking again. What each pass counts is its own business, so counters are one JSON
-- object rather than columns.
--
-- The model consolidation pass (kind 'consolidation') is the first user; the policy
-- baseline scan (kind 'policy-baseline') moves here in 0023.
--
-- Additive: nothing before this reads it.

CREATE TABLE IF NOT EXISTS brain_passes (
  brain_id       TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- e.g. 'consolidation'
  org_id         TEXT,                     -- NULL in the local runtime
  run_id         TEXT NOT NULL,
  status         TEXT NOT NULL,            -- 'running' | 'stopped' | 'done'
  cursor         TEXT,                     -- where the next step starts; NULL at the start
  counters       TEXT NOT NULL DEFAULT '{}', -- JSON, defined by the pass
  stopped_reason TEXT,
  started_by     TEXT,                     -- NULL in the local runtime
  started_at     INTEGER NOT NULL,         -- epoch ms
  updated_at     INTEGER NOT NULL,
  finished_at    INTEGER,                  -- epoch ms; NULL until done
  PRIMARY KEY (brain_id, kind)
);
