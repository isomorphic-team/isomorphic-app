-- 0018_policy_baseline: progress of the admin-run scan of a brain as it stands.
--
-- The guard only sees writes, so content that predates it needs a one-off pass
-- (docs/design/privacy-checks.md, Part 1). A scan walks the repository a budget at a
-- time, so a row carries the cursor the next call resumes from.
--
-- One row per brain, the latest scan. What it found lives in policy_detections with
-- mode = 'baseline': those rows stay until the next scan replaces them, because the
-- content they point at does not age out of the brain.
--
-- NO CONTENT, like policy_detections.
--
-- Additive: a new empty table, so the migration writes no existing rows.

CREATE TABLE IF NOT EXISTS policy_baseline (
  brain_id      TEXT PRIMARY KEY,
  status        TEXT NOT NULL,            -- 'running' | 'done'
  cursor        TEXT,                     -- last path handled; NULL before the first step
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0, -- binary files, which the text detectors cannot read
  detections    INTEGER NOT NULL DEFAULT 0,
  started_by    TEXT,                     -- NULL in the local runtime
  started_at    INTEGER NOT NULL,         -- epoch ms
  finished_at   INTEGER                   -- epoch ms; NULL until done
);
