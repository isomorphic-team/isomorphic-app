# Product spine

The jobs the product does for a team, the path a person and their agent take through each, and
the concepts each step uses. [`concepts.md`](concepts.md) says what each word means; this page
says what the words are for.

Changing a job, adding one or dropping one is a product decision for the maintainer, not a
documentation fix.

## How a change uses this page

- **A design names the job and the step it improves.** A change that serves no job here is out
  of scope until a job is added.
- **One surface per step.** A design that adds a second place to do a step that already has one
  either replaces the first or says why both stay.
- **A step is finished when the whole path works.** Every path below starts from something a
  person says or something that happens, not from a tool name. A feature the agent cannot reach
  from that trigger, through `SERVER_INSTRUCTIONS`, a tool description or the brain's
  `AGENTS.md`, is not done.
- **The open seams are the work list.** Each job ends with the places where its path splits,
  doubles back or stops. A design that touches one says whether it closes it or widens it.

The agent is the main user: a person talks to their AI assistant, and the assistant uses the
brain through its tools. Every path is written from that side.

## 1. Write it down without a separate job

A person says something worth keeping, in a conversation that is about something else. Writing
knowledge down is a separate job from doing the work, which is why it does not get done; the
agent does that job.

| Step               | What happens                                                                             | Surface                     | Concepts          |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------- | ----------------- |
| Trigger            | The person states a fact, a decision, a person or a process                              | The conversation            |                   |
| Find where it goes | The agent reads a sibling page and matches its `type:` and keys                          | `search_pages`, `read_page` | Brain, page       |
| Write              | One concept per page, linked from its parent, frontmatter as fields                      | `write_page`                | Page, folder note |
| Scan the write     | The guard scans the write for sensitive data and records what it finds, without blocking | Every write                 | Guard             |
| Outside sources    | Records kept in step with a system the team already uses, by key                         | `sync_records`              | Import            |

Open seams:

- Records (dated occurrences) are designed and not built, so a dated event is written as a
  page today, or not at all.

## 2. Answer from what we know

A person asks about their own work, people, customers or decisions.

| Step    | What happens                                                     | Surface                           | Concepts        |
| ------- | ---------------------------------------------------------------- | --------------------------------- | --------------- |
| Trigger | A question specific to this person or organization               | The conversation                  |                 |
| Find    | Search the active brain, or every reachable brain                | `search_pages` (`scope: "all"`)   | Content index   |
| Read    | The agent reads the pages it needs to reason over                | `read_page`                       | Page            |
| Show    | The person sees the page the answer came from                    | `view_page`, the app, the web app | Page, live view |
| Lists   | A listing or count is computed from links and fields, never kept | `okf-view` blocks                 | Live view       |

Open seams:

- A page in one brain cannot link to a page in another, so an answer that spans brains is
  assembled by the agent each time.

## 3. Keep it true

The brain drifts: links break, pages duplicate each other, two brains state one fact two ways,
and a write leaks what the brain's policy forbids.

| Step    | What happens                                                                   | Surface                                       | Concepts                                |
| ------- | ------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------- |
| Trigger | The person asks to tidy, or a scheduled pass runs                              | The conversation; the organization's schedule | Pass, organization pass                 |
| Detect  | Structure is checked on every call; contradictions take a pass                 | `validate`; `review_brain`                    | Defect, finding, tension, consolidation |
| Decide  | The agent works one finding at a time, reading the page first                  | `validate`, `read_page`                       | Finding                                 |
| Act     | Fix the page, merge with `move_page` so links follow, or dismiss with a reason | `write_page`, `move_page`, `resolve`          | Finding, review queue                   |
| Flag    | What the guard recorded becomes a policy finding a brain admin answers         | `validate`, the Review screen (`view_review`) | Guard, finding                          |

Open seams:

- Findings live in three places: computed on each `validate` call, stored in the review queue,
  and shown on the Review screen (`view_review`), which shows policy findings only. A person
  who opens the Review screen does not see what `validate` reports.
- The roles design names "open item" as the one list of what is unresolved. Today that list is
  split across the review queue, the template's open-questions page
  (`brain-template/wiki-open-questions.md`) and brain-specific pages.
- Nothing prevents a leak: the guard records after the write lands, so the path from a
  detection to a fix runs through a brain admin opening `validate` or the Review screen.

## 4. Know what we committed to, and whether it worked

A decision or commitment is made, with a result that can be checked later.

| Step        | What happens                                                                               | Surface                                  | Concepts    |
| ----------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------- |
| Trigger     | Someone commits to something, or a decision expects a result                               | The conversation                         |             |
| Record      | A Decision or Commitment page with `expected` and `check_at`, linked to the claim it tests | `write_page` (its reply asks for a date) | Expectation |
| Be reminded | The person asks what is due or on their plate                                              | `validate`, its due area                 | Expectation |
| Close       | The outcome is recorded on the page                                                        | `write_page`                             | Expectation |
| Learn       | The claim's page shows the decisions that tested it                                        | `RECORD_VIEW` on the claim's page        | Expectation |

Open seams:

- "What is on my plate" is answered by `validate`, the tool whose other job is tidying (job 3).
  The due area is the first thing in its reply, ahead of the findings. Each improvement to
  reminders has so far been a change to `validate`. Whether reminders keep living there or get
  their own surface is an open product decision.
- Nothing brings a due commitment back to the person unless they ask. The loop turns only when
  someone opens a conversation and asks.
- Dates under other deadline-named keys are listed in the same reply but are not expectations
  and cannot be closed with an outcome, so the due area holds two kinds of date with two
  different ways to clear them.
- The self, the executive and the compare pass that would raise surprises are proposed, not
  built ([`design/self-and-executive.md`](design/self-and-executive.md)).

## 5. Share with the right people

A team works across several brains, with people who should see some of them and not others.

| Step          | What happens                                              | Surface                                       | Concepts                  |
| ------------- | --------------------------------------------------------- | --------------------------------------------- | ------------------------- |
| Trigger       | Someone new joins, or a brain should be opened to someone | The conversation, the app                     |                           |
| Organization  | Members and their roles                                   | `members`, `set_member_role`, `invite_member` | Organization, member role |
| One brain     | Access to one brain, separate from membership             | `brain_access`, `share_brain`                 | Sharing                   |
| Across brains | Search reaches every brain the person can open            | `search_pages` (`scope: "all"`)               | Brain                     |

Open seams:

- A fact a reader of one brain needs from a brain they cannot open has no path: publishing is
  designed, not built ([`design/brain-seams.md`](design/brain-seams.md)).
