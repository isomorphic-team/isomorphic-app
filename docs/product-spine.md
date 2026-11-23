# Product spine

What the product is for, the jobs it does for a team, the path a person and their agent take
through each today, and where the vision takes that path. [`concepts.md`](concepts.md) says what
each word means; this page says what the words are for. The designs behind the vision are
[`design/roles-self-and-world-model.md`](design/roles-self-and-world-model.md) and
[`design/self-and-executive.md`](design/self-and-executive.md).

Changing what the product is for, or adding, dropping or changing a job, is a product decision
for the maintainer, not a documentation fix.

## What the product is for

Helping people and AI achieve together what neither could alone. Isomorphic is the interface for
that collective intelligence: the shared place where people and their agents keep what the group
knows, decides and expects, and do their work against it.

A team runs its business on what it knows, what it has decided and what it expects to happen.
Most of that lives in people's heads, in mail and in meetings. Writing it down is a separate job
from doing the work, which is why it does not get done, and knowledge nobody wrote down cannot
be shared with a colleague or handed to an agent. So the group never knows more than its members
remember, and its agents start every conversation from nothing.

Isomorphic makes that knowledge something the team's agents keep for them, and then something
the organization can reason with: notice where it disagrees with itself, say what it expects,
and learn when the world answers.

## Who does what

Working together means each side does what it is good at, through the same brains:

| AI does                                                     | People do                                               |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Write it down, as a byproduct of the conversation           | Say what is worth keeping, and correct what was written |
| Keep it true: find what is broken, stale or contradictory   | Decide what a finding means, and which side stands      |
| Sense: read meetings and mail, and draft what they show     | Confirm what was inferred before it counts as evidence  |
| Remember every commitment, and bring it back when it is due | Make the commitments, and record what happened          |
| Compare expectation with outcome, and rank what is open     | Author the charter: values, intent and set points       |
| Draft actions                                               | Send them                                               |

The brain is the shared medium. A person can read and edit everything an agent wrote, in the
viewer, in a browser or on github.com, and an agent can use everything a person wrote. Neither
side holds anything the other cannot see.

Collective intelligence fails in two directions, and the product guards against both. When the
AI does too little, people go back to remembering and the brain goes stale. When it does too
much, the group stops thinking: a model's draft becomes a fact, a belief is revised because a
pass said so, and an action goes out nobody chose. That is why inferred is never evidence, a
fix across brains waits for a person, and actions are drafts until a person sends them.

## Three levels

Each level widens the collective: a person and their agent, then a team of functions that
agree, then an organization that learns. Each level fixes a failure the one below it cannot see.
Each is useful without the ones above it, and none replaces the one below.

| Level                          | The team gets                                                                                       | The failure it fixes                                                                                                                          | State                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1. A brain kept true           | One brain its agent writes and keeps: one page per concept, links that survive moves, live listings | Knowledge never written down, and notes that rot once they are                                                                                | Built                                                                                |
| 2. Brains that agree           | Each function's brain owns its facts; the organization is one thing with one list of what is open   | A fact restated in two brains drifts, and each brain still validates clean. An organization is a set of brains plus permissions, nothing more | Built in part: contradictions between brains and the organization's scheduled checks |
| 3. An organization that learns | A declared intent, expectations written down, and a loop that compares them with what happened      | Events nobody records, expectations spoken in meetings and never written, and no way to be surprised, so no way to learn                      | Proposed. Built: the expectation fields and the findings raised on their check dates |

### Why roles across functions

Firms divide knowledge by function (legal, finance, delivery, the partners' handbook) because
each function owns different facts and leans a different way. A legal brain should be cautious
and a delivery brain should lean toward yes. That is useful only if the platform knows which
brain is which.

Without roles, the platform can say that two pages disagree and nothing more. With a role, a
brain declares what it owns and what it watches, so:

- a conflict between brains is settled by the ownership map: the owner's version stands and
  the other is the copy, with no judgment needed
- a finding goes to the person who can fix it, in the brain that owns the fact
- the organization gets a view of itself, computed and never written down: who owns what, what
  is unresolved, what it has committed to
- two brains that disagree because their stances differ show the disagreement to a person
  instead of averaging it away

The alternative people reach for, an agent per brain watching the others, brings identity,
messaging and autonomy to what is mostly bookkeeping, and has no rule for who is right.

### Why a self

A self is what lets a system of people and agents cohere into something that can act and adapt
in a competitive environment. Without one, every agent and every brain is locally right: each
serves its own conversation or its own function, and nothing decides between them when they
pull different ways. Roles say who owns which fact. They do not say what the firm is trying to
do, so they cannot say which of two reasonable actions to take, or notice that the market has
moved and the firm's beliefs have not. A self gives the system one intent to act toward and one
loop to learn from: it ranks what is open by that intent, acts through drafts people send, and
revises its beliefs when the world answers differently from what it expected. That is the
difference between a well-kept archive and an organization that competes.

The organization view can hold facts. It cannot hold intentions: goals, what deserves attention
this week, what the firm expects to happen, and its models of the people it works with. No
brain's content derives those; people choose them.

And the organization is the wrong boundary for them. An organization answers who may read what.
A firm's intent covers its own brains and its client work, and client brains often sit in the
client's organization. So the self is declared on its own, over brains from any organization,
with a charter its authors write: values that filter, intent that settles conflicts, and set
points to keep in range.

The self is what turns knowledge into learning. An expectation written down with a check date
can be surprised by what happens, and a surprise is the only thing that makes a belief worth
revisiting. A self-model that no recorded outcome can contradict is a self-image.

The platform holds the state and never reads an outside source. An executive, an agent on the
client side, senses through the connectors the client already has: it records what meetings and
mail show, with a provenance, and drafts actions for a person to send.

## How a change uses this page

- **A design names the job, the step and the level it works at.** A change that serves no job
  here is out of scope until a job is added.
- **A design says what people do and what AI does at its step.** It should take work off people
  that an agent does as well, and leave with people the decisions that are theirs in the table
  above. A change that moves one of those decisions to the AI is a product decision for the
  maintainer.
- **Work should move a job up a level, or close a seam on its current path.** Polishing a step
  that already works is the lowest-value change, and several in a row is how the product reaches
  a local optimum.
- **Do not grow a level-1 surface to do a level-3 job without saying so.** When a lower-level
  mechanism stands in for a higher one (as `validate` does for reminders today), the design says
  how its work carries over when the higher level arrives.
- **One surface per step.** A design that adds a second place to do a step that already has one
  either replaces the first or says why both stay.
- **A step is finished when the whole path works.** Every path starts from something a person
  says or something that happens, not from a tool name. A feature the agent cannot reach from
  that trigger, through `SERVER_INSTRUCTIONS`, a tool description or the brain's `AGENTS.md`, is
  not done.
- **The open seams are the work list.** A design that touches one says whether it closes it or
  widens it.

Most work reaches the brains through an agent: a person talks to their AI assistant, and the
assistant uses the brains through their tools. So every path is written from the agent's side,
and ends with what the person sees and decides.

## The lines that hold it together

These come from the designs and keep the three levels one product:

- **One home per fact.** A restated fact is derived content. Prefer a link or a live view to a
  copy; publishing is the only correct copy.
- **The organization view and the self are never brains.** A written-down view drifts like any
  other copy.
- **The platform reads no outside source.** Sensing and acting belong to the executive, on the
  client side.
- **Inferred is never evidence.** What a model drafted from a source counts only once a person
  confirms it.
- **A fix across brains waits for a person.** Passes raise findings; they never write the fix.
- **With the self off, every brain still stands.** Each level works without the ones above it.

## 1. Write it down without a separate job

A person says something worth keeping, in a conversation that is about something else.

| Step               | Today                                                                                    | Surface                     |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------- |
| Trigger            | The person states a fact, a decision, a person or a process                              | The conversation            |
| Find where it goes | The agent reads a sibling page and matches its `type:` and keys                          | `search_pages`, `read_page` |
| Write              | One concept per page, linked from its parent, frontmatter as fields                      | `write_page`                |
| Scan the write     | The guard scans the write for sensitive data and records what it finds, without blocking | Every write                 |
| Outside sources    | Records kept in step with a system the team already uses, by key                         | `sync_records`              |

Where the vision takes it:

- **Level 2:** a fact is written once, in the brain whose role owns it, and other brains link to
  it. Needs role declarations, cross-brain wikilinks and publishing.
- **Level 3:** the executive writes down what meetings and mail show, so nobody has to. Dated
  occurrences become records, not pages, each with a source and a provenance, and an inferred
  record waits for a person to admit it ([`design/records-tables-prd.md`](design/records-tables-prd.md)).

Open seams:

- Records are designed and not built, so a dated event is written as a page today, or not at
  all.
- Nothing tells the agent which brain owns a fact, so it writes in whichever brain is active.

## 2. Answer from what we know

A person asks about their own work, people, customers or decisions.

| Step    | Today                                                            | Surface                           |
| ------- | ---------------------------------------------------------------- | --------------------------------- |
| Trigger | A question specific to this person or organization               | The conversation                  |
| Find    | Search the active brain, or every reachable brain                | `search_pages` (`scope: "all"`)   |
| Read    | The agent reads the pages it needs to reason over                | `read_page`                       |
| Show    | The person sees the page the answer came from                    | `view_page`, the app, the web app |
| Lists   | A listing or count is computed from links and fields, never kept | `okf-view` blocks                 |

Where the vision takes it:

- **Level 2:** an answer comes from the brain that owns the fact, and cites it. The organization
  view answers questions about the organization itself: who owns this, what is still open, what
  have we committed to.
- **Level 3:** the brains answer what the firm expects, and how its past expectations turned
  out. A claim's page shows the record of the decisions that tested it.

Open seams:

- A page in one brain cannot link to a page in another, so an answer that spans brains is
  assembled by the agent each time.
- When two brains state a fact differently, search returns both with nothing to say which
  stands.

## 3. Keep it true

The brains drift: links break, pages duplicate each other, two brains state one fact two ways,
the world moves on without anyone writing it down, and a write leaks what a brain's policy
forbids.

| Step    | Today                                                                                      | Surface                                       |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Trigger | The person asks to tidy, or the organization's scheduled checks run                        | The conversation; the organization's schedule |
| Detect  | Structure is checked on every call; contradictions, within and between brains, take a pass | `validate`; `review_brain`                    |
| Decide  | The agent works one finding at a time, reading the page first                              | `validate`, `read_page`                       |
| Act     | Fix the page, merge with `move_page` so links follow, or dismiss with a reason             | `write_page`, `move_page`, `resolve`          |
| Flag    | What the guard recorded becomes a policy finding a brain admin answers                     | `validate`, the Review screen (`view_review`) |

Where the vision takes it:

- **Level 2:** brain against brain is settled by the ownership map, and the finding goes to the
  copy's brain. Every finding in the organization sits in one list of what is open, which the
  organization view shows.
- **Level 3:** world against brain is answered by records: the executive records what happened,
  and a dated observation of another brain is re-recorded when that brain moves on, never
  mirrored.

Open seams:

- Findings live in three places: computed on each `validate` call, stored in the review queue,
  and shown on the Review screen (`view_review`), which shows policy findings only.
- The single list of what is open is split across the review queue, the template's
  open-questions page (`brain-template/wiki-open-questions.md`) and brain-specific pages.
- A contradiction between brains has no rule for which side stands, because no brain declares
  what it owns.
- Nothing prevents a leak: the guard records after the write lands, so the path from a
  detection to a fix runs through a brain admin opening `validate` or the Review screen.

## 4. Know what we committed to, and whether it worked

A decision or commitment is made, with a result that can be checked later.

| Step        | Today                                                                                      | Surface                                  |
| ----------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Trigger     | Someone commits to something, or a decision expects a result                               | The conversation                         |
| Record      | A Decision or Commitment page with `expected` and `check_at`, linked to the claim it tests | `write_page` (its reply asks for a date) |
| Be reminded | The person asks what is due or on their plate                                              | `validate`, its due area                 |
| Close       | The outcome is recorded on the page                                                        | `write_page`                             |
| Learn       | The claim's page shows the decisions that tested it                                        | `RECORD_VIEW` on the claim's page        |

Where the vision takes it:

- **Level 2:** commitments are part of the organization view, across every brain, by the page
  types each role declares as commitments.
- **Level 3:** an expectation is a record. The executive records the commitments spoken in
  meetings and the outcomes mail settles, and every action it drafts carries an expectation.
  The compare pass raises a surprise when an outcome departs from what was expected, and a
  question when the cause is ambiguous. A belief that the record turns against is offered for
  revision; a person decides. A scheduled executive keeps the loop turning, so nobody has to
  remember to ask.

Open seams:

- "What is on my plate" is answered by `validate`, the tool whose other job is tidying (job 3).
  This is a level-1 surface doing a level-3 job, and each improvement to reminders so far has
  been a change to `validate`. Whether reminders move to the single list of what is open, or get
  their own surface, is an open product decision.
- Nothing brings a due commitment back to the person unless they ask.
- Dates under other deadline-named keys are listed in the same reply but are not expectations
  and cannot be closed with an outcome, so the due area holds two kinds of date with two ways to
  clear them.
- Commitments spoken in meetings are not recorded unless a person asks, because nothing senses
  them.

## 5. Decide what matters now

The team has more open than it can act on, and the brains disagree about some of it.

| Step    | Today                                                      | Surface          |
| ------- | ---------------------------------------------------------- | ---------------- |
| Trigger | The person asks what to work on, or what needs a decision  | The conversation |
| Rank    | The person reads the findings and the due area and decides | `validate`       |

Where the vision takes it:

- **Level 3:** the self's charter ranks what is open. Values come first: a commitment that breaks
  one is raised ahead of everything. Intent settles conflicts between brains: of two competing
  findings, the one that serves the end state ranks first. Set points raise a finding when the
  records predict drift out of range. When brains with different stances disagree, the ranking
  pass shows what each side would predict and which way the charter leans, and a person decides.

Open seams:

- None of this level is built. Ranking today is the person reading a flat list.

## 6. Share with the right people

A team works across several brains, with people who should see some of them and not others.

| Step          | Today                                          | Surface                                       |
| ------------- | ---------------------------------------------- | --------------------------------------------- |
| Trigger       | Someone new joins, or a brain should be opened | The conversation, the app                     |
| Organization  | Members and their roles                        | `members`, `set_member_role`, `invite_member` |
| One brain     | Access to one brain, separate from membership  | `brain_access`, `share_brain`                 |
| Across brains | Search reaches every brain the person can open | `search_pages` (`scope: "all"`)               |

Where the vision takes it:

- **Level 2:** a reader who cannot open the brain that owns a fact gets a declared, one-way copy
  of it through publishing, filtered for what that reader may see
  ([`design/brain-seams.md`](design/brain-seams.md)). The organization view answers by audience:
  each answer is filtered by what the asker can already read.
- **Level 3:** a self spans organizations. Putting a brain inside a self needs that brain's
  admin, and a self reads brains it does not own with an ordinary grant from their owners.

Open seams:

- A fact a reader of one brain needs from a brain they cannot open has no path, because
  publishing is designed, not built.
