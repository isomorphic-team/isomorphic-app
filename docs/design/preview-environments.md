# Design: preview environments

Status: **proposed** (2026-08-10; updated 2026-08-18). The preview environment itself is not
built. `wrangler.template.jsonc` already carries `"preview_urls": true`, so the platform
capability is on; what is missing is an isolated place for a preview to run and a workflow to
put it there.

Two things changed on 2026-08-18, both from the versioned-deploy work in `deploy.yml`:

- **The blocking open question is answered, and the answer is yes.** This Worker gets preview
  URLs despite the Durable Object migrations array. That was the item that could have sunk the
  whole design; see Limitations below.
- **The promotion half is built.** `deploy.yml` runs `versions upload` and `versions deploy`
  instead of `wrangler deploy`, with a smoke check and an automated rollback. So the version
  machinery this design assumed now exists in production, and the remaining cost of previews is
  the isolated resources, not the workflow shape. See
  [`../ops/deploy-and-rollback.md`](../ops/deploy-and-rollback.md).

## The problem

Every automated gate this repo has answers a question that stops at the process boundary.
`pnpm test` covers the pure engines, `test:e2e-librarian` and `test:e2e-import` cover the write
path against a real store, and `test:ui` covers the app bundle in a real browser. All of it runs
offline, which is what makes it fork-safe, and offline is exactly what caps it.

`dev/README.md` states the resulting gap directly: the harness IS the host, so "the claude.ai
mount gap, the real iframe CSP, and the auth round trip stay invisible here." Those are not
peripheral. The product is an MCP App rendered by someone else's client, behind an OAuth flow we
do not control, and the only way to exercise that is to give a real host a real URL.

Today the only URL that exists is production. A change to the mount path, the CSP, the OAuth
bridge, or the `initialize` result is tested by merging it and watching prod.

## What the pipeline covers today

| Stage        | Trigger        | Covers                                                                                                             | Blind to                         |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `ci.yml`     | every PR       | codegen sync, typecheck, every golden battery, both e2e batteries, UI suite, prettier, D1 migrations apply locally | anything needing a real origin   |
| `deploy.yml` | push to `main` | D1 migrations `--remote`, version upload, smoke check, promote, automated rollback, behind the `production` gate   | pre-merge verification of either |

The `deploy.yml` row changed on 2026-08-18 (see Promotion below). It now checks a real origin,
which is the first thing in this pipeline that ever did, but only after the code has merged.
The blind spot this design exists to close is unchanged: verification before a merge.

The shape is good. `ci.yml` is deliberately secret-free so a fork PR gets the same signal a
maintainer's branch does, and `deploy.yml` holds everything that needs a token. A preview
environment has to fit that split rather than break it.

## What Cloudflare provides

Verified against the live docs and against `wrangler 4.85` locally on 2026-08-10.

`wrangler versions upload` uploads a new version of a Worker without deploying it, and every
version gets a public URL immediately. Two forms:

- **Versioned**: `<VERSION_PREFIX>-<WORKER_NAME>.<SUBDOMAIN>.workers.dev`, generated
  automatically, different on every upload.
- **Aliased**: `<ALIAS>-<WORKER_NAME>.<SUBDOMAIN>.workers.dev`, created with
  `--preview-alias <alias>`, stable across uploads. Requires wrangler 4.21.0 or later.

The flags that matter here, confirmed from `wrangler versions upload --help`:

```
--preview-alias   Name of an alias for this Worker version
--tag             A tag for this version
--message         A descriptive message for this version
--var             A key-value pair injected into the script as a variable
--secrets-file    Secrets to upload with the version (JSON or .env)
--keep-secrets    Secrets from previous deployments are not deleted
--dry-run         Compile without uploading
```

`--var` is the useful one: it overrides a `vars` entry per version without regenerating the
config, and the aliased URL is deterministic, so `PUBLIC_BASE_URL` can be set to the URL the
version is about to occupy.

`cloudflare/wrangler-action` supports `command: versions upload` and exposes a `deployment-url`
output, which is what a PR comment would carry.

## The trap: a preview URL is not a preview environment

A version runs against the bindings in the Wrangler config at upload time. `wrangler.jsonc`
holds one D1 database id and one KV namespace id, and secrets are per Worker, not per version.
So uploading a preview version of the production Worker produces a second hostname in front of:

- the production `orgs`, `memberships`, `brains`, `brain_memberships`, and `usage_daily` tables;
- the production OAuth grants and tokens in `OAUTH_KV`;
- the production GitHub App installation, meaning writes land in real brain repos owned by real
  organizations;
- `FEEDBACK_TOKEN`, meaning a preview can file issues into the public tracker.

That is production with a different DNS name. The whole point of the preview is to run
unreviewed code, so it has to be pointed somewhere else.

## The design

### One preview Worker, not one per pull request

Stand up a second, long-lived Worker with its own resources:

| Resource      | Production           | Preview                           |
| ------------- | -------------------- | --------------------------------- |
| Worker        | (deployment's name)  | `<name>-preview`                  |
| D1            | `platform-db`        | `platform-db-preview`             |
| KV            | `OAUTH_KV` (prod id) | a second namespace                |
| GitHub App    | platform App         | a separate App on a throwaway org |
| Resend domain | production sender    | may be the same verified domain   |

Every pull request then gets a **version alias on that one Worker**, not a Worker of its own:
`pr-123-<name>-preview.<subdomain>.workers.dev`. Aliases are free, stable across pushes to the
branch, and Cloudflare retains the 1000 most recent, so nothing needs cleaning up at this
repository's rate.

`main` additionally uploads a `staging` alias, which is the stable origin that owns anything
requiring external registration.

### The preview profile is a set of variables, not a second config file

`wrangler.jsonc` is already generated from environment variables by `scripts/setup-config.ts`,
and that is what makes this cheap. A preview profile is the same template resolved from
`PREVIEW_`-prefixed repository variables, mapped to the canonical names in the workflow step:

```yaml
env:
  WORKER_NAME: ${{ vars.PREVIEW_WORKER_NAME }}
  CF_D1_DATABASE_ID: ${{ vars.PREVIEW_CF_D1_DATABASE_ID }}
  CF_OAUTH_KV_ID: ${{ vars.PREVIEW_CF_OAUTH_KV_ID }}
  D1_DATABASE_NAME: ${{ vars.PREVIEW_D1_DATABASE_NAME }}
  AUTH_MODE: oauth
  IDENTITY_MODE: authjs
  AUTO_PROVISION: 'true'
  USAGE_ANALYTICS: 'true'
  PUBLIC_BASE_URL: https://pr-${{ github.event.number }}-<worker>.<subdomain>.workers.dev
run: pnpm setup:config --force
```

No new file, no new mechanism, no branch in the code. This is the same reason
`docs/design/open-source-boundary.md` gives for generating the config in the first place: a
deployment's identity is values, and a second deployment is a second set of values.

`SETTINGS` in `scripts/setup-config.ts` needs no new entries. Every value above is already a
token in the template.

### The preview runs `authjs`, matching production

`AUTH_MODE=oauth` with `IDENTITY_MODE=authjs` is what production runs, and it is the only
configuration that registers the org tools at all: `hasOrgModel` gates `registerMemberTools`,
`registerConnectedAccountTools`, `registerOrgOnboardingTools`, and the `analytics` tool. A
`static` preview would silently exclude members, sharing, analytics, and onboarding from
everything the preview can show.

This works on a per-PR origin because Auth.js magic-link callbacks are served by the Worker
itself and Claude registers as an OAuth client via DCR. Neither needs a URL registered anywhere
in advance. The exception is below.

### Workflow shape

A new `.github/workflows/preview.yml`, `on: pull_request`:

1. **Guard.** Skip with a warning (green, not red) when the `PREVIEW_*` variables or the
   Cloudflare token are unset, exactly as `deploy.yml` guards today. A fork of this repository
   must not see a red check for infrastructure it does not have.
2. **Fork guard.** Skip when `github.event.pull_request.head.repo.full_name !=
github.repository`. Secrets are unavailable to fork PRs by design, so the job can only fail
   there. Do not reach for `pull_request_target` to work around this: it runs the base branch's
   workflow with secrets against the fork's code, which hands any contributor the preview
   Worker's credentials.
3. **Generate the preview config** (above).
4. **Apply D1 migrations to the preview database.** `versions upload` does not run migrations.
   Same schema-first ordering as `deploy.yml`.
5. **Upload the version**, aliased to the PR:
   ```sh
   wrangler versions upload \
     --preview-alias "pr-${PR_NUMBER}" \
     --message "PR #${PR_NUMBER}: ${COMMIT_MESSAGE}" \
     --tag "${GITHUB_SHA}"
   ```
6. **Smoke check** the resulting origin (below).
7. **Comment on the PR** with the connector URL, updating the existing comment rather than
   appending one per push.

### The smoke check is the part that makes this CI rather than a link

A preview URL nobody opens verifies nothing. Three assertions, all scriptable, all against the
origin the workflow just created:

- `GET /health` returns `200 ok`. The endpoint already exists in `src/worker.ts`.
- `POST /mcp` without credentials returns `401` carrying a `WWW-Authenticate` header. This is a
  liveness check on the OAuth surface: it proves the provider is mounted and the version booted,
  which is what actually breaks when a binding id is wrong.
- `GET /.well-known/oauth-protected-resource/mcp` and the authorization server metadata parse and
  are self-consistent, so a host can begin a connection.

A full authenticated `initialize` plus `tools/list` needs a magic-link round trip and is not
worth scripting. That is what the human paste-into-Claude step is for.

**What the smoke check cannot catch:** a wrong `PUBLIC_BASE_URL`.
`@cloudflare/workers-oauth-provider` builds the resource metadata URL from `url.origin` of the
incoming request, not from the configured base URL, so those responses are correct on any
hostname whatever the config says. `PUBLIC_BASE_URL` is read where there is no request to derive
an origin from: the connected-accounts tools building the `/link/start` verification URL, and
`src/manifest.ts`. A preview whose `PUBLIC_BASE_URL` still points at production therefore passes
every assertion above and then emails a tester a link into prod. Either assert it separately by
reading it back out of a tool response, or accept it as a known hole and keep the value derived
from `github.event.number` in one place.

### Promotion (built 2026-08-18, ahead of the rest of this design)

This section proposed that `deploy.yml` could upload a version and promote it with `wrangler
versions deploy` rather than calling `wrangler deploy`, and said it belonged in a separate
change because it touches the one workflow protecting production. It was done as that separate
change, and it landed first, because the value did not depend on previews existing: the
automated rollback was worth having on its own.

What shipped: record the live version, `versions upload`, smoke check the version's preview URL,
`versions deploy <id>@100%`, smoke check production, and roll back to the recorded version if
that fails. The assertions live in `scripts/smoke.ts` and are covered by `pnpm test:smoke`.

Two consequences for this design:

- **The pre-promotion smoke check is the same idea as a preview, aimed at production.** It reuses
  the preview-URL mechanism described above, which is how the `has_preview` question got settled
  without standing up any of the infrastructure below.
- **`scripts/smoke.ts` is reusable as-is for step 6 of the workflow shape.** It takes a base URL
  and asserts nothing about which deployment it is talking to, so the preview workflow should
  call it rather than growing a second copy of the same four assertions.

Gradual rollout (`@10%` then `@100%`) is available and deliberately not used: with traffic split,
a smoke request hits a random version, so the check becomes probabilistic and can pass while the
bad version is live.

## Setup cost

None of this can be created from a workflow. Before the workflow does anything:

**Cloudflare** (one time): a D1 database, a KV namespace, and a Worker name. `pnpm setup:config
--provision` already creates the first two and fills in the ids; `--print-ci` already prints the
`gh variable set` commands, and would need the `PREVIEW_` prefix applied.

**GitHub App** (one time): a separate App installed on a throwaway organization. Sharing the
production App is not an option, because a preview holding the production installation can write
to real brains. The preview App needs the same permissions as `src/manifest.ts` declares,
including `administration: write`, which means installing on an **organization**, never a personal
account.

**Preview Worker secrets**, set once via `wrangler secret put --name <preview-worker>`:

```
GITHUB_APP_ID  GITHUB_APP_PRIVATE_KEY_BASE64
GITHUB_APP_CLIENT_ID  GITHUB_APP_CLIENT_SECRET
PLATFORM_ORG  PLATFORM_INSTALLATION_ID
AUTH_SECRET  AUTH_RESEND_KEY
```

**Deliberately unset on preview:** `FEEDBACK_REPO` and `FEEDBACK_TOKEN`. Unset means
`submit_feedback` is not registered, so an unreviewed branch cannot file issues into the public
tracker. `MCP_BEARER_TOKEN`, `GITHUB_TOKEN`, `BRAIN_REPO_OWNER`, and `BRAIN_REPO_NAME` are
static-mode only and are not read here.

**GitHub environment**: a `preview` environment holding `CLOUDFLARE_API_TOKEN` scoped to the
preview resources, so the preview job cannot reach the production token and vice versa. The
token needs D1 edit permission for step 4, for the reason `deploy.yml` documents at length.

## Limitations that come from Cloudflare, not from this design

Verified against the Preview URLs docs on 2026-08-10.

- **No logs.** "You cannot view logs for Preview URLs today, this includes Workers Logs, Wrangler
  tail and Logpush." A preview that misbehaves has to be diagnosed from response bodies. This is
  the single largest weakness of the whole approach and it has no workaround short of promoting
  the version onto a real deployment.
- **workers.dev only.** No custom domain on a preview URL.
- **No Durable Objects. RESOLVED 2026-08-18: this Worker is clear.** "Preview URLs are not
  generated for Workers that implement a Durable Object." This repository binds no DO and exports
  no DO class, but `wrangler.template.jsonc` still carries the append-only `migrations` array
  declaring `IsomorphicMindMcp` as new in `v1` and deleted in `v2`, and whether Cloudflare's check
  keys off the bindings or off that array decided whether this design was possible at all.

  It keys off the bindings. Cloudflare returns the verdict per version as `metadata.has_preview`,
  and it is `true` on every version from number 77 onward, which is when `preview_urls: true`
  entered the config. No scratch Worker was needed; the answer was already sitting in the version
  list:

  ```sh
  pnpm exec wrangler versions list --json | jq '[.[] | {number, preview: .metadata.has_preview}]'
  ```

  **Adding a Durable Object binding takes this away silently**, so the preview workflow should
  read `preview_url` off the upload output and say so when it is absent, exactly as `deploy.yml`
  does, rather than assuming a URL it was given last time.

- **Alias naming:** lowercase letters, numbers, dashes, beginning with a letter, and alias plus
  Worker name under 63 characters. `pr-123-isomorphic-mcp-preview` is 29.
- **1000 most recent aliases retained.** No cleanup job needed.

## What this does not cover

- **Schema races between open pull requests.** All PR aliases share the one preview D1, so two
  open branches carrying different migrations apply both to the same database, in merge order,
  and a migration that is not backward compatible breaks the other branch's preview. Prod already
  requires additive, expand-then-contract migrations for the deploy window, so this mostly
  enforces a rule that already exists, but it will produce confusing preview failures when
  someone breaks it. A database per PR was rejected: D1 creation is slow, account-limited, and
  would need a teardown job that is itself a source of failures.
- **Repo accumulation.** `AUTO_PROVISION=true` means every tester who signs into a preview gets a
  `brain-<login>` repo created in the throwaway org, permanently. Wants a scheduled cleanup, which
  does not exist.
- **The GitHub App install flow.** `connect_github_org` builds an install URL and GitHub sends the
  admin back to the App's fixed Setup URL, which can only be one origin. That flow is testable on
  the `staging` alias and not on per-PR aliases.
- **Anything a browser test already covers.** This is not a replacement for `test:ui`, which is
  faster, offline, and fork-safe. The preview covers the layer above it.
- **Cost.** A second D1, a second KV namespace, and a second Worker on the account.

## Separate from this design: CI gaps that need no infrastructure

Found while reading `ci.yml` on 2026-08-10. Independent of everything above, and cheaper.
The first two were done on 2026-08-18 alongside the promotion work; the last two are still open.

- ~~**Playwright traces are captured and discarded.**~~ **Done 2026-08-18.** `playwright.config.ts`
  set `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'` while `ci.yml` uploaded no
  artifact, so the runner was destroyed with the evidence on it and a UI failure reported that it
  failed and nothing about why. `ci.yml` now uploads on `if: failure()`, and the html reporter was
  added under CI so the artifact is browsable rather than a directory of raw traces.
- ~~**Chromium is downloaded on every run.**~~ **Done 2026-08-18**, cached on the resolved
  Playwright version rather than a lockfile hash, so an unrelated dependency bump does not evict a
  browser that is still correct.

  Worth knowing for anything else that touches this step: the cache does **not** help the half
  that actually broke. On 2026-08-18 CI on this very pull request hung for 32 minutes inside
  `playwright install --with-deps`, and the cause was `apt-get` losing an Ubuntu mirror, not the
  browser download. `--with-deps` couples a flaky root apt call to a reliable CDN fetch; they were
  split, each attempt bounded by `timeout` and retried, with `timeout-minutes` on both jobs.
  apt has no timeout of its own, and neither workflow had one, so the step would have run to
  GitHub's six-hour default.

  **Superseded 2026-08-19 (issue #44).** Retrying a bad mirror made the step survivable, not fast:
  a degraded day still turned a 3 minute run into a 7 minute one. The UI tests moved to their own
  job running in `mcr.microsoft.com/playwright:v<version>-noble`, where the system libraries and
  the browser are both baked in, so apt never runs and neither the download step nor the cache
  above exists any more. `pnpm test:wiring` pins the image tag to the resolved Playwright version.
  The other half of that split is what the fast checks buy: typecheck, prettier, the golden tests
  and the migration check no longer wait behind a browser to report.

- **`test:e2e-librarian --github` runs nowhere automatic.** Still open. It is the only coverage of
  the GitHub adapter itself, and it is maintainer-run by hand. A nightly schedule, or a
  `run-github-e2e` label, would gate `githubStore` changes without touching fork safety.
- **No path to regenerate Linux visual baselines.** Still open, and smaller than it was. The
  Docker incantation in `dev/README.md` now names the same image the UI job runs in, so a baseline
  captured that way is captured against the browser and fonts that will compare it. What is still
  missing is automation: a `workflow_dispatch` job running `pnpm ui:baselines` and committing the
  result, so nobody has to have Docker to refresh them.

## Open questions

1. ~~Does the append-only `migrations` array disqualify this Worker from preview URLs? Blocking;
   test first.~~ **Answered 2026-08-18: no.** Cloudflare keys off the bindings, and reports the
   verdict per version as `metadata.has_preview`, true on every version since number 77. This was
   the question that could have ended the design, so it is worth being precise about what it does
   and does not license: preview URLs exist for this Worker, which is necessary for the plan above
   and not sufficient for any of it. Everything in Setup cost is still unbuilt.
2. Does the preview Worker justify a second Resend sending domain, or does it share production's
   verified domain with a different From address? **Still open.**
3. ~~Should `deploy.yml` move to `versions upload` plus `versions deploy` so the shipped artifact
   is the previewed artifact, or stay on `wrangler deploy`?~~ **Answered 2026-08-18: it moved**,
   and shipped ahead of this design. See Promotion above.
4. Is `AUTO_PROVISION=true` right for preview, given it silently accumulates repositories, or
   should preview be invite-only with one seeded test org? **Still open**, and now the largest
   unanswered question here, since it is the one that decides whether the preview environment
   needs a cleanup job on day one.
