# Design: the seam between brains

- Status: Draft for discussion. Nothing built. Open questions in §18 are unresolved.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-19. Supersedes the 2026-08-10 draft, which treated publishing as the only
  mechanism and ruled shared surfaces out of scope.
- Audience: the engineering session that picks this up, and Jon deciding whether it should exist
- Related: `docs/design/derived-views-and-sync-prd.md` (FR-3 importer, FR-4 source of truth),
  `docs/design/records-tables-prd.md` (which owns motivating flow 1, see §3),
  `docs/design/brain-level-permissions.md`, `docs/roadmap.md` (bulk page updates),
  `CLAUDE.md` (Brain model, Content index, Bulk import)

## 1. Summary

One person reaches several brains. Work done in one belongs, partly, in another: a client
engagement's deliverables, a personal to-do list that tracks client work, a venture's
methodology that a client should see. Today the only transport between two brains is a human
copying text, and nothing records that the copy happened, so the two diverge silently from the
moment they are made.

The previous draft proposed one mechanism for all of it: a declared, one-directional,
key-addressed flow of pages from one brain to another. That mechanism is still here and still
right, but it is one of three, and the smallest of the three.

What changed is the reach of §3's test. The discriminating question is not "which brain is it in"
but **who needs it**, and that question has a third answer once access can be granted across an
organization boundary. A reader who **can** be granted access needs no copy at all. A reader who
**cannot** is the only case where content must physically cross. Separating those shrinks
publishing to the case it is actually for, and gives collaboration a mechanism that publishing
could never have provided.

Two load-bearing claims, one per half:

- **Publication is mostly built.** `sync_records` is a non-destructive, key-addressed, idempotent,
  ledger-backed importer with proposed-not-applied deletions and a no-resurrection rule. Those are
  exactly the semantics a cross-brain flow needs, and they are already tested. The genuinely new
  work is reading two brains in one request, a body-ownership policy the importer does not have,
  and a trigger.
- **Collaboration needs exactly one new primitive:** a brain reachable by someone who is not a
  member of its organization. Everything else it wants (per-brain authorization, multi-brain
  resolution, per-brain index isolation, a shared writable repository) already ships.

### Terminology

- **Seam**: any declared relationship between two brains. Three kinds, §5.
- **Shared brain**: the storage behind a collaboration. An ordinary brain with grants on both
  sides, not a new kind of object.
- **Publication / subscription**: the two halves of a publication seam's declared config, §7.
- **Connection**: the product-level object a user manages, §12. A connection has a kind and wraps
  the mechanism.

## 2. Motivating case

Three brains, one person:

- A **client brain** for a consulting engagement. Shared with the client. Contains engagement
  material the client is entitled to see.
- A **personal brain**. To-dos, time tracking, working notes, everything.
- A **venture brain**. Methodology, offers, positioning. Some of it is material a client should
  receive; some of it is commercially sensitive.

Four flows the person wants. The first three are from the original draft; the fourth is what the
original had no mechanism for and declared out of scope.

1. Time entries and to-dos in the personal brain that are tagged to a client should be visible
   in that client's brain, or at least should roll up there.
2. A deliverable authored in the venture brain should land in the client's brain.
3. A page in the client brain should be findable while working in the venture brain.
4. A working document the consultant and the client both edit, owned by neither.

## 3. The reframe: who needs it

Flows 1 and 2 look alike and are not. The discriminating question is not "which brain is it in"
but **who needs it**:

- **"I need to find it."** The reader is the same person, who already has access to both brains.
  Nothing needs to move. What is missing is a **read** that spans a person's brains. Copying to
  solve this is strictly worse: it creates a second copy that drifts, for a reader who could have
  read the original.
- **"Someone who cannot reach my brain needs to see it."** The reader is a client, and the client
  cannot and must not read the personal brain. Content must physically cross into a repository
  they can read. This is **publishing**, and it is the only case where copying is the right answer.
- **"Someone who could be granted access needs to work on it with me."** The reader is a client,
  the content is not confidential to either side, and it does not belong to either brain. Nothing
  needs to cross, because the reader can be admitted to the place the content lives. This is
  **collaboration**, and it is new here.

Flow 3 is entirely the first kind. Flow 2 is entirely the second. Flow 4 is entirely the third.
Flow 1 is mixed and mostly the first: the person wants to _see_ their client to-dos while in the
client brain, which is a read across a boundary they already have, unless the client is meant to
see them too.

The third answer only exists because access can be widened. In the model as it stands today it
cannot: a brain is reachable only from its own organization (§6.1), so "admit the reader" was not
an available move and every cross-boundary want collapsed onto publishing. That is the single
constraint whose removal reorganizes this document.

**Flow 1 has a fourth answer that is probably the right one**, and it is not in this document.
Time entries and dated to-dos against a client are activity records, not pages, which is the
subject of `docs/design/records-tables-prd.md`. Modeled there, the cross-brain question stops
being "does this page cross" and becomes "can an aggregate over records cross a seam", which is a
sharper and smaller question: a client is owed the rollup ("14 hours this month against the
engagement"), not the underlying entries. Neither this document nor that one answers it yet, and
whichever is built second should.

Naming the mechanism **publication** rather than **sync** keeps this straight, and puts the
question that actually matters (who is now able to read this) in the name of the feature.

## 4. Hard constraints

Inherited from the architecture and not up for renegotiation here:

- **The repository is the source of truth. D1 is a cache.** Seam state lives in the repos, not in
  a platform table, so it survives a D1 wipe, diffs in review, and travels with the brain. Access
  grants are the exception and always were: they are platform state by nature.
- **No webhooks.** Freshness is a read-time guard (`ensureFresh`). Anything that claims to happen
  "automatically" has to say which read or which call it rides on.
- **No unbounded work in one request.** A whole-brain pass must be budgeted, cursored, and
  resumable, per the `rebuild_cursor` pattern.
- **Nothing hosted-only.** A seam is configuration in two repositories plus grants in the
  deployment's own D1, not a platform feature that only the hosted deployment can run. This rules
  out the platform-owned relationship repository, §6.2.
- **Multi-tenant isolation is the default.** Every index query is keyed by `brainId`. A seam is
  the one deliberate hole in that, so it has to be narrow and explicit.
- **A page has exactly one home brain.** Unchanged from the previous draft, and collaboration does
  not violate it: the shared brain **is** the home. There is still no page that lives in two
  brains at once.
- **One brain, one file tree.** The tree backs wikilink resolution, folder-note lookup, and the
  path policy, and is dropped on brain change for that reason (`setActiveBrain`,
  `app/core/store.ts`). No mechanism here merges foreign content into it, §13.

## 5. Three relationships, three mechanisms

|                   | Owner                            | Content crosses | Mechanism                            |
| ----------------- | -------------------------------- | --------------- | ------------------------------------ |
| **Collaboration** | Neither; co-owned                | No              | A shared brain, grants on both sides |
| **Publication**   | Sender, permanently              | Yes, one way    | Keyed flow, `body: source-owned`     |
| **Handoff**       | Transfers to receiver on arrival | Yes, once       | Keyed flow, `body: seed`             |

The kinds are not points on a spectrum and do not compose. Two publication seams pointed at each
other produce **correspondence**, not collaboration: each side owns its own artifacts and sends
copies, a page never becomes co-owned, and a receiver who edits an arrival has forked it. That is
the right shape for deliverables going out and status coming back. It is the wrong shape for a
document two people write.

Part I is collaboration, Part II is publication and handoff, Part III is how either appears in the
product.

---

# Part I: Collaboration

## 6. The shared brain

A collaboration is a brain both parties can write, living in one party's organization, with the
other party granted access to it directly. No copy, no mount, no third mechanism. Both sides open
the same brain, and every content tool already resolves it: `brain` is an argument on all of them,
`matchBrain` resolves the handle, `effectiveBrainRole` authorizes against the brain actually
named, and the index isolates by `brainId`.

This is §3's first answer applied across an organization boundary. The reader has access, so
nothing needs to move.

### 6.1 The missing primitive: cross-organization brain grants

Resolution today starts from organization membership. `listAccessibleBrains` (`src/lib/orgs.ts`)
runs:

```sql
FROM memberships m
JOIN orgs o   ON o.org_id = m.org_id
JOIN brains b ON b.org_id = o.org_id
LEFT JOIN brain_memberships bm ON bm.brain_id = b.brain_id AND bm.user_id = m.user_id
WHERE m.user_id IN (...)
```

A `brain_memberships` grant is a LEFT JOIN on top of that set, so it can only **raise** a role on
a brain the caller can already see. There is no way to express access to a brain in an
organization you do not belong to.

The change is a second resolution branch: brains reached by direct grant, unioned with brains
reached by organization membership.

- `effectiveBrainRole` (`src/lib/orgs.ts:90`) already takes `grant` as one of three additive
  sources, so **the policy rule survives**. What changes is its `orgRole` becoming nullable, and
  the grant-only path returning the grant alone. Sources (1) and (3), organization visibility and
  the organization-admin floor, are both inapplicable to an outsider and are skipped, which is
  what "not a member" should mean.
- `pnpm test:access` already walks the whole input space of that function, so the new input shape
  is a widening of an existing battery rather than a new one.
- Nothing changes at the GitHub layer. A brain in organization A is served by A's installation
  token, minted from `orgs.installation_id` on the brain's row. The blocker was never
  reachability; it was our own join.

That last point decides §6.2: **the constraint people reach for a platform-owned repository to
solve is a schema decision of ours, not a limit of git, GitHub, or installations.**

### 6.2 Why the shared brain is not platform-owned

The obvious alternative is a relationship repository in the platform organization, granted to both
sides. It does not work, and the reason is instructive.

Put a repository in the platform organization and grant it to A and B. Now ask how B reaches it. B
is not a member of the platform organization, so the join above returns nothing. **Platform
ownership solves reachability and does nothing about access.** It needs the identical primitive
from §6.1, and once that exists it buys nothing the simpler topology does not already have.

What it would still buy is **neutral custody**: neither party can unilaterally delete the shared
surface or rewrite its history, which matters when a relationship ends badly. Against that:

- **It strains the hosted-only rule.** `PLATFORM_ORG` is configuration, so a self-hoster sets
  their own and the letter of the rule holds. But a Model B customer organization has its own
  installation and cannot write to the platform organization, so the platform installation becomes
  structurally load-bearing in a transaction between two parties that otherwise have no
  relationship with it.
- **It changes what the operator holds.** The platform brokers today: it mints tokens and keeps a
  derived index that is explicitly a rebuildable cache and never the source of truth. A
  relationship repository is durable content, and for a Model B seam it means two customer
  organizations' co-authored working material sits in a repository we own, when we previously had
  access to neither brain. That changes the answer to "where does our data live", changes the DPA,
  and creates an orphaning question at the end of a relationship: delete it and their record is
  gone, keep it and we hold a former customer's client material indefinitely.
- **It is a silo, for the content least able to afford one.** Content in the customer's own
  repository is theirs when they leave, readable without us. That property is most of why this
  product is GitHub-backed.

The Worker is already the neutral meeting point and it holds nothing: bytes live in memory for the
length of one request. Platform ownership converts a transient broker into a durable custodian.

**Recommendation: the shared brain lives in one party's organization**, defaulting to whoever
created it, with the other party granted in. Revisit platform custody only if a real relationship
produces a dispute the grant model cannot survive.

### 6.3 Why not git submodules

Submodules recur in every discussion of this problem and are worth disposing of properly, because
the naive version and the sophisticated version fail differently.

**Submoduling the sending brain into the receiving brain** fails at four layers:

- **The content index cannot see it.** `listTree` (`src/lib/brain-repo.ts`) filters
  `e.type === 'blob'`. A submodule is a `commit` entry (mode 160000) and is silently dropped, so
  every read tool that runs off the index sees nothing at that path and `fetchPages` never gets a
  blob sha.
- **Wrong granularity.** A submodule is whole-repository. §9 argues what should cross is usually a
  selection, not a location, and a submodule cannot express "pages carrying `publish_to: X`".
- **It inverts the access model.** Anyone who can read the parent reads the submodule's full
  extent, bypassing `effectiveBrainRole` entirely, with no redaction, no link horizon, and no
  provenance stamp. It is the transitive-closure option §9 rejects, implemented in git.
- **It breaks write atomicity.** `commitFiles` atomicity is what makes an edit batch never
  half-applied. A write spanning a submodule boundary is two commits in two repositories.

**A publication repository per relationship**, mounted as a submodule, is the sophisticated version
and repairs the middle two: the repository _is_ the publication, so whole-repository is the right
unit, and selection and redaction happen writing into it. It also yields a pinned sha as exact
version provenance and an auditable record of what was sent. It still fails:

- The index blindness above is unchanged.
- **The receiver cannot file arrivals.** A submodule is a fixed mount. §8's rule that the receiver
  may move an arrival anywhere and the next run finds it by key becomes impossible, and moving a
  page out means copying it out, which recreates the drift this document exists to prevent.
- **No per-page identity.** A submodule pins a subtree, not keyed pages. Unpublishing becomes a
  page vanishing on the next pointer bump rather than a proposed deletion, and the no-resurrection
  rule is unimplementable because the receiver can remove nothing.
- **The publication repository does all the work and the mount does none of it.** Once a repository
  holds exactly the redacted published set, the receiver can mount it or sync from it with the
  importer that already exists. Choosing the mount changes only how bytes land, and pays for that
  with receiver filing, per-page identity, and proposed deletions.

**Bidirectional submodules** are legal (pinned shas terminate rather than cycling) but give
correspondence, not collaboration, per §5: a gitlink is a read mount, and writing into it means
committing in the other repository. Two mounts also mean each repository transitively contains a
stale snapshot of itself, so any resolver would have to cap recursion at depth 1.

The version pin and the audit record are real wants. They are cheaper elsewhere: the sender keeps
a published-manifest page in its own brain (§11), and the receiver keeps the upstream sha in its
own ledger. Each party holds their half, in a repository they own.

### 6.4 What collaboration does not solve

**Concurrent edits to one page are still last-writer-wins.** Git merges files; our write path does
read-modify-write against the authoritative blob and moves the branch ref. Two people editing the
same page in the same window will clobber. `write_page`'s `edits` (exact anchors, refused on zero
or multiple matches) is a partial mitigation and is the thing to lean on, but it is not a merge
story and should not be described as one. Last-writer-wins with conflict pages remains rejected
(§10): a conflict page is a to-do item nobody clears.

**Round-tripping a published document is a different problem**, and collaboration does not cover
it, because a published page is single-owner by construction. Two mechanisms preserve that
ownership while allowing a response:

- **A comment layer.** The received page stays read-only. The receiver writes a sibling page
  carrying `responds_to: <source_key>`, which flows back on their own return seam. In the sending
  brain the original renders an `okf-view` of its responses. Built entirely from machinery that
  exists: keyed pages, `backlinksTo`, a return seam. It matches how review works, where the
  document has one author and the feedback has others, and they are different objects rather than
  one contested object.
- **Propose-back as a pull request.** `commitOrPR` (`src/lib/brain-repo.ts:550`) already takes
  `writeMode: 'pull-request'` and builds the branch, tree, and PR. "Suggest an edit" on a received
  page opens a PR against the sending repository instead of writing locally. Single ownership,
  explicit review, no new storage topology, and it is what PRs are for.

Of the two, propose-back is the cheaper and the more direct answer to "B wants to change A's
document". The comment layer is the better answer to "B wants to say something about it".

### 6.5 Cross-organization grants are a confidentiality surface

A grant that crosses an organization boundary is a mechanism for one organization's admin to
expose a brain to an outsider. It needs the same care §11 gives publishing:

- **Both ends, or an organization-level policy.** A brain-scope admin in A granting a user in B is
  A's decision alone under the current sharing rules. At minimum an organization setting ("this
  organization permits external grants"), and possibly the §7 both-halves-declare property.
- **Outsiders are visibly marked.** In `brain_access`, in the roster, and anywhere a brain's
  audience is shown. An outsider must never read as an ordinary colleague.
- **The organization roster must not leak.** `members` is organization-scope and an outsider with
  a brain grant must not reach it. The two-role split (`role` vs `orgRole`) is exactly what
  prevents this, but no test has ever exercised a **grant-only caller**, whose `orgRole` is null.
  That is a new input shape for `pnpm test:scope` and it should be added with the primitive, not
  after it.
- **Billing and seats are unanswered.** A user in organization A working in organization B's
  brain: who counts them, and does `personUserIds` identity linking let someone widen their own
  reach across the boundary?

---

# Part II: Publication

Everything in this part is one-way, keyed, and reconciled. It is the mechanism for §3's second
answer, and only that.

## 7. Model: publications and subscriptions

A publication seam has two halves, declared independently in the two repositories, joined by a
shared id.

**The sending brain declares a publication** in `.isomorphic.json`:

```jsonc
{
	"publications": {
		"nw-engagement": {
			"select": { "field": "publish_to", "equals": "nw-engagement" },
			"fields": ["type", "status", "owner", "due"],
			"body": "source-owned"
		}
	}
}
```

**The receiving brain declares a subscription**:

```jsonc
{
	"subscriptions": {
		"nw-engagement": {
			"from": "example-org/venture-brain",
			"into": "wiki/from-venture/",
			"writes": "read-only"
		}
	}
}
```

The seam runs only where both halves exist and name each other. Neither end can unilaterally
open a channel into the other, and both ends are legible to anyone reading either repository in
git, which is the property everything else in this product has.

Why both ends: a publication declared only by the sender is content pushed into someone else's
repository without their say. A subscription declared only by the receiver is a pull out of
someone else's repository without theirs. Requiring both makes the handshake explicit at the
only layer that is durable, which is the file.

Authorization is checked **on every run, not at setup**: the caller must hold `editor` on the
receiving brain and at least `viewer` on the sending one, resolved through `effectiveBrainRole`.
A seam does not confer standing access; losing access to either brain stops the flow on the next
attempt.

## 8. Identity is a key, never a path

"Keep the directories stable" is the right instinct aimed at the wrong mechanism. Paths are the
one thing this product is explicitly good at changing: `move_page` repoints every inbound link,
and reorganizing a brain is normal maintenance rather than a migration. A seam keyed on path
turns a routine tidy on either side into a delete plus a create, which duplicates, resurrects, or
destroys depending on which side moved.

So identity is an explicit key, exactly as the importer already does it:

- Each published page carries a stable key. The obvious default is the page's own `source_key`
  if it has one, or a generated id stamped into frontmatter on first publication.
- The received page carries `source_key: <that key>` plus the seam id, which is how the next run
  finds it wherever it has since been moved.
- The `into:` folder is the **landing place for arrivals**, not the identity. Once a page has
  landed, the receiving brain may file it anywhere; the seam still tracks it.
- The per-seam ledger (`.isomorphic/imports/<seam>.json`, the existing file and format) records
  every key ever received, so a page the receiver deleted stays deleted instead of reappearing on
  the next run. This is the no-resurrection rule, unchanged.

### Where an arrival lands

Placement is a **first-arrival question only**, which is the whole payoff of keying on identity
instead of path. The default: `into:` plus the source page's basename, flat.

Sending brain, `wiki/clients/northwind/deliverables/2026-08-10 Kickoff Plan.md`:

```yaml
type: Deliverable
status: stable
publish_to: nw-engagement
```

Receiving brain, subscription `into: "wiki/from-venture/"`, first run creates
`wiki/from-venture/2026-08-10 Kickoff Plan.md`:

```yaml
type: Deliverable
status: stable
source_key: 01J9X...
source: nw-engagement
updated: 2026-08-10
```

Four decisions in that:

- **Flat, not mirrored.** Mirroring `clients/northwind/deliverables/` into the client's
  repository leaks the sending brain's internal organization, and folder names are themselves
  information (`prospects/`, `pricing/`, `renewal-risk/`). A frontmatter-selected set is scattered
  and has no common root to mirror anyway. Where a publication genuinely is a subtree, an optional
  `relative_to:` on the publication can preserve structure below that root, which keeps the
  leakage bounded to what the author named.
- **The selector field does not cross.** `publish_to` is the sender's routing, meaningless in the
  receiving brain, and actively wrong there: a received page carrying it looks like a page that
  wants to publish onward. Whatever key drives `select:` is stripped on the way through.
- **The seam id crosses, and today's importer does not do this.** `createContent` stamps
  `source_key` and `updated` and nothing naming the source, so a brain holding two subscriptions
  cannot tell from a page which seam delivered it, and the only answer lives in whichever ledger
  happens to hold the key. Tolerable for a spreadsheet; not for cross-brain, where "who sent me
  this" is the receiver's first question. The received page carries the seam id as `source`.
- **Collisions are already handled.** Two published pages sharing a basename hit the importer's
  existing clobber guard: a create aimed at a path that exists and does not claim the key errors
  by name and points at `adopt_existing`. Refusing and reporting beats auto-suffixing, since a
  generated suffix is unstable the moment the colliding page unpublishes.

After the first arrival the receiver owns the location:

- **The receiver may move it anywhere**, and the next run finds it by key and updates it in place.
  Arrivals land quarantined in `into:` so provenance is visible at a glance, and moving one out is
  how a receiver interleaves it with their own material. Both behaviors, one default.
- **A `move_page` on the SENDING side must not move the received page.** Filing in the receiving
  brain is the receiver's business. This is the rule that makes the seam survive routine tidying on
  either side, and it is the reason identity is a key.
- **Read-only governs the body, not the filing.** `move_page` stays available on a received page;
  renaming does not, because `title:` comes from upstream and a local rename would be overwritten
  on the next run.
- The landing folder wants a folder note, and it can be scaffolded with one: `index.md` holding a
  `kind: pages` view `under` the landing path indexes arrivals with machinery that already exists.

Because path is not identity, **the sending side's export folder does not need to exist at all**.

## 9. What crosses: an export folder is the wrong shape

The instinct is a folder: drop pages into `exports/`, and they cross. It is simple and it is worth
supporting as one selector. But it is the weaker half of the actual want.

The stronger half is that what should cross is usually a **selection**, not a location. To-dos
tagged to a client, time entries for one engagement, pages whose status went to `published`. These
are scattered through the brain by topic and would have to be manually duplicated into an export
folder, at which point the folder is a second copy inside the same brain and drifts from the first.

`okf-view` already has a selection language over the content index, and it is the same question a
publication asks: which pages. So `select:` should accept the same vocabulary (a folder prefix, a
frontmatter filter, or both), and the export folder becomes the degenerate case (`select: { under:
"wiki/exports/" }`) rather than the mechanism.

**One critical restriction.** The selector must key on **publication intent**, not a topical
attribute. `publish_to: nw-engagement` is a statement that this page should leave. `client:
northwind` is a statement about what the page is about, which someone will one day set on a
confidential internal page for a perfectly good reason and thereby publish it. The distinction is
invisible in the config and is the difference between a safe feature and a leak, so it belongs in
validation: a publication whose selector is not an opt-in field should be flagged.

### The link horizon

A page that crosses carries `[[wikilinks]]` to pages that do not exist in the receiving brain.
Three options, and only one is acceptable:

- **Carry the linked pages too** (transitive closure). Rejected. This is precisely how confidential
  material escapes: one deliberately published page drags in its neighbors, and the neighbors drag
  in theirs. A publication must never widen itself.
- **Rewrite to absolute links into the sending brain.** Useless for the case that motivates
  publishing, since the reader is a client who cannot open the sending brain, and it advertises the
  existence and title of pages they cannot see.
- **Resolve within the published set; flatten everything outside it.** Recommended. Links between
  two pages that both cross keep working, retargeted at their new paths. A link pointing out of the
  set becomes plain text. The run reports what it flattened, so the author can see that a page
  arrived with holes and decide whether the target should also publish.

**The published set is the link horizon.** That is the rule.

## 10. Who owns the body, and when it runs

`sync_records` writes the body **at create only**, and only ever updates frontmatter keys the call
declares source-owned. That is correct for a spreadsheet: the rows carry facts, the prose is the
brain's own curation, and human edits are sacred. For a publication the payload IS the prose, so a
document revised in the sending brain must be able to update the received copy. The importer has
no way to express that.

A `body:` policy on the publication, with two values, which are the two crossing kinds from §5:

- **`source-owned`** (publication; the default). The received page's body is replaced from
  upstream on every run. The received page is **read-only in the receiving brain**: it is listed
  as tool-maintained (the `isToolMaintained` family) so `write_page` refuses it and the app's
  `isEditablePath` refuses it too. A receiver who wants to change it forks: copy to a new path,
  which drops the key and severs the seam. To respond without forking, see §6.4.
- **`seed`** (handoff; the importer's current behavior). Body written at create, never touched
  again. The receiving brain owns it from then on; the seam only maintains the declared frontmatter
  fields.

Last-writer-wins with conflict pages is rejected. Two writers on one document with no merge UI is
the failure the PRD's P3 already names ("never let two writers silently fight"), and a conflict
page is a to-do item nobody clears. §6.4 concedes the shared-brain case does not fully escape this;
what it escapes is two writers in two repositories, which is the unrecoverable version.

A consequence worth stating: `source-owned` means a page can be **unpublished**. Removing the
selector field on the sending side takes the page out of the set, which surfaces on the next run
as a proposed deletion in the receiving brain. Proposed, not applied, per the existing rule.

### When it runs

"Automatically ported over" has to answer to a stateless Worker with no webhooks. Three rungs, in
the order they should be built:

1. **Explicit call.** A `publish` / `sync_seam` tool. Attributable, visible in the transcript,
   commits under the caller's identity, needs no new infrastructure, and proves the semantics.
   This is the whole of v1.
2. **Proposal on read of the receiving brain.** Reading the receiving brain checks the sending
   brain's HEAD against the last-seen sha in the ledger and, if it moved, surfaces "4 pages have
   changes waiting" the way `validate` already surfaces the importer's pending questions. One call
   applies them. This gets most of the felt automation without a read silently producing a commit
   in a repository under whoever happened to open it, which would be a surprising thing for a read
   to do and an odd line in the client's git history.
3. **A scheduled runner.** Genuinely unattended, and a different animal: it needs a stored
   credential to act with no user present, an answer to "committed as whom", and it collides with
   the open-source boundary unless it ships as configuration every deployment can run. The
   roadmap's "eager batch runner" for schema migrations wants the same machinery, so if this is
   ever built it should be built once for both.

Rung 2 is the good target. Rung 1 is the honest starting point. Rung 3 should wait for evidence
that rung 2's latency is actually annoying.

Collaboration needs none of this. A shared brain has no run, no ledger, and no freshness question
beyond `ensureFresh`, which is another way of saying it is the cheaper mechanism wherever it
applies.

## 11. Confidentiality is the feature, not a footnote

An automatic flow out of a personal brain into a client's repository is an exfiltration channel
that runs without a human in the loop, and a flow the other way may breach an engagement's terms.
Design consequences, all of which are already implied above but are collected here because they
are the reason to be careful rather than fast:

- **Opt-in per page**, via a selector that expresses intent to publish (§9).
- **Both ends declare the seam** (§7), so neither party can open a channel alone.
- **Authorization re-checked every run** (§7), so revoked access stops the flow.
- **Publications never widen themselves** (§9), so nothing crosses that was not selected.
- **Every arrival is on the record.** The receiving brain's `wiki/log.md` gets a line per run, and
  the ledger holds every key ever received. The sending side should get the reciprocal: one page
  answering "what of mine has ever gone to this client", which the ledger cannot answer because it
  lives in the other repository. A published-manifest page in the sending brain, maintained by the
  run, is the cheap version, and it is where the audit value of a publication repository (§6.3)
  actually lands.
- **A dry run is the default.** Same as `sync_records`' proposal pattern: the first call reports
  what would cross, and applying it is a second, explicit call.

Collaboration's equivalent list is §6.5, and it is shorter for a reason: nothing crosses, so the
whole exfiltration surface is replaced by a single question about who was admitted.

---

# Part III: How this appears in the product

## 12. The brain list must not sprawl

If every relationship is a brain, the list grows without bound: several clients, several shared
surfaces each, plus internal team-to-team surfaces. The switcher becomes unusable and fan-out
search gets expensive and noisy.

This is a modeling problem, not a display problem. Solving it with filters and badges is a losing
fight. It sprawls because a relationship is being rendered as a peer of a workspace, and it is not
one. Nobody has thirty-one brains; they have three brains and twelve relationships, and a
relationship is always **about** something.

### Rule 1: a shared surface is in scope when you are in a brain it connects to

This is the rule that bounds the list. Sprawl becomes bounded by the **degree of the current
brain**, not by the total count of relationships. From the personal brain: your brains, plus the
surfaces attached to the personal brain. From the client brain: the surfaces attached to that.
Nobody sees all twelve at once, it needs no configuration, and the answer to "why am I seeing
this" is always one hop.

The same rule governs fan-out search: **a shared surface is in scope for fan-out when its other
end is the active brain.** Otherwise a search from the personal brain surfaces client-shared
material, which is §15's leak-through-the-human scenario with a wider radius. One rule across nav
and search is worth more than two tuned ones.

### Rule 2: the connection is the object, the brain is its storage

Users manage **connections**, not shared brains. A connection has a name (the counterparty or the
shared purpose), its parties, its kind (§5), and a brain behind it. The brain surfaces when they
open it, the way a repository surfaces behind a brain today.

This also fixes naming. Twelve shared brains need twelve names someone has to invent and keep
distinct; twelve connections are named for who they are with, which is a name that already exists
and that both parties agree on.

### Rule 3: classification is free, but not sufficient

The §6.1 work adds a second resolution branch, so the payload can carry a derived
`via: 'org' | 'grant'` with no new column and no migration. That is enough to render a "Shared with
you" section differently.

It is not enough to identify a relationship: a private brain shared to a colleague in your own
organization also arrives by grant. Use `via` for presentation and the connection object for
meaning.

### Intra-organization is not the hard case

Two teams in one organization sharing a brain is already just a brain with grants. It works today,
needs no connection object, and its only issue is list length, which Rule 1 handles.

The connection wrapper earns its keep at **boundaries where the parties do not otherwise see each
other**: that is where the name matters, where consent matters, and where "who is on the other
side" is not answerable from the organization roster. Do not pay for the concept inside a single
organization.

### Hierarchy is deferred, not foreclosed

Up-and-down (division, department, team) is containment, which is a third relation and not a
two-party connection with a direction. Not built here. What preserves the option is keeping
connections as **named objects with parties**, so hierarchy later becomes a type or a containment
flag rather than a parallel model.

The trap is modeling hierarchy as a chain of pairwise shares. It looks correct at two levels and
produces exactly this section's sprawl at three.

## 13. The file tree is never merged

Content from a connected brain does not appear in the current brain's file tree. The tree is
per-brain by construction: `setActiveBrain` (`app/core/store.ts`) nulls `browseCache` and resets
the path policy on every brain change.

Merging would reintroduce everything the shared-brain design avoids:

- **The tree backs wikilink resolution and folder-note lookup**, which is why it is dropped on
  brain change. `wikilinkKey` builds its lookup table from one brain's page set and the index
  isolates by `brain_id`. Foreign pages in the tree give either a `[[link]]` silently resolving
  across a brain boundary, or rows that links provably cannot reach.
- **Edit policy stops being a path question.** `isEditablePath` is a path predicate with no brain
  to consult; a merged tree would force brain identity through every path in the app.
- **Paths collide.** Both brains have `wiki/index.md`. Any prefix invented to disambiguate is the
  submodule mount point again, without git behind it.
- **The freshness contract breaks.** §15 settles that the guarantee is per brain and only the brain
  you are in keeps it, because `ensureFresh` costs one `branchCommitSha` per brain per read. A
  merged tree either pays that for every connected brain on every render, or renders stale foreign
  content indistinguishably from live local content.
- **Folder names are disclosure.** §8 states this for publishing (`prospects/`, `pricing/`,
  `renewal-risk/`) and it applies identically here. A tree reads as "this is what is in here".

It is also issue #26 rebuilt as architecture. That bug was the crumb naming one brain while the
content came from another, and the fix was that the brain a result names is authoritative. A tree
under brain A's crumb containing brain B's pages makes that state permanent and intentional.

**Adjacent, not merged.** Showing a connected surface as a second, collapsed, clearly labeled root
in the same panel is fine: its own tree, its own brain, its own crumb when entered. The visual
adjacency is free. The semantic merge, one tree claiming to contain two brains, is what costs.

## 14. Reaching a connected brain

Five routes, in descending order of expected use.

1. **The brain switcher.** Connected surfaces appear in their own section below the organization
   groups, filtered by Rule 1. One click from anywhere. `groupBrainsByOrg` (`app/core/util.ts:95`)
   already returns sections and collapses to flat when there is one group, so only the third
   section is new. Clicking **switches you**: crumb, tree, and policy all follow, via the existing
   `setActiveBrain` path. Not a peek. A peek is a second brain rendered while the crumb still names
   the first, which is the issue #26 state.
2. **Asking.** "Show me the shared kickoff doc." Claude calls `view_page` with `brain:`, the widget
   opens on that brain, and `pickShownBrain` lands the crumb correctly because the result declares
   its brain. This works today with no new UI. The app is an MCP App inside a conversation, and the
   primary navigation is asking; the chrome is for orientation and browsing, not for being the only
   route in.
3. **Search.** Fan-out results name their brain, and clicking a foreign hit takes you there. This
   is the route for someone who does not know the connection exists.
4. **A Connections destination**, for "what is this brain joined to, and who is on the other side".
   Brain-scope by the scope test (switching brains changes the answer), and it belongs immediately
   after Sharing in `brainDestinations()` (`app/components/Breadcrumb.tsx:423`). That list is Files
   and Graph (the brain drawn two ways), Recent changes (its feed), then Sharing, which its own
   comment describes as "the only one about the brain's audience rather than its contents".
   Connections is the second of those: Sharing is who can come in, Connections is where this brain
   joins out. Gate it the way `Manage brains` and `Analytics` are gated, per the rule stated twice
   in that file that a picker must never offer a destination whose click is refused: show it when
   the brain has at least one connection, or when the caller can create one.
5. **Explicit cross-brain links** in page bodies, rendered as external destinations so the crossing
   is visible, never a bare wikilink resolving elsewhere. See §15 on why these are excluded from
   the read design as it stands.

The panel itself is the brain-scope twin of `BrainAccessView`: one row per connection with the
counterparty, the kind, your role on the far side, and last activity. Creating one is a pushed
flow off the header, following the `Flow.tsx` convention `ShareBrainView` and `InviteMemberView`
already use.

Routes 1 and 2 are the product. Route 4 is orientation, visited once to understand the shape. If
the Connections panel becomes the main way people reach shared content, the switcher section is not
working, and that is the thing to fix.

## 15. Cross-brain read: most of it already ships

§3 sends the "I need to find it" half of the problem here. Verified in source, the mechanism
already exists and the gap is narrower than it looks. It also now serves collaboration, since a
shared brain is reached by exactly this machinery.

**Every content tool already takes an optional `brain`.** `read_page`, `list_pages`,
`search_pages`, `find_inbound_links`, `validate`, `write_page`, `move_page` and `delete_page` all
carry `brainArg`, resolved by `matchBrain` against the caller's accessible set. Three properties
that make this safe today and are worth not breaking:

- **A targeted call does not move you.** `maybeStick` fires only when a tool passes `sticky`
  (the in-client view tools and `brain_access`), so reading or writing another brain leaves the
  active brain alone.
- **Authorization is per brain.** Resolution runs `effectiveBrainRole` for the brain actually
  named, so a write into another brain is checked against that brain, not the one you came from.
- **Ambiguity is refused, not guessed.** `matchBrain` returns candidates on a multi-hit and the
  resolver throws with the list.

So "while working in the client brain, add a to-do to my personal brain" works now. So does
reading one brain from a conversation rooted in another. **What does not exist is a single call
that spans brains**, and that is the whole of the gap.

### The three real gaps

1. **Fan-out.** Every call resolves exactly one brain. At the storage layer this is nearly
   nothing: one D1 holds every brain's index and the queries are `WHERE brain_id = ?1`. The cost
   is freshness, not SQL. `ensureFresh` is one `branchCommitSha` per brain per read, so fanning
   out over N brains spends N subrequests before answering. That forces a decision, and the right
   one is: **the freshness guarantee is per brain, and only the brain you are in keeps it.**
   Fan-out search serves the others from whatever is indexed and labels the result as such;
   a `read_page` on any hit resolves the authoritative blob anyway. Slightly stale discovery
   followed by a fresh read is correct behavior for a search.
2. **Discoverability.** The capability is invisible rather than absent. `SERVER_INSTRUCTIONS` is
   emitted only in the `initialize` result and is therefore fixed for the life of a connection, so
   it cannot enumerate a caller's brains; `brains` returns them but is only called when something
   prompts it. This is the `read_page` / `view_page` description failure in another costume: a
   capability an agent does not find by name does not exist.
3. **Attribution in results.** A fan-out result set that does not say which brain each hit came
   from will get one client's material quoted into another client's conversation. Every row must
   name its brain.

### The risk here is conversational, not mechanical

Publishing moves bytes into a repository someone else controls: one-time, auditable, irreversible,
and it changes who is _able_ to read. Cross-brain read moves nothing and grants nobody access, so
it reads as safe. The leak channel is different in kind: a conversation rooted in one client's
brain surfaces another engagement's material, the model writes it into a reply, and a human pastes
that reply somewhere. Nothing was published; the leak went through the human.

Mitigations, in order of value:

- **Every result names its brain** (gap 3 above). Cheap, and it is the one that matters.
- **Scope fan-out by Rule 1** (§12): connected surfaces are in scope when their other end is the
  active brain. This replaces the previous draft's per-brain opt-out in `.isomorphic.json` with a
  default that needs no configuration, though an explicit opt-out remains worth having for a
  personal brain.
- **Fan-out is opt-in per call, never ambient.** The default stays the active brain, so an
  ordinary conversation keeps an ordinary blast radius.

### Write fans out over nothing

Cross-brain read fanning out is a convenience. Cross-brain write fanning out is a bulk operation
whose blast radius crosses organizations and is invisible in the transcript. This is the objection
the roadmap already raises against `filter:`-selected bulk updates, one boundary worse. A write
names exactly one brain, always.

The residual write risk is not ambiguity (refused) but confident-and-wrong: a unique substring
match on the wrong brain lands a real page in a real client's repository. The cheap mitigation is
that **the write response names the brain it landed in**, so the mistake is visible in the same
turn rather than found later.

### Why this comes first

Cross-brain read does not replace publishing; it shrinks it. Everything that merely needs to be
_found_ stops needing to cross, and what remains is genuinely "a reader who cannot reach my brain
must see this", which is a smaller and much better specified problem. Building read first tells us
how much publishing is actually left. Cross-organization grants (§6.1) shrink it a second time,
for the same reason.

Deliberately excluded for now: **cross-brain wikilinks.** A `[[nw:Kickoff]]` means nothing to
github.com or to any OKF consumer, which is a larger divergence than `[[wikilinks]]` already are,
and a broken cross-brain link is indistinguishable from a permission denial. Rendering one tells a
reader that a page exists which they are not allowed to see, and `validate` would report the same
page broken for one reader and fine for another. §14's route 5 wants some explicit form; it should
be a link syntax that announces the crossing and degrades to plain text, not a wikilink.

---

## 16. What we reuse, what is new, and what this is not

**Reused essentially unchanged:**

- `sync_records`' planner (`src/lib/brain-import.ts`): upsert by key, source-owned fields,
  deletions proposed, idempotence, the ledger format, the no-resurrection rule, pending questions.
- `commitFiles` / `commitOrPR`: one atomic bundle per run, honoring the receiving brain's
  `writeMode`, so an arrival into a branch-protected client brain lands as a reviewable PR. The
  same `writeMode: 'pull-request'` path is the propose-back mechanism in §6.4.
- `okf-view`'s selection vocabulary for `select:`.
- `effectiveBrainRole` for every authorization check, with `orgRole` widened to nullable.
- `resolve_import` for the human answers (suppress this key, delete, recreate).
- `matchBrain`, `brainArg`, and per-brain index isolation, which is the whole of collaboration's
  read and write path.
- `groupBrainsByOrg` and the `Flow.tsx` pushed-flow convention for the UI.

**Genuinely new:**

- **Cross-organization brain grants** (§6.1): a second resolution branch, a nullable `orgRole`,
  and a `pnpm test:scope` case for the grant-only caller. This is the single unlock for
  collaboration and the smallest new thing in the document.
- **Two brains in one request** (publication only). `tenantContext({ brain })` resolves one brain
  per call, so a seam tool calls it twice and holds two `BrainStore`s and two installation tokens.
  Mechanically small, but it is the first code that legitimately crosses the `brainId` isolation
  line, so it wants a narrow, obvious seam of its own rather than a general "context for any brain"
  helper. Collaboration does not need it.
- **The `body: source-owned` policy** and the read-only received page (§10).
- **Link flattening at the horizon** (§9).
- **The publication/subscription config, its handshake, and validation of it** (§7, §9).
- **The connection object and the contextual scope rule** (§12), plus the Connections destination
  (§14).

**Explicitly not in scope:**

- **A shared page that lives in two brains at once.** Unchanged. A page has exactly one home brain;
  a collaboration's shared brain **is** that home, which is why it does not violate the rule.
- **Merging foreign content into a brain's file tree** (§13), in any form.
- **Platform-owned relationship repositories** (§6.2) and **submodules** (§6.3), in any variant.
- **Merge resolution for concurrent edits** (§6.4). Last-writer-wins at the body level is the
  accepted behavior in a shared brain, mitigated by anchored `edits`.
- **Hierarchical relationships** (§12), deferred but not foreclosed.
- **Bidirectional publication as a route to collaboration.** Two seams give correspondence (§5).
  Two seams over disjoint page sets remain fine and are how a return channel works.

## 17. Build order

1. **Cross-brain read** (§15, gaps 1 and 3). Smallest, highest value, shrinks everything below it,
   and needs no new model.
2. **Cross-organization grants** (§6.1) with the confidentiality work in §6.5. Unlocks
   collaboration outright.
3. **Rule 1 scoping and the switcher section** (§12, §14 route 1). Without this, step 2 sprawls.
4. **Publication, rung 1** (§7 through §10): explicit call, dry run by default.
5. **Publication, rung 2**: proposal on read.
6. **The connection object and Connections destination** (§12, §14 route 4), once two or three real
   relationships exist to shape it.

Steps 1 to 3 are the ones that would change how the product feels. Steps 4 and 5 are the ones that
carry the confidentiality risk, which is an argument for their ordering as much as the dependency
is.

## 18. Open questions

Answered since the previous draft, recorded so they are not reopened by accident: whether
publishing or cross-brain read is the real want (both, for different readers, §3); whether
bidirectional flows are in scope (as correspondence, not collaboration, §5); whether a shared page
can live in two brains (no, and it does not need to, §4).

Still open:

- **Should cross-organization grants require both ends to declare, like a publication seam does?**
  §6.5 argues for at least an organization-level policy. A full two-sided handshake is safer and is
  friction on the single act that makes collaboration work at all.
- **Where does the connection object live?** Repository config keeps it with the §4 rule that seam
  state lives in the repos. Platform state is the only place that can describe a relationship
  neither repository fully owns, and grants are already platform state.
- **Should fan-out search be a `brain: "*"` value or its own tool?** The argument already exists on
  every read tool, so widening its accepted values is nearly free and keeps one vocabulary. A
  separate tool is more discoverable (§15, gap 2) at the cost of a slot on a surface that was
  deliberately shrunk from 42 tools to 30.
- **Where does the key come from on first publication?** Stamping a generated id into the sending
  page's frontmatter is durable and survives moves on both sides, but it means publishing writes to
  the sending brain, which is a side effect on a read-shaped act. The alternative, deriving the key
  from the path at first crossing and storing the binding in the ledger, keeps the sending brain
  untouched but puts the binding in only one of the two repositories.
- **Does a published page's frontmatter cross wholesale, or only declared fields?** Declared fields
  match the importer and are safe. Wholesale is what a document actually wants and risks carrying
  internal annotations across.
- **What happens to a published page's media attachments?** Not considered here at all. Images
  referenced by a crossing page live in the sending repository and will not resolve. A shared brain
  has no such problem, which is another point in its favor where it applies.
- **Is a publication seam per-brain-pair or per-organization-pair?** Three client brains from one
  venture brain is three seams with three configs, which is fine at three and tedious at thirty.
- **Should the receiving brain be able to reject an arrival without severing the seam?** Suppression
  exists in the ledger for import keys and probably transfers, but it has not been thought through
  for a flow whose sender expects delivery.
- **Billing and seats for cross-organization collaborators** (§6.5). Unanswered, and it is a
  commercial question before it is a technical one.
- **What is the explicit cross-brain link syntax** that §14 route 5 needs and §15 declines to make
  a wikilink?

## 19. Rejected alternatives

Fully argued elsewhere in the document: **platform-owned relationship repositories** (§6.2),
**git submodules and subtree merges** in all three variants (§6.3), **bidirectional seams as
collaboration** (§5), and **merged file trees** (§13).

Remaining:

- **A shared "commons" brain that all three link into.** Rejected in the previous draft because the
  client still cannot read it, so the confidentiality boundary reappears one level up. That premise
  is now half repaired: with cross-organization grants the client **can** be admitted, which is
  precisely §6. What stays rejected is the _undifferentiated_ commons, one brain holding everything
  shared with everyone. A collaboration is scoped to its parties and its purpose; a commons is the
  same object with the scoping removed.
- **Symlink-style pointer pages that the reader resolves live.** This is cross-brain read wearing a
  page costume, and it fails the case that motivates publishing, since a client resolving a pointer
  into a brain they cannot read gets nothing.
- **Extending `sync_records` in place with a brain-shaped source.** Tempting, and the planner is
  reused either way, but the tool's contract is "an external system hands me keyed records" and its
  merge policy is "bodies belong to humans". Both are wrong here in ways that would have to be
  configured away, and a tool that means two different things by `source` is worse than two tools.
- **Solving collaboration with publication configured symmetrically.** Two `body: seed` seams over
  the same page set produce two independently owned copies that both claim the same key. It is the
  conflict-page failure with extra steps.
