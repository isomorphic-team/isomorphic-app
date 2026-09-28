-- 0012_brain_handles: a short random handle that addresses a brain.
--
-- A brain's URL and tool handle are `<name>-<handle>` (src/lib/brain-slug.ts):
-- the name part is for people, the handle identifies the brain. Until now both
-- were "owner/repo", which a storage relocation changes.
-- docs/design/storage-and-tenancy.md, step 4.
--
-- Additive. Code that predates this ignores the column; a brain inserted by it
-- (or by any path that does not set one) gets a handle the first time it is
-- listed (listAccessibleBrains).
ALTER TABLE brains ADD COLUMN handle TEXT;

UPDATE brains SET handle = lower(hex(randomblob(3))) WHERE handle IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS brains_handle_idx ON brains (handle);
