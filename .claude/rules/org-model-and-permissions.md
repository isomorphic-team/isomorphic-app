---
paths:
  - "src/worker.ts"
  - "src/lib/{orgs,storage-connections,brain-move,org-connect,invites,provision,identity,static-tenant,signin-email,scaffold-core,org-domains,sso,sso-cookie}.ts"
  - "src/tools/{brains,brain-access,members,org-onboarding,connected-accounts}.ts"
  - "src/oauth/**"
  - "src/auth/**"
  - "src/db/**"
  - "migrations/**"
  - "app/core/nav.ts"
  - "app/components/{Breadcrumb,Destinations,RoleSelect,ConnectedAccountsSection}.tsx"
  - "app/views/{Members,BrainAccess,ShareBrain,InviteMember,AddBrain,Brains,ConnectAccount,Settings,More}View.tsx"
  - "scripts/test-{access,invites,scope,email,sso,signin}.ts"
  - "scripts/{onboard-org,sso,sso-sql}.ts"
---

# Identity, orgs, brains, and who can reach what

Full RFCs: `docs/design/org-roles-permissions.md`, `docs/design/brain-level-permissions.md`,
`docs/design/guest-access.md`, `docs/design/storage-and-tenancy.md`,
`docs/design/brain-creation-and-init.md`.

## Sign-in and the single-user deployment

The Worker is an OAuth 2.1 server to Claude via `@cloudflare/workers-oauth-provider`. The human
sign-in behind `/authorize` is Auth.js (`src/oauth/auth-handler.ts` + `src/auth/config.ts`,
`@auth/core` + `@auth/d1-adapter`) with a Resend magic link; users need no GitHub account. Token
props `{ user_id, email }`. `AUTH_SIGN_IN=open` (preview deployments only, set by
`preview.yml`; default `email`) signs anyone in as any address they type: `handleAuthRequest`
redirects the sign-in POST to the link Auth.js minted instead of emailing it, so the session
is a real Auth.js one. Only the exact value `open` opens it. `pnpm test:signin` drives both
modes through real Auth.js over `node:sqlite`. Google/OIDC is the recommended future primary provider (not built).
GitHub sign-in (`IDENTITY_MODE=github`, the per-user `tenants` table, `brain-<login>`
auto-provisioning) was removed on 2026-09-23; `/authorize` answers 501 if it is still set.

**A static deployment (`AUTH_MODE=static`) runs the same org model.** `ensureStaticTenant`
(`src/lib/static-tenant.ts`) writes one org, one operator member (`static-operator`), one
storage connection and one brain from config on first use, in one batch, idempotent. CONFIG IS
THE TRUTH: the brain follows `BRAIN_REPO_*` and the connection follows `GITHUB_TOKEN` /
`GITHUB_APP_INSTALLATION_ID`, a brain from earlier config is removed, and an existing row for
the repo is adopted rather than tripping the `(repo_owner, repo_name)` constraint. The
operator's placeholder address never attributes a commit. `pnpm test:access` pins it.

Auth.js specifics that bite: config MUST be built per request with `env.PLATFORM_DB`
(`buildAuthConfig(env)`, never a module singleton). DB-strategy sessions omit `user.id` unless
a `session` callback copies it (we do; the OAuth bridge keys on it). The callback builds
`{ user, expires }` field by field and never returns the stored row, which carries
`sessionToken` (the cookie's value) to any script on the origin; `pnpm test:signin` pins it. `/oauth/complete` stashes
the client's OAuth request in `OAUTH_KV` under `pending_auth:<state>` across the email hop.
`authjs.callback-url` cookies are sticky and silently steer a bare `/auth/signin` visit: clear
cookies or use incognito when testing.

**The sign-in email is ours** (`src/lib/signin-email.ts`, pure, `pnpm test:email`), sent
through Resend from `src/auth/config.ts`. Auth.js's stock template (hostname subject, lone
button) was filed as spam. Keep the product name in the subject and From line, the requested
address, where the link goes, the expiry, and a plain-text part with the same words.

## Enterprise identity: directory sign-in

Design and what is still open: `docs/design/enterprise-identity.md`. `pnpm test:sso` pins the
decisions; `pnpm test:signin` drives a directory sign-in through real Auth.js against a
stubbed tenant that issues signed ID tokens. No real directory has been signed in through.

An org signs in through its Microsoft Entra directory when it has the `enterprise`
entitlement, a verified domain and an identity connection, and the deployment has
`AUTH_ENTRA_CLIENT_ID` and `AUTH_ENTRA_CLIENT_SECRET`. **There is no tool for any of it:** an
operator sets an org up with `pnpm sso` (`scripts/sso.ts`, SQL in `scripts/sso-sql.ts`).
Enforcement has a column (`org_domains.sso_enforced`) and its rules, and nothing sets it.

- **A verified domain decides how its addresses sign in** (`src/lib/org-domains.ts`, table
  `org_domains`). Proof is a TXT record carrying the org's own challenge, read over DNS over
  HTTPS. `currentVerifiedDomain` looks a stale one up again before it routes; only a conclusive
  "gone" unverifies (`afterTxtCheck`), a resolver failure changes nothing.
- **`resolveSignInRoute` (`src/lib/sso.ts`) is home-realm discovery**, and `chooseSignInRoute`
  is its pure rule. It checks the entitlement from the core: an unentitled org's domains route
  and enforce nothing. `handleSsoRequest` (`src/auth/config.ts`) runs it on the sign-in page's
  email POST and starts the provider sign-in for a connected domain.
- **An identity connection is a provider and a tenant id, never a credential**
  (`identity_connections`). `entraIssuer` throws on anything but a tenant id, so
  `entraProvider` (`src/auth/entra.ts`) cannot be built for the `common` endpoint.
- **The provider exists only in a config built for one org** (`buildAuthConfig`'s `sso`
  argument). The callback learns its org from a cookie signed with `AUTH_SECRET`
  (`src/lib/sso-cookie.ts`) and is refused without it, or if the org's tenant or entitlement
  changed since the start.
- **The `signIn` callback decides.** For the provider it requires `checkSsoSignIn`: the
  token's `tid` is the connected tenant and the address's domain is verified for that org.
  `entraProvider` sets `allowDangerousEmailAccountLinking`, so a member keeps their magic-link
  account, and that is safe only behind this check. For a magic link it refuses an address
  whose domain is enforced (`magicLinkRefused`), when the link is requested and when it is used.

## The org model

**Tables** (`migrations/`; `src/db/*.sql` are reference only): `app_users` (Auth.js user
projection, named apart from Auth.js `users`), `orgs`, `memberships` (user→org + `role`),
`brains` (org→repo), `brain_memberships` (per-brain grants), `invitations`,
`storage_connections`.

**Three org models** (`orgs.model`): `platform` (a personal org on the platform's
installation, minted at first touch), `customer` (the org's own GitHub App installation), and
`hosted` (a named team org on the platform's installation, created by `create_org` without
`github`, gated on `AUTO_PROVISION`).

**Resolution** (`tenantContext()` in `worker.ts`, via `src/lib/orgs.ts`), one path for every
deployment: the caller (`callerUserId()`: `props.user_id`, or the static operator) →
the person's linked user ids → accessible brains → the chosen brain → a token minted from that
brain's STORAGE CONNECTION (see below). First-touch users with no membership get an **org
only**, never a brain, via `provisionOrgForUser()` when `AUTO_PROVISION=true`. With no brain,
brain-scope resolution throws `NoBrainError` and the app shows the create-first-brain state
(`app/views/AddBrainView.tsx`). Org-scope actions resolve via `orgContext()`, which needs no
brain and refuses on a static connection, where the org-scope tools are not registered.

**Brains are created explicitly.** `create_brain` (org `editor`+) scaffolds a repository via
`createAndScaffoldBrain`, or a platform-held brain via `scaffoldInto` on its files object with
no GitHub call, or a folder in the caller's Google Drive (`createBrainFolder`), writes a
`brains` row with a user-given `name`, and switches to it.
`chooseBrainStorage` (pure, `pnpm test:access`) picks: the caller's `storage`, else
`BRAIN_STORAGE` for an org on a platform-owned connection, else GitHub. A Drive is only ever
asked for. **A name is taken when
a brain row holds it** (`brainNameTaken`), whatever GitHub says: a row outlives its
repository, and `createBrain` returns false, with no grant to follow, when it wrote nothing.
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
  opens a brain and at what role: two additive sources (org visibility, an explicit grant),
  highest wins, never demotes, unknown `visibility` fails OPEN. **Org admins get no floor**: a
  private brain is closed to them without a grant.
- **Org admins and owners STEWARD their org's brains** (`stewardsBrain`): they see a private
  brain they cannot open (`listStewardedBrains`, listed in `brains`' text), see its access
  list, and share it, including with themselves (`sharingAuthority`). A steward never gets
  a storage credential: `brain_access` and `share_brain` resolve through the Worker's
  `accessContext`, which mints none. A self-grant on a brain you did not create shows as
  `self_granted` on the sharing panel for everyone. Naming a stewarded brain in any other tool
  fails with `closedBrainMessage`.
  `pnpm test:access` walks its input space; `pnpm test:scope` pins which role each tool gates
  on. Consumers (`listAccessibleBrains`, `getDefaultBrainForUser`, `listBrainAccess`) fetch rows
  in SQL and admit them through this function: **never re-express the policy in a WHERE clause.**
- **`orgRole` is nullable**, meaning "not a member of the owning org": only a grant admits
  them, and every org-scope gate must read null as "not a member", never as "no gate".
- **`brains.read_only` is the one CEILING**, applied last. **`brains.archived_at` is NOT in the
  rule**: archived brains are filtered in the SQL of the two base queries.
- **Revocation tears down what hangs off it:** `disconnect_brain` → `forgetBrain`,
  `remove_member` → `deleteUserBrainGrantsInOrg`. `forgetBrain` (`src/lib/brain-forget.ts`)
  deletes the brain with its grants, pending brain invites, index, findings and policy rows in
  one batch; `createBrain` clears residue under the new id in its insert batch, because
  `brain_id` is derived from the repo name (`brainIdFor`) and a reconnected repo gets the same
  id. A new table
  with a `brain_id` column goes in `BRAIN_PURGED_TABLES` or `BRAIN_KEPT_TABLES`;
  `pnpm test:access` fails until it does.

## Sharing and guests

`brain_access` (anyone with access, or a steward) opens the sharing panel and returns the list;
`share_brain` (brain admin+, or a steward) grants, changes, revokes (`access: 'none'`) and
flips `private`/`org`. Guardrails: never above your `sharingAuthority`, never revoke yourself
unless you steward the brain, never `admin` for a guest. Share is gated on `canShare`
(`sharingAuthority`), deliberately not `canManage` (org role, which gates disconnect). Role names are shared across scopes, descriptions are not (`ROLE_BLURB` vs
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
the rail; Review, admin-only and occasional, is a brain view placed in More (`overflow`); Members and Analytics are ORG scope because sibling brains in one org show the same
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
`storage_connections` holds one row per credential (`github-app:<installation id>`, or
`github-token:env` on a single-user deployment); `brains.storage_connection_id` binds a brain
to one. The one `platform-files` row (`PLATFORM_FILES_KIND`) is no credential: a brain bound
to it has its files in its own Durable Object, and `credentialFor` is what `openStorage` in
`worker.ts` chooses the store by. A `google-drive` connection (`GOOGLE_DRIVE_KIND`, `src/lib/drive-connection.ts`,
`pnpm test:drive`) is one Google account connected by one person for one org
(`driveConnectionId`), its refresh token sealed in `storage_credentials` under a key derived
from `AUTH_SECRET` (`credentialKey`); a brain on one also carries `brains.storage_root`, its
folder. `create_brain` with `storage: "google-drive"` uses only a Drive the caller connected
(`driveConnectionFor`), and otherwise replies with a link (`startDriveConnect`) to
`/google/connect`, which with `/google/callback` requires a browser signed in as that person
(`pendingDriveConnect`). The scope is `drive.file`: never widen it without Google's
restricted-scope review. Nothing removes a connection or its credential yet.
`listAccessibleBrains` JOINS the binding: there is no fallback to the org, and a brain
without a binding is not listed. **An org names its storage too:** `orgs.default_connection_id`
(migration 0013) is where its new brains are created and what org-scope work (create, list
repos) reads through; `orgStorage` resolves it and `OrgScope.storage` carries it. `createOrg`
writes the org and its connection together. A connection's `owner_org_id` (NULL =
platform-owned) decides who may list and adopt through it (`orgAdministersConnection`), so
`connect_brain` refuses to ADOPT in personal and hosted orgs. **Never read
`orgs.installation_id`, `brain_owner` or `github_org_login`**: they are written only because
they are NOT NULL until dropped.

**`connect_brain` also MOVES brains.** Naming an existing brain exactly (id, repo name or
name) in another org moves it (org admin in BOTH orgs; a preview until `confirm: true`).
`moveBrain` (`src/lib/brain-move.ts`) is one batch that sets `org_id`, re-points pending brain
invites, and leaves the binding alone. The preview,
`planBrainMove`, runs `effectiveBrainRole` once per org rather than restating it. Renaming is
`configure_brain`'s `name`.

**`configure_brain` with `storage` moves a brain's files** between any two of `"github"`,
`"isomorphic"` and `"google-drive"`, by one path (`relocateBrain`,
`src/lib/brain-relocate.ts`, `pnpm test:store`). A destination is a `MoveTarget`: a `key`
naming it and an `open` that makes it ready and returns the store, the binding statements
and a token kept for later steps (the Drive folder made for the move). Adding a storage
means adding a target, not a direction. Each call copies a budget of the current files, its
place and target kept in `brain_passes`; a copy begun toward another target starts again;
the binding (`platformFilesBinding`, or `bindingStatement` with the folder as
`storage_root`) changes in the batch that marks the pass done, only when the copy matches
the source's head. Gated at brain admin AND org admin (`requires` and `requiresOrg`,
`pnpm test:scope`). `moveProblem` refuses a move to where the brain already is, to storage
the deployment lacks (a single-user deployment has none, its binding follows config), and
of a brain in pull-request mode to a store without `proposals`. A move into a Drive uses
only a Drive the caller connected. `repo_owner` and `repo_name` stay on the row as the
brain's locator and its claim on the name, and a move to GitHub goes to that repository
through `githubConnectionForAccount`, creating it if it is gone (`ensureRepository`); a
brain that never left a repository (`leftRepository` false, which `relocateBrain` keeps in
the pass and tells the target's `open`) refuses one that already exists under its name,
which is someone else's (`MoveRefused`). History stays where it was made. `disconnect_brain` refuses a
platform-held brain: it has no repository to leave behind. **Don't re-add `update_brain` and don't collapse these into a
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
