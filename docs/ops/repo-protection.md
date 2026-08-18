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
| Do not include administrators (for now) | See the note directly below. This stays off, and a separate ruleset covers what it was wanted for.                       |

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

**"Include administrators" is a trap here, and the ruleset below is the way around it**
(applied 2026-08-18). The reason to want it is narrow: required status checks should apply to
the maintainer too. On 2026-08-18 a pull request was merged 54 seconds after a push, while its
check was still running, and `main` went red. That is exactly what enforcing on admins would
prevent.

It also cannot be used. `enforce_admins` is all or nothing: it applies EVERY rule above to
admins, including `required_approving_review_count: 1` with `require_code_owner_reviews: true`.
`CODEOWNERS` names one person, GitHub does not allow approving your own pull request, and there
is no second code owner. So turning it on does not tighten the checks; it makes the repository
unmergeable by the only person who can merge.

Rulesets do not have that problem. They apply to admins **by default**, and exemptions are
per-ruleset via `bypass_actors` rather than a single repo-wide switch. So one narrow ruleset
carrying only the status-check rule, with an empty bypass list, gets the half that was wanted
and leaves reviews alone:

```sh
gh api -X POST repos/isomorphic-team/isomorphic-app/rulesets --input - <<'JSON'
{
  "name": "main: required checks are not bypassable",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "check" }, { "context": "cla" }]
      } }
  ]
}
JSON
```

Confirm it binds you rather than politely suggesting: the response carries
`"current_user_can_bypass": "never"`.

Rulesets and classic branch protection stack, and the most restrictive wins. That layering is
the entire point: classic protection keeps `enforce_admins: false` so the maintainer merges
without a self-approval, while the ruleset makes the checks unskippable for everyone including
the maintainer. Neither mechanism can express that on its own.

The one cost is `strict_required_status_checks_policy`, which now binds the maintainer too: a
branch must be up to date with `main` before it merges, with no override. That is the tax for
"CI ran on exactly the merged content" being true rather than nearly true. Drop that one field
if it becomes tiresome; keep the rest.

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

### 4. The environment gate on the deploy (reviewer rule removed 2026-08-18)

`deploy.yml` runs on push to `main`, so **a merged pull request deploys to production
immediately, with no human step.** That is deliberate as of 2026-08-18.

**What the `production` environment still does**, and these are permanent:

- **Secret scoping.** `CLOUDFLARE_API_TOKEN` lives in the environment, not at repository level,
  so no other workflow can reach it, including one added by a pull request.
- **Deployment branch policy.** Restricted to protected branches, so a `workflow_dispatch` from
  an arbitrary branch cannot ship.

**What it no longer does:** hold each deploy for a maintainer's approval. That rule was added
when the repo went public and removed once `deploy.yml` gained a smoke check and an automated
rollback. Two facts decided it. The click was a second approval of code the same person had
already approved as a reviewer, and it was expensive: deploys on 2026-08-11 waited 1h27m and
1h41m in "Waiting" before shipping.

Removing it, keeping the other two:

```sh
gh api -X PUT repos/isomorphic-team/isomorphic-app/environments/production --input - <<'JSON'
{
  "wait_timer": 0,
  "reviewers": [],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
JSON
```

**Pass `"reviewers": []` explicitly.** Omitting the key leaves an existing rule in place: the
PUT succeeds, reports success, and changes nothing. Verify with
`gh api repos/OWNER/REPO/environments/production --jq '[.protection_rules[].type]'`, which
should return `["branch_policy"]` alone.

To restore the rule, PUT the same payload with a `reviewers` array and
`"prevent_self_review": false`, which must stay false while there is one maintainer or nobody
can approve a deploy at all.

#### What stands between a stranger and production now

Worth being precise about, because "we removed the deploy approval" sounds like more than it is.
The deploy gate was never what kept outside contributions out; it sat one step later than the
control that does.

| Path to production       | Who can take it                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge a pull request     | Requires `check` + `cla` green, branch up to date, **and a code-owner review**. `CODEOWNERS` makes the maintainer the owner of `*`, so that means every pull request on every path. |
| `workflow_dispatch`      | Repository collaborators with write access. Redeploys whatever is on `main`; it cannot ship unreviewed code.                                                                        |
| Pull request from a fork | Nobody. `deploy.yml` has no `pull_request` trigger and fork pull requests receive no secrets.                                                                                       |
| Direct push to `main`    | Nobody. A pull request is required.                                                                                                                                                 |

So the answer to "who can deploy" is "whoever can get a commit onto `main`", and that is the
maintainer, via a review they were already performing.

**The residual risk is the maintainer's own merges, not contributors'.** With one code owner,
a self-merge is reviewed by nobody and now ships instantly. The rollout's smoke check and
rollback cover a version that fails to boot or loses its OAuth surface; they do not cover a
change that boots fine and is wrong. That is the trade, and it is worth re-reading the day a
second maintainer exists, at which point `prevent_self_review` and a real second review become
available for free.

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
