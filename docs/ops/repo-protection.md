# Repository protection with outside contributors

What is turned on for a public repo with outside contributors, and the reasoning behind each setting. The
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
does have that: [`CODEOWNERS`](../../.github/CODEOWNERS) plus "Require review from Code Owners". With
it on, a pull request touching `src/auth/`, `migrations/`, `pnpm-lock.yaml`, or `LICENSE`
cannot merge without a code owner's explicit approval.

It is off while the maintainer is the only account with write access: with one person able to
merge, a required approval is that person approving their own merge. `CODEOWNERS` still
requests the maintainer's review on every pull request. **Turn it on, with one required
approval, before a second account gets write access.**

## Settings to apply

### 1. Branch ruleset on `main`

`main` deploys to production on merge, so anyone who can push to it can ship. These are on:

| Setting                                     | Why                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Require a pull request before merging       | No direct pushes to `main`, including yours. Every change becomes reviewable and revertible as a unit.            |
| Require 0 approvals, no Code Owner review   | One account has write access, so an approval would be its own. Both go back on before a second account can merge. |
| Dismiss stale approvals on new commits      | Otherwise a contributor can get approval on a clean diff and then push something else before you merge.           |
| Require status checks: `check`, `cla`, `ui` | The offline batteries, the CLA, and the app in a real browser.                                                    |
| Require a merge queue (squash)              | Each pull request is tested merged onto current `main` before it lands, without a manual branch update.           |
| Require conversation resolution             | Cheap, and stops a review comment being merged past.                                                              |
| Block force pushes and deletions            | A rewritten `main` cannot be rolled back to.                                                                      |
| Allow auto-merge (a repository setting)     | `gh pr merge --auto` adds a pull request to the merge queue once its checks pass, with nobody waiting on CI.      |
| Do not include administrators               | See the note directly below. This stays off, and a separate ruleset covers what it was wanted for.                |

```sh
gh api -X PATCH repos/isomorphic-team/isomorphic-app -F allow_auto_merge=true

gh api -X PUT repos/isomorphic-team/isomorphic-app/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["check", "cla", "ui"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
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

It is still the wrong tool. `enforce_admins` is all or nothing: it applies EVERY rule above to
admins. Today that would bind the maintainer to `ui`, a browser job that can fail on browser
infrastructure, with no override. With an approval and Code Owner review required it is worse:
`CODEOWNERS` names one person and GitHub does not allow approving your own pull request, so
the repository becomes unmergeable by the only person who can merge.

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
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "check" }, { "context": "cla" }]
      } },
    { "type": "merge_queue",
      "parameters": {
        "merge_method": "SQUASH",
        "grouping_strategy": "ALLGREEN",
        "min_entries_to_merge": 1,
        "max_entries_to_merge": 5,
        "max_entries_to_build": 5,
        "min_entries_to_merge_wait_minutes": 0,
        "check_response_timeout_minutes": 60
      } }
  ]
}
JSON
```

Confirm it binds you rather than politely suggesting: the response carries
`"current_user_can_bypass": "never"`.

Rulesets and classic branch protection stack, and the most restrictive wins. That layering is
the entire point: classic protection keeps `enforce_admins: false` so the maintainer can
override a `ui` failure, while the ruleset makes `check` and `cla` unskippable for everyone
including the maintainer. Neither mechanism can express that on its own.

The merge queue makes "CI ran on exactly the merged content" true without requiring each branch
to be up to date, so `strict` is off in both places. A pull request that falls behind `main` no
longer waits for someone to update it: the queue builds it on top of `main` and on top of the
entries ahead of it. Every workflow behind a required check needs a `merge_group` trigger, or
the queue waits on a check that never reports (`pnpm test:wiring` pins `ci.yml` and `cla.yml`).
`cla` only reports in the queue; the signature was checked on the pull request.

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

| Path to production       | Who can take it                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge a pull request     | An account with write access, once `check`, `cla` and `ui` are green on it and again in the merge queue. The maintainer's is the only such account. |
| `workflow_dispatch`      | Repository collaborators with write access. Redeploys whatever is on `main`; it cannot ship anything else.                                          |
| Pull request from a fork | Nobody. `deploy.yml` has no `pull_request` trigger and fork pull requests receive no secrets.                                                       |
| Direct push to `main`    | Nobody. A pull request is required.                                                                                                                 |

So the answer to "who can deploy" is "whoever can get a commit onto `main`", and that is the
maintainer, or an agent session acting with the maintainer's credentials.

**The residual risk is the maintainer's own merges, not contributors'.** A merge is reviewed
only if the maintainer chooses to review it, and ships at once, including one that auto-merge
lands when the checks pass. The rollout's smoke check and rollback cover a version that fails
to boot or loses its OAuth surface; they do not cover a change that boots fine and is wrong,
and a rollback never reverts a migration. That is the trade, and it is worth re-reading the
day a second account gets write access: the approval and Code Owner review go back on first,
and `prevent_self_review` and a real second review become available for free.

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
