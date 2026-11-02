# Enterprise features

The code in this directory is licensed under the [Isomorphic Enterprise License](LICENSE), not
the AGPL that covers the rest of the repository. You can read, run and modify it for
development and testing; production use needs a subscription. Why the line falls where it does:
[`docs/design/open-source-boundary.md`](../docs/design/open-source-boundary.md).

Every feature here checks a per-org entitlement and does nothing without one, so an unentitled
org runs the core product unchanged.

| Path                      | What                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `entitlements.ts`         | `hasFeature`: whether an org has the `enterprise` entitlement. Rows are written by `pnpm entitle`. |
| `review/gateway.ts`       | The model gateway: Haiku first, Luna as the fallback, entitled orgs only, a monthly cap.           |
| `review/consolidation.ts` | The consolidation pass: pages that contradict each other, as `conflict` findings.                  |

This directory does not accept outside contributions.
