# Design: delete a brain's data when it is disconnected

Status: **partly built** (2026-11-06). Phases 1 to 3 are built; phase 4, a published retention
statement, is not.

Related: [`privacy-checks.md`](./privacy-checks.md) (what the policy guard stores),
[`storage-and-tenancy.md`](./storage-and-tenancy.md) (why derived state is keyed by `brain_id`),
[`.claude/rules/org-model-and-permissions.md`](../../.claude/rules/org-model-and-permissions.md)
(what revocation deletes).

## The problem

Before this change, `disconnect_brain` deleted the brain's grants and its `brains` row, and
nothing else. Every other table with a `brain_id` column kept its rows, including
`brain_pages`, whose `content` column holds the full text of every indexed page.

That had three consequences:

1. **Retention.** While the repository stayed disconnected, the product could not read the rows,
   because every read resolves a `brains` row through `tenantContext`. Anyone with database
   access could. We could not truthfully say that disconnecting removes the content.
2. **Reattachment.** `brain_id` is derived from the repository name (`brain-<owner>-<repo>`).
   Connecting the same repository again, from any org, produced the same id and picked up every
   row left behind: review findings, policy detections with `actor_user_id`, dismissals with
   their `why` text and `dismissed_by`, and pass state. A second org connecting the repository
   saw the first org's review history and dismissal notes. Page text was not the concern, since
   the second org can read the repository anyway.
3. **A failing disconnect.** `invitations.brain_id` has a foreign key to `brains` with no
   `ON DELETE` action, and D1 enforces foreign keys. Disconnecting a brain with a pending brain
   invite failed with `FOREIGN KEY constraint failed`.

## What is stored per brain

Every table with a `brain_id` column, as of migration 0025:

| Table               | Holds                                                                | On disconnect |
| ------------------- | -------------------------------------------------------------------- | ------------- |
| `brain_pages`       | path, title, blob sha, full `content`                                | Purged        |
| `brain_links`       | the link graph between pages                                         | Purged        |
| `brain_page_fields` | frontmatter values                                                   | Purged        |
| `brain_index_meta`  | indexed commit, rebuild cursor                                       | Purged        |
| `review_findings`   | `headline`, `evidence` (lines quoted from pages), `proposal`, author | Purged        |
| `policy_detections` | path, kind, offsets, actor; never the matched text                   | Purged        |
| `policy_dismissals` | HMAC fingerprints, file sha, `why`, `dismissed_by`                   | Purged        |
| `policy_baseline`   | scan status and a cursor holding the last path scanned               | Purged        |
| `brain_passes`      | pass run state: status, cursor, counters                             | Purged        |
| `brain_pass_items`  | per-item fingerprints; `item` is a page path or pair of paths        | Purged        |
| `write_attempts`    | retry ledger; `summary` is the tool's reply text, replayed on retry  | Purged        |
| `brain_memberships` | per-brain grants                                                     | Purged        |
| `invitations`       | rows with `brain_id` set are pending brain invites, with the email   | Purged        |
| `usage_daily`       | per-day call and error counts by org, brain, user, tool              | Kept          |
| `feedback_reports`  | product feedback; `brain_id` records the active brain at report time | Kept          |

Why each disposition:

- **Tables without page text are purged** if they name paths. A list of paths plus "this one
  contained a private key" says where sensitive data sat, and should not outlive the brain.
- **`policy_baseline`** is being replaced by `brain_passes` (0023 is the expand step), but current
  code still writes it, so both are purged until a later migration drops it.
- **`write_attempts`** rows are pruned after 10 minutes, but only when another write starts.
- **`usage_daily`** holds only integers and is the analytics history. Deleting one brain's rows
  would rewrite past totals. If keeping it becomes a problem, the fix is a retention window on
  the whole table.
- **`feedback_reports`** is a report about the product, covered by its own privacy rules.
- **Attached media is not in the database.** `attach_media` commits files to the brain's
  repository, and downloads go through short-lived signed links (`src/lib/asset-link.ts`).

## What was built

**`src/lib/brain-forget.ts` owns the list.** `BRAIN_PURGED_TABLES` and `BRAIN_KEPT_TABLES` name
every table above. `pnpm test:access` reads the live schema and fails on a table with a
`brain_id` column that is in neither list, so a new table cannot be missed the way the index
was.

- **`forgetBrain`** deletes the purged rows and the `brains` row in one `db.batch()`, grants and
  invites before the row they reference. `disconnect_brain` calls it. One batch, so a failure
  part way cannot remove the `brains` row and leave rows that nothing points at.
- **`createBrain`** runs `clearBrainResidueStatements` in the batch that inserts the brain,
  deleting rows under the new id in `BRAIN_UNLINKED_TABLES` (the purged tables with no foreign
  key to `brains`, the only ones residue can sit in). Every creation path goes through it, so
  a reconnected repository starts empty. It is a no-op when a brain holds the id, which keeps it
  safe if two repository names ever slugify to the same id. `brainIdFor` (`src/lib/orgs.ts`) is
  the one place the id is derived.
- **`forgetBrainsStatements`** takes a subquery of brain ids and deletes their purged rows and
  then the brains rows, from one selector. `forgetBrain` passes one id; `ensureStaticTenant`
  passes the brains config no longer names. That function runs once per request, so it checks
  for such a brain first and adds the statements only when one exists.
- **`resetIndex`** drops `BRAIN_INDEX_TABLES`, the same constant the purge list starts from.
- **Migration 0025** deletes rows whose `brain_id` matches no `brains` row, in every purged table,
  including rows that 0011 left keyed by `owner/repo`, and indexes `invitations.brain_id`. It
  writes one row per orphaned row.

The `disconnect_brain` tool description now says Isomorphic deletes its own copy of the brain.

**Tests** (`pnpm test:access`): one row is seeded in every `brain_id` table for two brains, one is
forgotten, and the battery checks that every purged table is empty for it (including with a
pending brain invite), that kept tables are untouched, that the other brain is untouched, that
`BRAIN_UNLINKED_TABLES` matches the schema's foreign keys, that `createBrain` starts a
reconnected repository empty and clears nothing under a live brain's id, that 0025 covers every
purged table and deletes orphans, and that a static config change purges the old brain's index.
Removing the purge from `forgetBrain`, or the purge from `ensureStaticTenant`, turns it red.
The one call in `disconnect_brain` (`src/tools/brains.ts`) is not covered by a battery.

### Reconnecting

A reconnected repository gets the same `brain_id`, starts with no derived state, and rebuilds its
index from the repository. Previously dismissed policy findings come back. That is the safe
direction, and it matches `privacy-checks.md`, where rotating the secret behind the fingerprints
has the same effect.

## Phases

1. **Built.** `forgetBrain` in `disconnect_brain`, residue cleared inside `createBrain`, and the
   tests.
2. **Built.** Other ways a brain goes away. The only other one in the code is
   `ensureStaticTenant` dropping a brain from earlier config, which now purges. There is no org
   deletion, and no webhook for a repository deleted upstream or an installation revoked; each
   should call `forgetBrain` when it is built.
3. **Built.** The orphan sweep, as migration 0025 rather than a budgeted pass, since the rows
   it deletes are bounded by what past disconnects left.
4. **Not built.** A retention section stating what each surface keeps and for how long, so the
   answer is written down rather than read out of the code.

## Known gaps

- **Archived brains keep their data.** `brains.archived_at` hides a brain from the brain list
  queries without deleting it, and archiving is reversible.
- **Random ids would be the deeper fix for reattachment.** A random `brain_id` for new brains
  would make reattachment impossible and close the collision below, but changes what an id
  looks like, so it is left as a separate decision. It would not help retention.
- **Id collisions.** `brainIdFor` maps `a-b/c` and `a/b-c` to the same id. Clearing residue
  will not delete a live brain's rows because of it, but connecting the second repository still
  fails on the primary key. That predates this change.
- **MCP clients keep their own history.** The server never calls a model, so a conversation that
  read a brain is stored by the client that made it, under that client's retention.
- **No deletion receipt.** A purge records nothing. A receipt would itself record that the brain
  existed, so adding one needs its own decision.
