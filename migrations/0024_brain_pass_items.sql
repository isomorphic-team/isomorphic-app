-- 0024_brain_pass_items: what each whole-brain pass last checked, item by item.
--
-- One row per brain, pass kind and item, read and written through src/lib/brain-pass.ts.
-- `fingerprint` records everything the check depended on (for the consolidation pass: the
-- prompt and gates, and both pages' blob shas), so a later pass skips an item whose
-- fingerprint is unchanged instead of paying to check it again. A row is rewritten only
-- when its item is checked again.
--
-- Additive: nothing before this reads it.

CREATE TABLE IF NOT EXISTS brain_pass_items (
  brain_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- the pass, e.g. 'consolidation'
  item        TEXT NOT NULL,            -- e.g. a page pair, 'a.md|b.md'
  fingerprint TEXT NOT NULL,
  checked_at  INTEGER NOT NULL,         -- epoch ms
  PRIMARY KEY (brain_id, kind, item)
);
