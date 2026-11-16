-- 0029_pass_other_brain: which other brain a pass, or a pair it remembers, is about.
--
-- A contradictions check against another brain keeps run state in `brain_passes` and a
-- memory of checked pairs in `brain_pass_items`, both under the brain it ran from. This
-- column names the other brain, so those rows are deleted when that brain is
-- (src/lib/brain-forget.ts). NULL for a pass over one brain.
--
-- Additive: one nullable column on each table, so the migration writes no existing rows.

ALTER TABLE brain_passes ADD COLUMN other_brain_id TEXT;
ALTER TABLE brain_pass_items ADD COLUMN other_brain_id TEXT;
