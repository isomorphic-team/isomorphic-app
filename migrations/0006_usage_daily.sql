-- 0006_usage_daily: per-day usage counters, the backend for the org Analytics tab.
--
-- WHY THIS IS A ROLLUP AND NOT AN EVENT LOG. The tab needs to answer "who is
-- using this, and is that changing" — active members, read vs write mix, which
-- brains are alive. None of that needs a timestamped record of individual
-- actions, and a raw event log would cost three things this shape does not: it
-- grows without bound (so it needs a prune job on day one), it is a per-person
-- activity timeline sitting in D1, and it makes every analytics query a scan
-- rather than a GROUP BY. Rows here are bounded by
-- members x brains x tools x days.
--
-- Granularity is deliberately one UTC day. The finest question the tab asks is
-- "was this person active on this day"; anything sharper is surveillance the
-- feature has no use for.
--
-- Recording is gated on the USAGE_ANALYTICS var (see src/worker.ts), which the
-- generated config sets to "true". Set it to "false" and this table is never
-- written and the `analytics` tool is never registered. The migration still runs
-- either way: the table is created and simply stays empty.
--
-- Additive: nothing deployed today reads or writes these rows, so the running
-- code is unaffected during the deploy window.

CREATE TABLE IF NOT EXISTS usage_daily (
  day      TEXT NOT NULL,              -- 'YYYY-MM-DD', UTC
  org_id   TEXT NOT NULL,
  -- '' (not NULL) for org-scope calls that resolved no brain. SQLite treats NULLs
  -- in a PRIMARY KEY as DISTINCT, so a nullable column here would make ON CONFLICT
  -- never match for those rows and the upsert would append a duplicate on every
  -- single call. The empty string is what keeps this table bounded.
  brain_id TEXT NOT NULL DEFAULT '',
  user_id  TEXT NOT NULL,
  tool     TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  errors   INTEGER NOT NULL DEFAULT 0,  -- calls that threw; a high ratio is a bug report
  PRIMARY KEY (day, org_id, brain_id, user_id, tool)
);

-- Every read the tab makes is "this org, this date window", so the index leads
-- with org_id and orders by day.
CREATE INDEX IF NOT EXISTS usage_daily_org_day_idx ON usage_daily (org_id, day);
