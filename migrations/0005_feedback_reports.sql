-- 0005_feedback_reports: the PRIVATE half of user feedback (src/tools/feedback.ts).
--
-- `submit_feedback` files an issue on the project's PUBLIC repository, so the
-- issue itself carries only the user's words plus an opaque report id. This table
-- is where the identifying half goes instead: report id → who filed it, from which
-- org and brain, and which issue it became. That split is the whole design. A
-- maintainer can answer "who asked for this?" without a customer's email address
-- being permanently published and indexed on a public repo.
--
-- `reporter_key` is the rate-limit subject (user id, else GitHub login, else
-- 'anon'), kept as its own column so the per-day cap is one indexed COUNT rather
-- than a COALESCE over three nullable columns.
--
-- Additive: nothing else reads these tables, so the currently deployed code is
-- unaffected during the deploy window.

CREATE TABLE IF NOT EXISTS feedback_reports (
  report_id    TEXT PRIMARY KEY,   -- the opaque id printed in the public issue
  created_at   TEXT NOT NULL,      -- ISO-8601 UTC
  kind         TEXT NOT NULL,      -- bug | idea | other
  summary      TEXT NOT NULL,      -- the issue title, for triage without leaving D1
  issue_number INTEGER,            -- NULL only if the row somehow outlives the API call
  issue_url    TEXT,
  reporter_key TEXT NOT NULL,      -- rate-limit subject
  user_id      TEXT,               -- app_users.id  (authjs path)
  email        TEXT,               -- reporter's email (authjs path). NEVER published
  gh_login     TEXT,               -- GitHub login (github identity path)
  org_id       TEXT,               -- resolved org, when there is one
  brain_id     TEXT                -- "owner/repo" of the active brain, when there is one
);

CREATE INDEX IF NOT EXISTS feedback_reports_reporter_idx
  ON feedback_reports (reporter_key, created_at);
