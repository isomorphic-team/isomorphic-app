# Design — brain creation & initialization

Extends [`org-roles-permissions.md`](./org-roles-permissions.md). A deliberately **narrow**
slice of Phase 8: explicit, named brain creation, and decoupling a session from an
auto-created brain. **Out of scope on purpose: org/brain membership and access.** The current
access model is left exactly as-is; per-brain access is a separate follow-up (see _Deferred_).

## Goal

1. Let any editor **stand up a new, named brain on demand** (UI or by telling Claude).
2. **Stop auto-creating a brain** for a user who has none — a repo exists only when someone
   explicitly asks. First sign-in lands in a _"create your first brain"_ state.

## Scope

**In:** `create_brain` (named); no brain auto-provisioning; "no active brain" as a first-class
state; the org-scope-vs-brain-scope split needed to support it.

**Out (unchanged / deferred):** `brain_memberships`, per-brain roles, private-by-default,
`visibility` enforcement, sharing/roster UI. No new access surface, no access query changes.

## The access model is UNCHANGED

We keep today's behavior: access == org membership; the caller's **org role** applies to every
brain in the org; new brains keep `visibility='org'` (the existing default, still unenforced).
`listAccessibleBrains` is untouched. Practical consequence to be explicit about:

- **Solo / personal org** (one member — you): your brains are effectively private; nobody else
  is in the org to see them. This is the primary near-term case.
- **Multi-member org** (team/customer): a newly created brain is visible to _all_ org members,
  same as today. Accepted for this slice; making brains private/shared per-brain is the deferred
  follow-up.

So there are **no new tables** and **no ACL changes** here. The only `brains` change is additive
display metadata for naming.

## Data model (D1) — minimal, additive

```sql
ALTER TABLE brains ADD COLUMN name       TEXT;   -- display name; repo_name stays the slug
ALTER TABLE brains ADD COLUMN created_by TEXT;   -- app_users.user_id of the creator (audit)
```

No `brain_memberships`. `visibility` stays at its `'org'` default, unenforced, exactly as now.

## Brain naming

The user names a brain ("Project X"). The repo slug is **derived** from the name
(`project-x`); on collision under the org's `brain_owner`, suffix (`project-x-2`). `name` is the
display label everywhere in the UI; `repo_name` is immutable after create.

**Rename = display-name-only** — update `brains.name`, never the GitHub repo (`repos.update`),
so links/history don't churn. (Resolves the earlier rename open-decision, within this scope.)

## Creating a brain

**Tool** `create_brain(name, org?)` + an app **"New brain"** entry in the switcher.

1. Resolve **org-scope** context (installation + org role) — _not_ a brain (see decoupling).
   Reject if org role < `editor`; reject the legacy github/static single-tenant paths
   ("org accounts only", like the member tools).
2. Slug `name` → `repo_name`; collision → suffix. Keep the typed `name`.
3. `createAndScaffoldBrain(octokit, { org: brain_owner, name: slug })` — already exists, already
   Worker-safe. Creates a private repo + scaffold (AGENTS.md + tool-maintained `log.md`).
4. Insert the `brains` row (`name`, `created_by`; `visibility` left at the `'org'` default).
5. `switch_brain` to it so the caller lands in the new brain.

No membership row is written or needed — visibility is governed by the unchanged org model (for a
personal org, that's just the creator).

## The decoupling refactor (the real work in this slice)

Removing auto-provision makes **"no active brain" a first-class state**, which today's code can't
represent — `resolveProductContext` always resolves a brain (creating one if none).

- **Split context resolution** into **org-scope** (installation + org role; no brain) and
  **brain-scope** (a selected/accessible brain). `create_brain` and org-admin/member tools need
  only org-scope; read/write/view need brain-scope.
- `tenantContext({ brain })` must tolerate _org but zero accessible brains_: brain-scope tools
  return a helpful error ("You don't have a brain yet — create one with `create_brain` or the New
  brain button"), not a crash.
- The app's first paint handles zero-brains → the create-first-brain empty state; the switcher
  shows "New brain" even at count 0.

This is the spine of the slice; `create_brain` is small once it's in place.

## First-touch onboarding (no auto-provision)

1. Sign in (magic-link/SSO) → `provisionOrgForUser` creates the **personal org only** (owner
   membership, `brain_owner` = platform org, **no `brains` row**).
2. The app renders the empty state; Claude offers `create_brain`.
3. The invite-adoption path is unchanged: a user pre-invited to a customer org joins _that_ org at
   the invited role instead of getting a personal org — and still no brain is forced on them.

Scope note: this targets the **authjs product path** (`provisionOrgForUser`). The legacy
github/`tenants` path (`provisionBrainForUser`) and `AUTH_MODE=static` are unchanged — they're the
admin/legacy identity, not product onboarding.

## Authorization

`create_brain` gates on **org role ≥ editor**. Content tools continue to gate on the **org role**
exactly as today — no per-brain roles in this slice.

## Phased plan

These land **together** (removing auto-provision is what _creates_ the no-brain state, and
`create_brain` is what makes the empty state actionable), in this order:

1. **Additive schema + `create_brain`.** `brains.name`/`created_by`; the tool + slug/collision;
   the "New brain" switcher entry. Behind the scenes, still on the org-visibility model.
2. **Decouple context.** org-scope vs brain-scope resolution; brain-scope tools handle "no brain".
3. **Kill auto-provision.** First touch creates org-only; wire the empty state end-to-end.

## Deferred — per-brain access (next phase)

Explicitly _not_ built here; captured so the direction is on record. When we do it: a
`brain_memberships(brain_id, user_id, role)` table as the access authority, new brains
**private by default**, `visibility` enforced (`private` = members only; `org` = share with the
whole org), per-brain roles, and a brain-scoped sharing/roster UI (mirroring `members.ts`). That
phase also retires the shared-org co-mingling remnants. **Interim behavior until then:** new
brains follow the org-visibility model — fine for solo/personal orgs, org-visible in shared orgs.

## Risks / notes

- The decoupling touches `tenantContext` — the core resolution path. Every brain-scope tool must
  handle "no brain" gracefully.
- **No access-regression risk:** this slice adds no access surface and doesn't change
  `listAccessibleBrains`.
- Interim: multi-member orgs see newly created brains org-wide until the deferred access phase —
  call this out to any such org.
- No conflict with identity-linking; installation-token repo I/O (all librarian tools) is untouched.
