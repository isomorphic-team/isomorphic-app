-- 0025_purge_orphaned_brain_rows: delete rows left by brains that no longer exist.
--
-- Until this release, disconnect_brain deleted only the brains row and its grants, so
-- every other table keyed on brain_id kept the brain's index, findings and policy
-- records. The code that ships with this deletes them on disconnect (forgetBrain,
-- src/lib/brain-forget.ts); this removes what earlier disconnects left behind,
-- including rows that 0011 left keyed by "owner/repo". The table list is
-- BRAIN_PURGED_TABLES, and pnpm test:access checks the two stay in step.
--
-- Rollback-safe: no code reads a row whose brain_id matches no brains row.
--
-- Rows written: one per orphaned row, i.e. the indexed pages, links, fields and
-- findings of every brain ever disconnected. Usually small; count with
--   SELECT COUNT(*) FROM brain_pages WHERE brain_id NOT IN (SELECT brain_id FROM brains)
-- before deploying to a large deployment.

DELETE FROM brain_pages WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM brain_links WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM brain_page_fields WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM brain_index_meta WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM review_findings WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM policy_detections WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM policy_dismissals WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM policy_baseline WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM brain_passes WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM brain_pass_items WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM write_attempts WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM brain_memberships WHERE brain_id NOT IN (SELECT brain_id FROM brains);
DELETE FROM invitations
 WHERE brain_id IS NOT NULL AND brain_id NOT IN (SELECT brain_id FROM brains);
