-- 0023_baseline_to_brain_passes: the policy baseline scan's state moves to brain_passes
-- (kind 'policy-baseline'), the shared run-state table from 0022.
--
-- Expand step. This copies each brain's policy_baseline row across. The code that ships
-- with it reads brain_passes, falling back to policy_baseline for a row the previous
-- version wrote after this ran, and writes both, so a rollback still finds its own table
-- current. A later migration drops policy_baseline once nothing reads it.
--
-- Rows written: one per brain that has ever run a baseline scan.

INSERT OR IGNORE INTO brain_passes
  (brain_id, kind, org_id, run_id, status, cursor, counters, stopped_reason,
   started_by, started_at, updated_at, finished_at)
SELECT
  pb.brain_id,
  'policy-baseline',
  (SELECT b.org_id FROM brains b WHERE b.brain_id = pb.brain_id),
  'baseline-' || pb.started_at,
  pb.status,
  pb.cursor,
  json_object(
    'filesScanned', pb.files_scanned,
    'filesSkipped', pb.files_skipped,
    'detections', pb.detections
  ),
  NULL,
  pb.started_by,
  pb.started_at,
  COALESCE(pb.finished_at, pb.started_at),
  pb.finished_at
FROM policy_baseline pb;
