-- 0015_policy_detections: what the data-policy guard flagged in shadow mode.
--
-- One row per detection in a write that landed (src/lib/policy-guard.ts). Its job
-- is measurement: how often the deterministic detectors would fire, and on what,
-- before anything is allowed to block a write.
--
-- NO CONTENT. A row holds the path, the kind of detection and its offsets, never
-- the matched text: copying a leaked credential into a second store would make
-- the leak worse. Anyone who needs the value reads the page.
--
-- Bounded: each insert prunes this brain's rows older than RETENTION_MS
-- (src/lib/policy-store.ts), so the table needs no separate job.
--
-- Additive: nothing deployed today reads or writes these rows.

CREATE TABLE IF NOT EXISTS policy_detections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  brain_id      TEXT NOT NULL,
  org_id        TEXT,                  -- NULL in the local runtime
  actor_user_id TEXT,                  -- NULL when no signed-in human wrote it
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- DetectionKind (src/lib/policy-detectors.ts)
  severity      TEXT NOT NULL,         -- 'low' | 'medium' | 'high'
  start_offset  INTEGER NOT NULL,
  end_offset    INTEGER NOT NULL,
  mode          TEXT NOT NULL,         -- the guard's mode when recorded: 'shadow'
  created_at    INTEGER NOT NULL       -- epoch ms
);

CREATE INDEX IF NOT EXISTS policy_detections_brain_idx
  ON policy_detections (brain_id, created_at);
