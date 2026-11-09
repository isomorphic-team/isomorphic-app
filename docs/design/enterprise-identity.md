# Design: enterprise identity (per-org SSO, verified domains, SCIM)

Status: **proposed** (2026-11-05). Nothing here is built.

This revises one clause of [`open-source-boundary.md`](./open-source-boundary.md), the one that
kept Enterprise SSO and SAML out of `ee/` permanently. The revision: a feature is enterprise
because it checks an entitlement, not because of which directory it sits in. Enterprise
identity stays in the core and is still sold.

Related: [`org-roles-permissions.md`](./org-roles-permissions.md),
[`guest-access.md`](./guest-access.md),
[`.claude/rules/org-model-and-permissions.md`](../../.claude/rules/org-model-and-permissions.md).

## The problem

An organization's IT function reviews a hosted product before its team uses it, and asks:

1. Can our people sign in with our directory?
2. Can that be the only way in?
3. When someone leaves, does their access end without anyone remembering to end it?
4. Where is the data, and what is the audit trail?

Only the fourth has an answer today: content is in the customer's GitHub repository, its
commit history is the audit trail, and access metadata is in the deployment's own D1.

There is one way in, an Auth.js email magic link. On a multi-tenant deployment that leaves no
way to tell which org an address belongs to before sign-in, no way to refuse the magic link for
an org that requires SSO, and no way to remove a person from outside the product.

## What exists

- **One Auth.js provider.** `src/auth/config.ts` registers a Resend magic link. `D1Adapter`
  keeps users, sessions, accounts and verification tokens in the platform D1
  (`migrations/0001_init.sql`). The accounts table is where a second provider's links go.
- **The config is built per request.** `buildAuthConfig` runs on every call because D1
  bindings are request-scoped. So the provider list, and each provider's settings, can be
  chosen per request. This is what makes per-org SSO cheap here.
- **The OAuth bridge is ours.** In `src/oauth/auth-handler.ts`, `/authorize` stashes the MCP
  client's request in KV (`PENDING_AUTH_TTL_SECONDS`), the person signs in, and
  `/oauth/complete` resolves the product identity (`resolveProductIdentity`) and claims pending
  invitations (`claimPendingInvites`). None of that changes when a provider is added.
- **Orgs, roles, guests and expiring invitations are built** (`src/lib/orgs.ts`,
  `src/lib/invites.ts`). Invitations store a hash of their token, not the token.
- **No per-org credential is stored.** `storage_connections` holds an installation id; the
  GitHub App key is a Worker secret. The design keeps it that way.
- **Entitlements are built.** `org_entitlements`, read through `hasFeature` and
  `getEntitlement` in `ee/entitlements.ts`, written by `pnpm entitle`.
- **The Auth.js Entra provider is installed** with `@auth/core` and takes an `issuer` per
  config. Given a tenant-specific issuer, it validates tokens against that tenant only.

## Prior art: PostHog

PostHog is open core, self-hostable, and sells enterprise identity to the same buyer. From
their source:

- **Built in-house** on python-social-auth and python3-saml. No identity vendor.
- **The SSO code is in the core**, under their MIT license: a multi-tenant SAML backend in
  `posthog/api/sso.py`. It moved there from `ee/`, which keeps aliases only so that sessions
  created before the move still restore.
- **The gate is a per-org feature list on the core Organization model**, populated by billing.
  SAML sign-in checks the SAML feature; the domain model checks SSO enforcement, then SAML or
  OIDC, before enforcing. An org without the feature is told it lacks the license.
- **Domains carry the governance settings.** Each organization domain row holds its JIT
  provisioning switch, its SSO enforcement setting, and its SCIM switch and token. A SAML
  assertion's email domain must match one of the config's verified domains, and a config with
  none cannot be used.
- **Instance-wide social sign-in is free.** GitHub and GitLab are configured per deployment by
  environment variable. Per-org OIDC, SAML and enforcement are paid.

Their documentation also warns that enforcing SSO leaves existing API keys working, that SAML
does not remove users (SCIM does), and that an untrusted identity provider can assert any email
address.

## Decisions

### D1. An entitlement check makes a feature enterprise

The boundary document decides by directory. That works for the model gateway, a separate
subsystem, and fails for sign-in, which every request passes through.

Revised: **a feature is enterprise if it checks an entitlement.** Most enterprise features
will still live in `ee/` because most can be separated. Enterprise identity cannot, so it lives
in the core and checks the entitlement where it runs.

Two consequences, stated plainly:

- **Sign-in stays free.** The magic link and a deployment-wide OIDC provider are not entitled.
  A self-hoster can point their own directory at their own instance without a subscription.
- **The check is a commercial gate, not a lock.** The code is AGPL, so a fork can delete the
  check; anyone serving that fork over a network must offer its source to their users. PostHog
  accepts the same exposure under MIT, with no such obligation.

### D2. The entitlement read moves into the core

Core code cannot call `hasFeature` while it is in `ee/`: the core never calls into `ee/` to do
its own job ([`.claude/rules/ee.md`](../../.claude/rules/ee.md)).

Move the read (`FEATURES`, `Entitlement`, `isActive`, `getEntitlement`, `hasFeature`) to its
own module in `src/lib/`. `ee/` keeps the grant tooling (`entitlementSql`,
`ENTITLEMENT_SOURCES`). Four files change their imports: `ee/review/gateway.ts`,
`scripts/entitle.ts`, `scripts/consolidate-report.ts` and `scripts/test-ee.ts`. The migration
stays where it is.

The moved code changes license, from the Enterprise License to the AGPL. `ee/` takes no
outside contributions, so that is the owner's decision alone.

This matches PostHog, where the per-org feature list lives on a core model.

### D3. Verified organization domains

A new table, org_domains: domain, org, challenge value, verified time, and the per-domain
settings below. Verification is a DNS TXT record, read over DNS over HTTPS. It is re-checked at
sign-in when the last check is more than a day old, so a lapsed domain stops routing sign-ins.
The Worker has no scheduled handler, and this does not need one.

A verified domain decides how everyone at that domain signs in, members or not. An unverified
claim routes nothing.

### D4. One multi-tenant application, pinned by issuer

Register one Entra application and have each customer's admin consent to it. Do not collect a
client id and secret per customer: that would store a credential per org and bring encryption
at rest and rotation with it.

A new table, identity_connections, maps an org to a provider and a tenant id. No credential.

**Pin the tenant through the issuer.** Because the config is built per request, the Entra
provider for an org is configured with that org's tenant-specific issuer,
`https://login.microsoftonline.com/<tenant id>/v2.0/`. A token from any other tenant fails
standard issuer validation before our code sees it. Then check the email domain against the
org's verified domains as PostHog does. Always pass `issuer` explicitly: the provider's
fallback reads `process.env` and then the `common` endpoint, which accepts any tenant.

**The callback rebuilds the same config.** Starting a sign-in records the chosen identity
connection in a signed, short-lived cookie. The callback request reads it to set the issuer,
and fails closed without it.

**The address comes from our own `profile()`.** The provider's default takes the `email`
claim, which Entra omits for a user with no mailbox, and fetches a Graph photo into a data URL.
Ours takes `email`, then `preferred_username`, lowercased, requests `openid profile email`
only, and fetches nothing. The account is keyed on `sub`. A tenant admin can set either claim,
so the address is trusted only because the issuer is pinned and its domain is verified for
that org.

### D5. Home-realm discovery

Sign-in asks for the email address first. A verified domain with an identity connection routes
to that provider; anything else gets the magic link. One provider id serves every tenant, so
there is one redirect URI.

### D6. SSO enforcement per verified domain

An enforced domain refuses the magic link for its addresses.

- **Enforce by domain, not by brain.** Guests are outside the org and cannot use its
  directory. Enforcing on a brain would lock out every guest the first time it was turned on.
- **Enforcing revokes.** OAuth grants issued before enforcement keep working until they
  expire, the same gap PostHog documents for API keys. Turning enforcement on revokes the
  domain's existing grants through the OAuth provider's grant listing and revocation calls
  (`listUserGrants`, `revokeGrant`), and deletes those users' rows in the Auth.js sessions
  table, which is what the web app signs in with.
- **Enforced grants are short-lived.** A grant issued to an address at an enforced domain gets
  a per-grant refresh-token lifetime of days, set at code exchange. A person disabled in the
  directory then loses access when it lapses, because the next sign-in goes through the
  provider. This bounds the leaver gap before SCIM exists.

### D7. Just-in-time provisioning

A first sign-in from a verified domain with JIT on creates a membership at the domain's default
role. Without it, SSO adds an invitation step instead of removing one. People at other domains
are still invited.

### D8. SCIM, in its own design

A SCIM endpoint per org, mapping to `memberships`, authenticated by a bearer token stored as a
hash the way invitation tokens are. It is the only answer to the leaver question: sign-in never
removes anyone. It needs its own design and battery.

### D9. The first SSO sign-in links to the existing account

A member who has signed in by magic link already has an Auth.js user, and the product identity
is keyed on that user's id. Auth.js refuses to attach a second provider to an existing address
unless the provider sets `allowDangerousEmailAccountLinking`.

Set it on the per-org provider. Auth.js runs the `signIn` callback before it links, and that
callback refuses any address whose domain is not verified for the org whose issuer was pinned.
Linking by address is safe only behind that check, so the flag is never set on a provider built
without a pinned issuer.

## Core and entitled

| Capability                            | Core | Entitled |
| ------------------------------------- | ---- | -------- |
| Magic link sign-in                    | yes  |          |
| One OIDC provider for a deployment    | yes  |          |
| Verified organization domains         |      | yes      |
| A provider per org (OIDC, later SAML) |      | yes      |
| SSO enforcement                       |      | yes      |
| Just-in-time provisioning             |      | yes      |
| SCIM                                  |      | yes      |

This is the boundary document's buyer test. A team running its own instance needs sign-in. An
organization buying central control of access is the compliance buyer.

## Why not WorkOS now

WorkOS supplies SAML, SCIM, directory sync and a self-service admin portal, priced per
connection. Not now, because:

- **The core cannot depend on it.** A self-hoster who needs a WorkOS account to sign in is not
  self-hosting. The core path gets built regardless, so a vendor adds a path.
- **It replaces the smallest part.** The OAuth bridge, identity resolution, invitations and
  membership stay ours. A vendor replaces only the Auth.js leg, and adds a hop to the hardest
  flow to debug.
- **The hard part already exists.** Per-org provider selection is what `buildAuthConfig`
  already allows.

Revisit when a customer's identity provider cannot do OIDC, or when SCIM and the admin portal
cost more in support than the vendor would. Moving in later is bounded: accounts map onto the
vendor's model, and verified-email linking joins them. Moving out is the expensive direction.

## Known gaps

- **People in several orgs.** An address at one org's enforced domain who is a guest elsewhere
  signs in through the enforcing org's provider. Whether that is always right is open.
- **Bootstrapping.** The org admin signs in by magic link to verify the domain and connect the
  provider. Enforcement must refuse to turn on until a test sign-in through the provider has
  succeeded, or the admin can lock the org out.
- **Unverified against a real tenant.** Whether the issuer string takes a trailing slash (the
  match against the discovery document is exact), and whether an admin can consent to the
  multi-tenant application before its publisher is verified.
- **Static mode.** `AUTH_MODE=static` has one operator and no sign-in. The governance tools
  register only when `multiUser` is true, like the member tools.
- **Sign-in audit.** Nothing records a sign-in as an event. The sessions table holds live
  sessions, not history, and usage counters are daily aggregates.
