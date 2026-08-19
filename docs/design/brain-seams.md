# Design: collaboration between brains

- Status: BUILT, 2026-08-19. Steps 1 to 6 of §15 are in `main`: cross-brain search, the connection
  object, anchor-derived access, creating and joining, ending with resumable read-only mirrors, and
  the panel. What is NOT built is listed at the end of §15 and in `CLAUDE.md`: creating or ending a
  connection from the UI (conversational only), any notification when an invitation arrives, and
  export. Where this document and the code disagree, the code won and §15 says so.
- Author: Jon Hansing (via Claude)
- Date: 2026-08-19. Supersedes the 2026-08-10 draft, which designed publishing (a one-way
  key-addressed copy between repositories) and ruled shared surfaces out of scope. Publishing is
  not the route being taken; §16 says what happened to it.
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
organization. Everything else a connection brain needs already ships. Per-brain authorization, the
`brain` argument on every content tool, `matchBrain` resolution, per-brain index isolation, and
atomic writes are all in place and all brain-scoped already.

Three decisions sit on top of that primitive:

- **Access is derived, not granted** (§6). Each side anchors the connection to one of its own
  brains, and anyone who can reach that anchor reaches the connection, at their role there, capped
  at editor. So each party governs who is in the room by governing its own brain's access list,
  and no cross-organization user administration exists at all.
- **The connection brain is owned by neither party** (§5). It lives in the platform organization,
  which is already where every auto-provisioned brain lives. A collaboration between two commercial
  peers should not sit inside one peer's namespace, where the other is a guest for the life of the
  engagement. Where the bytes physically sit has no user-visible consequence, since nobody in this
  audience touches a repository; it is a legal and commercial question, not a product one.
- **Ending a connection is non-destructive** (§7). Either party may end it, neither inherits the
  original, and each receives a **mirror**: a read-only copy landing in their own brain list. That
  is what keeps the revoke button from being a weapon, and it is what makes the rest of this design
  tolerable to design around.

What this does not do is serve a reader who cannot be granted access at all. That case is real and
this design leaves it unserved, deliberately and visibly. See §9.

### Terminology

- **Connection**: the product-level object, and the thing a user manages. It names a relationship,
  has two parties, and has a connection brain as its storage.
- **Connection brain**: where a connection's pages live. Not a new kind of object: an ordinary
  brain, owned by neither party, in the platform organization.
- **Anchor**: the brain each party joins the connection to. It is the unit of access (§6) and the
  unit of scope (§10), and each party names its own.
- **Mirror**: the read-only copy each party receives in their own brain list when a connection ends,
  §7. Never written to, so it cannot drift.

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
| 2   | A deliverable authored in the venture brain lands in the client's brain      | Publishing. Not built, §16.    |
| 3   | A page in the client brain is findable while working in the venture brain    | Cross-brain read, §13          |
| 4   | A working document the consultant and the client both edit, owned by neither | **A connection brain, §5**     |

Flow 4 is the subject of this document. Flow 3 is adjacent and mostly already ships, and is here
because a connection brain is reached by exactly that machinery.

**Flow 1's real answer is records, and it is not in this document.** Time entries and dated to-dos
against a client are activity records, not pages, which is the subject of
`docs/design/records-tables-prd.md`. Modeled there, the cross-brain question stops being "does this
page cross" and becomes "can an aggregate over records cross a boundary", which is a sharper and
smaller question: a client is owed the rollup ("14 hours this month against the engagement"), not
the underlying entries.

**Flow 2 is the one this design does not serve.** §9 states that plainly rather than pretending a
grant covers it.

## 3. The test: who needs it

The discriminating question is not "which brain is it in" but **who needs it**. Three answers:

- **"I need to find it."** The reader is the same person, who already has access to both brains.
  Nothing needs to move. What is missing is a **read** that spans a person's brains, §13.
- **"Someone who could be granted access needs to work on it with me."** The reader is a client,
  the content is not confidential to either side, and it does not belong to either brain. Nothing
  needs to cross, because the reader can be admitted to the place the content lives. This is
  **collaboration**, and it is the whole of this document.
- **"Someone who cannot reach my brain needs to see it."** The reader cannot be admitted: the
  material sits inside a brain holding things they must never see, and the page cannot be lifted
  out of it. Content must physically cross into a repository they can read. This is **publishing**,
  and it is the only case where copying is the right answer. Not built, §16.

The middle answer only became available when access could be widened. In the model as it stands
today it cannot: a brain is reachable only from its own organization (§6), so "admit the reader"
was not a move on the board, and every cross-boundary want collapsed onto publishing. Removing that
one constraint is what makes this document possible and makes the previous one mostly unnecessary.

The line between the second and third answers is **not** "is it confidential". It is whether the
content can live somewhere the reader is allowed to be. A confidential deliverable that can be
authored in a connection brain from the start is a collaboration. A page that can only exist inside a
brain full of other clients' material is a publication.

## 4. Hard constraints

Inherited from the architecture and not up for renegotiation here:

- **The repository is the source of truth. D1 is a cache.** Access is the exception and always was:
  it is platform state by nature, and a connection adds no new repo-side state. The connection
  object itself inherits that carve-out for the same reason, since it describes a relationship
  neither repository owns.
- **No unbounded work in one request.** Any whole-brain pass must be budgeted, cursored, and
  resumable, per the `rebuild_cursor` pattern.
- **Nothing hosted-only.** A connection brain is an ordinary brain in the deployment's own platform
  organization plus rows in its own D1. Every deployment has a `PLATFORM_ORG`, so a self-hoster
  runs this unchanged. Both parties must be on the same deployment, which was already true of
  everything else here.
- **Multi-tenant isolation is the default.** Every index query is keyed by `brainId`. A shared
  brain does not weaken this: it is one brain, with one `brainId`, that more people can reach.
- **A page has exactly one home brain.** Unchanged, and collaboration does not violate it: the
  connection brain **is** the home. There is still no page that lives in two brains at once, and no
  page that is copied to stay in sync.
- **One brain, one file tree.** The tree backs wikilink resolution, folder-note lookup, and the
  path policy, and is dropped on brain change for that reason (`setActiveBrain`,
  `app/core/store.ts`). Nothing here merges foreign content into it, §11.

## 5. The model: a platform-owned connection brain

A collaboration is **a connection brain: an ordinary brain, owned by neither party, that each party
reaches through one of its own brains.** No copy, no mount, no reconciliation, no third mechanism.

Both sides open the same brain, and every content tool already resolves it: `brain` is an argument
on all of them, `matchBrain` resolves the handle, `effectiveBrainRole` authorizes against the brain
actually named, and the index isolates by `brainId`. A connection brain is not a new object with new
semantics; it is the object that already exists, reachable by two parties instead of one
organization.

Consequences worth stating, because each is a thing the publishing design had to build and this one
gets for free:

- **No drift.** There is one copy. The question "are these two in sync" cannot be asked.
- **No run, no trigger, no ledger.** There is nothing to reconcile, so the previous draft's three
  rungs of automation, ending in a scheduled runner with a stored credential, evaporate. Freshness
  is `ensureFresh`, the same guard every read already uses.
- **No link horizon.** Links inside the connection brain resolve inside it. There is no published
  set to flatten links against and no page that arrives with holes.
- **No identity problem.** The previous draft needed keys because a page existed twice and paths
  moved on both sides. One page has one path, and `move_page` works on it normally.
- **Ordinary editing.** Nothing is read-only, nothing is tool-maintained, `write_page` and
  `isEditablePath` need no new cases.
- **Media works.** Attachments live in the same repository as the page referencing them. The
  previous draft had no answer for this at all.

### Where the bytes live is not a UX question

The repository sits in the **platform organization**, which is where `provisionBrainForUser`
already puts every auto-provisioned brain (`src/lib/provision.ts`: "the platform org all brains are
created under"). This is not a new custody posture; it is the existing one.

One correction to that sentence, because it matters for implementation: `PLATFORM_ORG` is a GitHub
organization _login_, not a row in `orgs`. In the database, `model = 'platform'` means a personal
organization, one per user. Since `brains.org_id` is `NOT NULL`, a connection brain needs an
organization row of its own, and the right shape is a single system organization holding every
connection and having **no members at all**. That is not a workaround; it is what makes §6 hold by
construction rather than by a filter.

It is worth being clear that this choice has **no user-visible consequence**. Nobody in the target
audience clones a repository. What a person experiences is three things, and all three are D1 rather
than storage: can I open it, does it show in my brain list, and can someone take it away from me.
So repository location should be decided on legal and commercial grounds (who is the data
controller, what the DPA says, what happens to the content on insolvency) rather than on product
ones, and it can be revisited without touching anything in this document except this paragraph.

What platform ownership buys is **custody neutrality while the connection is live**: neither party
can delete the other's access to a brain they do not own, rewrite its history, or control the record
if a relationship turns adversarial. A connection between two commercial peers should not sit inside
one peer's namespace, and the alternative (one party's organization, defaulting to whoever created
it) makes the other party a guest for the life of the engagement.

An argument that was made for customer-owned repositories and does not survive contact with the
audience: that content in your own repository is "yours, readable without us". For a non-technical
user that is a property they cannot exercise. It is real in a liquidation scenario and it is not
lived. The answer to "what if Isomorphic disappears" is an **export** capability, which is separate
work and is not what §7's mirror provides.

### Platform ownership does not remove the primitive. It doubles it

A recurring temptation is to treat a platform-owned repository as a way to avoid the access work in
§6. It is not. **Both parties are non-members of the platform organization**, so `listAccessibleBrains`
returns the connection brain for neither of them until §6 exists. Platform ownership solves
reachability, which was never the blocker; §6 solves access, which is. Choosing a platform-owned
connection brain means the anchor branch is on the critical path for **both** sides rather than one.

That is also the safety property. With no members anywhere in a connection's organization, the
anchor branch is the _only_ path that returns these rows, so a mistake in §6 makes connection
brains invisible rather than over-shared.

## 6. The missing primitive: reaching a brain through an anchor

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

The change is a second resolution branch, unioned with the membership one, that reaches a
connection brain through its **anchor**:

```
memberships → brains (the anchor) → connection_parties → connections → brains (the connection)
```

**Access is derived, not granted, and that is the decision this section turns on.** The obvious
design was an individual cross-organization grant: a `brain_memberships` row naming an outsider.
It is rejected in §16. Deriving access from the anchor instead means:

- **Each party governs its own audience.** Adding a colleague to the room is adding them to your
  own brain, which is something a person already does and already understands. Neither side
  administers people in the other's organization, and neither side can.
- **Revocation is automatic and cannot be forgotten.** Losing the anchor loses the connection, in
  the same statement. An individual grant, by contrast, hangs off nothing in either organization's
  membership table and has no existing teardown path: `deleteUserBrainGrantsInOrg` is scoped by
  `brains.org_id`, so a person removed from their own organization would keep the client room.
- **There is no outsider object to mark or audit**, so §8 shrinks to what it should be.
- **The role cap is one rule rather than a policy surface.** Effective role is
  `min(anchor role, editor)`. `admin` is deliberately unreachable, because brain-admin means share
  and configure and both are meaningless when access is derived. Ending a connection is gated
  separately, §7.

What carries over unchanged:

- **The policy rule survives.** `effectiveBrainRole` (`src/lib/orgs.ts:90`) already takes three
  additive sources. What changes is its `orgRole` becoming nullable, plus a cap input. Sources (1)
  and (3), organization visibility and the organization-admin floor, are both inapplicable to
  someone who is not a member and are skipped, which is exactly what a null should mean.
- **The battery widens rather than multiplying.** `pnpm test:access` already walks the whole input
  space of that function, so a nullable `orgRole` and a cap are two new columns in an existing
  table of cases.
- **Do not re-express the policy in the new WHERE clause.** The rule stated in
  `docs/design/brain-level-permissions.md` is that every consumer resolves rows in SQL and then
  admits them through `effectiveBrainRole`. A second resolution branch is a second place that could
  quietly encode policy, and it must not.
- **Nothing changes at the GitHub layer.** A brain in organization A is served by A's installation
  token, minted from `orgs.installation_id` on the brain's row. The blocker was never reachability;
  it was our own join. This is why platform ownership (§5) is not a substitute for this section:
  it solves reachability, which was never the blocker, and leaves access exactly where it was.

Downstream consumers that resolve brains (`getDefaultBrainForUser`, `listBrainAccess`,
`personUserIds` fan-in) all read from the same helper and inherit the widening. `chooseOrg` and
`listAccessibleOrgs` do **not**: an anchor admits you to a brain, never to an organization, and a
connection brain must never appear as a place you can create or place brains. Because those two
start `FROM memberships` and a connection's organization has no members, that holds by
construction rather than by a filter someone can forget.

## 7. Ending a connection: revocation and the mirror

The question a connection brain has to answer is not who stores it but **who can end it, and what
the other party is left with.** A shared surface that one side can make vanish is not a peer
relationship, whatever the storage says.

**Either party may end a connection.** It is a relationship, not a permission one side hands down,
and requiring the other side's consent to leave would be worse than the asymmetry it fixes.

**Neither party inherits the original.** When a connection ends, both anchors detach and the
connection brain is archived. The alternative, where the party who revoked keeps the live brain, makes revoking
first a way to win the artifact and turns the button into a weapon. Nobody owning it while it runs
and nobody inheriting it when it stops are the same decision stated twice.

**Each party gets a mirror**: a read-only copy of the connection brain's content, landing in that
party's own brain list as an ordinary brain they can open, search, and read. Three properties, each
a decision:

- **Per organization, not per person.** Granted to whoever held access when the connection ended.
  Per-person would give four colleagues four copies of the same engagement, and would hand a
  personal copy to someone who happened to have access on their last day.
- **Created at revocation, not maintained from the start.** An earlier version of this design kept
  a live mirror throughout, on the reasoning that exit-time cooperation is unreliable. Platform
  ownership removes that worry: the platform holds the content and can mirror it unilaterally, with
  no cooperation from either party and no dependency on the other organization still existing.
  Creating it lazily saves two repositories per relationship and keeps the brain list clean while
  the connection is live, where a mirror would only be a duplicate of something you can already
  open. The connection brain is archived rather than deleted, so a mirror that fails to materialize
  can still be produced late.
- **Dead on arrival, deliberately.** Nothing ever writes to a mirror. It is a record, not a second
  working surface, which is what separates it from the publishing design: one editable copy and one
  inert one means drift is not managed, it is impossible. No keys, no ledger, no reconciliation.
  Note that inertness is not free. Giving everyone a viewer role is not enough, because the
  organization-admin floor in `effectiveBrainRole` hands an admin of the receiving organization
  their own role back. The brain itself has to carry the flag, and the resolved role is capped
  against it.

**What the mirror does and does not protect against.** It protects you from your counterparty:
ending a relationship costs future collaboration and never costs the record. It does **not** protect
you from us. A platform-held mirror of a platform-held brain is no insurance against the platform,
and describing it that way would be dishonest. That concern is real and its answer is an export
capability, §15.

Revocation being non-destructive is what makes the rest of this design tolerable. If ending a
connection could destroy six months of a client's co-authored work, the revoke path would need
governance, confirmation flows, and probably a cooling-off period. Because it cannot, revoking is an
ordinary act.

## 8. Confidentiality: what a connection opens

A connection is a mechanism for exposing a brain to an organization that cannot otherwise see it.
It is the entire risk surface of this design, and it is smaller than publishing's but not zero.
Deriving access from an anchor (§6) removes three of the five concerns an individual grant would
have carried; what remains is real.

- **Consent is two-sided by construction, not by policy.** Because access derives from an anchor
  and only a party can name its own, the far side must join a connection before anyone there can
  reach it. That is the two-sided handshake §6 would otherwise have needed as a separate
  mechanism, and it costs one deliberate act rather than an invitation table. An organization-level
  setting to decline connections wholesale is still worth having, but it is defense in depth rather
  than the control.
- **A room shows who is in it, marked by side.** A connection's people list is the union of two
  anchors' audiences, and a person from the other organization must never render as a colleague:
  the whole judgement someone makes before writing something down is "who is in this room".
- **The organization roster must not leak.** `members` is organization-scope and someone reaching a
  connection must not touch it. The two-role split (`role` vs `orgRole`) is exactly what prevents
  this, but no test has ever exercised a caller whose `orgRole` is **null**. That is a new input
  shape for `pnpm test:scope` and it should land with the primitive rather than after it. Analytics
  has the same exposure: the per-person table gates on `orgRole`, and a null must read as "not
  admin" rather than as "no gate". Both fail closed today, but by accident rather than by design,
  and one of them renders the literal string `undefined` to the user.
- **Revocation needs no teardown path, which is the point.** An individual grant hangs off nothing
  in either organization's membership table and would need its own cleanup. A derived one is
  revoked by the statement that removes someone from the anchor brain, so there is no row to leave
  behind and nothing to forget.
- **Billing and seats are unanswered.** Someone in organization A working in a connection: who
  counts them, and does `personUserIds` identity linking let a person widen their own reach across
  the boundary? There is a concrete instance of this already: usage counters are written per
  organization, and a connection's organization has no admin, so work done in a connection is
  recorded against nobody and is invisible on every Analytics tab. Commercial question before
  technical, §15.

## 9. What this does not solve

Three things, stated plainly because each is a case someone will bring and none is covered.

**Concurrent edits to one page are last-writer-wins.** Git merges files; our write path does
read-modify-write against the authoritative blob and moves the branch ref. Two people editing the
same page in the same window will clobber. `write_page`'s `edits` (exact anchors, refused on zero or
multiple matches) is a real mitigation and is the thing to lean on, but it is not a merge story and
should not be described as one. Conflict pages remain rejected: a conflict page is a to-do item
nobody clears. What a connection brain does escape is two writers in two repositories, which is the
unrecoverable version of the same problem.

**A reader who cannot be granted access is unserved.** This is §3's third answer and it is real: a
page that can only exist inside a brain holding other clients' material, needed by someone who must
never see that brain. Today the answer is a human copying text, which is where we started. The
previous draft's publishing design is the answer to this and it is not being built; §16 says where
it lives. If this case turns out to be common in practice, that is the signal to go get it, and the
design is intact rather than lost.

**Single-owner documents have no round trip.** If a document genuinely belongs to one side and the
other should only respond, a connection brain does not model that: it makes both parties editors.
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

## 10. The brain list must not sprawl

If every relationship is a brain, the list grows without bound: several clients, several shared
surfaces each, plus internal team-to-team surfaces. Anything that lists brains becomes unusable, and
fan-out search gets expensive and noisy.

This is a modeling problem, not a display problem. Solving it with filters and badges is a losing
fight. It sprawls because a relationship is being rendered as a peer of a workspace, and it is not
one. Nobody has thirty-one brains; they have three brains and twelve relationships, and a
relationship is always **about** something.

### Rule 1: a connection brain is in scope when you are in a brain it connects to

This is the rule that bounds the list. Sprawl becomes bounded by the **degree of the current
brain**, not by the total count of relationships. From the personal brain: your brains, plus the
surfaces attached to the personal brain. From the client brain: the surfaces attached to that.
Nobody sees all twelve at once, it needs no configuration, and the answer to "why am I seeing this"
is always one hop.

Since §6, this is no longer a display rule sitting on top of an access rule. The anchor is both:
you can reach a connection because of the brain you are in, and you see it for the same reason.
One fact, so the two can never disagree.

The same rule governs fan-out search: **a connection brain is in scope for fan-out when its other end is
the active brain.** Otherwise a search from the personal brain surfaces client-shared material,
which is §13's leak-through-the-human scenario with a wider radius. One rule across navigation and
search is worth more than two tuned ones.

### Rule 2: the connection is the object, the brain is its storage

Users manage **connections**, not connection brains. A connection has a name (the counterparty or the
shared purpose), its parties, and a brain behind it. The brain surfaces when they open it, the way a
repository surfaces behind a brain today.

This also fixes naming. Twelve connection brains need twelve names someone has to invent and keep
distinct; twelve connections are named for who they are with, which is a name that already exists
and that both parties agree on.

### Rule 3: classification is free, but not sufficient

The §6 work adds a second resolution branch, so the payload can carry a derived
`via: 'org' | 'grant' | 'connection'` with no new column and no migration. That is enough to render
a connection differently from a brain, and to keep it out of the switcher entirely (§12).

It is not enough to identify a _relationship_: a private brain shared to a colleague in your own
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

## 11. The file tree is never merged

Content from a connection brain does not appear in another brain's file tree. The tree is per-brain by
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
- **The freshness contract breaks.** §13 settles that the guarantee is per brain and only the brain
  you are in keeps it, because `ensureFresh` costs one `branchCommitSha` per brain per read. A
  merged tree either pays that for every connected brain on every render, or renders stale foreign
  content indistinguishably from live local content.
- **Folder names are disclosure.** `prospects/`, `pricing/`, `renewal-risk/`. A tree reads as "this
  is what is in here", and structure is information even when the pages are unreadable.

It is also issue #26 rebuilt as architecture. That bug was the crumb naming one brain while the
content came from another, and the fix was that the brain a result names is authoritative. A tree
under brain A's crumb containing brain B's pages makes that state permanent and intentional.

**Adjacent, not merged.** Showing a connection brain as a second, collapsed, clearly labeled root in the
same panel is fine: its own tree, its own brain, its own crumb when entered. The visual adjacency is
free. The semantic merge, one tree claiming to contain two brains, is what costs.

## 12. Reaching a connection

Four routes, in descending order of expected use.

1. **Asking.** "Show me the shared kickoff doc." Claude calls `view_page` with `brain:`, the widget
   opens on that brain, and `pickShownBrain` lands the crumb correctly because the result declares
   its brain. This works today with no new UI, and it is the primary route rather than a fallback:
   the app is an MCP App inside a conversation, and the primary navigation is asking. The chrome is
   for orientation and browsing.
2. **From the anchor brain.** A "Connected to" list inside the brain a connection is joined to,
   naming the counterparty and last activity. This is the only route in the chrome, and it is §10's
   Rule 1 made visible: a connection appears where it is relevant and nowhere else, which needs no
   configuration and answers "why am I seeing this" in one hop. Creating and ending one hang off it
   as pushed flows, following the `Flow.tsx` convention `ShareBrainView` and `InviteMemberView`
   already use.
3. **Search.** Fan-out results name their brain, and clicking a foreign hit takes you there. This is
   the route for someone who does not know the connection exists.
4. **Explicit cross-brain links** in page bodies, rendered as external destinations so the crossing
   is visible, never a bare wikilink resolving elsewhere. See §13 for why the syntax is still open.

**A connection is deliberately not in the brain switcher.** The switcher is for workspaces you own,
and a connection is not one. Rendering it as a peer is what produces §10's sprawl, and it invites
the issue #26 confusion where the chrome claims one thing and the content is another. It would also
fail today in a specific way: the switcher's grouping collapses to a single unheaded list when a
person belongs to one organization, which is the common case, so a client room would render flush
against your own brain with nothing saying what it is.

**But a connection brain must still resolve from anywhere.** Keeping it out of the switcher is a
presentation decision and must not become an access one. If it left the accessible set, a targeted
`view_page(brain: …)` would fail with "no brain matching", which is indistinguishable from a
permission denial: exactly the failure §13 rejects cross-brain wikilinks for. So it stays
resolvable, and is filtered out of the list the switcher draws.

**A connection's chrome is smaller than a brain's**: files, recent changes, and who is in the room.
No graph, no analytics, and no sharing, because a connection has no audience of its own to share
and its access lives on the anchors. Graph is deferred rather than rejected: traversing a graph _of
brains_ is a plausible later direction, and nothing here forecloses it.

If people start reaching shared content mainly by hunting through anchor brains rather than by
asking for it, route 1 is not working, and that is the thing to fix.

## 13. Cross-brain read: most of it already ships

§3's first answer sends "I need to find it" here. It is also how a connection brain is reached, so it is
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
shared; the leak went through the human. A connection brain widens the population this can happen to,
which is why Rule 1 governs fan-out and not just navigation.

Mitigations, in order of value:

- **Every result names its brain** (gap 3 above). Cheap, and it is the one that matters.
- **Scope fan-out by Rule 1** (§10): a connection brain is in scope when its other end is the active
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
see, and `validate` would report the same page broken for one reader and fine for another. §12's
route 4 wants some explicit form; it should be a link syntax that announces the crossing and
degrades to plain text, not a wikilink. The syntax is open, §15.

## 14. What we reuse, what is new, and what this is not

**Reused unchanged:**

- `effectiveBrainRole` for every authorization check, with `orgRole` widened to nullable and a cap
  input added, and `pnpm test:access` as its battery.
- `matchBrain`, `brainArg`, and per-brain index isolation, which is the whole of a connection's read
  and write path.
- `commitFiles` / `commitOrPR`, unchanged. The `writeMode: 'pull-request'` path is also the
  propose-back mechanism in §9 if that is ever built.
- `createAndScaffoldBrain`, which is exactly right for a fresh working surface.
- The `Flow.tsx` pushed-flow convention for the UI.

**Genuinely new:**

- **Anchor-derived access** (§6): a second resolution branch, a nullable `orgRole`, an editor cap,
  and a `pnpm test:scope` case for a caller with no organization role at all. This is the entire
  access mechanism, and it replaces the individual cross-organization grant (§16).
- **The confidentiality work around it** (§8): the two-sided join, marking who is on which side,
  and the roster and analytics gates re-verified against a null `orgRole`.
- **A system organization holding connections** (§5), with no members, plus provisioning a
  connection brain into it. `provisionBrainForUser` already creates repositories in the platform
  GitHub organization; what is new is the organization row, a naming scheme that is not
  `brain-<login>`, and a platform-scoped client, since the caller's own installation has no rights
  there.
- **The connection object** (§10): the relationship, its parties, and each party's anchor. It is
  platform state, because it describes something neither repository owns and because reading it
  must not cost a repository fetch on every brain list.
- **Ending a connection and materializing mirrors** (§7): detach the anchors, archive the
  connection brain, and write one read-only mirror per party into their own organization. The copy
  is `commitFiles` over content the platform already holds, so the new part is the lifecycle rather
  than the copy. Two things it must respect: the copy is unbounded work and so must be budgeted and
  resumable per §4, and a mirror needs a read-only flag on the brain rather than a viewer role.
- **The "Connected to" affordance and a connection's reduced chrome** (§12).

**Explicitly not in scope:**

- **Publishing / one-way keyed copies between brains** (§16). The mechanism the previous draft
  designed. Not built, and §9 states the case it leaves unserved.
- **Individual cross-organization grants** (§16). Considered as the access mechanism and replaced
  by anchors.
- **A connection in the brain switcher** (§12), in any form.
- **A shared page that lives in two brains at once.** A page has exactly one home brain; a
  connection brain **is** that home, and a mirror is inert rather than a second live copy.
- **Merging foreign content into a brain's file tree** (§11), in any form.
- **Git submodules** (§16), in any variant, including as a retention mechanism.
- **Export** (§15). A mirror protects a party from their counterparty, never from the platform.
- **Merge resolution for concurrent edits** (§9). Last-writer-wins at the body level is the accepted
  behavior, mitigated by anchored `edits`.
- **Hierarchical relationships** (§10), deferred but not foreclosed.

## 15. Build order and open questions

1. **Cross-brain read** (§13, gaps 1 and 3). Smallest, highest value, needs no new model, and is the
   substrate everything else sits on.
2. **The connection object** (§10): the schema and its data layer. It comes before the access work
   rather than after the product shape, because §6 resolves access _through_ a connection's anchor,
   so nothing downstream can be built or tested without it.
3. **Anchor-derived access** (§6) with the confidentiality work in §8. This is the unlock, and the
   two halves ship together: the roster and analytics gates are not a follow-up.
4. **Creating and joining a connection** (§5). The first demonstrable slice: two organizations that
   cannot see each other co-author one surface, and neither one's roster or per-person analytics
   reaches the other.
5. **Ending a connection**, revocation first and the mirror second (§7). Revocation is one request
   and must land whole; the copy is the long tail and must be resumable. Do not ship the ability to
   create a connection without the ability to end one safely, which is the failure mode this whole
   shape exists to avoid.
6. **The "Connected to" affordance and a connection's chrome** (§12), once two or three real
   relationships exist to shape it.

Step 3 is where the whole confidentiality risk sits, and step 5 is where the commercial risk does.

**What building it changed.** Three things this document had wrong, kept here because each was only
visible from the code. `PLATFORM_ORG` is a GitHub organization login and not a row, so connections
needed a memberless system organization of their own, which turned out to be what makes §6 hold by
construction rather than by a filter. Ending a connection detaches the anchors, and the anchors are
the only way to NAME one, so the copies would have been unresumable without a second resolution
path for an admin of a party. And a mirror cannot infer which files are binary from what the batched
read omits: that is exact on GitHub and silently corrupting on the filesystem backend, which returns
the same blob as mangled text that looks like a successful read.

Open:

- **Export, which is the thing the mirror is not.** §7 protects a party from their counterparty and
  not from the platform. A real export (take your brains and leave, in a form readable without us)
  is separate work that this design does not do and should not be described as doing.
- **Billing and seats for people reaching a connection** (§8), including the concrete instance that
  usage counters are per organization and a connection's organization has no admin, so the work is
  currently recorded against nobody. Commercial question before technical.
- **What is the explicit cross-brain link syntax** that §12 route 4 needs and §13 declines to make a
  wikilink?
- **How does a party learn a connection is waiting for them?** Joining is deliberate (§8), and the
  only channel that exists today is presence in the product. Someone who does not open Isomorphic
  learns nothing, and there is no outbound mail anywhere in this system.
- **Should a connection brain say so on every page?** Marking it in the list is settled. Whether the
  brain itself should carry "this is shared with Northwind, and they can read everything in it" is a
  stronger claim and probably the right one.
- **Does the unserved case in §9 show up in practice?** This is the question that decides whether
  publishing comes back. It should be answered with real usage, not in advance.

## 16. Rejected alternatives

- **Publishing: a one-way, key-addressed flow of pages between repositories.** The previous draft's
  entire design (publication/subscription config declared in both repos, identity as a key rather
  than a path, `body: source-owned` with read-only received pages, link flattening at the published
  set's horizon, proposed-not-applied deletions, a no-resurrection ledger, three rungs of
  automation). It is coherent and it answers §3's third question, which this design does not. It is
  not being built because the other two answers cover the flows we actually have, and because it is
  a large mechanism with a permanent confidentiality surface: an automated flow out of a personal
  brain into a client's repository is an exfiltration channel that runs without a human in the loop.
  The full design is recoverable from git history (`docs/design/brain-seams.md` before this
  revision) if §9's unserved case turns out to matter.
- **A connection brain living in one party's organization**, defaulting to whoever created it. This
  was the recommendation in an earlier revision and is rejected in favor of platform ownership (§5).
  It makes the other party a guest for the life of the engagement: the owning side can revoke
  unilaterally, delete pages, rewrite history, and controls the record precisely when a dispute
  makes it matter. Two commercial peers collaborating should not have one of them holding the room.
  The argument that had been made for it, that content in your own repository is yours and readable
  without us, does not survive contact with the audience: these users never touch a repository, so
  it is a property they cannot exercise. What answers that concern is an export capability, §15.
- **Individual cross-organization grants**: a `brain_memberships` row naming a person in another
  organization, which was the access mechanism through several revisions of this document. Replaced
  by anchors (§6). It fails on administration and on teardown, and both are the same underlying
  problem: the row hangs off nothing. Someone would have to administer people in an organization
  they cannot see, an outsider would need marking everywhere a brain's audience is shown, and
  `deleteUserBrainGrantsInOrg` is scoped by `brains.org_id`, so a person removed from their own
  organization would silently keep the client room. Deriving access from a brain each side already
  governs makes all three disappear rather than solving them.
- **A connection in the brain switcher**, as a third section below the organization groups. This
  was the recommendation in an earlier revision. It renders a relationship as a peer of a
  workspace, which is precisely §10's diagnosis of why the list sprawls, and it fails concretely
  today: the switcher's grouping collapses to one unheaded list for a person with a single
  organization, so the section that explains what a client room is would be the one that does not
  render. Connections are reached from the brain they are joined to, §12.
- **Git submodules, in every variant**, including a platform-owned repository submoduled into each
  party's brain so that revoking access leaves them holding the content. **It leaves them holding
  nothing.** Measured on a scratch pair of repositories: the parent's entire object database is one
  tree, one commit, and one 93-byte blob, and that blob is `.gitmodules`. The tree carries
  `160000 commit <sha>` for the submodule path and not a single content blob. Cloning the parent
  with the submodule's remote unreachable produces an empty directory, and `submodule update --init`
  fails outright. A submodule is a URL and a SHA, which is a bookmark to something you can no longer
  read. It is also invisible to the content index, since `listTree` (`src/lib/brain-repo.ts`)
  filters `e.type === 'blob'`. The retention property this was reaching for is real and §7's mirror
  is how to get it: actual content, written as ordinary blobs, which the index can see.
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
