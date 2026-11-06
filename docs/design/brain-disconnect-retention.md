# Design: delete a brain's data when it is disconnected

Status: **proposed** (2026-11-05). Nothing here is built.

Related: [`privacy-checks.md`](./privacy-checks.md) (what the policy guard stores),
[`storage-and-tenancy.md`](./storage-and-tenancy.md) (why derived state is keyed by `brain_id`),
[`.claude/rules/org-model-and-permissions.md`](../../.claude/rules/org-model-and-permissions.md)
(what revocation deletes today).

## The problem

`disconnect_brain` (`src/tools/brains.ts`) calls `deleteBrainGrants`, then `deleteBrain`.
`deleteBrain` deletes only the `brains` row. Every other table with a `brain_id` column keeps its
rows, including `brain_pages`, whose `content` column holds the full text of every indexed page.

`resetIndex` (`src/lib/brain-index.ts`) already deletes four of those tables in one batch. Its only
caller is `configure_brain`, which uses it to force a full rebuild.

The org-model rule says revocation deletes what depends on it, and lists
`disconnect_brain → deleteBrainGrants`. The index and the review and policy tables are not on that
list.

## Why it matters

**1. Retention.** While the repository stays disconnected, the product cannot read these rows:
every read resolves a `brains` row through `tenantContext`, and that row is gone. Anyone with
direct database access still can. So we cannot truthfully say that disconnecting a brain removes
its content from the deployment, and the rows pile up, one set per brain ever disconnected.

**2. Reattachment.** `brain_id` is derived from the repository name: `brainIdFor` returns
`brain-<owner>-<repo>`. Connecting the same repository again, from any org, produces the same
`brain_id`, and the new brain picks up every row the old one left behind: review findings,
policy detections and their `actor_user_id`, dismissals with their `why` text and `dismissed_by`,
and pass state. If the second connection is from a different org, that org sees the first org's
review history and dismissal notes. The comment above `deleteBrainGrants` names exactly this risk
for grants; the fix stopped at grants.

Page text is not the concern in case 2, since the new org can read the repository anyway. The
exposure is the metadata the first org's people wrote.

## What is stored per brain

Every table with a `brain_id` column, from the schema after migration 0024:

| Table               | Holds                                                                 | Action           |
| ------------------- | --------------------------------------------------------------------- | ---------------- |
| `brain_pages`       | path, title, blob sha, full `content`                                 | Purge            |
| `brain_links`       | the link graph between pages                                          | Purge            |
| `brain_page_fields` | frontmatter values                                                    | Purge            |
| `brain_index_meta`  | indexed commit, rebuild cursor                                        | Purge            |
| `review_findings`   | `headline`, `evidence` (lines quoted from pages), `proposal`, author  | Purge            |
| `policy_detections` | path, kind, offsets, actor; never the matched text                    | Purge            |
| `policy_dismissals` | HMAC fingerprints, file sha, `why`, `dismissed_by`                    | Purge            |
| `policy_baseline`   | scan status and a cursor holding the last path scanned                | Purge            |
| `brain_passes`      | pass run state: status, cursor, counters                              | Purge            |
| `brain_pass_items`  | per-item fingerprints; `item` is a page path or pair of paths         | Purge            |
| `write_attempts`    | retry ledger; `summary` is the tool's reply text, replayed on retry   | Purge            |
| `invitations`       | rows with `brain_id` set are pending brain invites, with the email    | Purge            |
| `brain_memberships` | per-brain grants                                                      | Already deleted  |
| `usage_daily`       | per-day call and error counts by org, brain, user, tool               | Keep             |
| `feedback_reports`  | product feedback; `brain_id` records the active brain at report time  | Keep             |

Notes on individual rows:

- **Tables without page text still get purged** if they name paths. A list of paths plus "this
  one contained a private key" says where sensitive data sat, and should not outlive the brain.
- **`policy_baseline`** is being replaced by `brain_passes` (migration 0023 is the expand step),
  but current code still writes it. Purge both until a later migration drops it.
- **`write_attempts`** rows are pruned after 10 minutes, but pruning only runs when another write
  starts, so on a quiet deployment they stay. Purging them costs one statement.
- **`invitations`** has a foreign key to `brains` with no `ON DELETE` action, and D1 enforces
  foreign keys by default. A pending brain invite may already make `disconnect_brain` fail.
  Confirm this with a test before phase 1; if it does, phase 1 also fixes that bug.
- **`usage_daily`** is kept because it holds only integers and is what the analytics tab uses
  for history. Deleting one brain's rows would rewrite past totals. If keeping it ever becomes a
  problem, the fix is a retention window on the whole table.
- **`feedback_reports`** is kept because it is a report about the product, covered by its own
  privacy rules.
- **Attached media is not in the database.** `attach_media` commits files to the brain's
  repository, and downloads go through short-lived signed links (`src/lib/asset-link.ts`).
  Disconnecting leaves them in the repository the customer owns.

## The change

**One function.** Add `forgetBrain(db, brainId)` in `src/lib/`. It deletes every "Purge" row in
the table above, the grants, and the `brains` row, in a single `db.batch()`. The next table keyed
on `brain_id` then has one place to register. This follows the `effectiveBrainRole` pattern: the
logic sits in `src/lib/` where a test can call it, and the Worker only wires it in.

**One batch.** If the `brains` row were deleted first and the rest then failed, the remaining rows
would have nothing pointing at them. A single batch either runs completely or not at all.

**Also run it on connect.** `connect_brain` and `create_brain` should call `forgetBrain` on the
new `brain_id` before `createBrain` when no `brains` row exists for it. That closes reattachment
for residue already on disk, without waiting for the sweep in phase 3.

**Tests.** Per the testing policy: index a page, add a finding and a dismissal, disconnect, and
assert the rows are gone. Reconnect the same repository and assert no old finding or dismissal
comes back. Then remove the purge and confirm both assertions fail.

**Update the rule.** Add `disconnect_brain → forgetBrain` to
`.claude/rules/org-model-and-permissions.md`.

### Reconnecting after the fix

The brain gets the same `brain_id`, starts with no derived state, and rebuilds its index from the
repository. Previously dismissed policy findings come back. That is the safe direction, and it
matches `privacy-checks.md`, where rotating the secret behind the fingerprints has the same
effect.

## Phases

1. **`forgetBrain`, wired into disconnect and connect, with tests.** This is the whole
   user-visible fix.
2. **Other ways a brain goes away.** Org deletion, a repository deleted upstream, and an
   installation revoked. Each either calls `forgetBrain` or the doc states why not.
3. **Orphan sweep.** Delete rows whose `brain_id` matches no `brains` row, including rows that
   migration 0011 left keyed by `owner/repo`. Budget it and make it resumable like the other
   whole-brain passes. Until it runs, residue from past disconnects stays in the database.
4. **Document retention.** A section stating what each surface keeps and for how long, so the
   answer is written down rather than read out of the code.

Ship phases 1 and 2 together. Run phase 3 right after.

## Known gaps

- **Archived brains keep their data.** `brains.archived_at` hides a brain from the brain list
  queries without deleting it, and archiving is reversible. State this in phase 4; do not change
  it.
- **MCP clients keep their own history.** The server never calls a model, so a conversation that
  read a brain is stored by the client that made it, under that client's retention. Disconnecting
  cannot reach it.
- **No deletion receipt.** Phase 1 deletes rows but records nothing. Proving a purge ran means
  showing the rows are absent. A receipt would itself record that the brain existed, so adding
  one needs its own decision.
