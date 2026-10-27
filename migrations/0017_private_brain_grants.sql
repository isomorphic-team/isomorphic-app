-- 0017_private_brain_grants: keep everyone who should reach a private brain reaching it
-- once org admins no longer open private brains by default.
--
-- effectiveBrainRole stops admitting org admins and owners to a private brain they hold
-- no grant on; they steward it instead (docs/design/brain-level-permissions.md). Two
-- kinds of brain relied on that admission and get an explicit grant here:
--
--   1. A private brain whose creator, still a member of its org, holds no grant. The
--      creator gets admin, as create_brain and connect_brain grant today.
--   2. A private brain with no grant at all and no recorded creator (a row seeded by
--      hand). Its org's owners get admin, so the brain is not closed to everyone.
--
-- Rows written: one per brain in either set, a handful on any deployment.
-- Additive: the previous code reads these grants exactly as it reads any other.

INSERT OR IGNORE INTO brain_memberships (brain_id, user_id, role, granted_by)
SELECT b.brain_id, b.created_by, 'admin', b.created_by
  FROM brains b
  JOIN memberships m ON m.org_id = b.org_id AND m.user_id = b.created_by
 WHERE b.visibility = 'private'
   AND b.archived_at IS NULL;

INSERT OR IGNORE INTO brain_memberships (brain_id, user_id, role, granted_by)
SELECT b.brain_id, m.user_id, 'admin', NULL
  FROM brains b
  JOIN memberships m ON m.org_id = b.org_id AND m.role = 'owner'
 WHERE b.visibility = 'private'
   AND b.archived_at IS NULL
   AND b.created_by IS NULL
   AND NOT EXISTS (SELECT 1 FROM brain_memberships bm WHERE bm.brain_id = b.brain_id);
