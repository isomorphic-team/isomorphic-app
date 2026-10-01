# Design: preview environments

Status: **in implementation** (2026-10-01). `.github/workflows/preview.yml` and
`scripts/preview.ts` are built and pinned by `pnpm test:preview`. The workflow skips green
until the [one-time setup](#setup-one-time) exists, so the first live run is the remaining
step, and the items under [Unverified until the first run](#unverified-until-the-first-run)
are what it settles.

This replaces the 2026-08 design, which planned version aliases (`wrangler versions upload
--preview-alias`) on a second Worker. Cloudflare has since shipped
[Worker Previews](https://developers.cloudflare.com/workers/previews/) (open beta), which do
the same job with per-preview secrets, deletion and logs; see
[Why Worker Previews](#why-worker-previews-and-not-version-aliases).

## The problem

Every automated gate in `ci.yml` is offline, which is what makes it fork-safe and what caps
it. The local harnesses are the host, so the claude.ai mount, the real iframe CSP, the OAuth
round trip, and the web app's session cookie stay invisible to them. Before this, the only
real origin was production, so a change to any of those was tested by merging it.

A preview gives each pull request a real origin with a real sign-in, where a reviewer opens
`/b` in a browser or connects a host to `/mcp`, before the merge.

## How it works

Each pull request gets a Worker Preview named `pr-<number>` on a dedicated **preview
Worker**, served at `https://pr-<number>-<preview worker>.<subdomain>.workers.dev`.

| Resource   | Production              | Preview                                          |
| ---------- | ----------------------- | ------------------------------------------------ |
| Worker     | (the deployment's name) | `PREVIEW_WORKER_NAME`, hosting every Preview     |
| D1         | `platform-db`           | `<PREVIEW_D1_DATABASE_NAME>-pr-<number>`, per PR |
| KV         | `OAUTH_KV`              | one shared preview namespace                     |
| Secrets    | the production Worker's | the preview Worker's Previews base config        |
| GitHub App | the platform App        | a separate App on a throwaway organization       |
| Feedback   | `FEEDBACK_TOKEN` set    | unset, so `submit_feedback` is not registered    |

`preview.yml` runs three jobs, and the split is the security model:

1. **`resolve`** decides whether to preview and which commit. A same-repository pull
   request is previewed on every push. A fork is not (below).
2. **`build`** checks out the pull request, installs, regenerates, and bundles with
   `wrangler versions upload --dry-run --outdir`. It references no secret, has a read-only
   token, and keeps no git credential. Its artifact is `worker.js` and `migrations/*.sql`.
3. **`deploy`** holds the Cloudflare token and runs only its own checkout's code. It ensures
   the pull request's D1 database, generates the preview's config (below), applies the
   branch's migrations to that database, runs `wrangler preview <worker.js>`, smoke checks
   the result with `scripts/smoke.ts`, and edits one comment on the pull request carrying the
   web URL and the connector URL.

A fourth job, **`cleanup`**, runs on `pull_request_target: closed`, checks out the base branch
only, and deletes the Preview and its database.

### The config

A Preview inherits no vars and no bindings: `wrangler preview` reads only the config's
`previews` block, which is one per Worker. `deploy` generates `wrangler.jsonc` from the
preview profile with `pnpm setup:config` (the `PREVIEW_*` variables mapped onto the usual
names, with `AUTH_MODE=oauth` and `AUTO_PROVISION=true`), and `scripts/preview.ts config`
copies its vars and bindings into `previews`, writing `wrangler.preview.json`.
`pnpm test:preview` fails if the template gains a binding kind the block does not carry.

`PUBLIC_BASE_URL` is set to the planned origin before the deploy. Cloudflare does not document
how a Preview's hostname is derived from its name, so `deploy` reads the origin wrangler
reports and, if it differs, redeploys once with `--var PUBLIC_BASE_URL:<actual>`.

### Forks

A fork's `pull_request` run has no secrets, so it stops in `resolve` with a notice. Previewing
it is a maintainer's decision, because a Preview's secrets (the preview App key, `AUTH_SECRET`,
the Resend key) are readable by the code it runs. After reading the diff:

```sh
gh workflow run preview.yml -f pr=<number> -f sha=$(gh pr view <number> --json headRefOid -q .headRefOid)
```

The `sha` input pins the commit that was read; a push after the review is not deployed.
`build` runs the fork's code without secrets exactly as for any pull request.
`pull_request_target` is never used for the build: it would run the fork's code with
secrets.

## Decisions

### Why Worker Previews and not version aliases

Version aliases share the Worker's secrets with production when they live on the production
Worker, so the 2026-08 design needed a second Worker for isolation anyway. Worker Previews
on that second Worker add what aliases lack:

- **Secrets per Preview**, copied from the base config when the Preview is created.
- **Deletion.** An alias can only age out of the 1000-alias cap; a Preview is deleted on
  close, with its database.
- **Logs.** Previews support Workers Logs and traces in the dashboard (each Preview's
  Observability tab). Version URLs support none, which the old design named its largest
  weakness. `wrangler tail` still does not target Previews.

The cost is the beta: the command surface may change, and the gaps below are undocumented.

### A dedicated preview Worker, not Previews on production

Previews do not inherit production's secrets or bindings and take no production routes, so
hosting them on the production Worker would be isolated at runtime. The token is the reason
not to: a token that can deploy Previews to the production Worker can deploy the production
Worker, and anyone with write access can change `preview.yml` to use it. A token scoped to a
dedicated Worker (Cloudflare's per-Worker "Specified Workers" tokens, 2026-09-15) cannot
touch production's code.

D1 permissions are still account-wide, so a preview token with D1 edit can reach production's
database in the same account. **A separate Cloudflare account for previews closes that**, and
is the recommended setup. In the same account, the exposure is to people with write access to
this repository, never to a fork's code, which only runs in `build`.

### One database per pull request

Cloudflare provisions no D1 for a Preview, and two Previews sharing a `database_id` share
rows. A shared preview database would also carry every open branch's migrations at once, and
one branch's schema change would break the others. D1 allows 10 databases on Workers Free and
50,000 on Paid, so a preview account on Free supports nine open previews alongside its base.

KV is shared. OAuth grants in it are bound to each Preview's own origin, so a token from one
Preview is refused by another.

### `AUTO_PROVISION=true`, accepting the accumulation

An invite-only preview means every reviewer is invited by hand first. Auto-provisioning lets a
reviewer open `/b`, sign in, and reach the create-your-first-brain state, which is the path a
new customer takes. Brain repositories accumulate in the throwaway organization; deleting the
pull request's database does not delete them.

## What the smoke check covers

`scripts/smoke.ts`, the same five assertions the production deploy runs: `/health`, the `/mcp`
Bearer challenge, both OAuth metadata documents pointing at the Preview's origin, and a
signed-out `/b/` refused. A failure marks the run red and says so in the comment; the Preview
stays up for diagnosis.

It cannot see a wrong `PUBLIC_BASE_URL`, because the OAuth provider is built per request origin
(`src/lib/oauth-provider.ts`). The read-back in `deploy` is what keeps that value right.
Anything behind sign-in is the reviewer's step.

## Setup (one time)

None of this can be created from a workflow. Use a separate Cloudflare account if possible.

1. **The preview Worker.** Choose a name short enough that `pr-<number>-<name>` stays under
   63 characters. Create its own database (`wrangler d1 create <PREVIEW_D1_DATABASE_NAME>`),
   then create the Worker with one `wrangler deploy` from a checkout whose `pnpm setup:config`
   used the preview profile and that database. That deploy also applies `preview_urls: true`
   from the template, which Previews need for a workers.dev URL.
2. **KV.** `wrangler kv namespace create` once; its id is `PREVIEW_CF_OAUTH_KV_ID`.
3. **A GitHub App for previews**, installed on a throwaway **organization** (the App needs
   `administration: write`, as `src/manifest.ts` declares). Never the platform App: a Preview
   holding it could write to real brains.
4. **Base-config secrets** on the preview Worker, copied into every new Preview:
   ```sh
   for k in GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY_BASE64 GITHUB_APP_CLIENT_ID \
            GITHUB_APP_CLIENT_SECRET PLATFORM_ORG PLATFORM_INSTALLATION_ID \
            AUTH_SECRET AUTH_RESEND_KEY; do
     wrangler preview base-config secret put "$k" --worker-name <preview worker>
   done
   ```
   Leave `FEEDBACK_REPO` and `FEEDBACK_TOKEN` unset.
5. **A Cloudflare API token**: Workers, scoped to the preview Worker only, Editor role; plus
   Account D1 Edit. An account API token (per-Worker scoping exists only there);
   setting `CLOUDFLARE_ACCOUNT_ID` below keeps wrangler from the `/memberships` lookup that
   makes `deploy.yml` need a user token.
6. **A GitHub environment named `preview`**, with no branch restriction (pull request runs
   use their merge ref), holding the token:
   ```sh
   gh secret set CLOUDFLARE_API_TOKEN --env preview
   gh secret set CLOUDFLARE_ACCOUNT_ID --env preview
   ```
7. **Repository variables**:
   ```sh
   gh variable set PREVIEW_WORKER_NAME --body <preview worker>
   gh variable set PREVIEW_WORKERS_SUBDOMAIN --body <account subdomain, without .workers.dev>
   gh variable set PREVIEW_D1_DATABASE_NAME --body platform-db-preview
   gh variable set PREVIEW_CF_OAUTH_KV_ID --body <kv id>
   gh variable set PREVIEW_AUTH_EMAIL_FROM --body "Isomorphic Preview <preview@your-domain>"
   gh variable set PREVIEW_APP_SLUG --body <preview app slug>
   ```
   The sending domain may be production's; a distinct From address shows a reviewer which
   deployment mailed them.

## Unverified until the first run

Cloudflare's docs leave these open. Each has a visible failure, not a silent one:

- **Whether a Preview's hostname is `<name>-<worker>`.** The read-back corrects a mismatch and
  warns.
- **Whether a Preview keeps its secrets across redeploys.** The docs say base secrets are
  copied on create; a redeploy that dropped them would fail sign-in and, most likely, the
  `/b/` smoke assertion.
- **Whether a per-Worker Editor token can create and delete Previews.** If not, the deploy
  step fails with a permission error, and the token needs account-level Workers Scripts Edit,
  which is the stronger reason for a separate account.
- **That `WRANGLER_OUTPUT_FILE_DIRECTORY` carries a `preview` entry with `preview_urls`.** The
  wrangler source writes one; `scripts/preview.ts preview-url` fails loudly if it is absent.
- **Pricing.** Unstated; presumably ordinary Workers usage.

## Limitations

- **Open beta.** A wrangler bump can change `wrangler preview`; `pnpm test:preview` pins only
  this repository's side, so the first preview run after such a bump is the check.
- **100 Previews per Worker on Free, 500 on Paid**; the least recently deployed is evicted.
- **A migration edited after it was applied** is not re-run on that pull request's database
  (D1 tracks applied migrations by name). Close and reopen the pull request to start clean.
- **Fork previews are built from the fork's code but configured by the base branch's**
  template, so a fork that adds a binding previews without it.

## The manual version preview

The fallback for looking at a branch against **production** data, which a Preview never sees.
It is a version of the production Worker, uploaded with `wrangler versions upload` and never
promoted, so it serves no traffic and has a preview URL. **It shares production's bindings**,
so it is wrong as a place to run arbitrary code and acceptable for one narrow purpose:

- **A maintainer only**, signing in **as themselves**, for **read-only use**. Every write the
  web app makes is a real commit to a real brain. Do not create a brain or invite anyone.
- **Never promoted.**
- **Run `scripts/smoke.ts` against it first.**

```sh
eval "$(gh variable list --json name,value --jq '.[] | "export \(.name)=\(.value)"')"
pnpm setup:config --force && pnpm gen:templates
pnpm exec wrangler versions upload --tag "pr<N>-<sha>" --message "PR #<N> manual preview"
pnpm exec tsx scripts/smoke.ts https://<version>-<worker>.<subdomain>.workers.dev
rm wrangler.jsonc   # it carries production ids; never leave it in a checkout
```
