# Design: enterprise identity (SSO, verified domains, SCIM)

Status: **proposed** (2026-11-05). Nothing here is built.

Revises one clause of [`open-source-boundary.md`](./open-source-boundary.md): the clause that
put sign-in, including Enterprise SSO and SAML, permanently outside `ee/`. The revision is not
"SSO becomes an enterprise feature". It is that **the gate is a runtime entitlement check, not
where the file sits**, which lets the sign-in code stay in the core and still be sold.

Related: [`org-roles-permissions.md`](./org-roles-permissions.md),
[`brain-level-permissions.md`](./brain-level-permissions.md),
[`guest-access.md`](./guest-access.md), and
[`.claude/rules/org-model-and-permissions.md`](../../.claude/rules/org-model-and-permissions.md).

## The case

An organization evaluating a hosted knowledge base sends it to IT before it sends it to a
team. IT asks four questions, in this order:

1. Can our people sign in with our directory, rather than a password or an emailed link?
2. Can we make that the only way in?
3. When somebody leaves, does their access die without one of us remembering to kill it?
4. What is the audit trail, and where does the data sit?

Question 4 is answered today: content is in the customer's own GitHub repository, its history
is the audit trail, and access metadata is in the deployment's own D1. Questions 1 to 3 are
not answered at all.

The deployment currently has one way in: an Auth.js email magic link. For a single
organization that is fine. For a hosted service selling to several organizations at once it
fails three ways. There is no way to say which organization an email address belongs to before
the person signs in, no way to refuse the magic link for an organization that has bought SSO,
and no way to remove a person from outside the product.

## What exists today

Worth stating precisely, because most of the hard part is already built.

- **Auth.js, one provider.** `src/auth/config.ts` registers a Resend magic link and nothing
  else. `D1Adapter` stores users, sessions, accounts and verification tokens in the same D1 the
  org model uses (`migrations/0001_init.sql`).
- **The config is rebuilt per request.** `buildAuthConfig` takes `env` and runs on every call,
  because D1 bindings are request-scoped and a module singleton would capture a dead binding.
  This is the single most useful fact in this document: **a per-request config can choose a
  provider per organization**, which is the part that is usually hard to retrofit.
- **The OAuth bridge is ours.** `src/oauth/auth-handler.ts` is the upstream identity behind the
  MCP OAuth server: `/authorize` stashes the client's request in KV under a state nonce
  (`PENDING_AUTH_TTL_SECONDS`), sign-in happens, then `/oauth/complete` reads the session,
  resolves the product identity (`resolveProductIdentity`) and claims pending invitations
  (`claimPendingInvites`). Nothing about that changes when a second provider arrives.
- **Orgs, roles and membership are built.** `src/lib/orgs.ts`, with `effectiveBrainRole`,
  guests capped by `GUEST_ROLE_CAP`, and invitations that already carry an expiry.
- **No per-org secret is stored anywhere.** `storage_connections`
  (`migrations/0010_storage_connections.sql`) holds an installation id and no credential; the
  GitHub App private key is a Worker secret and tokens are minted per request. Keeping that
  property is a constraint on the design below, not an accident to preserve by habit.
- **Entitlements are built.** `org_entitlements` plus `hasFeature` and `getEntitlement` in
  `ee/entitlements.ts`, written by `pnpm entitle`, read today only by `ee/review/gateway.ts`.

## Prior art

PostHog is the closest comparable: open core, a self-hostable product, and enterprise identity
sold to the same buyer. Their shape, read from their repository rather than their marketing:

- They built it themselves on python-social-auth and python3-saml. No identity vendor.
- Their multi-tenant SAML backend subclasses the library's own, and lives in the **core**
  module tree, not in their `ee/` directory. Their `ee/` retains only legacy aliases, kept so
  that sessions created before the move still restore.
- Two models carry it: a per-organization identity provider config, and a verified
  organization domain. One config can back several verified domains.
- **The gate is a runtime license check inside that core code.** An unlicensed organization
  gets "your organization does not have the required license to use SAML", raised from a core
  module.
- The SAML assertion's email domain is validated against the config's verified domains, and a
  config backing no verified domain cannot be used at all.
- Basic OAuth sign-in (GitHub, GitLab) stays free and unlicensed. SAML, just-in-time
  provisioning, SSO enforcement and SCIM are the paid line.

Their documented warnings are worth copying outright: enforcing SSO does not disable
pre-existing API keys, their SAML integration does not handle user removal (SCIM does), and an
untrusted identity provider can spoof an email address to impersonate a user.

## Decisions

### D1. The gate is the entitlement check, not the directory

The boundary document's current rule places a feature by where its file sits. That was a good
rule for the model gateway, which is a genuinely separable subsystem, and it is the wrong rule
for sign-in, which is threaded through a code path every user takes.

The revised rule: **a feature is enterprise because it checks an entitlement.** Most enterprise
features will still live in `ee/`, because most of them are separable. Enterprise identity does
not have to, and should not.

This keeps a promise the current wording makes for the wrong reason. A self-hoster still gets
working sign-in with no key and no subscription, because the magic link and plain OIDC are
unentitled. What is sold is the governance layer on top.

### D2. The entitlement read moves into the core

D1 is not reachable while `hasFeature` lives in `ee/`: core code calling it would break the
invariant that the core never calls into `ee/` to do its own job
([`.claude/rules/ee.md`](../../.claude/rules/ee.md)).

Move the read into `src/lib/` as its own module: `FEATURES`, `Entitlement`, `isActive`,
`getEntitlement`, `hasFeature`. `ee/` keeps `entitlementSql` and `ENTITLEMENT_SOURCES`, which
are the operator's grant tooling, and imports the read like any other `src/lib/` helper. One
importer changes today (`ee/review/gateway.ts`), the migration does not move, and the
invariant is strengthened rather than excepted: after the move, the core still never calls into
`ee/`.

This mirrors PostHog, where the license read is core and the licensed features are what sits
behind it.

### D3. Verified organization domains

A new table, org_domains: a domain, the org it belongs to, a verification challenge, and a
verified timestamp. Verification is a DNS TXT record on a per-org challenge value, re-checked
periodically rather than once, because a domain that lapses should stop routing sign-ins.

Claiming a domain is a security boundary, not a convenience. Whoever holds a verified claim on
a domain decides how everyone at that domain signs in, including people who are not members of
the org. Unverified claims route nothing.

### D4. One multi-tenant application registration, pinned on the tenant id

Register **one** application and have customers consent to it, rather than asking each customer
for a client id and secret.

This is the decision that preserves "no per-org secret in D1". A per-customer registration
would put a client secret per org in the database and bring encryption at rest and rotation
with it, for no gain. A new table, identity_connections, holds the provider, the issuer or
tenant id, and the org, and no credential.

**Pin the tenant id claim on every assertion.** Email domain validation alone is not enough:
with account linking on verified emails, an identity provider we do not trust can present a
token for an address at a domain mapped to somebody else's org. Validate both, the way PostHog
validates the assertion's email domain, and refuse a connection that backs no verified domain.

### D5. Home-realm discovery

Sign-in asks for an email address first, looks up the domain in org_domains, and either routes
to that org's identity provider or falls back to the magic link. The provider id stays stable
so the redirect URI is one value for every tenant; the per-request config supplies the rest.

### D6. SSO enforcement, scoped to verified domains

Once an org enforces SSO, the magic link is refused for addresses at its verified domains. Two
things fall out, and both are easy to get wrong:

- **Scope enforcement to domains, never to a brain.** A guest holding a `brain_memberships`
  grant is by definition outside the org and cannot authenticate against the customer's
  directory. Scoping to the brain would break `share_brain` the first time anyone enforced.
- **Enforcement must revoke, not just refuse.** Existing OAuth grants and MCP bearer tokens
  keep working after enforcement is switched on, which is exactly the hole PostHog documents
  for API keys. Turning on enforcement sweeps the org's live grants.

### D7. Just-in-time provisioning

First sign-in from a verified domain creates the membership at a configured default role
instead of requiring an invitation. Without this, SSO adds an administrative step rather than
removing one. Invitations stay for everyone outside the verified domains.

### D8. SCIM is separate, and later

A SCIM endpoint with a per-org bearer token, mapping to `memberships`. It is the answer to the
leaver question, and no amount of sign-in work substitutes for it: authentication does not
handle removal.

It is deliberately out of this document's scope. It wants its own design, its own battery, and
a reading of the spec's edge cases rather than a paragraph here.

## What is core, and what is entitled

| Capability                                   | Core | Entitled |
| -------------------------------------------- | ---- | -------- |
| Magic link sign-in                           | yes  |          |
| OIDC sign-in, one provider per deployment    | yes  |          |
| Verified organization domains                |      | yes      |
| Per-org identity provider config             |      | yes      |
| SSO enforcement                              |      | yes      |
| Just-in-time provisioning                    |      | yes      |
| SCIM                                         |      | yes      |

The split is the buyer test the boundary document already states, applied honestly. A
self-hoster pointing their own directory at their own instance pays nothing. An organization
buying centralized control over who reaches what, and an audit story to go with it, is a
compliance function spending a compliance budget.

## Why not an identity vendor, yet

WorkOS or an equivalent would supply SAML, SCIM, directory sync and a customer-facing admin
portal, priced per connection. It is the right answer eventually and the wrong answer now:

- **The core cannot depend on it.** A self-hoster who needs a third-party account to sign in is
  not self-hosting. So the core path gets built either way, and a vendor adds a second path
  rather than removing the first.
- **It replaces the smallest piece.** The OAuth bridge, product identity, invitation claiming
  and membership stay ours. A vendor replaces the Auth.js leg and adds a hop to the flow that
  is already hardest to debug.
- **The per-request config is the expensive part, and it exists.** Paying per connection to
  avoid building what `buildAuthConfig` already enables is paying to not use an asset.

Revisit when a customer arrives on an identity provider that does not speak OIDC, or when SCIM
and an admin portal cost more support time than an invoice would. Migrating into a vendor later
is bounded, because the `accounts` table maps onto their model and email-verified linking
handles the join. Migrating out is the expensive direction, which is the asymmetry that says
wait.

## Known gaps

- **Multi-org people.** Somebody whose address is at a verified domain for one org and a guest
  on a brain in another needs a sign-in route that does not strand them. Home-realm discovery
  decides on the address, so the enforcing org wins; whether that is right is open.
- **The first user of a deployment** cannot sign in through an org's provider before the org
  exists. PostHog hits the same wall and documents it rather than solving it.
- **Disabling SSO** leaves previously provisioned members with no credential, since they never
  had a password and may never have used a magic link.
- **`AUTH_MODE=static`** has no users and no roles, so none of this applies to it. It should
  refuse the governance tools rather than half-answer them.
- **Audit.** Sign-in events are not recorded anywhere today. Usage counters are per-day
  aggregates by design and are the wrong place for them.
