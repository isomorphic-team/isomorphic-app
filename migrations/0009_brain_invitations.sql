-- 0009_brain_invitations: an invitation can name a brain.
--
-- A brain invite is how someone with no account yet is made a GUEST of one
-- brain (docs/design/guest-access.md): it is claimed as a brain_memberships
-- grant rather than a memberships row. org_id stays NOT NULL and is the brain's
-- own organization, so nothing that reads invitations meets an org-less row.
--
-- Additive, nullable, unread by the old code: safe in the deploy window and
-- under a rollback.
ALTER TABLE invitations ADD COLUMN brain_id TEXT REFERENCES brains(brain_id);
