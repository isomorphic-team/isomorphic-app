---
paths:
  - "wrangler.template.jsonc"
  - "scripts/{setup-config,smoke,test-smoke,regen-pr,doctor}.ts"
  - "src/persist.ts"
  - ".github/workflows/**"
  - ".github/dependabot.yml"
  - ".github/codeql/**"
  - "migrations/**"
---

# Deployment config, deploys, and dependency scanning

Runbooks: `docs/ops/deploy-and-rollback.md`, `docs/ops/d1-migrations.md`.

## Secrets and config

- `.dev.vars` is the local source of truth (Wrangler's own filename, reused by `worker:dev`).
  Bootstrap writes it via `src/persist.ts`; `loadDevVarsIntoEnv()` lifts keys into
  `process.env` for Node. Claude's `Read` of it is denied in `.claude/settings.json`.
- The Worker reads the same keys from `Env`. Production secrets go in via `wrangler secret put`.

## `wrangler.jsonc` is GENERATED

`wrangler.jsonc` is **gitignored and generated** from the committed `wrangler.template.jsonc`
by `pnpm setup:config` (`scripts/setup-config.ts`). Never edit it (it is overwritten, and
the PreToolUse hook refuses the edit); never commit it (it is one deployment's identity).

- **Why:** Wrangler will not interpolate env vars into resource bindings, so a config carries
  literal KV/D1 ids. Committed, they leak one deployment's identity and send every fresh clone's
  `wrangler deploy` into "namespace not found".
- **How:** every deployment-specific value is a `__DOUBLE_UNDERSCORE__` token resolved from
  `process.env` → `.dev.vars` → a local default. `SETTINGS` in `scripts/setup-config.ts` is the
  single list; a template token missing from it is a hard error. Substitution is split/join,
  not `String.replace` (the `$&` gotcha).
- **Local ids are fake on purpose:** Miniflare never resolves them, so the default profile needs
  no Cloudflare account. `--provision` creates the real KV namespace and D1 database;
  `--print-ci` emits the `gh variable set` commands.
- **CI:** `ci.yml` runs `pnpm setup:config` with no secrets (fork PRs stay green). `deploy.yml`
  regenerates from repository **variables** and **skips with a warning** if
  `CF_OAUTH_KV_ID`/`CF_D1_DATABASE_ID` are unset rather than deploying template defaults.
- **Don't hardcode our deployment anywhere.** `src/manifest.ts` takes the OAuth callback origin
  as an argument (`PUBLIC_BASE_URL`); the install-callback page derives its host from the request.

## Template rules

- **No `routes` block, ever.** Custom domains are bound in the Cloudflare dashboard. A `routes`
  entry with `custom_domain: true` makes `wrangler dev` rewrite `request.url`'s host and breaks
  the OAuth provider's host-based routing.
- The DO `migrations` array (`v1` new / `v2` deleted `IsomorphicMindMcp`) is **append-only** by
  Cloudflare's rules. Neither entry may be removed. There is no Durable Object binding.

## Deploys are versioned, and roll themselves back

`deploy.yml` does **not** call `wrangler deploy` (it uploads and routes traffic in one step,
leaving nothing to fall back to). It records the live version id, `versions upload`s (no
traffic), smoke checks the version's preview URL, `versions deploy <id>@100%`, smoke checks
production, and on failure `wrangler rollback`s to the recorded id and fails red. Migrations
apply in the step before, schema first.

- **The checks live in `scripts/smoke.ts`, pinned by `pnpm test:smoke`.** They decide whether a
  merge stays in production, and fail expensively in both directions. Five unauthenticated
  reads: `/health`; an unauthenticated `POST /mcp` that must be `401` with a Bearer challenge;
  both OAuth metadata documents pointing back at the serving origin; and a signed-out `GET /b/`
  that must redirect to sign-in on the same origin, or 404.
- **A rollback reverts CODE, never SCHEMA.** Migrations must stay additive (renames and drops go
  expand-then-contract) so the previous version is runnable at any moment. Remote migrations run
  only in `deploy.yml`; the PreToolUse hook refuses them from a session.
- **The pre-promotion smoke depends on preview URLs,** which Cloudflare withholds from Workers
  implementing a Durable Object (`metadata.has_preview`). This Worker has them today. **Adding a
  Durable Object binding would silently drop the pipeline onto promote-then-roll-back**, where a
  bad version serves real traffic during the smoke. The workflow warns rather than failing.
- **Nothing catches a wrong `PUBLIC_BASE_URL`:** the OAuth provider builds metadata from the
  request origin, so every check passes on any hostname.

## Dependency and code scanning

- **Dependabot** (`.github/dependabot.yml`): weekly npm, monthly actions, GROUPED (production
  minor/patch, development, security, actions); majors stay individual. `package-ecosystem: npm`
  is correct for pnpm.
- **CodeQL** (`.github/workflows/codeql.yml` + `.github/codeql/codeql-config.yml`) runs the
  `security-and-quality` suite. **Do not enable CodeQL default setup in the repository
  settings**: it takes over and runs the narrower `default` suite, silently dropping the quality
  rules. The config excludes `src/lib/app-bundle.generated.ts`.
- **`pnpm security:audit`** runs in ci.yml as a `continue-on-error` reporting step; `--prod`
  drops the wrangler/miniflare subtree. Drop `continue-on-error` once the tree is clean.
- Snyk was not adopted: it needs an account and token that a fork cannot have.

**A Dependabot PR that bumps a BUNDLED dependency always fails CI** ("Generated artifacts in
sync"), because `pnpm gen:app` inlines what the app imports (`zod`, `marked`, and more) and
Dependabot does not run repository code. A maintainer regenerates with `pnpm regen:pr <number>`
(the `regen-pr` skill). It is deliberately not a workflow: it would bundle an unreviewed
version with a write token at a bot's say-so, and a `GITHUB_TOKEN` push does not re-trigger
checks anyway.
