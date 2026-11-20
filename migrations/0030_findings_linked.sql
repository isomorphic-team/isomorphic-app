-- 0030_findings_linked: one check of a pair of pages in two brains, one finding in each
-- brain's queue.
--
-- `review_findings.linked_key` is the key the same finding has in the other brain's queue
-- (`other_brain_id`). `closed_by_other` is when that copy was dismissed there, which
-- closes this one too. Both are NULL for a finding inside one brain.
--
-- A pair of pages in two brains is remembered once in `brain_pass_items`, under the brain
-- whose id sorts first, with the second brain in `other_brain_id`. The index is for the
-- second brain's pass, which reads the rows that name it there.
--
-- Additive: two nullable columns, which write no existing rows, and one index, which
-- writes one entry per existing `brain_pass_items` row.

ALTER TABLE review_findings ADD COLUMN linked_key TEXT;
ALTER TABLE review_findings ADD COLUMN closed_by_other INTEGER;
CREATE INDEX idx_brain_pass_items_other ON brain_pass_items (other_brain_id, kind);
