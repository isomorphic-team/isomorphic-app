# Design: the seam between brains

- Status: Draft for discussion. Nothing built. Open questions in §13 are unresolved.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-10
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

This document proposes a **seam**: a declared, one-directional, key-addressed flow of pages from
one brain to another, reconciled rather than overwritten, with both ends of the flow visible in
both repositories.

The load-bearing claim is that most of this already exists. `sync_records` is a non-destructive,
key-addressed, idempotent, ledger-backed importer with proposed-not-applied deletions and a
no-resurrection rule. Those are exactly the semantics a cross-brain flow needs, and they are
already tested. The genuinely new work is smaller than it looks: reading two brains in one
request, a body-ownership policy the importer does not have, and a trigger.

## 2. Motivating case

Three brains, one person:

- A **client brain** for a consulting engagement. Shared with the client. Contains engagement
  material the client is entitled to see.
- A **personal brain**. To-dos, time tracking, working notes, everything.
- A **venture brain** (The AI Lab). Methodology, offers, positioning. Some of it is material a
  client should receive; some of it is commercially sensitive.

Three flows the person wants:

1. Time entries and to-dos in the personal brain that are tagged to a client should be visible
   in that client's brain, or at least should roll up there.
2. A deliverable authored in the venture brain should land in the client's brain.
3. A page in the client brain should be findable while working in the venture brain.

## 3. The reframe: these are two different problems

Flows 1 and 2 look alike and are not. The discriminating question is not "which brain is it in"
but **who needs it**:

- **"I need to find it."** The reader is the same person, who already has access to both brains.
  Nothing needs to move. What is missing is a **read** that spans a person's brains. Copying to
  solve this is strictly worse: it creates a second copy that drifts, for a reader who could have
  read the original.
- **"Someone who cannot reach my brain needs to see it."** The reader is a client, and the client
  cannot and must not read the personal brain. Content must physically cross into a repository
  they can read. This is **publishing**, and it is the only case where copying is the right answer.

Flow 3 is entirely the first kind. Flow 2 is entirely the second. Flow 1 is mixed and mostly the
first: the person wants to _see_ their client to-dos while in the client brain, which is a read
across a boundary they already have, unless the client is meant to see them too.

**Flow 1 has a third answer that is probably the right one**, and it is not in this document.
Time entries and dated to-dos against a client are activity records, not pages, which is the
subject of `docs/design/records-tables-prd.md`. Modeled there, the cross-brain question stops
being "does this page cross" and becomes "can an aggregate over records cross a seam", which is a
sharper and smaller question: a client is owed the rollup ("14 hours this month against the
engagement"), not the underlying entries. Neither this document nor that one answers it yet, and
whichever is built second should.

Naming the mechanism **publication** rather than **sync** keeps this straight, and puts the
question that actually matters (who is now able to read this) in the name of the feature.

The rest of this document is about publishing. Cross-brain read is separate, smaller, and
probably higher-value work, and most of its mechanism already ships: see §11.

## 4. Hard constraints

Inherited from the architecture and not up for renegotiation here:

- **The repository is the source of truth. D1 is a cache.** Seam state lives in the repos, not in
  a platform table, so it survives a D1 wipe, diffs in review, and travels with the brain.
- **No webhooks.** Freshness is a read-time guard (`ensureFresh`). Anything that claims to happen
  "automatically" has to say which read or which call it rides on.
- **No unbounded work in one request.** A whole-brain pass must be budgeted, cursored, and
  resumable, per the `rebuild_cursor` pattern.
- **Nothing hosted-only.** A seam is configuration in two repositories, not a platform feature
  that only the hosted deployment can run.
- **Multi-tenant isolation is the default.** Every index query is keyed by `brainId`. A seam is
  the one deliberate hole in that, so it has to be narrow and explicit.

## 5. Model: publications and subscriptions

A seam has two halves, declared independently in the two repositories, joined by a shared id.

**The sending brain declares a publication** in `.isomorphic.json`:

```jsonc
{
	"publications": {
		"gb-engagement": {
			"select": { "field": "publish_to", "equals": "gb-engagement" },
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
		"gb-engagement": {
			"from": "the-ai-laboratory/ai-lab-brain",
			"into": "wiki/from-ai-lab/",
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

## 6. Identity is a key, never a path

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

Sending brain, `wiki/clients/gordon-brothers/deliverables/2026-08-10 Kickoff Plan.md`:

```yaml
type: Deliverable
status: stable
publish_to: gb-engagement
```

Receiving brain, subscription `into: "wiki/from-ai-lab/"`, first run creates
`wiki/from-ai-lab/2026-08-10 Kickoff Plan.md`:

```yaml
type: Deliverable
status: stable
source_key: 01J9X…
source: gb-engagement
updated: 2026-08-10
```

Four decisions in that:

- **Flat, not mirrored.** Mirroring `clients/gordon-brothers/deliverables/` into the client's
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
Which is the next point.

## 7. What crosses: an export folder is the wrong shape

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
attribute. `publish_to: gb-engagement` is a statement that this page should leave. `client:
gordon-brothers` is a statement about what the page is about, which someone will one day set on a
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

## 8. Who owns the body

This is the one place the existing importer's policy is actively wrong for this use case, and it
is worth being precise about why.

`sync_records` writes the body **at create only**, and only ever updates frontmatter keys the call
declares source-owned. That is correct for a spreadsheet: the rows carry facts, the prose is the
brain's own curation, and human edits are sacred. For a publication the payload IS the prose, so a
document revised in the sending brain must be able to update the received copy. The importer has
no way to express that.

The recommended answer is a `body:` policy on the publication with two values:

- **`source-owned`** (the default for publications). The received page's body is replaced from
  upstream on every run. The received page is **read-only in the receiving brain**: it is listed
  as tool-maintained (the `isToolMaintained` family) so `write_page` refuses it and the app's
  `isEditablePath` refuses it too. A receiver who wants to change it forks: copy to a new path,
  which drops the key and severs the seam. This is a real product statement, that a page with an
  upstream is not yours to edit, and it is much better than the alternative.
- **`seed`** (the importer's current behavior). Body written at create, never touched again. The
  receiving brain owns it from then on; the seam only maintains the declared frontmatter fields.

Last-writer-wins with conflict pages is rejected. Two writers on one document with no merge UI is
the failure the PRD's P3 already names ("never let two writers silently fight"), and a conflict
page is a to-do item nobody clears.

A consequence worth stating: `source-owned` means a page can be **unpublished**. Removing the
selector field on the sending side takes the page out of the set, which surfaces on the next run
as a proposed deletion in the receiving brain. Proposed, not applied, per the existing rule.

## 9. When it runs

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

## 10. Confidentiality is the feature, not a footnote

An automatic flow out of a personal brain into a client's repository is an exfiltration channel
that runs without a human in the loop, and a flow the other way may breach an engagement's terms.
Design consequences, all of which are already implied above but are collected here because they
are the reason to be careful rather than fast:

- **Opt-in per page**, via a selector that expresses intent to publish (§7).
- **Both ends declare the seam** (§5), so neither party can open a channel alone.
- **Authorization re-checked every run** (§5), so revoked access stops the flow.
- **Publications never widen themselves** (§7), so nothing crosses that was not selected.
- **Every arrival is on the record.** The receiving brain's `wiki/log.md` gets a line per run, and
  the ledger holds every key ever received. The sending side should get the reciprocal: one page
  answering "what of mine has ever gone to this client", which the ledger cannot answer because it
  lives in the other repository. A published-manifest page in the sending brain, maintained by the
  run, is the cheap version.
- **A dry run is the default.** Same as `sync_records`' proposal pattern: the first call reports
  what would cross, and applying it is a second, explicit call.

## 11. Cross-brain read and write: most of it already ships

§3 sends the "I need to find it" half of the problem here. Verified in source, the mechanism
already exists and the gap is narrower than it looks.

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
- **A per-brain opt-out from fan-out** in `.isomorphic.json`. A client brain almost certainly
  wants it; a personal brain probably does.
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
how much publishing is actually left.

Deliberately excluded: **cross-brain wikilinks.** A `[[gb:Kickoff]]` means nothing to github.com
or to any OKF consumer, which is a larger divergence than `[[wikilinks]]` already are, and a
broken cross-brain link is indistinguishable from a permission denial. Rendering one tells a
reader that a page exists which they are not allowed to see, and `validate` would report the same
page broken for one reader and fine for another.

## 12. What we reuse, what is new, and what this is not

**Reused essentially unchanged:**

- `sync_records`' planner (`src/lib/brain-import.ts`): upsert by key, source-owned fields,
  deletions proposed, idempotence, the ledger format, the no-resurrection rule, pending questions.
- `commitFiles` / `commitOrPR`: one atomic bundle per run, honoring the receiving brain's
  `writeMode`, so an arrival into a branch-protected client brain lands as a reviewable PR.
- `okf-view`'s selection vocabulary for `select:`.
- `effectiveBrainRole` for both authorization checks.
- `resolve_import` for the human answers (suppress this key, delete, recreate).

**Genuinely new:**

- **Two brains in one request.** `tenantContext({ brain })` resolves one brain per call, so a seam
  tool calls it twice and holds two `BrainStore`s and two installation tokens. Mechanically small,
  but it is the first code that legitimately crosses the `brainId` isolation line, so it wants a
  narrow, obvious seam of its own rather than a general "context for any brain" helper.
- **The `body: source-owned` policy** and the read-only received page (§8).
- **Link flattening at the horizon** (§7).
- **The publication/subscription config, its handshake, and validation of it** (§5, §7).

**Explicitly not in scope:**

- Bidirectional sync. A page has exactly one home brain. Two-way traffic between two brains is two
  seams over disjoint page sets, never the same page in both. This is the PRD's out-of-scope item
  and it stays out.
- Cross-brain read, which is separate and smaller work that answers the "I need to find it" half
  of §3 outright, and which should probably be built first. See §11.
- Any notion of a shared page that lives in two brains at once.

## 13. Open questions

- **Is publishing the actual want, or is it cross-brain read?** §3 splits the motivating flows and
  two of the three fall on the read side, where §11 finds the mechanism already shipped. If that
  holds, this document describes the smaller half and should be built second.
- **Should fan-out search be a `brain: "*"` value or its own tool?** The argument already exists on
  every read tool, so widening its accepted values is nearly free and keeps one vocabulary. A
  separate tool is more discoverable (§11, gap 2) at the cost of a slot on a surface that was
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
  referenced by a crossing page live in the sending repository and will not resolve.
- **Is the seam per-brain-pair or per-org-pair?** Three client brains from one venture brain is
  three seams with three configs, which is fine at three and tedious at thirty.
- **Should the receiving brain be able to reject an arrival without severing the seam?** Suppression
  exists in the ledger for import keys and probably transfers, but it has not been thought through
  for a flow whose sender expects delivery.

## 14. Rejected alternatives

- **A shared "commons" brain that all three link into.** Moves the problem: the client still cannot
  read it, so the confidentiality boundary reappears one level up, and now three brains depend on a
  fourth.
- **Git submodules or subtree merges between brain repos.** Correct at the storage layer and wrong
  at every other one: invisible to the content index, unintelligible in the app, and it exposes git
  mechanics to users the product deliberately keeps away from them.
- **Symlink-style pointer pages that the reader resolves live.** This is cross-brain read wearing a
  page costume, and it fails the case that motivates publishing, since a client resolving a pointer
  into a brain they cannot read gets nothing.
- **Extending `sync_records` in place with a brain-shaped source.** Tempting, and the planner is
  reused either way, but the tool's contract is "an external system hands me keyed records" and its
  merge policy is "bodies belong to humans". Both are wrong here in ways that would have to be
  configured away, and a tool that means two different things by `source` is worse than two tools.
