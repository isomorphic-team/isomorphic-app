# The open-source boundary

- Status: decided 2026-07-27, at the point of making the repository public
- Related: [`docs/licensing.md`](../licensing.md), [`GOVERNANCE.md`](../../GOVERNANCE.md),
  [`docs/self-hosting.md`](../self-hosting.md)

This records where the line falls between what is in this repository and what belongs to the
hosted service, and the constraint that keeps the line from drifting.

## The rule

**Everything is in the repository. The hosted service is a deployment of it, not a fork of
it, and not a superset of it.**

The hosted service differs from your self-hosted instance in exactly three ways:

1. **Configuration.** Which auth mode, which identity provider, which Cloudflare account,
   which domain. All of it flows through `wrangler.template.jsonc` plus environment
   variables. See `scripts/setup-config.ts` for the complete list; there is no other input.
2. **Secrets.** A GitHub App private key, an Auth.js secret, an email provider key. Ours are
   ours; yours are yours.
3. **Operational work.** We run it, watch it, upgrade it, take the support calls, and carry
   the uptime. That is the actual product we sell.

There is no private module, no feature flag gating a paid capability, and no
`if (isHosted)` branch. If you find one, it is a bug worth an issue.

## Why not open core

Open core (a permissive core plus a proprietary paid layer) is the obvious alternative and we
rejected it. Three reasons, in order of how much they mattered:

- **It corrupts the roadmap.** Once a paid tier exists as a separate codebase, every design
  question acquires a second axis: not "is this the right shape" but "which side of the wall
  does this go on". Multi-brain support, roles, and the member roster are all things a
  self-hoster with a team genuinely needs, and all things a naive open-core split would have
  put behind the wall. The result is a public product deliberately kept mediocre.
- **It makes contribution feel like unpaid labor for a product you cannot fully use.** A
  contributor who fixes the index and then cannot use the feature it enables has learned
  something about the deal.
- **It splits the test surface.** Two configurations, and the one most people run is the one
  we exercise least.

AGPL plus a CLA lets us skip all of that. The commercial option comes from being able to sell
an exception to the copyleft, not from withholding capability, so the code can stay one thing.
See [`docs/licensing.md`](../licensing.md) for the license reasoning.

AGPL section 13 also turns the invariant at the bottom of this document into a legal
obligation rather than only a promise: because the hosted service runs unmodified `main` from
a public repository, there is nothing extra to disclose. A private hosted-only patch would
create a disclosure duty, which is a useful thing to have standing behind the rule.

## What "platform-izing" means here, then

Multi-tenancy is a feature of the software, not a proprietary wrapper around it. It is
already built and already public:

- An org model with roles (`src/lib/orgs.ts`), a member roster with invitations
  (`src/tools/members.ts`), and per-brain access resolution.
- Two identity modes, including email sign-in so members never need a GitHub account.
- Auto-provisioning, so a new user's brain is created on first use with no GitHub interaction.
- Model-B onboarding, where a customer keeps their brains in their own GitHub org under their
  own App installation (`src/tools/org-onboarding.ts`).

A self-hoster can turn every one of those on. Most will not want to, and will run
`AUTH_MODE=static` with one brain, which is why that path stays supported and documented
first. But the multi-tenant path is not a hosted-only capability; it is a configuration.

So "platform-izing" is a business activity: sales, support, compliance, uptime, billing, and
the accounts and infrastructure behind them. None of it needs to live in this repository, and
therefore none of it does.

## Where the line will be tested

Recording these now, with the answer, so that a future decision is a deliberate change rather
than a drift:

- **Billing and subscription management.** Not in this repository. It touches a payment
  processor and our own accounts, and a self-hoster has no use for it. This is the one clean
  example of something that is genuinely hosted-only, and note that it is infrastructure
  rather than product capability.
- **Usage metering and analytics.** Not in this repository, and not in the Worker. No
  telemetry, no phone-home, no anonymous usage beacon, in either the hosted build or yours.
  We can measure our own deployment from our own logs.
- **A future paid capability, for example a hosted synthesis agent that needs an LLM key.**
  In this repository, with the key as configuration. Self-hosters bring their own key. We
  bundle ours into the subscription. That is the pattern to reuse: the capability is public,
  the credential is the product.
- **Enterprise SSO / SAML.** In this repository. It is a provider slot in the Auth.js config,
  and putting it behind a wall would be the textbook open-core mistake this document exists to
  prevent.
- **Our own operational runbooks and infrastructure state.** Not in this repository. Generic
  runbooks are (`docs/ops/`); anything naming a real customer, account, or resource is not.
  The `/ops/` directory is gitignored for exactly this.

## The invariant that keeps this true

**The hosted service is deployed from `main`, with no patches.** If we ever need a change that
only makes sense for the hosted deployment, it goes in as configuration or it does not go in.

That is not a promise of goodwill, it is a structural constraint: the moment a private patch
exists, the reasoning above stops being true, and everyone can tell. Keeping it means
occasionally solving a problem more generally than we strictly need to, which is the price of
the deal and is usually the better design anyway.
