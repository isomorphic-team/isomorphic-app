# Design — org identity, roles & permissions

Status: **draft / RFC**. Branch `feature/org-identity-rbac` (worktree `.claude/worktrees/org-identity`). Not implemented.

## Goal

Let a customer organization use the brain platform with two clearly separated personas:

- an **admin** who does the one-time GitHub-facing setup (owns the org's GitHub org, installs the platform App), and
- **members / readers** who use the brain via Claude and **never need a GitHub account** at all.

The current build authenticates _every_ user with GitHub OAuth (`props.gh_user_id`, `tenantContext()` keyed on it). That forces a GitHub account on everyone. This doc reworks the identity layer so only the admin touches GitHub, and adds a role/permission model on top.

## The core reframe: identity ≠ storage

GitHub currently does **two unrelated jobs**, and they're tangled:

| Job                                         | Mechanism today                                    | Who it forces onto GitHub             |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| **Storage access** — read/write brain repos | App **installation token** (`installationOctokit`) | nobody per-user; it's org/admin-level |
| **User identity** — "who is this person"    | GitHub **OAuth** (`github-handler.ts`)             | **every user**                        |

Only the _identity_ job forces GitHub on everyone. Decouple them:

- **Identity** → move to a non-GitHub provider (Auth.js: email magic-link / Google / SSO). Regular users authenticate here. No GitHub.
- **Storage** → unchanged. The platform holds the org's installation token and performs all repo I/O _on behalf of_ members. Members never see a repo.

Result: **GitHub becomes storage-only. The admin is the sole GitHub-facing human; everyone else is a product-native identity.**

## Personas

| Persona                    | Has a GitHub account? | What they do                                                                                                                                                                       |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform operator** (us) | Yes                   | Runs the platform. Owns the platform GitHub org used for individual-tier brains. Registers the platform App.                                                                       |
| **Customer admin / owner** | **Yes**               | Owns the customer's GitHub org, installs the platform App on it (one-time), then manages the team _in-product_: invites members, manages brains, configures integrations, billing. |
| **Member**                 | **No**                | Signs in with email/SSO. Reads + contributes to the org's brain(s) via the MCP tools.                                                                                              |
| **Viewer / reader**        | **No**                | Signs in with email/SSO. Read-only.                                                                                                                                                |

Only the top two touch GitHub, and the customer admin only during setup.

## Ownership / storage models

Two coexist — the identity layer is non-GitHub in **both**:

- **Model B — customer-owned GitHub org (primary for teams).** The customer admin installs the App on _their_ GitHub org; brains are repos under it; the platform uses _their_ installation token. Chosen as the anchor: matches "admin owns setup," gives data residency ("our repos, our org").
- **Model A — platform-owned org (individual / free tier).** No customer GitHub org. Brain lives under the _platform's_ org via the platform installation (the auto-provisioning already built in phase 2.1). The individual signs in with email/SSO and never touches GitHub either.

The `orgs` row (below) records which model an org uses via its `installation_id` + `brain_owner` — Model A rows point at the platform org/installation, Model B rows at the customer's.

## Identity layer — Auth.js

### Why Auth.js

- `@auth/core` is runtime-agnostic (Web `Request`/`Response`) → runs on workerd.
- **`@auth/d1-adapter`** persists users/accounts/sessions/verification-tokens in D1 — we already have `PLATFORM_DB`. (Caveat: community-maintained, D1 API not declared stable; pin versions and cover with the e2e.)
- Providers give us **email magic-link** (via HTTP email, not nodemailer — see below), **Google**, and eventually **SSO/OIDC** for enterprise with little marginal code.

### Workers-specific constraints (from research)

- **Per-request instantiation.** Bindings (D1) are request-scoped, so the Auth config must be built _inside_ the fetch handler with `env.PLATFORM_DB`, not exported as a module singleton.
- **No nodemailer.** It depends on Node `stream`/`dns`; it will not run on workerd. Use the HTTP-based **Resend** provider (or a custom `sendVerificationRequest` hitting any transactional-email HTTP API). Adds a `RESEND_API_KEY` secret.
- **Migrations.** `@auth/d1-adapter` ships an `up()` migration helper; run it as a one-shot (or fold its tables into `src/db/schema.sql`).

### How Auth.js slots into the existing MCP OAuth server (the tricky part)

The Worker is **already an OAuth 2.1 authorization server** to Claude via `@cloudflare/workers-oauth-provider`. That does **not** change. Auth.js replaces only the _upstream human-authentication_ step that `github-handler.ts` performs today:

```
Claude (MCP client)
  └─OAuth 2.1─▶ Worker /authorize            (workers-oauth-provider — UNCHANGED)
                   └─ delegates to defaultHandler
                        ├─ TODAY:  github-handler.ts → redirect to GitHub → callback → completeAuthorization({ gh_user_id })
                        └─ NEW:    auth-handler.ts → Auth.js login (magic-link / Google / SSO)
                                     → on success, completeAuthorization({ user_id, email, org_id, role })
```

So: `workers-oauth-provider` stays the token issuer to Claude; Auth.js becomes the identity source behind `/authorize`; `completeAuthorization` is handed a **product** identity instead of a GitHub one. `McpProps` changes from `{ gh_user_id, gh_login }` to `{ user_id, email, org_id, role }`.

**UX caveat worth an early decision:** the connector auth happens inside an OAuth redirect popup. A redirect-style provider (**Google / hosted SSO**) completes in one hop and fits that popup cleanly. **Magic-link** requires leave → check email → click → return, possibly cross-device, which we must carry across the OAuth `state` (same pattern as today's `pending_auth:<state>` KV nonce, plus an email hop). Magic-link is lowest-setup; an OIDC provider is smoother in-connector. Recommendation: ship **magic-link first** (fewest external deps), keep the provider list open so Google/SSO drop in later.

## Roles & permissions

Four roles. Membership is **product-managed** (admin invites by email) — it can _not_ be derived from GitHub org membership, because members aren't GitHub users.

| Capability                                                                                         | owner | admin | member | viewer |
| -------------------------------------------------------------------------------------------------- | :---: | :---: | :----: | :----: |
| Read tools (`whoami`, `list_pages`, `read_page`, `search_pages`, `find_inbound_links`, `validate`) |   ✓   |   ✓   |   ✓    |   ✓    |
| Contribute (`write_page`)                                                                          |   ✓   |   ✓   |   ✓    |   ✕    |
| Destructive wiki ops (`delete_page`, `move_page`)                                                  |   ✓   |   ✓   |  ✓\*   |   ✕    |
| Invite / remove members, set roles                                                                 |   ✓   |   ✓   |   ✕    |   ✕    |
| Manage brains (create/rename/archive)                                                              |   ✓   |   ✓   |   ✕    |   ✕    |
| Configure integrations (Slack, email ingest, etc.)                                                 |   ✓   |   ✓   |   ✕    |   ✕    |
| Connect GitHub org / install App                                                                   |   ✓   |   ✕   |   ✕    |   ✕    |
| Billing, delete org, transfer ownership                                                            |   ✓   |   ✕   |   ✕    |   ✕    |

\* Open question: gate `delete_page` / `move_page` to admin only? They're destructive but reversible via git history. Default: allow members; revisit.

`owner` = the admin who created the org (the GitHub-connected human). `admin` = a delegated product-admin who does _not_ need GitHub — GitHub connection stays an owner-only power.

## Data model (D1)

Replaces the flat `tenants` table. `tenants` (keyed on `gh_user_id`) becomes a legacy/compat path during migration.

```sql
-- A customer organization (or an individual's implicit personal org).
CREATE TABLE orgs (
  org_id           TEXT PRIMARY KEY,          -- our id (uuid), NOT a GitHub id
  name             TEXT NOT NULL,
  model            TEXT NOT NULL,             -- 'platform' (Model A) | 'customer' (Model B)
  installation_id  INTEGER NOT NULL,          -- platform install (A) or customer install (B)
  brain_owner      TEXT NOT NULL,             -- GitHub org/login that holds the repos
  github_org_login TEXT,                      -- customer's GitHub org (Model B only)
  created_by       TEXT NOT NULL,             -- users.user_id of the owner
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at     TEXT
);

-- Product-native user (Auth.js owns auth; this is our app-level projection).
-- Auth.js's own user/account/session/verification_token tables live alongside
-- (created by @auth/d1-adapter); user_id here == Auth.js user id.
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,             -- Auth.js user id
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  github_login  TEXT,                         -- set ONLY for GitHub-connected owners
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which users belong to which org, and their role.
CREATE TABLE memberships (
  org_id     TEXT NOT NULL REFERENCES orgs(org_id),
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  role       TEXT NOT NULL,                   -- owner | admin | member | viewer
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);

-- Brains owned by an org (supersedes tenants.brain_*; supports >1 brain/org).
CREATE TABLE brains (
  brain_id    TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id),
  repo_owner  TEXT NOT NULL,
  repo_name   TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'org',    -- 'org' (all members) | 'private' | future per-brain ACL
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_owner, repo_name)
);

-- Pending email invitations (accepted → membership row).
CREATE TABLE invitations (
  invite_id   TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  invited_by  TEXT NOT NULL,
  token_hash  TEXT NOT NULL,                  -- store a hash, not the raw token
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);
```

## Authorization enforcement (`src/worker.ts`)

Today `tenantContext()`: `gh_user_id → tenants row → { octokit, repoArgs }`. New shape:

1. From `this.props`, read `user_id` + `org_id` (bound at `completeAuthorization`).
2. Resolve membership → **role**; resolve the target **brain** (org's default, or a `brain` param once multi-brain lands) → `{ repo_owner, repo_name }`.
3. Mint the installation token from `orgs.installation_id`.
4. **Gate the tool by role** before executing — reject writes for `viewer`, admin-ops for non-admins. Centralize as a `requireRole(minRole)` check wrapping each `registerTool` handler (or a small capability map keyed by tool name).

Integrations and **brain** management stay out of the tool authz map for now. **Member** management, originally planned for a separate surface, instead shipped as admin-only MCP tools + an in-client roster UI (2026-07-13) — same `memberships` source of truth, guardrails enforced per-handler in `src/tools/members.ts`.

## Onboarding flows

**Admin (GitHub-facing, once):** sign in with email/SSO → "Create a team" → "Connect your GitHub org" → install the App on their org (GitHub's org install UI; org-admin required) → install-callback records `orgs` row (model=`customer`, installation*id, github_org_login) → optionally scaffold a first shared brain. Same machinery as today's `bootstrap.ts` install-callback, but customer-facing and recording a \_customer* org.

**Member (no GitHub, ever):** admin invites by email → member clicks the invite link → Auth.js magic-link/SSO sign-in → `invitations` row consumed → `memberships` row created → connect Claude to `https://mcp.isomorphic.sh/mcp` → they're in, scoped to the org's brain(s) at their role.

## Phased plan

1. **Identity swap (no roles yet).** Add Auth.js (`@auth/core`, `@auth/d1-adapter`, Resend magic-link) behind `/authorize` as `auth-handler.ts`; keep `github-handler.ts` selectable via env for the admin/legacy path. `McpProps` → product identity. Prove: a non-GitHub email user can sign in from Claude and hit read tools.
2. **Org + membership model.** `orgs`/`users`/`memberships`/`brains` tables; `tenantContext()` resolves org + brain from product identity. Migrate the existing single tenant.
3. **Roles + tool authz.** `requireRole` capability map over the tools; viewer/editor/admin enforced.
4. **Admin surface.** ✅ **Built 2026-07-13** (member half). Invitations flow is wired (written by `invite_member`, consumed at first sign-in via `provisionOrgForUser`), and member management ships as admin-only mutation tools (`invite_member` / `set_member_role` / `remove_member`) plus `members` (viewer+), which both opens the in-client roster UI (`MembersView`) and returns the roster as data. Roles surface as **Viewer / Editor / Admin** (the `member` token was renamed `editor`); `owner` is a non-assignable lockout anchor. Guardrails in `src/tools/members.ts`. Still open: **brain** management (add/rename/remove brains) and a standalone (non-Claude) admin web surface.
5. **Model B onboarding.** ✅ **Built.** Two paths, both writing a `customer`-model `orgs` row + owner membership (see `docs/ops/onboarding-a-customer-org.md`). Self-serve: `connect_github_org` (`src/tools/org-onboarding.ts`) → GitHub App install → `/github/install-callback` resolves the install and calls `connectCustomerOrg` (`src/lib/org-connect.ts`); idempotent on re-install. Operator: `pnpm onboard-org` (`scripts/onboard-org.ts`) resolves the installation, verifies repo reachability, and seeds the org/brain/invite rows (dry-run by default). Repo adoption is then the already-built `connect_brain`.
6. **SSO.** Add Google, then OIDC/SAML via an IdP when enterprise demands it.
7. **Multi-brain access.** One connection, many brains. **P1 ✅ Built 2026-07-14** (`src/tools/brains.ts`): a person selects among the brains their memberships grant — active brain + per-tool `brain` override, `brains`/`switch_brain`, a nav switcher, `tenantContext` resolving the chosen brain per call. Accessible-brains resolution takes a SET of user ids so P2 slots in. **P2 (identity linking)** — link a person's emails (`app_users.person_id`) so the set unions across identities (personal gmail + team + client), verified by magic-link, managed under "Connected accounts". Enterprise follow-up: a per-org "no linked-identity access" policy.
8. **Brain creation & initialization.** Explicit, named brain creation (any editor); no
   auto-provisioning (first touch = empty personal org + "create your first brain"); decouple
   session context from an auto-created brain. Access model unchanged in this slice; per-brain
   membership/access is a deferred follow-up. Spec: [`brain-creation-and-init.md`](./brain-creation-and-init.md).

## Open decisions

- **First identity provider:** magic-link (lowest setup) vs Google/OIDC (smoother in the connector popup). Leaning magic-link for MVP with the provider list kept open.
- **Buy vs build later:** stay on Auth.js + providers, or adopt a B2B IdP (WorkOS/Clerk/Stytch) when SAML SSO becomes a sales requirement. Auth.js abstracts identity enough to defer this.
- **Per-brain ACL vs org-wide:** still `visibility='org'` (all members see all org brains). Explicit named brain creation + init decoupling lands first ([`brain-creation-and-init.md`](./brain-creation-and-init.md)); per-brain membership / private-by-default is the deferred follow-up.
- **Destructive-op gating:** members or admin-only for `delete_page`/`move_page`.
- **How the admin's GitHub identity links to their product account:** GitHub as an Auth.js _linked account_ on the owner's user (account-linking), vs a separate "connect GitHub" step storing the installation without a GitHub _login_ on the user. Leaning the latter — GitHub is storage config, not identity.
- **`@auth/d1-adapter` stability risk:** pin versions; if it drifts, a thin custom D1 adapter is small.

## Risks / notes

- Embedding a multi-step magic-link inside the OAuth `/authorize` round-trip is the fiddliest bit — reuse the existing `pending_auth:<state>` KV pattern, extended across the email hop.
- Keep the `AUTH_MODE=static` legacy branch out of this; it dies at phase-3 cutover regardless.
- This is an identity-layer change, not a storage re-architecture — the installation-token repo I/O (incl. all librarian tools) is untouched.
