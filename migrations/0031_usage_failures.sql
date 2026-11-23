-- 0031_usage_failures: why counted tool calls failed, at the grain of usage_daily.
--
-- One row per (day, org, brain, user, tool, reason), bumped once per failed call
-- next to the usage_daily upsert. `reason` is a category from
-- src/lib/failure-reason.ts, never an error message: a refusal can quote page
-- text, and this table holds nothing a brain holds. The sum of `failures` over a
-- usage_daily key equals that row's `errors` from this migration on.
--
-- `brain_id` is '' (not NULL) for org-scope calls, as in usage_daily: SQLite
-- treats PK NULLs as distinct, so a nullable column would defeat the upsert.
--
-- Additive: a new, empty table. Writes no existing rows.

CREATE TABLE IF NOT EXISTS usage_failures (
  day      TEXT NOT NULL,              -- 'YYYY-MM-DD', UTC
  org_id   TEXT NOT NULL,
  brain_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  tool     TEXT NOT NULL,
  reason   TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, org_id, brain_id, user_id, tool, reason)
);
