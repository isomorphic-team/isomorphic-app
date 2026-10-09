-- 0016_org_entitlements: which orgs have which enterprise features, and what the model
-- gateway has spent for each.
--
-- `org_entitlements` is read by ee/entitlements.ts and written only by the operator
-- (`pnpm entitle`) or, later, by billing outside this repository. No row means the core
-- product; an expired row means the same.
--
-- `model_usage_monthly` is the gateway's own ledger (ee/review/gateway.ts): one row per org
-- per calendar month (UTC), bumped after each model call with the cost the provider
-- reported. It exists to enforce the monthly cap, and it never leaves this database.
--
-- Additive: nothing deployed today reads or writes these rows.

CREATE TABLE IF NOT EXISTS org_entitlements (
  org_id          TEXT NOT NULL,
  feature         TEXT NOT NULL,            -- e.g. 'review-models' (FEATURES in ee/entitlements.ts)
  source          TEXT NOT NULL,            -- 'plan' | 'trial' | 'manual'
  granted_at      INTEGER NOT NULL,         -- epoch ms
  expires_at      INTEGER,                  -- epoch ms; NULL never expires
  monthly_cap_usd REAL,                     -- model spend cap; NULL uses the deployment default
  note            TEXT,
  PRIMARY KEY (org_id, feature)
);

CREATE TABLE IF NOT EXISTS model_usage_monthly (
  org_id   TEXT NOT NULL,
  month    TEXT NOT NULL,                   -- 'YYYY-MM', UTC
  calls    INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month)
);
