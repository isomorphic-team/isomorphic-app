---
paths:
  - "src/worker.ts"
  - "src/lib/{orgs,storage-connections,brain-move,org-connect,invites,provision,identity,tenants,signin-email,scaffold-core}.ts"
  - "src/tools/{brains,brain-access,members,org-onboarding,connected-accounts}.ts"
  - "src/oauth/**"
  - "src/auth/**"
  - "src/db/**"
  - "migrations/**"
  - "app/core/nav.ts"
  - "app/components/{Breadcrumb,Destinations,RoleSelect,ConnectedAccountsSection}.tsx"
  - "app/views/{Members,BrainAccess,ShareBrain,InviteMember,AddBrain,Brains,ConnectAccount,Settings,More}View.tsx"
  - "scripts/test-{access,invites,scope,email}.ts"
  - "scripts/onboard-org.ts"
---

# Identity, orgs, brains, and who can reach what

Full RFCs: `docs/design/org-roles-permissions.md`, `docs/design/brain-level-permissions.md`,
`docs/design/guest-access.md`, `docs/design/storage-and-tenancy.md`,
`docs/design/brain-creation-and-init.md`.

## Two identity modes (`IDENTITY_MODE`)

The Worker is an OAuth 2.1 server to Claude via `@cloudflare/workers-oauth-provider`. What
varies is the upstream human-auth step behind `/authorize`:

- **`github`** (legacy/admin): `src/oauth/github-handler.ts`. Token props `{ gh_user_id, gh_login }`.
  Tenant from the flat `tenants` table (`src/lib/tenants.ts`), treated as `owner`. A GitHub id
  linked to a product identity resolves through the person model instead. This is the ONLY
  path that auto-provisions a BRAIN (`provisionBrainForUser`, via `McpSession.autoProvision`,
  gated on `AUTO_PROVISION`).
- **`authjs`** (member-facing, the hosted default): `src/oauth/auth-handler.ts` +
  `src/auth/config.ts`. Auth.js (`@auth/core` + `@auth/d1-adapter`) with a Resend magic link;
  users need no GitHub account. Token props `{ user_id, email }`. Google/OIDC is the
  recommended future primary provider (not built).

Auth.js specifics that bite: config MUST be built per request with `env.PLATFORM_DB`
(`buildAuthConfig(env)`, never a module singleton). DB-strategy sessions omit `user.id` unless
a `session` callback copies it (we do; the OAuth bridge keys on it). `/oauth/complete` stashes
the client's OAuth request in `OAUTH_KV` under `pending_auth:<state>` across the email hop.
`authjs.callback-url` cookies are sticky and silently steer a bare `/auth/signin` visit: clear
cookies or use incognito when testing.

**The sign-in email is ours** (`src/lib/signin-email.ts`, pure, `pnpm test:email`), sent
through Resend from `src/auth/config.ts`. Auth.js's stock template (hostname subject, lone
button) was filed as spam. Keep the product name in the subject and From line, the requested
address, where the link goes, the expiry, and a plain-text part with the same words.

## The org model (authjs)

**Tables** (`migrations/`; `src/db/*.sql` are reference only): `app_users` (Auth.js user
projection, named apart from Auth.js `users`), `orgs`, `memberships` (user→org + `role`),
`brains` (org→repo), `brain_memberships` (per-brain grants), `invitations`,
`storage_connections`.

**Three org models** (`orgs.model`): `platform` (a personal org on the platform's
installation, minted at first touch), `customer` (the org's own GitHub App installation), and
`hosted` (a named team org on the platform's installation, created by `create_org` without
`github`, gated on `AUTO_PROVISION`).

**Resolution** (`tenantContext()` in `worker.ts`, via `src/lib/orgs.ts`): `props.user_id` →
the person's linked user ids → accessible brains → the chosen brain → a token minted from that
brain's STORAGE CONNECTION (see below). First-touch users with no membership get an **org
only**, never a brain, via `provisionOrgForUser()` when `AUTO_PROVISION=true`. With no brain,
brain-scope resolution throws `NoBrainError` and the app shows the create-first-brain state
(`app/views/AddBrainView.tsx`). Org-scope actions resolve via `orgContext()`, which needs no
brain and refuses outright on single-tenant connections.

**Brains are created explicitly.** `create_brain` (org `editor`+) scaffolds via
`createAndScaffoldBrain`, writes a `brains` row with a user-given `name`, and switches to it.
`create_brain` AND `connect_brain` default to `visibility='private'` plus an admin grant for
the caller; older brains keep `'org'`.

## Roles and the two scopes

`viewer < editor < admin < owner`. **TWO ROLES, TWO SCOPES: don't collapse them.**
`TenantContext` carries `role` (on the resolved brain) and `orgRole` (in that brain's org);
`TenantOpts` gates with `requires` (brain) or `requiresOrg` (org). Org scope = people, creating
orgs, create/connect/disconnect/move brains. Brain scope = read, write, move/delete pages,
configure, share. Gating an org action on `role` would let one shared brain confer the whole
org roster.

- **`effectiveBrainRole` (`src/lib/orgs.ts`) is the single authority** on whether a caller
  reaches a brain and at what role: three additive sources (org visibility, an explicit grant,
  the org-admin floor), highest wins, never demotes, unknown `visibility` fails OPEN.
  `pnpm test:access` walks its input space; `pnpm test:scope` pins which role each tool gates
  on. Consumers (`listAccessibleBrains`, `getDefaultBrainForUser`, `listBrainAccess`) fetch rows
  in SQL and admit them through this function: **never re-express the policy in a WHERE clause.**
- **`orgRole` is nullable**, meaning "not a member of the owning org": only a grant admits
  them, and every org-scope gate must read null as "not a member", never as "no gate".
- **`brains.read_only` is the one CEILING**, applied last. **`brains.archived_at` is NOT in the
  rule**: archived brains are filtered in the SQL of the two base queries.
- **Revocation tears down what hangs off it:** `disconnect_brain` → `deleteBrainGrants`,
  `remove_member` → `deleteUserBrainGrantsInOrg`.

## Sharing and guests

`brain_access` (anyone with access) opens the sharing panel and returns the list;
`share_brain` (brain admin+) grants, changes, revokes (`access: 'none'`) and flips
`private`/`org`. Guardrails: never above your own brain role, never revoke yourself, never
`admin` for a guest. Share is gated on `canShare` (brain role), deliberately not `canManage`
(org role). Role names are shared across scopes, descriptions are not (`ROLE_BLURB` vs
`BRAIN_ROLE_BLURB` in `app/components/RoleSelect.tsx`).

**A guest** holds a grant on a brain in an org they are not a member of. `via: 'guest'` is
DERIVED, never stored. `listAccessibleBrains` and `listBrainAccess` each union a memberships
leg and a grants leg. Guests are capped at editor (`GUEST_ROLE_CAP`) and `share_brain` refuses
an admin grant for one. An address with no account gets a **brain invite**
(`invitations.brain_id`), claimed as a grant, never a membership; the org roster's
`listPendingInvites` excludes them (`brain_id IS NULL`). **No invitation email is sent** for
either kind; the reply carries a sentence to forward.

## Members

`members` (viewer+) opens the roster and returns it as data; `invite_member` /
`set_member_role` / `remove_member` are admin+. Guardrails in `members.ts`: `owner` is never
assignable, removable or demotable; you cannot edit your own membership or grant above your
own role.

**Nav scopes** live in `app/core/nav.ts` (`Scope` = `brain` / `org` / `account`,
`DEST_META`, `destinationsIn`), pure and pinned by `pnpm test:policy`; glyphs and clicks are
`app/components/Destinations.tsx`. Brain views (files, graph, search, activity, sharing) are
the rail; Members and Analytics are ORG scope because sibling brains in one org show the same
answer. The brain glyph at the root of the trail opens the Brains page, which is the switcher.

## Claiming invitations

An invitation becomes a membership (or grant) in exactly one place: `claimPendingInvites`
(`src/lib/invites.ts`, `pnpm test:invites`).

- **Keyed on the person's set of addresses** (`linkedUserIds`); the membership lands on the
  invited `user_id`, so invites survive account linking.
- **Runs wherever an address is proven, once per request:** `/link/complete` and
  `McpSession.personUserIds`. Both fail open.
- **`AUTO_PROVISION` does not gate it.** That flag governs minting a personal org for someone
  nobody invited.
- **A membership is never rewritten by an invite.** An invite to an org the person already
  belongs to is marked accepted and writes nothing.
- `noBrainOutcome` (`provision.ts`, pure) tells a member with no reachable brain which problem
  they have; editors+ get the create-first-brain state.

## Multiple brains, multiple orgs

`tenantContext({ brain })` resolves: explicit `brain` arg (fuzzy) → the active brain → the
default (oldest). The active pointer is per USER in `OAUTH_KV` (`active_brain:<userKey>`),
written awaited. **Only an explicit act moves it:** `switch_brain`, `create_brain`, and
`disconnect_brain` falling back to a survivor. A view tool never moves it (a view in one
conversation would retarget every other conversation's bare calls); `pnpm test:scope` pins the
three writers. `brains` returns data only and carries no `_meta.ui`.

Identity linking: a person's addresses share `app_users.person_id`; every brain AND org query
unions across `personUserIds` (`connected_accounts` / `link_identity` / `unlink_identity`).

**Placing a brain uses `listAccessibleOrgs`, never `listAccessibleBrains`** (which inner-joins
`brains`, so an org holding none is invisible). `create_brain` and `connect_brain` take an
optional `org` (`matchOrg`); `chooseOrg` is the pure pick and throws rather than guessing:
named > active brain's org > oldest. `orgNameProblem` refuses an org name the caller already
belongs to.

**`brains` must cost nothing for a configured brain.** The widget calls it on every open;
`hasIndexedPages` answers a configured brain with one query and no context, and only an EMPTY
index pays for freshness and a tree scan. Any per-brain work added to `brains` needs that
shape: index first, GitHub only when the index cannot say. `pnpm test:scope` pins it.

**`needsConfig` lists the whole tree** (`detectNeedsConfig`, so it sees `.isomorphic.json`),
and `configure_brain` refuses to replace an existing config without `overwrite: true`.

## Storage connections and moving brains

**A brain's credential comes from its storage binding, not its org** (migration 0010).
`storage_connections` holds one row per credential (today `github-app:<installation id>`);
`brains.storage_connection_id` binds a brain to one. `listAccessibleBrains` uses the binding's
installation, falling back to the org's for a NULL binding. A connection's `owner_org_id`
(NULL = platform-owned) decides who may list and adopt through it, so `connect_brain` refuses
to ADOPT in personal and hosted orgs.

**`connect_brain` also MOVES brains.** Naming an existing brain exactly (id, repo name or
name) in another org moves it (org admin in BOTH orgs; a preview until `confirm: true`).
`moveBrain` (`src/lib/brain-move.ts`) is one batch that sets `org_id`, re-points pending brain
invites, and first PINS a NULL binding to the source org's connection. The preview,
`planBrainMove`, runs `effectiveBrainRole` once per org rather than restating it. Renaming is
`configure_brain`'s `name`. **Don't re-add `update_brain` and don't collapse these into a
`manage_*` tool**: hosts grant approval per tool (design doc §6).

## Creating orgs

`create_org` (`src/tools/org-onboarding.ts`) makes a hosted org on the spot, or with
`github: true` returns an App install URL carrying a KV-stashed `state`;
`/github/install-callback` turns it into a `customer` org via `connectCustomerOrg`
(`src/lib/org-connect.ts`), idempotent on re-install. Needs `GITHUB_APP_SLUG`. Operators can
use `pnpm onboard-org` (dry-run by default; `--apply local|remote|both`). `src/db/seed-*.sql`
are `<PLACEHOLDER>` templates.

## Platform setup

An admin runs `pnpm bootstrap` once, registers the App, installs it on one platform org;
the install callback records `PLATFORM_ORG` + `PLATFORM_INSTALLATION_ID`. Personal and hosted
orgs create repos through that single installation, so members never see GitHub.

**Uncovered:** the Worker call sites of `claimPendingInvites` and the link callback.
