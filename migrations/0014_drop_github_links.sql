-- 0014_drop_github_links: remove the GitHub identity bridge.
--
-- github_links mapped a GitHub sign-in onto a person. GitHub sign-in was removed,
-- and since migration 0013's release nothing reads or writes this table.
-- Production held no rows. docs/design/storage-and-tenancy.md, step 6.
DROP INDEX IF EXISTS github_links_user_idx;
DROP TABLE IF EXISTS github_links;
