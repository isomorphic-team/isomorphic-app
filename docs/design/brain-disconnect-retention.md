# Design: what a disconnected brain leaves behind

Status: **proposed** (2026-11-05). Nothing here is built.

Related: [`privacy-checks.md`](./privacy-checks.md) (what the guard records and why it records
offsets rather than values), [`storage-and-tenancy.md`](./storage-and-tenancy.md) (which
credential reaches which repo), [`org-roles-permissions.md`](./org-roles-permissions.md) (what
revocation tears down today).

## The problem

`disconnect_brain` removes the pointer and the grants. It does not remove the derived copy of
the brain's content.

The handler calls `deleteBrainGrants` and then `deleteBrain`, and `deleteBrain` is a single
statement against `brains`. Every other table keyed by `brain_id` keeps its rows. That includes
`brain_pages`, whose `content` column holds the full text of every indexed page.

`resetIndex` (`src/lib/brain-index.ts`) already does most of the right cleanup. It exists for a
different reason: dropping the index so the next freshness check does a full rebuild when the
content shape changes. Nothing calls it from the disconnect path.

The org model states the principle already: revocation tears down what hangs off it,
`disconnect_brain` to `deleteBrainGrants`, `remove_member` to `deleteUserBrainGrantsInOrg`. The
derived index is simply missing from that list.

### What this is, and what it is not

The orphaned rows are **not reachable through the product**. Every read resolves an org, a role
and a brain through `tenantContext`, keyed on a `brains` row that no longer exists, so no
request can name the brain and no tool can return its pages. Search is scoped by `brain_id`
resolved the same way.

So this is a **retention** gap, not an access-control gap. Nobody gains access they did not
have. What it costs is the ability to say, accurately, that disconnecting a brain removes its
content from the deployment. An operator querying the database directly can still read it, and
that operator is the one party the sentence was supposed to reassure a customer about.

It also compounds silently. A deployment accumulates one orphaned index per brain ever
disconnected, with no surface that lists them and no query that would notice.

## What is stored per brain today

Every table carrying a `brain_id`, and what it holds:

| Table                | Holds                                                           | Content? |
| -------------------- | --------------------------------------------------------------- | -------- |
| `brain_pages`        | `content`: each page's full text, plus title and blob sha        | Yes      |
| `brain_links`        | the link graph between pages                                     | Derived  |
| `brain_page_fields`  | frontmatter field values, extracted from page content            | Derived  |
| `brain_index_meta`   | index state and the rebuild cursor                               | Pointer  |
| `review_findings`    | `headline`, `evidence` (lines quoted from pages), `proposal`     | Yes      |
| `write_attempts`     | the retry ledger: fingerprint, state, `summary`                  | Likely   |
| `policy_detections`  | path plus detection kind and offsets, never the matched text     | Pointer  |
| `policy_dismissals`  | one keyed HMAC per dismissed value                               | Derived  |
| `policy_baseline`    | scan status, counts, and a cursor holding the last path handled  | Pointer  |
| `brain_passes`       | pass run state: status, cursor, counters                         | Pointer  |
| `brain_memberships`  | per-brain grants                                                 | No       |
| `usage_daily`        | per-day counters at (day, org, brain, user, tool)                | No       |

"Pointer" means the row holds no page text but still says something about the content: which
paths existed, and for `policy_detections`, which of them held sensitive data of which kind. A
list of paths plus "this one had a private key in it" is not nothing, and it outlives the
pages it describes.

Two things are **not** in this table on purpose:

- **Attached media lives in the brain's own repository.** `attach_media` commits through the
  store like any other write, and downloads are served through a short-lived signed link
  (`src/lib/asset-link.ts`) rather than a stored copy. Disconnecting leaves the files where
  they always were, in the repository the customer owns.
- **`feedback_reports` is keyed by an `owner/repo` string, not a `brain_id`.** It is a report
  about the product submitted by a person, not brain data, and it is covered by its own privacy
  rules.

## The decision

**Disconnect forgets content.** Anything that holds page text, quotes it, or records where it
sat is purged when the brain is disconnected. Counters that carry no content are kept.

| Disposition | Tables |
| ----------- | ------ |
| **Purge on disconnect** | `brain_pages`, `brain_links`, `brain_page_fields`, `brain_index_meta`, `review_findings`, `write_attempts`, `policy_detections`, `policy_dismissals`, `policy_baseline`, `brain_passes` |
| **Keep** | `usage_daily` |
| **Already handled** | `brain_memberships`, via `deleteBrainGrants` |

Why `usage_daily` stays: it holds integers at a day grain and no content, it is what answers
whether an org uses its brains at all, and zeroing a month's history because one brain was
disconnected would make the analytics tab lie about the past. It never leaves the deployment's
own database. If that answer ever stops being comfortable, the fix is a retention window on the
whole table, not a purge keyed on one brain.

Why the policy tables go, despite holding no matched text: a path plus a detection kind is a
map of where sensitive data sat, and it is exactly the thing a reader should not find for a
brain the deployment no longer serves. The dismissal fingerprints go with them.

### Reconnecting

A repository connected again is a new brain with a new `brain_id`. The index rebuilds from the
repository, which is the source of truth, so nothing of substance is lost. Previously dismissed
policy findings re-raise, because the dismissals were purged with everything else. That is the
safe direction and it matches the existing reasoning in `privacy-checks.md`, where rotating the
key behind the fingerprints re-raises dismissals for the same reason.

## The shape of the change

**One function owns the list.** A single `forgetBrain(db, brainId)` in `src/lib/`, db-only and
directly callable from a test, so that the next table keyed on `brain_id` has one obvious place
to register itself. This is the same shape as `effectiveBrainRole`: the decision lives where a
test can reach it, and the Worker only wires it in. A purge spread across call sites is how the
index came to be missed in the first place.

**Order matters.** If the `brains` row is deleted first and the purge then fails, the content is
orphaned with nothing left pointing at it, so no cleanup keyed on `brains` can ever find it
again. The purge runs first, or the whole thing runs as one `db.batch()`.

**The test has to go red.** Per the testing policy: disconnect a brain with an indexed page,
assert the row is gone, then remove the purge and confirm the assertion fails.

## Phases

1. **`forgetBrain` plus the disconnect wiring.** The function, the full table list, one batch,
   and the battery that proves it. This is the whole user-visible fix.
2. **The other exit paths.** Deleting an org, a repository deleted upstream, an installation
   revoked, and a repository reconnected under a fresh `brain_id` while the old rows survive.
   Each either routes through `forgetBrain` or gets a stated reason not to.
3. **The orphan sweep.** Every existing deployment already carries residue from every brain it
   has ever disconnected, and phase 1 does nothing about that. A sweep over rows whose
   `brain_id` matches no `brains` row, budgeted and resumable like any other whole-brain pass.
   This is the phase that changes what is true of data already on disk.
4. **Say it in the docs.** A retention section stating what each surface keeps and for how long,
   so the question has a published answer instead of a code-reading exercise. `SECURITY.md`
   already tells self-hosters that a private brain belongs in a private repository; this is the
   same kind of statement about the derived copy.

Phases 1 and 2 are one change. Phase 3 should follow immediately, because the sentence the fix
is meant to support stays false until it runs.

## Known gaps

- **Archived brains keep their index**, deliberately: `brains.archived_at` filters a brain out
  of the two base queries without removing it, and archiving is reversible. Worth stating in
  phase 4 rather than changing.
- **`write_attempts.summary` needs reading before phase 1.** It is listed as content above on
  the strength of its name and the retry ledger's purpose. If it turns out to hold only a
  status string, it moves to the keep column, and the doc should say which.
- **Nothing here covers the MCP client's own history.** The server never calls a model, so a
  conversation that read a brain lives with whatever client made the call, under that client's
  retention. Disconnecting a brain cannot reach it, and no change proposed here pretends to.
- **No deletion receipt.** Phase 1 purges rows; it does not record that it did. An operator
  asked to prove a purge ran has only the absence of rows. A receipt would mean writing down
  that a brain existed, after deciding to forget it, which needs its own argument.
