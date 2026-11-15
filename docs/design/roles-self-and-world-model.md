# Design: roles, the org self, and the world model

Status: **proposed** (2026-11-15). Nothing in this document is built. It is a vision document:
it names how pieces that are already built or already designed fit together, and the small
number of new pieces that join them.

- Author: Jon Hansing (via Claude)
- Audience: anyone deciding what to build next, and the sessions that pick up the work items
- Related: [`consistency-checks.md`](consistency-checks.md), [`privacy-checks.md`](privacy-checks.md),
  [`multi-agent-surface.md`](multi-agent-surface.md), [`brain-seams.md`](brain-seams.md),
  [`derived-views-and-sync-prd.md`](derived-views-and-sync-prd.md),
  [`records-tables-prd.md`](records-tables-prd.md),
  [`brain-level-permissions.md`](brain-level-permissions.md), [`../roadmap.md`](../roadmap.md)

## 1. Summary

An organization on Isomorphic today is a set of brains plus permissions. Each brain is kept
well on its own. Nothing keeps them true to each other, and nothing represents the
organization as one thing.

This document proposes three ideas, in order of size:

1. **A brain has a role.** It declares what it owns and what it watches.
2. **An org has a self.** A view computed from those declarations: who owns what, what is
   unresolved, what the organization has committed to, and what it believes.
3. **The brains together are a world model.** State and theory are already there. Dated
   events and outcomes are the missing layer, and with them the organization can state what
   it expects and learn from what happened.

Most of the machinery exists. Consolidation finds conflicts, the review queue holds findings,
the guard checks every write, cross-brain search reads across brains, and publishing and
records tables are designed. What is new is the declaration that ties them together and the
org-level view that reads it.

## 2. The problem

Take Northwind, a small services firm with four brains: finance, legal, admin, and a handbook
its partners read. Three of those are cut by function and one by audience. They go stale in
two different ways.

**Brain against brain.** A day rate is stated in a legal agreement and restated on a handbook
page. One is updated and the other is not. Both pages are well formed, so `validate` reports
each brain clean. Consolidation never pairs them, because it compares pages inside one brain.

**World against brain.** An invoice goes out, a contract is signed, a certificate is sent,
and nobody writes it down. No page contradicts the stale one, so no conflict check can see it.

The natural reaction is to ask for an agent per brain, each watching the others. That
imports identity, messaging and autonomy to solve a problem that is mostly bookkeeping. This
document treats "agent" as a metaphor for three things the platform lacks, and names those
instead.

## 3. Vocabulary

| Term         | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| Brain        | A set of pages in one store (a git repository, a Drive folder, or held by the platform)  |
| Role         | What a brain is for: the facts it owns, the brains it watches, its standards, its stance |
| Org self     | A computed view over an org's brains: ownership, open items, commitments, beliefs        |
| World model  | Everything the org's brains say about the world, in three layers: state, theory, events  |
| Derivation   | A declared link saying this content has its home somewhere else                          |
| Open item    | Something unresolved, with an owner and a source                                         |
| Scoped actor | A person, a conversation or a scheduled pass, acting within a grant                      |
| Pass         | A budgeted, resumable sweep over content that produces open items                        |

## 4. Three primitives

Each of these already appears in the product several times under different names. Naming
them once is most of the design.

### 4.1 Derivation: one home per fact

[`derived-views-and-sync-prd.md`](derived-views-and-sync-prd.md) found the root cause inside
one brain: the static page does two jobs, authored content and derived content, and derived
content stored as static text is stale from the moment it is written. Drift between brains is
the same defect at org scale. A restated fact is derived content.

| Case                                     | Right answer                                     | State                                                      |
| ---------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| A listing or count inside one brain      | A live view (`okf-view`)                         | Built                                                      |
| An external source feeding a brain       | `sync_records`, with source-owned fields         | Built                                                      |
| A reader who can reach both brains       | A link to the home page, not a copy              | Cross-brain search is built; cross-brain wikilinks are not |
| A reader who cannot reach the home brain | Publishing: a declared, one-way, reconciled copy | Designed in [`brain-seams.md`](brain-seams.md), not built  |
| A copy made by hand anyway               | Detection, after the fact                        | Consolidation, inside one brain only                       |

Prevention comes first and detection covers what prevention misses. Publishing is the only
case where a copy is correct, and it is a copy with a disclosure filter: the question it
answers is who can now read this.

### 4.2 Open item: one list of what is unresolved

The product has four partial versions of the same thing:

- findings in the review queue (`src/lib/review-queue.ts`), of kind conflict, duplicate or policy
- the open-questions page a brain template ships with
- handoff notes, proposed in [`multi-agent-surface.md`](multi-agent-surface.md)
- pages a brain keeps for things still needed, by its own convention

Each is something unresolved, with a source and someone who should answer it. The queue is
the one with keys, visibility rules and a `resolve` path, so it is the one to extend: more
kinds (a question, an obligation, a prediction due), and a read across every brain in an org.
A page convention can stay as the human-readable face of the same items.

Open items are also the only channel between brains. A pass or an agent that finds something
wrong in a brain it does not own raises an item for that brain's owner. It does not write the
fix.

### 4.3 Scoped actor: lanes

Today a person has a role per brain ([`brain-level-permissions.md`](brain-level-permissions.md)),
and every conversation or job acting for that person has the same reach.
[`multi-agent-surface.md`](multi-agent-surface.md) adds a connection identity and agent
attribution, and lists grants narrower than the person's role as out of scope.

This design brings that back in scope, in one specific form: a connection that may read
several brains and write one. That makes "write only to the brain you serve" a property of
the grant, not a sentence in a prompt. The guard at `BrainStore.commitOrPR` stays the backstop
for content.

## 5. A brain has a role

A role has four parts:

| Part                                                      | Where it lives                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| Charter: what the brain owns, and which brains it watches | A new declaration in `.isomorphic.json`, summarized in `AGENTS.md` |
| Standards: what correct means here                        | The policy rulebook page the guard already reads                   |
| Stance: the bias the brain is meant to have               | Prose in `AGENTS.md`                                               |
| Its own open items and history                            | The review queue and the activity log                              |

Ownership is declared at the grain a person would say it: "executed agreements and their
terms", "billing procedure", "client pages". It is not a registry of sentences. Its uses are
concrete:

- When a conflict spans two brains, the owner's version stands and the other is the copy.
- A proposed patch targets the copy, never the owner.
- `validate` can report a subject two brains both claim, and one that none claims.

A role is not a self. A brain makes no promises in its own name and cannot change what it is
for. Its stance is still worth having: a legal brain that leans cautious and a delivery brain
that leans toward yes disagree usefully, and the org decides between them.

## 6. An org has a self

An org today is members, brains and entitlements. It has no content of its own. The org self
is a view, computed on read, with five parts:

| Part                                         | Computed from                                                         |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Boundary: what is ours, and who may see what | Brain visibility, sharing and the policy rulebooks                    |
| Ownership map                                | Every brain's role declaration                                        |
| Open items                                   | The review queue across the org's brains                              |
| Commitments                                  | Pages of the types a role declares as commitments, such as agreements |
| Beliefs, with their record                   | Theory pages and the outcomes that link to them (section 8)           |

It also has one authored part: a short charter page saying what the organization is and what
it will not do. That page lives in an existing brain, and the org setting points at it.

Three rules follow from what the self is:

- **It is a view, never a brain.** A written-down self would drift like any other copy.
- **It owns no facts and writes none.** It reads every brain and raises open items. The
  failure to design against is the story overwriting the record.
- **It answers by audience.** It is the one place where material at different disclosure
  levels meets, so every answer is filtered by what the asker can already read. A finding
  that spans two brains quotes only the side its reader can open, and points at the other.

How role and self work together:

| Disagreement                              | Who settles it                                                    |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Brain against brain, about a fact         | The ownership map. No judgment needed                             |
| World against brain                       | The brain doing the work, by recording it                         |
| A fact against what the org says it holds | A person. Either the position changed or the fact is an exception |

The third row is where identity learns. A position that every recent agreement departs from
is no longer the position.

## 7. The world model

The world model is not a new store. It is what the org's brains already say, in three layers:

| Layer               | Holds                                                         | Primitive              | State                                                                   |
| ------------------- | ------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| State               | What is: the entities and their current facts                 | Concept pages          | Built                                                                   |
| Theory              | How the org thinks the world works: methods, rules, positions | Concept pages, by type | Built                                                                   |
| Events and outcomes | What happened, and what happened next                         | Records                | Designed in [`records-tables-prd.md`](records-tables-prd.md), not built |

Records are what answer world-against-brain staleness. A page models a concept; a record is a
dated occurrence that points at concepts through wikilinks, so backlinks and the graph cover
it with no new machinery.

The org self is the part of the world model that is about the organization.

## 8. Predictions and learning

A belief becomes a prediction when it is applied to a case with a date and a result that can
be checked. A decision record already does half of that. The rest is three fields:

- what is expected
- when to check
- what happened

These work today as frontmatter on a decision page, because every scalar frontmatter key is
indexed. They move to a records table when records exist.

The loop:

1. A decision is recorded with its expectation and a check date, linked to the theory page
   it applies.
2. On the check date, a pass raises an open item for the owning brain: what happened?
3. The answer is recorded as the outcome.
4. Each theory page shows its record, as a live view over the outcomes that link to it.
5. When the record turns against a belief, a pass proposes a revision as an open item. A
   person decides.

How to revise comes from experiments we ran on claim learning:

- Retiring a claim after a fixed number of contradictions lost to plain recency. Do not
  retire beliefs automatically.
- Judging between rival claims for the case in hand was the part that worked. Keep rivals
  side by side.
- A rule with two anchor cases was readable and close to the best accuracy. Write beliefs
  that way.

Two limits. A small organization will not produce statistics, so the value is in stating
expectations and looking back, not in the numbers. And a self-model that no recorded outcome
can contradict is a self-image: the loop only works if outcomes are written down.

## 9. How the platform's pieces fit

| Piece                       | Design                                                                         | State                   | Part it plays here                                     |
| --------------------------- | ------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------ |
| Data-policy guard           | [`privacy-checks.md`](privacy-checks.md)                                       | Built                   | Standards, and the backstop for the boundary           |
| Consolidation               | [`consistency-checks.md`](consistency-checks.md), `ee/review/consolidation.ts` | Built, inside one brain | Drift detection; extended across brains                |
| Review queue                | `src/lib/review-queue.ts`                                                      | Built                   | The open-item list                                     |
| Passes                      | `src/lib/brain-pass.ts`                                                        | Built                   | How the self runs; extended to an org                  |
| Live views                  | [`derived-views-and-sync-prd.md`](derived-views-and-sync-prd.md)               | Built                   | Derivation inside a brain; scorecards                  |
| `sync_records`              | Same                                                                           | Built                   | Derivation from outside; the planner publishing reuses |
| Cross-brain search          | [`brain-seams.md`](brain-seams.md)                                             | Built                   | Candidate pairs across brains                          |
| Publishing                  | Same                                                                           | Not built               | Derivation across a disclosure boundary                |
| Connections and attribution | [`multi-agent-surface.md`](multi-agent-surface.md)                             | Proposed                | Scoped actors                                          |
| Records tables              | [`records-tables-prd.md`](records-tables-prd.md)                               | Draft                   | The events layer                                       |

## 10. Where agents fit

An agent is any scoped actor: a person in a conversation, a scheduled pass, a hosted agent.
It reads within its grant, writes pages in the brain it serves, and opens or closes items.
None of the above needs an agent to have an identity.

Two jobs are worth keeping apart:

- **Keeping brains consistent** is a pass. It is stateless, cheap, and already built for one
  brain.
- **Doing a function's work** and recording it as a byproduct is the job for an agent with
  tools. It is the real answer to world-against-brain staleness, and it is outside this
  document.

When a pass is not enough because routing an item needs judgment, the shape to use is one
coordinator with cheap readers, not peers messaging each other. A hosted agent runtime can
run it. It should reach brains through the MCP server with a read-mostly grant, not through
a copy of the content, since a copy is one more thing to drift.

## 11. Order of work

Each step is useful without the ones after it.

1. **Roles as a convention.** An owns and watches section in `AGENTS.md`, and a charter
   page. No code. This tests the idea on a real org before the platform changes.
2. **Role declarations in `.isomorphic.json`,** with the `validate` checks in section 5.
3. **Consolidation across brains.** Candidate pairs from cross-brain search, keys that
   include the brain, evidence filtered by what the reader can open, and the owner deciding
   which side stands.
4. **The org view.** Review and open questions across an org's brains. The first visible
   form of the self.
5. **More kinds of open item:** question, obligation, prediction due.
6. **Prevention.** Cross-brain wikilinks, then publishing.
7. **A scheduled org pass.**
8. **Expectation and outcome fields,** then records tables, then scorecards on theory pages.
9. **A grant that reads many brains and writes one.**
10. **A coordinator with judgment,** only if the queue shows it is needed.

Steps 1 to 4 deliver roles and the self. Steps 5 to 7 make them maintain themselves. Steps
8 to 10 add learning and autonomy.

## 12. Decided against

- **An agent per brain, messaging its peers.** More traffic than content at the size of org
  this serves, and no rule for who is right. Ownership plus open items does the same job.
- **A brain for the org self.** It would be a fifth copy.
- **Brains with selves.** A brain that cares about its own continuity defends its scope
  where it should defer to the ownership map.
- **A registry of individual claims.** Ownership at the grain of a subject is enough to
  decide a conflict, and the conflict key already identifies the disputed value.
- **Automatic fixes across brains.** A cross-brain finding always waits for a person.
- **Retiring beliefs automatically.** See section 8.

## 13. Open questions

- What is the grain of an ownership declaration: page types, path prefixes, named subjects,
  or a mix?
- Where is a cross-brain finding stored, given the queue is keyed by brain, and who may see
  it when its two sides have different readers?
- Should a brain cut by audience own anything, or only receive publications?
- Which page types count as commitments, and is that per brain or per org?
- Does the charter page need its own protection, given it steers every pass?
- How often should the belief loop run? Consistency is nightly work; revising beliefs is
  monthly at most.
