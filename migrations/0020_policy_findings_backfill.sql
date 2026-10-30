-- 0020_policy_findings_backfill: carry recorded detections into the findings queue.
--
-- The guard's reports now read review_findings, so a detection already in
-- policy_detections has to become a finding or it would leave the report. One row per
-- brain, path and kind, in the shape policyFindings (src/lib/review-queue.ts) writes.
-- page_shas starts empty, so the first report rescans the file: that corrects the count
-- and closes any finding already fixed.
--
-- Bounded: at most one row per distinct (brain, path, kind) in a table already pruned
-- to 90 days, and only high-precision detections reach that table. Holds kinds and
-- paths, never values. Existing rows win, so it is safe to replay.

INSERT OR IGNORE INTO review_findings
  (brain_id, key, kind, paths, headline, evidence, proposal, scores, page_shas,
   run_id, cluster_id, author_user_id, created_at, updated_at)
SELECT
  brain_id,
  'policy:' || path || ':' || kind,
  'policy',
  json_array(path),
  'Sensitive data (' || kind || ') in ' || path || '.',
  '["Values are not stored, so read the file to review."]',
  NULL,
  json_object('detections', COUNT(*)),
  '{}',
  'backfill',
  NULL,
  MAX(actor_user_id),
  MIN(created_at),
  MAX(created_at)
FROM policy_detections
GROUP BY brain_id, path, kind;
