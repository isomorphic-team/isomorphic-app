# Design: collaboration between brains

- Status: Draft for discussion. Nothing built. Open questions in §14 are unresolved.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-19. Supersedes the 2026-08-10 draft, which designed publishing (a one-way
  key-addressed copy between repositories) and ruled shared surfaces out of scope. Publishing is
  not the route being taken; §15 says what happened to it.
- Audience: the engineering session that picks this up, and Jon deciding whether it should exist
- Related: `docs/design/brain-level-permissions.md` (the access rule this extends),
  `docs/design/records-tables-prd.md` (which owns motivating flow 1, see §2),
  `docs/roadmap.md`, `CLAUDE.md` (Brain model, Content index)

## 1. Summary

One person reaches several brains. Work done in one belongs, partly, in another: a client
engagement's deliverables, a personal to-do list that tracks client work, a venture's methodology
that a client should see. Today the only transport between two brains is a human copying text, and
nothing records that the copy happened, so the two diverge silently from the moment they are made.

The previous draft answered this with **publishing**: a declared, one-directional, key-addressed
flow of pages from one brain into another, reconciled rather than overwritten. That mechanism was
designed in full and is not what we are building.

The reason is that publishing answers a question most of these cases were not asking. The
discriminating question is not "which brain is it in" but **who needs it**, and for a reader who
**can be granted access**, nothing needs to move at all. Copying for such a reader is strictly
worse: it creates a second copy that drifts, for someone who could have read the original. Once
access can cross an organization boundary, that covers the collaboration case outright, and it
covers it with no copy, no reconciliation, no ledger, and no run.

**The whole design is one new primitive:** a brain reachable by someone who is not a member of its
organization. Everything else a shared brain needs already ships. Per-brain authorization, the
`brain` argument on every content tool, `matchBrain` resolution, per-brain index isolation, and
atomic writes are all in place and all brain-scoped already.

What this does not do is serve a reader who cannot be granted access at all. That case is real and
this design leaves it unserved, deliberately and visibly. See §8.

### Terminology

- **Shared brain**: a brain both parties can reach, holding work that belongs to neither of their
  own brains. Not a new kind of object: an ordinary brain, with grants.
- **Connection**: the product-level object a user manages, §9. A connection names a relationship
  and has a shared brain as its storage.
- **Grant**: a `brain_memberships` row. Today it can only raise a role within your own
  organization; §6 is about letting it cross.

## 2. Motivating case

Three brains, one person:

- A **client brain** for a consulting engagement. Shared with the client. Contains engagement
  material the client is entitled to see.
- A **personal brain**. To-dos, time tracking, working notes, everything.
- A **venture brain**. Methodology, offers, positioning. Some of it is material a client should
  receive; some of it is commercially sensitive.

Four flows the person wants, and what serves each:

|     | Flow                                                                         | Served by                      |
| --- | ---------------------------------------------------------------------------- | ------------------------------ |
| 1   | Client-tagged to-dos and time entries visible in the client's brain          | Records, not pages. See below. |
| 2   | A deliverable authored in the venture brain lands in the client's brain      | Publishing. Not built, §15.    |
| 3   | A page in the client brain is findable while working in the venture brain    | Cross-brain read, §12          |
| 4   | A working document the consultant and the client both edit, owned by neither | **A shared brain, §5**         |

Flow 4 is the subject of this document. Flow 3 is adjacent and mostly already ships, and is here
because a shared brain is reached by exactly that machinery.

**Flow 1's real answer is records, and it is not in this document.** Time entries and dated to-dos
against a client are activity records, not pages, which is the subject of
`docs/design/records-tables-prd.md`. Modeled there, the cross-brain question stops being "does this
page cross" and becomes "can an aggregate over records cross a boundary", which is a sharper and
smaller question: a client is owed the rollup ("14 hours this month against the engagement"), not
the underlying entries.

**Flow 2 is the one this design does not serve.** §8 states that plainly rather than pretending a
grant covers it.

## 3. The test: who needs it

The discriminating question is not "which brain is it in" but **who needs it**. Three answers:

- **"I need to find it."** The reader is the same person, who already has access to both brains.
  Nothing needs to move. What is missing is a **read** that spans a person's brains, §12.
- **"Someone who could be granted access needs to work on it with me."** The reader is a client,
  the content is not confidential to either side, and it does not belong to either brain. Nothing
  needs to cross, because the reader can be admitted to the place the content lives. This is
  **collaboration**, and it is the whole of this document.
- **"Someone who cannot reach my brain needs to see it."** The reader cannot be admitted: the
  material sits inside a brain holding things they must never see, and the page cannot be lifted
  out of it. Content must physically cross into a repository they can read. This is **publishing**,
  and it is the only case where copying is the right answer. Not built, §15.

The middle answer only became available when access could be widened. In the model as it stands
today it cannot: a brain is reachable only from its own organization (§6), so "admit the reader"
was not a move on the board, and every cross-boundary want collapsed onto publishing. Removing that
one constraint is what makes this document possible and makes the previous one mostly unnecessary.

The line between the second and third answers is **not** "is it confidential". It is whether the
content can live somewhere the reader is allowed to be. A confidential deliverable that can be
authored in a shared brain from the start is a collaboration. A page that can only exist inside a
brain full of other clients' material is a publication.

## 4. Hard constraints

Inherited from the architecture and not up for renegotiation here:

- **The repository is the source of truth. D1 is a cache.** Access grants are the exception and
  always were: they are platform state by nature, and a shared brain adds no new repo-side state.
- **No unbounded work in one request.** Any whole-brain pass must be budgeted, cursored, and
  resumable, per the `rebuild_cursor` pattern.
- **Nothing hosted-only.** A shared brain is an ordinary brain plus grants in the deployment's own
  D1. This rules out the platform-owned relationship repository, §15.
- **Multi-tenant isolation is the default.** Every index query is keyed by `brainId`. A shared
  brain does not weaken this: it is one brain, with one `brainId`, that more people can reach.
- **A page has exactly one home brain.** Unchanged, and collaboration does not violate it: the
  shared brain **is** the home. There is still no page that lives in two brains at once, and no
  page that is copied to stay in sync.
- **One brain, one file tree.** The tree backs wikilink resolution, folder-note lookup, and the
  path policy, and is dropped on brain change for that reason (`setActiveBrain`,
  `app/core/store.ts`). Nothing here merges foreign content into it, §10.

## 5. The model: a shared brain

A collaboration is **a brain both parties can write, living in one party's organization, with the
other party granted access to it directly.** No copy, no mount, no reconciliation, no third
mechanism.

Both sides open the same brain, and every content tool already resolves it: `brain` is an argument
on all of them, `matchBrain` resolves the handle, `effectiveBrainRole` authorizes against the brain
actually named, and the index isolates by `brainId`. A shared brain is not a new object with new
semantics; it is the object that already exists, reachable by one more person.

Consequences worth stating, because each is a thing the publishing design had to build and this one
gets for free:

- **No drift.** There is one copy. The question "are these two in sync" cannot be asked.
- **No run, no trigger, no ledger.** There is nothing to reconcile, so §10 of the previous draft
  (three rungs of automation, ending in a scheduled runner with a stored credential) evaporates.
  Freshness is `ensureFresh`, the same guard every read already uses.
- **No link horizon.** Links inside the shared brain resolve inside the shared brain. There is no
  published set to flatten links against and no page that arrives with holes.
- **No identity problem.** The previous draft needed keys because a page existed twice and paths
  moved on both sides. One page has one path, and `move_page` works on it normally.
- **Ordinary editing.** Nothing is read-only, nothing is tool-maintained, `write_page` and
  `isEditablePath` need no new cases.
- **Media works.** Attachments live in the same repository as the page referencing them. The
  previous draft had no answer for this at all.

**Where it lives:** one party's organization, defaulting to whoever created it. Not a
platform-owned repository, §15. The party who owns the repository keeps it when the relationship
ends, which is a real asymmetry and is the subject of an open question in §14.

## 6. The missing primitive: cross-organization brain grants

This is the only new mechanism in the document.

Resolution today starts from organization membership. `listAccessibleBrains` (`src/lib/orgs.ts`)
runs:

```sql
FROM memberships m
JOIN orgs o   ON o.org_id = m.org_id
JOIN brains b ON b.org_id = o.org_id
LEFT JOIN brain_memberships bm ON bm.brain_id = b.brain_id AND bm.user_id = m.user_id
WHERE m.user_id IN (...)
```

A `brain_memberships` grant is a LEFT JOIN on top of that set, so it can only **raise** a role on a
brain the caller can already see. There is no way to express access to a brain in an organization
you do not belong to.

The change is a second resolution branch: brains reached by direct grant, unioned with brains
reached by organization membership.

- **The policy rule survives.** `effectiveBrainRole` (`src/lib/orgs.ts:90`) already takes `grant`
  as one of three additive sources. What changes is its `orgRole` becoming nullable, and the
  grant-only path returning the grant alone. Sources (1) and (3), organization visibility and the
  organization-admin floor, are both inapplicable to an outsider and are skipped, which is exactly
  what "not a member" should mean.
- **The battery widens rather than multiplying.** `pnpm test:access` already walks the whole input
  space of that function, so a nullable `orgRole` is a new column in an existing table of cases.
- **Do not re-express the policy in the new WHERE clause.** The rule stated in
  `docs/design/brain-level-permissions.md` is that every consumer resolves rows in SQL and then
  admits them through `effectiveBrainRole`. A second resolution branch is a second place that could
  quietly encode policy, and it must not.
- **Nothing changes at the GitHub layer.** A brain in organization A is served by A's installation
  token, minted from `orgs.installation_id` on the brain's row. The blocker was never reachability;
  it was our own join. That fact is what rules out the platform-owned repository in §15, since
  platform ownership solves reachability and leaves access exactly where it was.

Downstream consumers that resolve brains (`getDefaultBrainForUser`, `listBrainAccess`,
`personUserIds` fan-in) all read from the same helper and inherit the widening. `chooseOrg` and
`listAccessibleOrgs` do **not**: a grant admits you to a brain, never to an organization, and a
shared brain must never appear as a place you can create or place brains.

## 7. Confidentiality: what a cross-organization grant opens

A grant that crosses an organization boundary is a mechanism for one organization's admin to expose
a brain to an outsider. It is the entire risk surface of this design, and it is smaller than
publishing's but not zero.

- **Both ends, or an organization-level policy.** Under current sharing rules a brain admin in A
  can grant a user in B unilaterally. At minimum an organization setting ("this organization permits
  external grants"), so an org can decline the capability wholesale. A full two-sided handshake is
  safer and is friction on the one act that makes collaboration work, §14.
- **Outsiders are visibly marked.** In `brain_access`, in the roster, and anywhere a brain's
  audience is shown. An outsider must never render as an ordinary colleague, because the whole
  judgement a person makes before writing something down is "who is in this room".
- **The organization roster must not leak.** `members` is organization-scope and an outsider
  holding only a brain grant must not reach it. The two-role split (`role` vs `orgRole`) is exactly
  what prevents this, but no test has ever exercised a **grant-only caller**, whose `orgRole` is
  null. That is a new input shape for `pnpm test:scope`, and it should land with the primitive
  rather than after it. Analytics has the same exposure: the per-person table gates on `orgRole` and
  a null must read as "not admin", not as "no gate".
- **Revocation must actually revoke.** Grants are torn down with what they hang off
  (`disconnect_brain` calls `deleteBrainGrants`, `remove_member` calls
  `deleteUserBrainGrantsInOrg`). A cross-organization grant hangs off nothing in the granting
  organization's membership table, so it has no existing teardown path and needs its own.
- **Billing and seats are unanswered.** A user in organization A working in organization B's brain:
  who counts them, and does `personUserIds` identity linking let someone widen their own reach
  across the boundary? Commercial question before technical, §14.

## 8. What this does not solve

Three things, stated plainly because each is a case someone will bring and none is covered.

**Concurrent edits to one page are last-writer-wins.** Git merges files; our write path does
read-modify-write against the authoritative blob and moves the branch ref. Two people editing the
same page in the same window will clobber. `write_page`'s `edits` (exact anchors, refused on zero or
multiple matches) is a real mitigation and is the thing to lean on, but it is not a merge story and
should not be described as one. Conflict pages remain rejected: a conflict page is a to-do item
nobody clears. What a shared brain does escape is two writers in two repositories, which is the
unrecoverable version of the same problem.

**A reader who cannot be granted access is unserved.** This is §3's third answer and it is real: a
page that can only exist inside a brain holding other clients' material, needed by someone who must
never see that brain. Today the answer is a human copying text, which is where we started. The
previous draft's publishing design is the answer to this and it is not being built; §15 says where
it lives. If this case turns out to be common in practice, that is the signal to go get it, and the
design is intact rather than lost.

**Single-owner documents have no round trip.** If a document genuinely belongs to one side and the
other should only respond, a shared brain does not model that: it makes both parties editors.
Two mechanisms preserve single ownership, neither built:

- **A comment layer.** The document stays owned; a responder writes a sibling page carrying
  `responds_to: <page>`, and the original renders an `okf-view` of its responses. Built from
  machinery that exists: `backlinksTo` and ordinary pages. It matches how review works, where the
  document has one author and the feedback has others, and they are different objects rather than
  one contested object.
- **Propose-back as a pull request.** `commitOrPR` (`src/lib/brain-repo.ts:550`) already takes
  `writeMode: 'pull-request'` and builds the branch, tree, and PR. "Suggest an edit" opens a PR
  instead of writing directly. Single ownership, explicit review, no new storage topology.

Both are additive later and neither blocks the primitive.

## 9. The brain list must not sprawl

If every relationship is a brain, the list grows without bound: several clients, several shared
surfaces each, plus internal team-to-team surfaces. The switcher becomes unusable and fan-out search
gets expensive and noisy.

This is a modeling problem, not a display problem. Solving it with filters and badges is a losing
fight. It sprawls because a relationship is being rendered as a peer of a workspace, and it is not
one. Nobody has thirty-one brains; they have three brains and twelve relationships, and a
relationship is always **about** something.

### Rule 1: a shared brain is in scope when you are in a brain it connects to

This is the rule that bounds the list. Sprawl becomes bounded by the **degree of the current
brain**, not by the total count of relationships. From the personal brain: your brains, plus the
surfaces attached to the personal brain. From the client brain: the surfaces attached to that.
Nobody sees all twelve at once, it needs no configuration, and the answer to "why am I seeing this"
is always one hop.

The same rule governs fan-out search: **a shared brain is in scope for fan-out when its other end is
the active brain.** Otherwise a search from the personal brain surfaces client-shared material,
which is §12's leak-through-the-human scenario with a wider radius. One rule across navigation and
search is worth more than two tuned ones.

### Rule 2: the connection is the object, the brain is its storage

Users manage **connections**, not shared brains. A connection has a name (the counterparty or the
shared purpose), its parties, and a brain behind it. The brain surfaces when they open it, the way a
repository surfaces behind a brain today.

This also fixes naming. Twelve shared brains need twelve names someone has to invent and keep
distinct; twelve connections are named for who they are with, which is a name that already exists
and that both parties agree on.

### Rule 3: classification is free, but not sufficient

The §6 work adds a second resolution branch, so the payload can carry a derived
`via: 'org' | 'grant'` with no new column and no migration. That is enough to render a "Shared with
you" section differently.

It is not enough to identify a relationship: a private brain shared to a colleague in your own
organization also arrives by grant. Use `via` for presentation and the connection object for
meaning.

### Intra-organization is not the hard case

Two teams in one organization sharing a brain is already just a brain with grants. It works today,
needs no connection object, and its only issue is list length, which Rule 1 handles.

The connection wrapper earns its keep at **boundaries where the parties do not otherwise see each
other**: that is where the name matters, where consent matters, and where "who is on the other side"
is not answerable from the organization roster. Do not pay for the concept inside a single
organization.

### Hierarchy is deferred, not foreclosed

Up-and-down (division, department, team) is containment, which is a third relation and not a
two-party connection with a direction. Not built here. What preserves the option is keeping
connections as **named objects with parties**, so hierarchy later becomes a type or a containment
flag rather than a parallel model.

The trap is modeling hierarchy as a chain of pairwise shares. It looks correct at two levels and
produces exactly this section's sprawl at three.

## 10. The file tree is never merged

Content from a shared brain does not appear in another brain's file tree. The tree is per-brain by
construction: `setActiveBrain` (`app/core/store.ts`) nulls `browseCache` and resets the path policy
on every brain change.

Merging would reintroduce everything this design avoids:

- **The tree backs wikilink resolution and folder-note lookup**, which is why it is dropped on brain
  change. `wikilinkKey` builds its lookup table from one brain's page set and the index isolates by
  `brain_id`. Foreign pages in the tree give either a `[[link]]` silently resolving across a brain
  boundary, or rows that links provably cannot reach.
- **Edit policy stops being a path question.** `isEditablePath` is a path predicate with no brain to
  consult; a merged tree would force brain identity through every path in the app.
- **Paths collide.** Both brains have `wiki/index.md`. Any prefix invented to disambiguate is a
  mount point, with nothing behind it.
- **The freshness contract breaks.** §12 settles that the guarantee is per brain and only the brain
  you are in keeps it, because `ensureFresh` costs one `branchCommitSha` per brain per read. A
  merged tree either pays that for every connected brain on every render, or renders stale foreign
  content indistinguishably from live local content.
- **Folder names are disclosure.** `prospects/`, `pricing/`, `renewal-risk/`. A tree reads as "this
  is what is in here", and structure is information even when the pages are unreadable.

It is also issue #26 rebuilt as architecture. That bug was the crumb naming one brain while the
content came from another, and the fix was that the brain a result names is authoritative. A tree
under brain A's crumb containing brain B's pages makes that state permanent and intentional.

**Adjacent, not merged.** Showing a shared brain as a second, collapsed, clearly labeled root in the
same panel is fine: its own tree, its own brain, its own crumb when entered. The visual adjacency is
free. The semantic merge, one tree claiming to contain two brains, is what costs.

## 11. Reaching a shared brain

Five routes, in descending order of expected use.

1. **The brain switcher.** Shared brains appear in their own section below the organization groups,
   filtered by Rule 1. One click from anywhere. `groupBrainsByOrg` (`app/core/util.ts:95`) already
   returns sections and collapses to flat when there is one group, so only the third section is new.
   Clicking **switches you**: crumb, tree, and policy all follow, via the existing `setActiveBrain`
   path. Not a peek. A peek is a second brain rendered while the crumb still names the first, which
   is the issue #26 state.
2. **Asking.** "Show me the shared kickoff doc." Claude calls `view_page` with `brain:`, the widget
   opens on that brain, and `pickShownBrain` lands the crumb correctly because the result declares
   its brain. This works today with no new UI. The app is an MCP App inside a conversation, and the
   primary navigation is asking; the chrome is for orientation and browsing, not for being the only
   route in.
3. **Search.** Fan-out results name their brain, and clicking a foreign hit takes you there. This is
   the route for someone who does not know the connection exists.
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
   is visible, never a bare wikilink resolving elsewhere. See §12 for why the syntax is still open.

The panel itself is the brain-scope twin of `BrainAccessView`: one row per connection with the
counterparty, your role on the far side, and last activity. Creating one is a pushed flow off the
header, following the `Flow.tsx` convention `ShareBrainView` and `InviteMemberView` already use.

Routes 1 and 2 are the product. Route 4 is orientation, visited once to understand the shape. If the
Connections panel becomes the main way people reach shared content, the switcher section is not
working, and that is the thing to fix.

## 12. Cross-brain read: most of it already ships

§3's first answer sends "I need to find it" here. It is also how a shared brain is reached, so it is
not a separate feature so much as the substrate this one sits on.

**Every content tool already takes an optional `brain`.** `read_page`, `list_pages`, `search_pages`,
`find_inbound_links`, `validate`, `write_page`, `move_page` and `delete_page` all carry `brainArg`,
resolved by `matchBrain` against the caller's accessible set. Three properties that make this safe
today and are worth not breaking:

- **A targeted call does not move you.** `maybeStick` fires only when a tool passes `sticky` (the
  in-client view tools and `brain_access`), so reading or writing another brain leaves the active
  brain alone.
- **Authorization is per brain.** Resolution runs `effectiveBrainRole` for the brain actually named,
  so a write into another brain is checked against that brain, not the one you came from. This is
  what makes §6 safe: widening which brains resolve does not widen what happens once one does.
- **Ambiguity is refused, not guessed.** `matchBrain` returns candidates on a multi-hit and the
  resolver throws with the list.

So "while working in the client brain, add a to-do to my personal brain" works now. **What does not
exist is a single call that spans brains**, and that is the whole of the gap.

### The three real gaps

1. **Fan-out.** Every call resolves exactly one brain. At the storage layer this is nearly nothing:
   one D1 holds every brain's index and the queries are `WHERE brain_id = ?1`. The cost is
   freshness, not SQL. `ensureFresh` is one `branchCommitSha` per brain per read, so fanning out
   over N brains spends N subrequests before answering. That forces a decision, and the right one
   is: **the freshness guarantee is per brain, and only the brain you are in keeps it.** Fan-out
   search serves the others from whatever is indexed and labels the result as such; a `read_page` on
   any hit resolves the authoritative blob anyway. Slightly stale discovery followed by a fresh read
   is correct behavior for a search.
2. **Discoverability.** The capability is invisible rather than absent. `SERVER_INSTRUCTIONS` is
   emitted only in the `initialize` result and is therefore fixed for the life of a connection, so
   it cannot enumerate a caller's brains; `brains` returns them but is only called when something
   prompts it. This is the `read_page` / `view_page` description failure in another costume: a
   capability an agent does not find by name does not exist.
3. **Attribution in results.** A fan-out result set that does not say which brain each hit came from
   will get one client's material quoted into another client's conversation. Every row must name its
   brain.

### The risk here is conversational, not mechanical

Cross-brain read moves nothing and grants nobody access, so it reads as safe. The leak channel is
different in kind: a conversation rooted in one client's brain surfaces another engagement's
material, the model writes it into a reply, and a human pastes that reply somewhere. Nothing was
shared; the leak went through the human. A shared brain widens the population this can happen to,
which is why Rule 1 governs fan-out and not just navigation.

Mitigations, in order of value:

- **Every result names its brain** (gap 3 above). Cheap, and it is the one that matters.
- **Scope fan-out by Rule 1** (§9): a shared brain is in scope when its other end is the active
  brain. A default that needs no configuration, though an explicit opt-out is still worth having for
  a personal brain.
- **Fan-out is opt-in per call, never ambient.** The default stays the active brain, so an ordinary
  conversation keeps an ordinary blast radius.

### Write fans out over nothing

Cross-brain read fanning out is a convenience. Cross-brain write fanning out is a bulk operation
whose blast radius crosses organizations and is invisible in the transcript. This is the objection
the roadmap already raises against `filter:`-selected bulk updates, one boundary worse. A write
names exactly one brain, always.

The residual write risk is not ambiguity (refused) but confident-and-wrong: a unique substring match
on the wrong brain lands a real page in a real client's repository. The cheap mitigation is that
**the write response names the brain it landed in**, so the mistake is visible in the same turn
rather than found later.

### Cross-brain wikilinks stay excluded

A `[[other-brain:Kickoff]]` means nothing to github.com or to any OKF consumer, which is a larger
divergence than `[[wikilinks]]` already are, and a broken cross-brain link is indistinguishable from
a permission denial. Rendering one tells a reader that a page exists which they are not allowed to
see, and `validate` would report the same page broken for one reader and fine for another. §11's
route 5 wants some explicit form; it should be a link syntax that announces the crossing and
degrades to plain text, not a wikilink. The syntax is open, §14.

## 13. What we reuse, what is new, and what this is not

**Reused unchanged:**

- `effectiveBrainRole` for every authorization check, with `orgRole` widened to nullable, and
  `pnpm test:access` as its battery.
- `matchBrain`, `brainArg`, and per-brain index isolation, which is the whole of a shared brain's
  read and write path.
- `commitFiles` / `commitOrPR`, unchanged. The `writeMode: 'pull-request'` path is also the
  propose-back mechanism in §8 if that is ever built.
- `groupBrainsByOrg` and the `Flow.tsx` pushed-flow convention for the UI.
- `brain_memberships`, `share_brain`, and `BrainAccessView`, which already model per-brain grants
  and only need to stop being organization-bounded.

**Genuinely new:**

- **Cross-organization brain grants** (§6): a second resolution branch, a nullable `orgRole`, a
  teardown path for a grant that hangs off no membership, and a `pnpm test:scope` case for the
  grant-only caller. This is the entire mechanism.
- **The confidentiality controls around them** (§7): the organization-level policy, outsider
  marking, and the roster and analytics gates re-verified against a null `orgRole`.
- **The connection object and the contextual scope rule** (§9), plus the Connections destination
  (§11).

**Explicitly not in scope:**

- **Publishing / one-way keyed copies between brains** (§15). The mechanism the previous draft
  designed. Not built, and §8 states the case it leaves unserved.
- **A shared page that lives in two brains at once.** A page has exactly one home brain; a shared
  brain **is** that home.
- **Merging foreign content into a brain's file tree** (§10), in any form.
- **Platform-owned relationship repositories** and **git submodules** (§15), in any variant.
- **Merge resolution for concurrent edits** (§8). Last-writer-wins at the body level is the accepted
  behavior, mitigated by anchored `edits`.
- **Hierarchical relationships** (§9), deferred but not foreclosed.

## 14. Build order and open questions

1. **Cross-brain read** (§12, gaps 1 and 3). Smallest, highest value, needs no new model, and is the
   substrate everything else sits on.
2. **Cross-organization grants** (§6) with the confidentiality work in §7. This is the unlock, and
   the two halves ship together: the roster and analytics gates are not a follow-up.
3. **Rule 1 scoping and the switcher section** (§9, §11 route 1). Without this, step 2 sprawls.
4. **The connection object and Connections destination** (§9, §11 route 4), once two or three real
   relationships exist to shape it.

Steps 1 to 3 are what would change how the product feels. Step 2 is where the whole risk sits.

Open:

- **Should a cross-organization grant require both ends to declare it?** §7 argues for at least an
  organization-level policy so an organization can decline the capability. A full two-sided
  handshake is safer and is friction on the single act that makes collaboration work at all.
- **Where does the connection object live?** Repository config keeps it with the §4 rule that state
  lives in the repos. Platform state is the only place that can describe a relationship neither
  repository fully owns, and grants are already platform state.
- **What happens to a shared brain when the relationship ends?** It lives in one party's
  organization (§5), so the other party loses it on revocation. That is correct for access and
  possibly wrong for the record: a client who co-authored a document for six months has no copy.
  An export, a fork-on-revoke, or an explicit "your copy" arrangement are all unbuilt.
- **Billing and seats for cross-organization collaborators** (§7). Commercial question before
  technical.
- **What is the explicit cross-brain link syntax** that §11 route 5 needs and §12 declines to make a
  wikilink?
- **Should a shared brain be visibly different from an ordinary one to its non-owning party?** `via`
  (§9, Rule 3) marks it in the list. Whether the brain itself should say "this is shared with
  Northwind, and they can read everything in it" on every page is a stronger claim and probably the
  right one.
- **Does the unserved case in §8 show up in practice?** This is the question that decides whether
  publishing comes back. It should be answered with real usage, not in advance.

## 15. Rejected alternatives

- **Publishing: a one-way, key-addressed flow of pages between repositories.** The previous draft's
  entire design (publication/subscription config declared in both repos, identity as a key rather
  than a path, `body: source-owned` with read-only received pages, link flattening at the published
  set's horizon, proposed-not-applied deletions, a no-resurrection ledger, three rungs of
  automation). It is coherent and it answers §3's third question, which this design does not. It is
  not being built because the other two answers cover the flows we actually have, and because it is
  a large mechanism with a permanent confidentiality surface: an automated flow out of a personal
  brain into a client's repository is an exfiltration channel that runs without a human in the loop.
  The full design is recoverable from git history (`docs/design/brain-seams.md` before this
  revision) if §8's unserved case turns out to matter.
- **Platform-owned relationship repositories.** A repository in the platform organization, granted
  to both sides. It does not work: the caller is not a member of the platform organization either,
  so the §6 join returns nothing. **Platform ownership solves reachability and does nothing about
  access**, and once §6 exists it buys nothing the simpler topology lacks. What it would buy is
  neutral custody, so neither party can delete the surface or rewrite its history. Against that: it
  makes the platform installation structurally load-bearing between two parties who otherwise have
  no relationship with it; it turns a transient broker (the Worker holds bytes for one request) into
  a durable custodian of two customers' co-authored material, with an orphaning problem when a
  relationship ends; and it is a silo for exactly the content least able to afford one, since
  content in a customer's own repository is theirs when they leave.
- **Git submodules, in every variant.** Mounting the other brain into yours fails at four layers:
  `listTree` (`src/lib/brain-repo.ts`) filters `e.type === 'blob'`, so a gitlink is invisible to the
  content index; granularity is whole-repository; anyone who can read the parent reads the
  submodule's full extent, bypassing `effectiveBrainRole`; and a write spanning the boundary is two
  commits in two repositories, breaking `commitFiles` atomicity. A dedicated publication repository
  per relationship repairs the middle two and still leaves the index blind, the receiver unable to
  file anything (a mount is a fixed path), and no per-page identity. Bidirectional mounts are legal
  (pinned shas terminate) but a gitlink is a read mount, so writing into it means committing in the
  other repository, which is correspondence rather than collaboration.
- **Two publishing seams pointed at each other.** Produces **correspondence**, not collaboration:
  each side owns its own artifacts and sends copies, a page never becomes co-owned, and a receiver
  who edits an arrival has forked it. Fine for deliverables out and status back; wrong for a
  document two people write. Two `body: seed` seams over the same page set are worse still: two
  independently owned copies both claiming the same key, which is the conflict-page failure with
  extra steps.
- **An undifferentiated "commons" brain.** One brain holding everything shared with everyone. A
  collaboration is scoped to its parties and its purpose; a commons is the same object with the
  scoping removed, which makes every grant a decision about all of it.
- **Symlink-style pointer pages that the reader resolves live.** Cross-brain read wearing a page
  costume. It adds a page-shaped object whose content depends on the reader, which `validate` cannot
  reason about and which reports differently to two people looking at the same brain.
