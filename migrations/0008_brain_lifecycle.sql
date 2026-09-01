-- 0008_brain_lifecycle: two columns on the row every consumer already reads.
--
-- archived_at is EXISTENCE, not policy: listAccessibleBrains and
-- getDefaultBrainForUser filter on it in SQL rather than threading it through
-- effectiveBrainRole, because "this brain is gone" is not a question about who
-- you are, and expressing it in the pure rule would double that function's input
-- space to say so. An archived brain leaves every switcher, every matchBrain, and
-- every fan-out in one place.
--
-- read_only IS policy, and it caps the resolved role at viewer. A brain cannot be
-- made inert with a viewer grant instead: effectiveBrainRole's org-admin floor
-- hands any admin of the owning organization their own role straight back, and an
-- org-visible brain hands every member theirs. With the cap, every existing
-- `requires: 'editor'` gate refuses with the message it already has and nothing
-- else in the codebase learns a new concept.
--
-- Both additive, with defaults the old code never reads, so the deploy window and
-- a code rollback are both safe.
ALTER TABLE brains ADD COLUMN archived_at TEXT;
ALTER TABLE brains ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
