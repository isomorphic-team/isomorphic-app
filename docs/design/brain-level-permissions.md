# Design: brain-level permissions

Status: **built**. The deferred follow-up named in
[`brain-creation-and-init.md`](./brain-creation-and-init.md), and Phase 9 of
[`org-roles-permissions.md`](./org-roles-permissions.md).

## The problem

Access to a brain was exactly org membership, and the caller's **org role applied to every brain
in the org**. `brains.visibility` existed in the schema, defaulted to `'org'`, and was read by
nothing. Two consequences:

- **Shared orgs co-mingled.** Any brain anyone created was immediately readable by the whole
  organization, at their org role. There was no way to keep a draft, a client brain, or a personal
  brain to yourself inside a team org.
- **One role for two questions.** "Can you manage this organization's people?" and "can you write
  in this brain?" were the same number. An org Editor could not share their brain with a teammate
  read-only, because the teammate's org role decided what they could do in it.

## The model: two scopes, deliberately separate

| Scope          | Source                                    | Governs                                                                                               |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Org role**   | `memberships`                             | Invite/remove people, set org roles, connect the GitHub org, create brains, connect/disconnect brains |
| **Brain role** | `brain_memberships` + `brains.visibility` | Read, write, move/delete pages, configure, share                                                      |

`TenantContext` carries **both** (`role` = brain, `orgRole` = org), and `TenantOpts` gates on
either (`requires` = brain, `requiresOrg` = org). That split fixed a latent bug: `members.ts`
gated org roster management on `ctx.role`, which is now the brain role. Without the split, being
shared a brain as admin would have conferred the power to edit the whole org roster.

`owner` is **not a brain role**. Ownership is the org's anti-lockout anchor; an org owner/admin
floors to admin on every brain instead.

## The rule

One pure function, `effectiveBrainRole` in `src/lib/orgs.ts`, is the single authority. Three
independent sources of access, and the effective role is the **highest** any of them grants:

1. `visibility='org'` → your org role, for every member of the org.
2. An explicit `brain_memberships` grant → that grant's role, whatever the visibility.
3. Org admin/owner → your org role, floored at admin, always.

Resolution is **additive on purpose**: a share may only ever raise what another source already
gave you. If a grant could lower an effective role, "sharing" would become a way to strip
someone's access, and an org admin could be demoted on a brain and lose the recovery path.

Why (3), the admin override: an org owner controls the GitHub org that physically holds the repo
and can read it directly, so hiding a brain from them in-product would be theater. It also stops a
brain orphaning when the only person it was shared with leaves.

Unknown `visibility` values **fail open** to org-visible. Only the exact string `'private'`
restricts. An over-restrictive default here means a brain nobody, including its owner, can
open, which is a worse failure than the one it would prevent.

Everything downstream trusts this one function rather than re-expressing the policy in SQL:
`listAccessibleBrains` widens the query to every brain in every org you belong to and then admits
or drops each row by its verdict; `getDefaultBrainForUser` picks a landing brain with it;
`listBrainAccess` renders the sharing panel from it. A filter written twice is a filter that will
eventually disagree with itself. `pnpm test:access` walks the rule's whole input space.

## Defaults

- **`create_brain` → `private`**, plus an explicit admin grant for the creator. A brain you just
  made is yours until you share it.
- **`connect_brain` → `org`.** Adopting an existing repo is an _admin_ act on a repo the
  organization already owns; the intent is "this org repo is now a brain for the team". Narrow it
  afterwards with `share_brain`.
- **Existing brains are grandfathered.** They keep `visibility='org'` and behave exactly as before.
  The change is not retroactive, so nobody loses access on deploy.

## Surface

Two tools, mirroring `members.ts` one scope down:

- **`brain_access`** (any access to the brain): who can reach it and at what level, as the inline
  sharing panel _and_ as data. Knowing who else is in a room you are already in is not privileged.
- **`share_brain`** (brain admin+): every mutation in one verb: share with a person, change their
  level, revoke (`access: 'none'`), and flip `visibility` between `private` and `org`. Revoke and
  re-share are the same verb from the user's side; a separate `unshare_brain` would be a third
  name for it.

Guardrails, enforced in `src/tools/brain-access.ts`: you can only share with people already in the
brain's org (a grant to a non-member is unreachable anyway, since resolution starts from
`memberships`; writing one would be a silent no-op); you can't grant above your own brain role;
you can't revoke your own access.

UI: `app/views/BrainAccessView.tsx`, reached from a **Share** control in the brains list (gated on
`canShare`, the brain role, distinct from `canManage`, the org role that gates disconnect). The
list also badges private brains. Adding someone opens `app/views/ShareBrainView.tsx`, a pushed
flow off the panel's header, which is the brain-scope twin of `InviteMemberView`: the two are
deliberately the same screen one scope apart, because "add to the org" and "add to this brain"
are exactly the pair a user is liable to confuse. `BRAIN_ROLE_BLURB` (in
`app/components/RoleSelect.tsx`, beside the org-scoped `ROLE_BLURB`) is why the role names can
be shared while their descriptions are not: a brain admin can share one brain, an org admin can
manage the roster.

## Cleanup paths

Revocation has to actually revoke, so grants are torn down with the thing they hang off:

- `disconnect_brain` → `deleteBrainGrants`, or the rows outlive the brain and re-attach if the same
  repo is adopted again under the same id.
- `remove_member` → `deleteUserBrainGrantsInOrg`, or removing someone from the org leaves per-brain
  grants that still let them in.

## Tests

Two golden tests, both pure and both in CI, because the feature has two independent ways to
be wrong:

- `pnpm test:access` pins the RULE and the queries that apply it: `effectiveBrainRole` over its
  whole input space, then the real exported functions against the real schema in an in-memory
  SQLite. It answers "who can reach this brain, at what role".
- `pnpm test:scope` pins WHICH ROLE EACH TOOL GATES ON, which the first cannot see. The real
  handlers are registered against a stub server with a fake `getContext` that reproduces
  worker.ts's two assertions, and both directions are asserted: an org viewer holding brain
  admin is refused by every org-scope tool and admitted by `share_brain`, while an org owner
  holding only brain viewer is the reverse. It also covers the guardrails that live in the tool
  rather than in `orgs.ts` (share with a non-member, share with a strange email, revoking
  yourself, the member-management lockout rules).

Both were mutation-tested when written: reverting `members.ts` to `requires: 'admin'` turns
`test:scope` red in five places, and flipping `share_brain` to `requiresOrg` turns it red in
two. A scope test that stays green under those edits is not testing anything.

## Known gaps

- **No audit trail on access changes.** `brain_memberships` records `granted_by`/`granted_at`, but
  a revoke deletes the row, so there is no history of who removed whom.
- **Invited-user landing.** A user invited to an org whose brains are all private lands with no
  brain and is told to ask an admin to share one. That is correct but it is a manual step; an
  invite that names a brain to share would be better.
- **No per-brain invite.** You must be an org member before a brain can be shared with you.
