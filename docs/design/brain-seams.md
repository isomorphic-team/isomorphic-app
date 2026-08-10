# Design: the seam between brains

- Status: Draft for discussion. Nothing built. Open questions in §12 are unresolved.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-10
- Audience: the engineering session that picks this up, and Jon deciding whether it should exist
- Related: `docs/design/derived-views-and-sync-prd.md` (FR-3 importer, FR-4 source of truth),
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
  Nothing needs to move. What is missing is a **read** that spans a person's brains: cross-brain
  search, and cross-brain wikilinks. Copying to solve this is strictly worse: it creates a second
  copy that drifts, for a reader who could have read the original.
- **"Someone who cannot reach my brain needs to see it."** The reader is a client, and the client
  cannot and must not read the personal brain. Content must physically cross into a repository
  they can read. This is **publishing**, and it is the only case where copying is the right answer.

Flow 3 is entirely the first kind. Flow 2 is entirely the second. Flow 1 is mixed and mostly the
first: the person wants to _see_ their client to-dos while in the client brain, which is a read
across a boundary they already have, unless the client is meant to see them too.

Naming the mechanism **publication** rather than **sync** keeps this straight, and puts the
question that actually matters (who is now able to read this) in the name of the feature.

The rest of this document is about publishing. Cross-brain read is a separate, probably cheaper,
probably higher-value piece of work, sketched in §11.

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

## 11. What we reuse, what is new, and what this is not

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
- Cross-brain search and cross-brain wikilinks. Separate work, probably cheaper, and it answers
  the "I need to find it" half of §3 outright. Worth doing first if the real pain turns out to be
  finding rather than publishing.
- Any notion of a shared page that lives in two brains at once.

## 12. Open questions

- **Is publishing the actual want, or is it cross-brain read?** §3 splits the motivating flows and
  two of the three fall on the read side. If that holds, cross-brain read is the higher-value build
  and this document describes the smaller half.
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

## 13. Rejected alternatives

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
