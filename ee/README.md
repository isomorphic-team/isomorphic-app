# Enterprise features

The code in this directory is licensed under the [Isomorphic Enterprise License](LICENSE), not
the AGPL that covers the rest of the repository. You can read, run and modify it for
development and testing; production use needs a subscription. Why the line falls where it does:
[`docs/design/open-source-boundary.md`](../docs/design/open-source-boundary.md).

Every feature here checks a per-org entitlement and does nothing without one, so an unentitled
org runs the core product unchanged.

The reverse does not hold, by a decision taken on 2026-11-05: an entitled feature does not have
to live here. Enterprise identity will be gated by the same entitlement from inside the core,
because it is threaded through the sign-in path rather than separable from it
([`docs/design/enterprise-identity.md`](../docs/design/enterprise-identity.md), proposed). That
feature moves the entitlement read into `src/lib/`, leaving the operator's grant tooling here,
so core code can gate itself without calling into `ee/`. Nothing has moved yet.

| Path                      | What                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `entitlements.ts`         | `hasFeature`: whether an org has the `enterprise` entitlement. Rows are written by `pnpm entitle`. |
| `review/gateway.ts`       | The model gateway: Haiku first, Luna as the fallback, entitled orgs only, a monthly cap.           |
| `review/consolidation.ts` | The consolidation pass: pages that contradict each other, as `conflict` findings.                  |

This directory does not accept outside contributions.
