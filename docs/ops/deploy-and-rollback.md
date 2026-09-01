# Deploying, and undoing a deploy

How a merge to `main` reaches production, what happens when it should not have, and the
drill to run before the human approval gate comes off.

The workflow is [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml); the
checks it runs are [`scripts/smoke.ts`](../../scripts/smoke.ts), covered offline by
`pnpm test:smoke`.

## The sequence

`wrangler deploy` does two things at once: it uploads code and it points traffic at it.
Splitting them is what makes an automated rollback possible, so the job does this instead:

| Step | Command                        | If it fails                                      |
| ---- | ------------------------------ | ------------------------------------------------ |
| 1    | `d1 migrations apply --remote` | nothing else runs; prod stays on the old code    |
| 2    | `deployments status --json`    | warns; a later failure goes red without rollback |
| 3    | `versions upload`              | nothing has taken traffic; run goes red          |
| 4    | `smoke.ts <preview url>`       | **stops before promoting**; nothing to undo      |
| 5    | `versions deploy <id>@100%`    | run goes red, prod stays on the old version      |
| 6    | `smoke.ts <production url>`    | triggers step 7                                  |
| 7    | `rollback <recorded id>`       | re-checked, and the run goes red either way      |

Step 2 records the rollback target before anything changes, so the job never has to work
out where to return to from inside a failure.

Step 4 is the one worth having. A version that cannot boot is caught while it is serving
nobody, and no rollback is needed because no rollout happened.

It runs only when Cloudflare issues a preview URL for the version, reported on the upload as
`metadata.has_preview`. **This Worker gets them.** Preview URLs are not issued for Workers
that implement a Durable Object, and this repo still carries the append-only `migrations`
array naming the deleted `IsomorphicMindMcp` class, which raised the question of whether
that array alone disqualifies it. It does not: Cloudflare keys off the bindings, and every
version from number 77 onward (when `preview_urls: true` entered the config) reports
`has_preview: true`. Confirmed on 2026-08-18 with:

```sh
pnpm exec wrangler versions list --json | jq '[.[] | {number, preview: .metadata.has_preview}]'
```

The job still branches on the answer per run rather than assuming it, because the
disqualifying condition is a binding away: adding a Durable Object would silently drop the
pipeline onto the promote-then-roll-back path. It warns when that happens instead of going
quiet.

## What the checks assert

All five are unauthenticated reads, safe against any origin including one sharing
production's bindings:

- `GET /health` returns exactly `200 ok`. The Worker booted.
- `POST /mcp` with no credentials returns `401` with a `Bearer` `WWW-Authenticate` header.
  The OAuth provider is mounted **and refusing**. A `2xx` here means an unauthenticated
  caller just reached the tools, which is the most expensive thing this suite can catch.
- `/.well-known/oauth-protected-resource/mcp` names this origin as the resource and its own
  authorization server.
- `/.well-known/oauth-authorization-server` has a matching issuer and three endpoints on
  this origin. A host can begin a connection.
- `GET /b/example/brain` with no cookie is refused: a same-origin redirect to sign-in, or
  a `404` where the web app is not mounted (static and github identity modes). Never a
  `200`, which would be a version handing authenticated content to a stranger. Added
  2026-09-01 with the web app.

### What they do not assert

- **A wrong `PUBLIC_BASE_URL`.** `@cloudflare/workers-oauth-provider` builds the metadata
  above from the request origin, not from the configured base URL, so all of it is correct
  on any hostname whatever the config says. `PUBLIC_BASE_URL` is read where there is no
  request to derive an origin from: `src/manifest.ts`, and the connected-accounts tools
  building the `/link/start` URL. A deploy carrying the wrong value passes every check here
  and then emails someone a link into the wrong deployment.
- **Anything behind auth.** A real `initialize` plus `tools/list` needs a magic-link round
  trip. Not scripted, and not planned.
- **Data correctness.** A version that boots, authenticates, and returns wrong page content
  is a green deploy. That is what the golden batteries on the pull request are for.

## Looking at a branch before it merges

The same `versions upload` step, run by hand from a branch, gives a URL that serves no
traffic and shares production's bindings. That makes it a read-only look, not a place to
run arbitrary code: the rules and the procedure are in
[`../design/preview-environments.md`](../design/preview-environments.md#until-it-is-built-the-manual-version-preview),
and an isolated preview Worker is the design's unbuilt half.

## What a rollback does not undo

**Applied migrations.** Step 1 runs before anything else and is never reverted; the
rollback repoints traffic at the previous Worker version and stops there. The existing rule
that migrations must be backward compatible with the still-running old code (additive, with
renames and drops done expand-then-contract) is what keeps that safe. It was already
required for the deploy window. It is now load-bearing, because the old code can come back
at any moment for as long as it takes someone to read the failure.

See [`d1-migrations.md`](d1-migrations.md).

## Rolling back by hand

When the automation did not fire, or fired and you want a different target:

```sh
pnpm exec wrangler deployments status --json    # what is live now
pnpm exec wrangler versions list                # the 10 most recent versions
pnpm exec wrangler rollback <version-id> --message "why" --yes
```

Then confirm, rather than assuming:

```sh
pnpm exec tsx scripts/smoke.ts https://<production origin>
```

## The drill

**Part A is done.** The merge of the pull request that introduced this workflow triggered it,
and the whole path ran on 2026-08-18 in 43 seconds:

```
Rollback target: ff88abe2-84e4-4938-b8fc-91db3503cecf
Worker Version ID: 6687bc0c-a70d-4a53-813a-88b0875ec606
Version Preview URL: https://6687bc0c-<worker>.<subdomain>.workers.dev
pre-promotion smoke: All smoke checks passed
promoted to 100%
production smoke: All smoke checks passed
```

What that settled, both of which were open questions rather than formalities:

- **The pre-promotion check is the real path, not the fallback.** The step ran rather than
  skipping, so Cloudflare issued a preview URL for a version of this Worker in practice and not
  merely in the version metadata. Bad code is checked before it takes traffic.
- **The API token can do all three new things.** Reading deployment status, uploading a version,
  and promoting one. It had been scoped for `wrangler deploy`, so this was the likeliest first
  failure and turned out to be a non-issue.

**Part B, the rollback round trip, has NOT been run.** `wrangler rollback` is the one command in
this pipeline that has still never executed against this account. It is also the one whose
failure you would discover during an incident. Rolling back to a known-good version and forward
again never breaks production, so the drill is close to free:

Roll production back one version and then forward again. Both versions are known good:

```sh
live=$(pnpm exec wrangler deployments status --json | jq -r '.versions[0].version_id')
# versions list is ASCENDING, so the second-newest is .[-2], not .[1]
prev=$(pnpm exec wrangler versions list --json | jq -r '.[-2].id')

pnpm exec wrangler rollback "$prev" --message "rollback drill" --yes
pnpm exec tsx scripts/smoke.ts https://<production origin>   # expect green

pnpm exec wrangler versions deploy "$live@100%" --message "end of drill" --yes
pnpm exec tsx scripts/smoke.ts https://<production origin>   # expect green
```

What this proves: the rollback command works on this account, with this token, on this
Worker, and that the origin recovers. What it does not prove is the workflow's own step
conditions, which have no test and are read rather than run. That is the residual risk in
removing the approval gate, and it is bounded: the worst case is a bad version that stays up
until someone reads the red run.

The reviewer rule was removed on 2026-08-18, so merging `main` now ships with no human step.
What that did and did not change, including who can still reach production, is in
[`repo-protection.md`](repo-protection.md).

## Why this is safe enough without the click (the reviewer rule was removed 2026-08-18)

Every merge to `main` already carries a green `check` context on exactly the content being
merged: branch protection requires it with `strict: true`, so a pull request must be up to
date with `main` before it can merge. By the time the deploy runs, 15 golden batteries, both
end-to-end batteries, the UI suite, and a local migration apply have all passed on that tree.
The approval click was re-reading code CI had already run.

What CI cannot see is everything that needs a real origin: a binding id that does not
resolve, a secret that was never set, a version that does not boot. That is exactly the list
the smoke check covers, and it now runs on every deploy instead of never.
