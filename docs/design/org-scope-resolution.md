# Design: org-scope resolution (org-scope tools should not need a brain)

Status: **proposed, not built**. Found while adding web URLs for the org-scope
destinations ([`link-sharing-and-the-web-app.md`](./link-sharing-and-the-web-app.md),
Phase 3). The URLs shipped without it; this is the half that did not.

Depends on the two-scope model in
[`brain-level-permissions.md`](./brain-level-permissions.md) and the resolution chain in
[`org-roles-permissions.md`](./org-roles-permissions.md).

## The problem

The permission model and the navigation both treat the org as a first-class scope.
**Resolution does not.** `members` and `analytics` are wired to `tenantContext`, which
resolves a **brain** and hands back `orgId` as a byproduct:

```ts
// src/tools/members.ts — the only input is a brain
inputSchema: {
	brain: brainArg;
}
const ctx = await getContext({ brain });
const { orgId, actorUserId } = requireOrg(ctx);
```

So an org-scope answer is reachable only by first resolving a brain. Three consequences,
all the same defect:

- **An org holding no brain has no reachable roster.** `tenantContext` throws
  `NoBrainError` before the roster query runs. This is the same join shape that
  `chooseOrg` exists to work around: `listAccessibleBrains` inner-joins `brains`, so an
  org with none produces no row, which is what once made the first brain in a freshly
  connected org impossible to create.
- **It strands exactly the person who needs it.** Brains are private by default, so a
  newly invited member frequently has an org and no brain they can open.
  `noBrainOutcome` already special-cases them, and the roster is one of the few things
  they could usefully be shown.
- **A multi-org person cannot reach their second org's roster** without switching a
  brain into that org first, because the org is inferred from the active brain.

`analytics` has the same shape and a sharper irony: it answers "is this organization
using its brains", and you can only ask from inside one.

## Why this is not a URL problem

The web app now addresses these at `/b/<owner>/<repo>?view=members` and
`?view=analytics` (see `WEB_TOOL_ROUTING` in `src/lib/web-app.ts`), which reads as "the
roster of the org that owns this brain" and is true. That is an **addressing** decision
and it is settled. This document is about **resolution**, which is a correctness
question and independent of it.

An org-keyed URL prefix (`/o/<org_id>`) was considered and deliberately deferred. The
reasoning belongs here because it is the same subject:

- `org_id` is a uuid, and it is the only unique handle. `name` is mutable, and
  `brain_owner` is **shared by every platform-model org** (they all live under the
  platform GitHub org), so neither can address an org.
- Two destinations do not justify a second addressing scheme with an unreadable handle.
- **The brain is the unit of place, deliberately.** The ambient pointer is
  `active_brain:<userKey>` in KV; there is no active-org pointer, and `activeBrainOrgId()`
  derives the org from the active brain. Every tool takes `brain`, the crumb is
  brain-first. Org is an ownership fact about where you are, not a location.
- **The threshold to revisit** is a third and fourth org-scope destination: billing, SSO
  configuration, an audit log, org settings. At that point `/o/<org_id>` earns itself and
  the work below is its prerequisite anyway.

## The change

`orgContext` **already does the right thing** and is the reason this is tractable:

```ts
private async orgContext(opts?: { requires?: Role; org?: string }): Promise<OrgScope> {
  const personIds = await this.personUserIds(userId);
  const picked = await resolveOrgForPerson(env.PLATFORM_DB, personIds, {
    org: opts?.org,
    activeOrgId: () => this.activeBrainOrgId()
  });
  ...
  assertRole(membership.role, opts?.requires);   // against the RESOLVED org
```

It resolves a person's orgs (not one user id), honours a named `org` handle through
`chooseOrg`/`matchOrg`, needs no brain, and authorizes against the org it actually
resolved. Today only `registerOrgOnboardingTools` and the brains tools use it.

The work is to move the org-scope tools onto it:

1. **`members` and `analytics` take `org` instead of `brain`**, resolved through
   `orgContext`. `matchOrg` already accepts an org id, name, or GitHub owner, so the
   handle is whatever the caller has.
2. **The member mutations take `org` too** (`invite_member`, `set_member_role`,
   `remove_member`). This is not optional politeness: the moment the roster can display a
   **named** org, a mutation still gating on the ambient org writes to a different
   organization than the one on screen. What you see must be what you act on.
3. **`OrgScope` needs what these tools read that it does not carry.** `members.ts`
   currently reads `ctx.activeBrain` and `ctx.role` alongside `ctx.orgId`/`ctx.orgRole`.
   `activeBrain` is echoed so the widget's crumb stays correct, which an org-scope
   result still wants; `role` (the brain role) should not be reachable from an org-scope
   tool at all, and its uses need auditing rather than porting.

### What must not regress

- **Authorization follows the named org, never the ambient one.** `assertRole` already
  runs against the resolved membership, so the shape is right, but every path needs a
  test in both directions. Gating an org action on the wrong org is the same class of
  bug the two-scope split was created to prevent.
- **The person, not the user id.** `personUserIds` / `listAccessibleOrgs` union across
  linked identities. Org scope was the last path still keyed on a single `user_id` and
  it has already been fixed once; a rewrite must not reintroduce it.
- **`hasOrgModel` still gates registration.** Single-tenant deployments register none of
  this and must keep not doing so.

## Testing, and the honest gap

`pnpm test:scope` is the battery: it drives the real handlers over a stub server and a
fake `getContext`, asserting which of the two roles each tool gates on, in both
directions. It should gain, per tool, that a named `org` is what authorization is
evaluated against, and that a caller who is admin in org A and viewer in org B cannot
mutate B by naming it.

**None of this can be verified in a browser.** The local runtime (`pnpm try`, and so
`pnpm web:dev` and the `web` Playwright project) has no org model at all: it never
registers the member, analytics, or brain-access tools, because there are no orgs or
memberships to resolve. That is already why `?view=access` ships with a round-trip test
and no browser test. An authorization change landing on pure tests only is the risk this
document exists to make visible before the work starts, not after.

Two ways to reduce it, neither free and neither yet chosen:

- Teach the local runtime a minimal org model (rows in the shimmed D1, one org, one
  member) purely so these surfaces can be driven. It would make the harness less
  representative in exchange for making it cover more.
- Cover the wiring in `pnpm test:scope` against the real migration on `node:sqlite`, as
  `test:dedupe` and `test:usage` already do, and accept that the app layer stays
  untested, as it is everywhere else.

## Not in scope

- `/o/<org_id>` URLs. Deferred above, with a stated threshold.
- An active-org pointer. The brain is the unit of place and this change does not alter
  that; naming an org is a per-call argument, exactly as naming a brain is.
- Any change to what a role may do. This moves where the org is resolved from, and
  nothing else.
