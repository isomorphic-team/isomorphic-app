# The open-source boundary

- Status: decided 2026-07-27, revised 2026-09-30 to open core for enterprise features
- Related: [`docs/licensing.md`](../licensing.md), [`GOVERNANCE.md`](../../GOVERNANCE.md),
  [`docs/self-hosting.md`](../self-hosting.md), [`ee/README.md`](../../ee/README.md)

This records where the line falls between the open source core, the enterprise features, and
the hosted service, and the constraints that keep each line from drifting.

## The rule

**Everything is in this repository. The hosted service is a deployment of it, not a fork of
it, and not a superset of it.** That part has not changed.

What changed on 2026-09-30: the repository now has two licenses.

- **Everything outside `ee/` is the core**, under GNU AGPL-3.0-only. It is complete on its own:
  a self-hoster with a team gets brains, members, roles, sharing, multi-brain, search, the
  editor, and the deterministic data-policy detectors, with no key and no limit.
- **`ee/` holds the enterprise features**, under the [Isomorphic Enterprise
  License](../../ee/LICENSE). The source is public and readable; production use needs a
  subscription. Each feature checks a per-org entitlement (`org_entitlements`,
  `ee/entitlements.ts`) and does nothing without one.

The hosted service differs from a self-hosted instance in four ways:

1. **Configuration.** Auth mode, identity provider, Cloudflare account, domain. All of it flows
   through `wrangler.template.jsonc` plus environment variables (`scripts/setup-config.ts`).
2. **Secrets.** A GitHub App private key, an Auth.js secret, an email key, a model provider
   key. Ours are ours; yours are yours.
3. **Entitlements.** Which orgs have which enterprise features. Rows in `org_entitlements`,
   written by the operator (`pnpm entitle`), never by code that asks whether it is hosted.
4. **Operational work.** We run it, watch it, upgrade it, take the support calls.

There is still no private module and no `if (isHosted)` branch. A feature is enterprise because
it lives in `ee/` and checks an entitlement, never because of where it runs.

## What goes in `ee/`, and what never does

**The test is who buys it.** A capability a team needs to work together stays in the core. A
capability an organization's compliance, security, or leadership function buys goes in `ee/`.
This is the buyer-based split GitLab uses, and it is the reason the original objection to open
core (below) no longer applies: the core is not kept incomplete for the people using it.

In `ee/`: model-powered review (the data-policy guard's model stages and brain consolidation),
the model gateway those use, and the entitlement check itself.

Never in `ee/`: multi-tenancy, orgs, roles, members, sharing, multi-brain, sign-in including
Enterprise SSO / SAML, the deterministic detectors, the findings queue and `resolve`, and
anything that fixes a bug in the core. A core feature never calls into `ee/` to do its own job.

## Why this is not the open core we rejected

The 2026-07-27 decision rejected open core for three reasons. Each is answered, not waived:

- **"It corrupts the roadmap."** The buyer test decides placement in one question, and the
  list above fixes the hard cases in advance. A feature that fails the test stays in the core.
- **"It makes contribution unpaid work on a product you cannot fully run."** `ee/` does not
  accept outside contributions (`CONTRIBUTING.md`), so no contributor's work lands behind the
  license, and everything a contribution to the core enables runs without a subscription.
- **"It splits the test surface."** One codebase, one test suite: the `ee/` batteries run in
  the same CI, and an unentitled org is just the core.

The commercial options are now two: an exception to the AGPL for organizations that cannot
ship copyleft (unchanged, see [`docs/licensing.md`](../licensing.md)), and a subscription for
the enterprise features.

## Where the line will be tested

- **Billing and subscription management.** Not in this repository. It writes entitlements; the
  code only reads them.
- **Usage metering.** The model gateway counts spend per org in the deployment's own D1 so it
  can enforce a cap. Nothing reports it anywhere; billing reads our own records.
- **Self-hosted enterprise use.** Needs a subscription and an entitlement row. Signed offline
  license keys come when a self-hoster needs them (roadmap, "brain review", step 6).
- **Sending content to a model provider.** Only the operator configures it, only to
  zero-data-retention endpoints, and only for an entitled org. This is processing on the
  operator's behalf, not telemetry.
- **Our own operational runbooks and infrastructure state.** Not in this repository. Generic
  runbooks are (`docs/ops/`); anything naming a real customer, account, or resource is not.

## The invariant that keeps this true

**The hosted service is deployed from `main`, with no patches.** Enterprise code ships in
`main` like everything else. If we ever need a change that only makes sense for the hosted
deployment, it goes in as configuration or an entitlement, or it does not go in.
