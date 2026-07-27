# Repository protection with outside contributors

What to turn on before the repo goes public, and the reasoning behind each setting. The
short version: **outside contributors already cannot touch anything**, so the job is not to
restrict their access, it is to make sure a merge is a deliberate act and that untrusted CI
cannot reach a secret.

## The thing most people get wrong

GitHub has **no per-path write permission**. You cannot grant someone write access to
`app/` but not `src/auth/`. People go looking for that setting, do not find it, and conclude
they need to split the repository.

You do not need it, because outside contributors have **no write access at all**. They fork
the repository and open a pull request from their fork. They cannot push to any branch here,
cannot merge, cannot change settings, and cannot read a secret. The only thing they can do is
propose a diff.

So the control you actually want is **path-scoped review**, not path-scoped write, and GitHub
does have that: [`CODEOWNERS`](../../.github/CODEOWNERS) plus "Require review from Code Owners". A pull
request touching `src/auth/`, `migrations/`, `pnpm-lock.yaml`, or `LICENSE` cannot merge
without a maintainer's explicit approval on that file. A pull request that only touches
`app/views/GraphView.tsx` still needs a review, but it does not need to wait on the person
who owns the auth code.

## Settings to apply

### 1. Branch ruleset on `main`

Current state as of the open-sourcing change: `main` requires the `check` status and blocks
force pushes and deletions, but does **not** require a pull request or a review. That was
correct for a solo private repo. It is not correct for a public one, where the same
configuration means anyone with write access, including a future maintainer on a bad day, can
push straight to a branch that auto-deploys to production.

Turn on:

| Setting                                 | Why                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Require a pull request before merging   | No direct pushes to `main`, including yours. Every change becomes reviewable and revertible as a unit.                   |
| Require 1 approval                      | The floor. With one maintainer you approve your own PRs, which is theater; it stops being theater the day there are two. |
| Require review from Code Owners         | This is the path-scoped control. Without it `CODEOWNERS` is documentation.                                               |
| Dismiss stale approvals on new commits  | Otherwise a contributor can get approval on a clean diff and then push something else before you merge.                  |
| Require status checks: `check`          | The CI job. Already on.                                                                                                  |
| Require branches to be up to date       | Catches a change that passes alone and fails against current `main`.                                                     |
| Require conversation resolution         | Cheap, and stops a review comment being merged past.                                                                     |
| Block force pushes and deletions        | Already on.                                                                                                              |
| Do not include administrators (for now) | With one maintainer, enforcing on admins means locking yourself out of a hotfix. Revisit when there are two of you.      |

```sh
gh api -X PUT repos/isomorphic-team/isomorphic-app/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["check"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

### 2. Actions: require approval for outside contributors

**Settings → Actions → General → Fork pull request workflows from outside collaborators.**
Set it to **"Require approval for all external contributors"**, not the default
"first-time contributors".

This is the setting that matters most, and it is not the obvious one. A workflow file is
code, and a pull request can change it. Requiring approval means no workflow runs on a
contributor's branch until a maintainer has looked at what it is about to run.

### 3. Actions: read-only default token

**Settings → Actions → General → Workflow permissions → Read repository contents and
packages permissions.** `ci.yml` already declares `permissions: contents: read` for itself,
but the repo-wide default should be the safe one so a future workflow does not silently
inherit write.

### 4. The environment gate on the deploy (partly done)

`deploy.yml` runs on push to `main`, so **a merged pull request deploys to production
immediately**. That was fine when every commit was yours. With outside contributions it means a
merge you regret is live before you have finished reading the diff again.

This is the single change that most reduces the blast radius of accepting outside code, and it
costs one click per release.

**Done already:** the `production` environment exists with a deployment branch policy limiting
it to protected branches, and the `deploy` job declares `environment: production`. The run now
appears under the repo's Deployments tab with the deployed origin attached.

**Blocked until the repo is public:** the required-reviewer rule. Environment protection rules
are free on public repositories and unavailable on private ones whatever the plan. The API is
blunt about it, rejecting the rule with `Failed to create the environment protection rule.
Please ensure the billing plan supports the required reviewers protection rule.` even on a Team
org. So run this the moment you flip visibility, and not before, because until then the gate
records deployments without holding them:

```sh
gh api -X PUT repos/isomorphic-team/isomorphic-app/environments/production --input - <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [{ "type": "User", "id": $(gh api users/isomorphic-12 --jq .id) }],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
JSON
```

`prevent_self_review` must stay `false` while there is one maintainer, or nobody can ever
approve a deploy and `main` becomes undeployable. Flip it to `true` when there are two of you.

**Still to do, and it needs your hands because a secret cannot be read back:** move the
Cloudflare token from repository scope into the environment, so no other workflow can reach it,
including one introduced by a pull request.

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production   # paste the same token
gh secret delete CLOUDFLARE_API_TOKEN                 # only after the env one is set
```

Order matters. Environment secrets take precedence over repository secrets, so setting the
environment one first means the deploy keeps working throughout and the delete is the last step
rather than a window of breakage. Verify with a `workflow_dispatch` run before deleting the
repository-scoped copy.

## What CI already defends against

Worth knowing so you do not review for it by hand:

- **`ci.yml` needs no secrets.** Every step is offline. A fork PR gets the same green or red
  signal a maintainer's branch does, and there is nothing in the job to steal. Keep it that
  way: a step that needs a token belongs in `deploy.yml`.
- **`cla.yml` uses `pull_request_target`, deliberately and carefully.** That trigger runs in
  the base repository's context with write access, which is exactly why the workflow does not
  check out pull-request code. A change that adds such a checkout is a privilege escalation
  dressed as a refactor. The file says so at the top, and `CODEOWNERS` puts `.github/` behind
  your review.
- **Generated files cannot smuggle code.** `src/lib/app-bundle.generated.ts` is committed and
  compiled into the Worker, which makes it an attractive place to hide something. CI
  regenerates it from source and fails on any diff, so a hand-edit is caught mechanically
  rather than by review attention. Same for `brain-template.generated.ts`.
- **`pnpm install --frozen-lockfile`** means a dependency cannot change without a lockfile
  diff, and the lockfile is in `CODEOWNERS`.

## Do we need a platform split?

No, and doing one would cost more than it buys.

The reason people split is to keep something sensitive out of contributors' hands. Everything
in that category is **already** out of this repository, and not by accident:

- Credentials live in Worker secrets and `.dev.vars`, never in the repo.
- Deployment identity (Worker name, public URL, Cloudflare resource ids) lives in generated
  config and GitHub variables. `wrangler.jsonc` is gitignored.
- Anything naming real infrastructure or a real customer lives in the gitignored `/ops/`.

What a split would additionally protect is production against a malicious merge, and an
environment gate on the deploy job protects that better, for one click instead of a permanent
tax on every change.

What a split would cost is the thing that makes the open-sourcing worth doing. A public
half-product with the interesting parts missing does not attract contributors, and it makes
every design decision carry a second question: which side of the wall does this go on. That
argument is in [`docs/design/open-source-boundary.md`](../design/open-source-boundary.md),
along with the cases that will test the line.

The license, not the repository layout, is what preserves the commercial option: the CLA lets
us sell an exception to the AGPL copyleft. Note that AGPL deliberately does NOT stop someone
hosting a competing service, and we decided we were not worried about that (see
[`docs/licensing.md`](../licensing.md)). Splitting the repo would not have stopped it either.

## When a second maintainer appears

- Replace `@isomorphic-12` in `CODEOWNERS` with a `@isomorphic-team/maintainers` team, so
  ownership is a group rather than a person.
- Turn on **Include administrators** in the ruleset. Once someone else can unblock you, there
  is no reason for the rule not to apply to you.
- Consider requiring signed commits. Skip it while you are solo; it is friction with no
  reader.
