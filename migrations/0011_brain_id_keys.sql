-- 0011_brain_id_keys: derived state is keyed by the brain's primary key.
--
-- The content index, the write-retry ledger and usage were keyed by "owner/repo",
-- which is where a brain is STORED, not which brain it is. Keyed by
-- brains.brain_id, they survive a storage relocation and never collide with a
-- repo that a later brain reuses. docs/design/storage-and-tenancy.md, step 3.
--
-- Rows are re-keyed in place rather than rebuilt, so no brain reindexes. Rows for
-- a repo no brain holds are left as they are: nothing reads them.
--
-- Rollback-safe: every table here is a cache or a counter. Code that still reads
-- "owner/repo" finds no rows, reindexes into fresh ones and counts from zero; the
-- rows it writes in the deploy window are orphaned, not wrong.
UPDATE brain_index_meta
   SET brain_id = (SELECT b.brain_id FROM brains b
                    WHERE b.repo_owner || '/' || b.repo_name = brain_index_meta.brain_id)
 WHERE brain_id IN (SELECT repo_owner || '/' || repo_name FROM brains);

UPDATE brain_pages
   SET brain_id = (SELECT b.brain_id FROM brains b
                    WHERE b.repo_owner || '/' || b.repo_name = brain_pages.brain_id)
 WHERE brain_id IN (SELECT repo_owner || '/' || repo_name FROM brains);

UPDATE brain_links
   SET brain_id = (SELECT b.brain_id FROM brains b
                    WHERE b.repo_owner || '/' || b.repo_name = brain_links.brain_id)
 WHERE brain_id IN (SELECT repo_owner || '/' || repo_name FROM brains);

UPDATE brain_page_fields
   SET brain_id = (SELECT b.brain_id FROM brains b
                    WHERE b.repo_owner || '/' || b.repo_name = brain_page_fields.brain_id)
 WHERE brain_id IN (SELECT repo_owner || '/' || repo_name FROM brains);

UPDATE write_attempts
   SET brain_id = (SELECT b.brain_id FROM brains b
                    WHERE b.repo_owner || '/' || b.repo_name = write_attempts.brain_id)
 WHERE brain_id IN (SELECT repo_owner || '/' || repo_name FROM brains);

UPDATE usage_daily
   SET brain_id = (SELECT b.brain_id FROM brains b
                    WHERE b.repo_owner || '/' || b.repo_name = usage_daily.brain_id)
 WHERE brain_id IN (SELECT repo_owner || '/' || repo_name FROM brains);
