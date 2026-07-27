# D1 migrations (CI-managed)

Prod schema changes ship **through CI**, the same way code does — no one runs
`wrangler ... --remote` by hand. This is the wrangler D1 migrations framework.

## How it works

- Migrations live in `migrations/` (`migrations_dir` in `wrangler.jsonc`), numbered
  `NNNN_<name>.sql`. `migrations/0001_init.sql` is the **baseline** — a snapshot of the full
  current schema, all `CREATE ... IF NOT EXISTS`.
- Wrangler tracks applied migrations in a `d1_migrations` table on the DB, so each runs
  **once**. Applying is idempotent.
- **Deploy pipeline** (`.github/workflows/deploy.yml`, on push to `main`): `wrangler d1
migrations apply platform-db --remote` runs **before** `wrangler deploy` — schema first, then
  the code that depends on it. If the migration fails, the deploy is skipped and `main` stays on
  the old code.
- **PR CI** (`.github/workflows/ci.yml`): applies migrations against a fresh **local** DB
  (offline, no token, never touches prod) to catch malformed SQL before merge.
- `src/db/*.sql` remain as human-readable reference; `migrations/0001_init.sql` is canonical.

## Add a migration

```sh
pnpm db:migrate:new add-something     # creates migrations/000N_add-something.sql
# edit the file — additive/backward-compatible (see below)
pnpm db:migrate                       # apply to your LOCAL db
pnpm db:migrate:list                  # sanity-check what's applied / pending
```

Then open a PR. On merge to `main`, CI applies it to prod and deploys. **Do not run
`--remote` yourself.**

## Rules

- **Backward-compatible only.** Migration applies just before the deploy, so the _still-running
  old code_ must tolerate the new schema during the deploy window. Additive columns/tables are
  safe. Renames/drops need **expand → (deploy) → contract** across two migrations.
- **No auto-rollback.** D1 doesn't roll back a failed migration — keep them small.
- Never edit an already-applied migration; add a new one.

## One-time setup (owner)

The CI `CLOUDFLARE_API_TOKEN` (repo secret) needs **D1 edit** permission in addition to Workers.
In the Cloudflare dashboard → My Profile → API Tokens, edit the token used for
`isomorphic-mind-mcp` to include **D1 → Edit** (or recreate it from a template that covers
Workers + D1), then update the `CLOUDFLARE_API_TOKEN` repo secret if it changed. Until then, the
migrate step is gated by the same token guard as the deploy — it skips (green) with a warning if
the token is absent, but will **fail** if the token exists without D1 permission. The baseline
itself needs no manual "mark applied" step: `0001_init` is all `IF NOT EXISTS`, so its first
`apply --remote` no-ops against the already-populated prod DB and records itself.
