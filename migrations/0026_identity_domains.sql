-- 0026_identity_domains: the domains an org has claimed, and the identity provider an org
-- signs in through (docs/design/enterprise-identity.md).
--
-- `org_domains` is read and written through src/lib/org-domains.ts. Several orgs may claim
-- one domain; only one may hold it verified, which the partial unique index enforces.
-- `verified_at` is cleared when a re-check no longer finds the TXT record.
--
-- `identity_connections` is read and written through src/lib/sso.ts. It holds a provider and
-- a tenant id, never a credential.
--
-- Additive: two new empty tables, no rows written.

CREATE TABLE IF NOT EXISTS org_domains (
  org_id          TEXT NOT NULL,
  domain          TEXT NOT NULL,            -- lowercased, no trailing dot
  challenge       TEXT NOT NULL,            -- the token the domain's TXT record must carry
  created_at      INTEGER NOT NULL,         -- epoch ms
  created_by      TEXT,                     -- app_users.user_id
  verified_at     INTEGER,                  -- epoch ms; NULL = not verified
  last_checked_at INTEGER,                  -- epoch ms of the last conclusive TXT lookup
  sso_enforced    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, domain)
);

CREATE UNIQUE INDEX IF NOT EXISTS org_domains_verified_idx
  ON org_domains (domain) WHERE verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity_connections (
  org_id     TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,                 -- 'microsoft-entra-id'
  tenant_id  TEXT NOT NULL,                 -- the directory's tenant id
  created_at INTEGER NOT NULL,              -- epoch ms
  created_by TEXT                           -- app_users.user_id
);
