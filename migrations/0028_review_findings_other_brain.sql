-- 0028_review_findings_other_brain: a finding between a page in this brain and a page in
-- another one (review_brain, check "contradictions", with `against`).
--
-- The row stays in the queue of the brain the check ran from (`brain_id`), with that
-- brain's page in `paths`. These columns name the page on the other side: the other
-- brain's id, the page's path there, and its version tag at check time. All three are
-- NULL for a finding inside one brain.
--
-- Additive: three nullable columns, so the migration writes no existing rows.

ALTER TABLE review_findings ADD COLUMN other_brain_id TEXT;
ALTER TABLE review_findings ADD COLUMN other_path TEXT;
ALTER TABLE review_findings ADD COLUMN other_sha TEXT;
