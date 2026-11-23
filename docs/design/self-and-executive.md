# Design: the self and the executive

Status: **proposed** (2026-11-21). Nothing in this document is built.

- Author: Jon Hansing (via Claude)
- Audience: anyone deciding what to build after roles and the org view, and the sessions that
  pick up the work items
- Related: [`roles-self-and-world-model.md`](roles-self-and-world-model.md),
  [`records-tables-prd.md`](records-tables-prd.md), [`consistency-checks.md`](consistency-checks.md),
  [`privacy-checks.md`](privacy-checks.md), [`multi-agent-surface.md`](multi-agent-surface.md),
  [`open-source-boundary.md`](open-source-boundary.md)

## 1. Summary

[`roles-self-and-world-model.md`](roles-self-and-world-model.md) gives each brain a role and
computes an org view over facts: ownership, open items, commitments, beliefs. A computed view
can hold facts. It cannot hold intentions. Goals, priorities, what deserves attention this
week, what the organization expects to happen and its models of the people it works with are
choices and perspectives, and no brain's content derives them.

This document adds a **self**: a boundary declared over brains, outside any brain and any
organization, with an **executive** that perceives through declared senses, records what it
observes and expects, compares expectation with outcome, and proposes actions. The self and
everything that runs for it live in `ee/`. The wiki underneath stays a wiki: switch the self
off and every brain still reads, validates and renders.

## 2. The problem

Northwind, the services firm from the roles document, delivers client work. Its client
brains are held by a partner organization that owns the client relationship. Northwind's own
brains (legal, partners, handbook) sit in Northwind's organization.

Three things go wrong with what exists:

- **The organization is the wrong boundary.** An organization is a permission grouping.
  Northwind's boundary of intent covers its own brains and its model of the client work, and
  the client brains sit in another organization. A self keyed to the organization cannot see
  the work it does; a self keyed to every brain it can read swallows the client.
- **Expectations are never written down, and they are already spoken.** One week of a real
  firm's meetings yielded eighteen expectations in three recurring meetings, eleven with a
  date. Mail settled most of them within a week. Nothing in the product records either side.
- **The cheap sources are wrong in ways that matter.** In the same week, a generated meeting
  summary recorded a figure ten times its true value, misspelled a site and a person, and gave
  no speaker for one commitment. The sender's own recap email had the figure right.
  Prediction over unreconciled input predicts noise.

## 3. Vocabulary

| Term        | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| Self        | A declared boundary of intent over brains, with a charter and an executive          |
| Blanket     | The boundary itself: what crosses inward is sensing, what crosses outward is action |
| Inside      | A brain within a self's blanket. A brain is inside at most one self                 |
| Sensed      | A brain or source a self reads without owning: a client brain, mail, a transcript   |
| Charter     | Values, intent and set points, authored by the self's authors                       |
| Observation | A dated, sourced record of what a source showed at a time                           |
| Expectation | A dated record of what is expected, when to check, and later what happened          |
| Staging     | Extractions not yet reconciled, held outside git with a time limit                  |
| Reconciler  | Resolves entities and ranks sources; promotes staged extractions to records         |
| Executive   | The process that runs for a self: compares, ranks, raises items, drafts actions     |

## 4. The self is declared outside brains

A self is a platform object in `ee/`, alongside organizations, with:

- a name, and its authors: the people who may edit the charter and the declaration
- its inside brains, from any organization
- its senses: connectors and sensed brains
- its charter (section 6)

It is not a brain, because a self that spans organizations cannot be owned by one of its
brains: a home brain would hold privilege over the others, and moving or deleting it would
break the self. It is not an organization, because the organization answers who may read
what, and the self answers what the firm is trying to do.

Rules:

- **A brain is inside at most one self.** Two executives writing records into one brain have
  no rule for who is right.
- **A brain may be sensed by any number of selves.** Sensing is reading with an ordinary grant
  from that brain's owner.
- **Inclusion needs the brain's admin.** Putting a brain inside a self gives the executive
  write access for records, so the brain's admin consents, as they do for sharing.
- **The executive runs as the self.** No person's access is consulted and no person is the
  actor, as with the scheduled organization pass (`ee/review/org-pass.ts`). Commits and items
  are attributed to the self.

## 5. What the self owns

Ownership has two axes. The roles document assigns it by subject. A self adds the observer.

| The self owns: perspectival and intentional         | Owner brains keep: subject facts                |
| --------------------------------------------------- | ----------------------------------------------- |
| Goals and priorities                                | Agreements, terms, entities and their state     |
| Attention: what matters now                         | Methods and theory, by the brain that owns them |
| Expectations, and the record of how they turned out | Anything in a sensed brain                      |
| Models of counterparties                            |                                                 |
| Observations of sensed brains                       |                                                 |
| The boundary policy: what may cross inward          |                                                 |

A model of a client is the firm's, whatever it is about, and it never lands in the client's
brain. A fact about a contract is the legal brain's, whoever observed it.

The self's perspectival records live as records in its inside brains, chosen by subject: an
expectation about delivery in the brain that models engagements, a clause risk in the legal
brain. Its intentional state (goals, attention) lives on the self.

## 6. The charter

The charter is short and authored by people:

- **Values** are constraints. They filter options before anything is ranked and are never
  traded against each other. The guard's rulebook ([`privacy-checks.md`](privacy-checks.md))
  is the same mechanism for writes; the charter extends it to actions.
- **Intent** is a purpose and an end state, written so that a conflict between brains can be
  settled without asking. When the legal brain says hold and delivery says go, the executive
  asks which serves the end state.
- **Set points** are the variables kept in range, such as cash, capacity, client health and
  partner bandwidth. The executive raises an item when it predicts drift. Nothing is maximized:
  a self that maximizes one variable is the one Goodhart's law takes.

The charter is stored on the self with a version history and an author on each change.

## 7. The blanket

| Crossing | Is      | Examples                                                                  | Effect                                      |
| -------- | ------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| Inward   | Sensing | Transcripts, mail, calendar, a sensed brain's edits                       | Staged, reconciled, recorded inside         |
| Outward  | Action  | Mail, a page written in a client brain, an item raised in a brain outside | Drafted, attributed, carries an expectation |

Inside brains model sensed brains at the grain of the engagement: commitments, outcomes,
decisions, counterparties, status and risks. They do not copy the client's content. That keeps
confidential material out of the firm's repository, and it is the inward rule of the boundary
policy, which the guard enforces on inside brains. Retention limits from client agreements
belong in that policy.

## 8. Perception: staging and the reconciler

Senses write extractions to staging, in D1 with a time limit and never in git, for the reason
quarantine is kept out of git: whatever is committed stays in history.

Every extraction carries a provenance:

- **inferred**: drafted by a model from a source
- **observed**: stated directly by a source the reconciler ranks as authoritative for it
- **confirmed**: accepted by a person

Only observed and confirmed count as evidence. An inferred record is never evidence for a
prediction or an outcome, which keeps the self's own drafts from teaching it.

The reconciler:

- **resolves entities** across sources: the same person, site and organization under the
  spellings transcripts and summaries produce
- **ranks sources** per kind of fact: what a person wrote and sent outranks what they said,
  which outranks a generated summary of what they said
- **promotes** staged extractions to records. Facts from the firm's own sent mail promote
  when they agree with the other sources. Anything taken from a transcript needs a person's
  confirmation until its measured precision justifies less.

Precision is measured against a hand-labeled gold set of expectations and outcomes from real
meetings. The first one, one week of a real firm's meetings, is kept outside this repository.

## 9. Records: observations and expectations

Records come from [`records-tables-prd.md`](records-tables-prd.md). The self adds fields:

| Field        | Holds                                 |
| ------------ | ------------------------------------- |
| `source`     | The sense and the item it came from   |
| `provenance` | inferred, observed or confirmed       |
| `owner`      | Who made the commitment               |
| `expected`   | What is expected                      |
| `check_at`   | When to check                         |
| `outcome`    | What happened, with its own source    |
| `revisions`  | Each re-dating of the same commitment |

An observation is dated and sourced ("as of a date, this brain showed this"). It never claims
to be current. When a sensed brain moves away from what an inside brain observed, the
observation is stale and the compare pass records a new one. The change is a `surprise` only
when an expectation covered it.

## 10. Compare, and the items it raises

`prediction-due` needs only a check date. The core raises it for any brain, with or without a
self ([`roles-self-and-world-model.md`](roles-self-and-world-model.md), section 8). The
compare pass is a pass type on `brain_passes` (`src/lib/brain-pass.ts`) and raises the other
four. All five are items in the review queue (`src/lib/review-queue.ts`):

| Kind             | Raised when                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `prediction-due` | An expectation's check date arrives with no outcome recorded          |
| `surprise`       | An outcome or an observation departs from what was expected           |
| `question`       | The cause of a surprise is ambiguous and one answer would settle it   |
| `proposal`       | The next move is clear; carries a drafted action and its expectation  |
| `arbitration`    | Inside brains or authors disagree; shows what each side would predict |

Two signals need no outcome at all:

- **Absence.** A commitment that no later source mentions. Nothing contradicts it, so no
  consistency check sees it.
- **Re-dating.** A commitment given a new date. Each revision is recorded, and the count is
  data about the owner.

## 11. The executive

The executive runs on a schedule as the self, through the model gateway (`ee/review/gateway.ts`).

Ranking:

1. **Values filter.** An option that breaks one is dropped before ranking.
2. **Intent arbitrates.** Between options that pass, the one that serves the end state ranks
   first.
3. **Set points flag.** A predicted drift out of range raises an item on its own.
4. **Value of information ranks the rest.** At the size of firm this serves there are no
   statistics to compute it from, so it uses a proxy: how many pages and commitments depend on
   the belief (backlinks), times how uncertain it is, times how soon the answer matters.

Arbitration is shown, never settled silently. The point of inside brains with different
stances is that they disagree; the executive states the disagreement, which way it leans and
why, and a person decides.

When authors diverge: a conflict of values stops the action. A conflict of intent or set points
becomes an `arbitration` item addressed to the authors.

Grant: read inside brains and sensed sources; write records into inside brains; everything
else is a `proposal`. Outward actions are drafts until a person sends them.

## 12. Invariants

1. The self never writes a subject fact, and never writes into a brain it only senses. It
   writes records in its inside brains and proposals everywhere else.
2. Inferred is never evidence.
3. Observations are dated and sourced, never mirrors.
4. Every outward action carries an expectation.
5. Values filter and are never ranked.
6. No automatic belief revision. A write across the blanket waits for a person.
7. With the self off, every brain still stands.

## 13. Licensing boundary

The self is in `ee/`: the declaration, the charter, staging, the reconciler, the compare pass
and the executive. It builds on core primitives that stay AGPL: records with the expectation
fields, the `prediction-due` item, the review queue and `resolve`, live views (the record a
theory page shows is one) and the guard's deterministic detectors. See
[`open-source-boundary.md`](open-source-boundary.md).

## 14. Order of work

Each step is useful without the ones after it. Steps 1, 2 and 6 are core.

1. **Records with the expectation fields, and the `prediction-due` item,** from the
   records-tables PRD.
2. **Cross-brain wikilinks.** One meeting produces records in several inside brains, linked to
   one shared source.
3. **The self declaration, staging and the reconciler,** starting with transcripts and mail,
   measured against the gold set. A declaration is refused when a brain is already inside
   another self, a sensed brain has no grant, or the charter has no values.
4. **The compare pass and its four item kinds.**
5. **Executive ranking and drafted proposals.**
6. **Calibration:** each theory page shows its record, as a live view over the outcomes that
   link to it.

## 15. Decided against

- **A self in a home brain.** It privileges one brain, and the self breaks when that brain
  moves.
- **A self per organization.** The organization is a permission boundary; the self is a
  boundary of intent, and the two diverge as soon as client work lives in another
  organization.
- **A single objective,** such as profit or client satisfaction. Satisfaction is a signal and
  profit is a set point to defend.
- **Inferred extractions as evidence.** The self would learn from its own drafts.
- **Sending actions automatically.** Drafts only, until measured.
- **Copying client content into inside brains.** Model the engagement, not the client's
  business.

## 16. Open questions

- Whose entitlement and spend cap does the executive run under? Both are per organization,
  and a self is outside every organization.
- Where do a self's items live, and who may see them? The review queue is keyed by brain and
  shown by brain role. An item about mail or a sensed brain has no brain, and an author need
  not be a member of any inside brain. A record drawn from mail is also open to every reader
  of the brain it lands in.
- Senses need connectors, and the platform has none. Does a grant to read a brain cover
  sending its content to a model provider?
- How does staging relate to the propose-and-admit ledger in
  [`records-tables-prd.md`](records-tables-prd.md), which keeps a proposed row in git? And if
  transcript extractions wait for confirmation, does a record ever carry `inferred`?
- Should the charter also be readable as a page, given that a copy of it would drift?
- Is a person a self? A personal brain and a person's mail make the same blanket at size one.
- What happens to observations of a client when the engagement ends and an agreement limits
  retention?
- When two selves sense the same brain, can either learn that the other exists?
- How often should the executive run? Comparison is daily work; revising beliefs is monthly at
  most.
