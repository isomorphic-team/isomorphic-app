# Design: many agents, many brains

Status: **proposed** (2026-10-13).

## The case

One person works across several brains (personal, team, one per client) through several
agents at once: a Claude Code session in a repository, a Claude.ai conversation, a ChatGPT
conversation, a scheduled job. Each agent reads and writes brains, and each one starts cold:
it does not know which brain it should be in, what the last agent did, or what is half-done.
The person carries that context between them by hand.

The platform today assumes one person driving one brain at a time. Four changes make it a
surface that several agents share safely:

1. **A default brain per connection**, not per user.
2. **Agent attribution** on every write and in the history.
3. **Activity across brains** in one feed.
4. **Handoff notes**, a brain convention for passing open work from one agent to the next.

Each part ships on its own and is useful without the parts after it. Out of scope here: page
leases, per-agent grants narrower than the person's role, cross-brain links, and routing a write
to a brain the caller did not name. Those wait for usage of parts 1 to 4 to show where agents
actually collide.

## 1. A default brain per connection

### The defect

The active brain is one KV entry per user, `active_brain:<user>` (`loadActiveBrain` and
`setActiveBrain` in `src/worker.ts`). Every connection that person holds reads and moves the same
pointer. When agent A calls `switch_brain`, agent B's next `write_page` without a `brain` argument
lands in the brain A chose. B's reply names the brain it `landed` in, but nothing stops the write.

The app widget and the web app are not affected: they pass `brain` explicitly on every call.

### What a connection is

**A connection is one OAuth grant**: one host's authorization of the server for one person.
Claude.ai, ChatGPT and a Claude Code install are three grants, so they are three connections.
Two conversations in the same host share a grant, so they share a connection. Separating
conversations would need per-conversation state from the host, which MCP does not send.

The grant's props are written once in `completeAuthorization` (`src/oauth/auth-handler.ts`) and
come back on every request as `McpProps`. The change:

- **Mint `connection_id`** (a random id) into the props at authorization, beside `user_id`.
- **Record `client_id` and `client_name`** there too: `oauthReqInfo.clientId`, and the name the
  client registered (`lookupClient`). Part 2 uses them.
- **Existing grants gain a `connection_id` on their next token refresh**, through the provider's
  `tokenExchangeCallback` returning `newProps`. Until then they fall back to the user pointer,
  which is today's behavior.

### Resolution

The rule is a pure function in `src/lib/`, so a battery can call it directly:

```
pointer keys for a request:
  connection key  active_brain:<user>:<connection>   when props carry connection_id
  user key        active_brain:<user>                always

read:   connection key, else user key, else the first accessible brain (today's fallback)
write:  switch_brain writes the connection key AND the user key
```

The user key becomes "the brain this person chose most recently, anywhere". It seeds a new
connection's first read and serves legacy grants. Once a connection has switched, its own key
wins and no other connection can move it.

`create_brain` and `disconnect_brain` move the pointer by the same write path, unchanged
otherwise.

### Explicit pins

A client that can send headers (Claude Code's `.mcp.json`, any static-mode setup) can pin its
default with `Isomorphic-Brain: <handle>`. The pin beats both keys and `switch_brain` refuses
while it is set, with a reply saying the connection is pinned and that `brain` still works
per call. This gives a per-project default in Claude Code, which a grant cannot: one Claude
Code install is one grant across every project.

Static mode has no grants, so the header is its only way to separate connections.

### Tests

`pnpm test:scope` already pins that the active brain moves only on an explicit act. It gains:

- two connections of one user switch independently
- a grant without `connection_id` reads and writes the user key
- a new connection's first read is the user key's value
- a pinned header wins over both keys, and `switch_brain` refuses under it

## 2. Agent attribution

### What is known about the caller

| Source                                         | Available                | Trust                  |
| ---------------------------------------------- | ------------------------ | ---------------------- |
| `client_name` from dynamic client registration | per grant, after part 1  | self-asserted label    |
| MCP `clientInfo.name` from the handshake       | see open questions       | self-asserted label    |
| A name the person gives the connection         | later, in Connected apps | the person's own label |

All three are display labels. **Attribution never authorizes anything**: the person who owns
the grant stays accountable, and the role checks do not change.

### Where it is written

- **The commit author stays the human.** The agent goes in trailers that `commitOpts`
  (`src/lib/change-record.ts`) adds to every commit:

  ```
  Isomorphic-Agent: Claude Code
  Isomorphic-Connection: 3f9c2a1b
  ```

  The connection id is truncated: long enough to tell two connections apart in one person's
  history, too short to be useful as a credential.

- **The changelog bullet gains `via <agent>`.** `describeChange` already owns the bullet's
  wording, so this is one optional field on `Change` and one test in `pnpm test:record`.

- **Pull requests** (`coalescedPrText`) carry the same trailer lines in their body.

### Where it is read

`listCommits` in `src/lib/brain-repo.ts` parses trailers into two new optional fields on
`CommitEntry`:

- `agent`: from `Isomorphic-Agent`
- `coAuthors`: from any `Co-Authored-By` trailer, which is how agents writing to a brain
  through git directly already mark their commits

`view_activity` shows the agent beside the author ("Ada, via Claude Code") and filters by
it. The fs store's `listCommits` parses the same trailers, so `pnpm try` shows them too.

### Tests

`pnpm test:record` pins the trailers and the `via` suffix. The trailer parser is pure and gets
cases for: no trailers, both kinds, a trailer-shaped line in the body that is not in the
trailer block, and malformed values.

## 3. Activity across brains

### The call

`view_activity` gains `scope: 'all'`, the same opt-in fan-out `search_pages` has. No new tool.

- **Targets** come from the same accessible-brain list `searchTargets`
  (`src/tools/librarian.ts`) uses, so the two fan-outs cannot disagree about which brains a
  person sees.
- **One `listCommits` per brain**, run concurrently, capped at a brain count and a per-brain
  limit so the call stays inside the Worker's subrequest budget. Each brain needs its own
  store (and installation token), which is the dominant cost; tokens for a shared installation
  are minted once.
- **Merged newest first**, and every entry names its brain, as cross-brain search results do.
- **A brain that fails is reported in the result**, never fatal to the feed.
- **Freshness** needs no index: the feed reads commits, not the content index.

### Since I last looked

Opening the all-brains feed records a timestamp per user (KV `activity_seen:<user>`). The next
open marks entries after it as new and passes it as `since` to `listCommits`, which GitHub
supports and the fs store filters locally. One timestamp per person, not per connection: it
is a person reading it.

### Rendering

The activity view groups by brain, then by agent, with an "only new" toggle. The web app needs
a `WEB_TOOL_ROUTING` entry for the scoped variant if its route differs from the single-brain
one.

### Tests

The merge (ordering, per-brain caps, a failed brain, `since` marking) is a pure function beside
`mergeBrainResults`, with its own cases. `pnpm test:ui` gets one scenario with two brains.

## 4. Handoff notes

### The convention

A handoff is an ordinary OKF page, so this is a convention plus steering, not a new tool and not
a format change. Existing brains are unaffected until someone writes one.

- **Location:** `handoffs/` under the brain's first content root (`wiki/handoffs/` by default).
  One page per handoff, named by date and subject: a handoff is a dated record, not a concept.
- **Frontmatter**, all set through `write_page`'s `type` and `fields`:

  ```yaml
  type: handoff
  status: open # open | taken | closed
  from: Claude Code # the agent label from part 2, or a person
  for: any # an agent label, a person, or any
  about: ['[[Pricing model]]', '[[Q4 plan]]']
  ```

- **Body:** four short sections. _Done_, _Open_, _Next step_, _Read first_ (links to the pages a
  successor needs).
- **Lifecycle** is a field write: the agent that picks one up sets `status: taken` and
  `taken_by`; whoever finishes the work sets `status: closed`. Nothing is deleted, so the folder
  is the history of who passed what to whom.
- **The folder note** `handoffs/index.md` lists the open ones:

  ````
  ```okf-view
  kind: pages
  under: wiki/handoffs/
  filter: { type: handoff, status: open }
  as: table
  columns: title, from, for, created
  sort: created
  order: desc
  ```
  ````

### Telling the agents

By the descending-reach pattern (OKF rules file):

- **`SERVER_INSTRUCTIONS`:** before multi-step work in a brain, check its open handoffs; when a
  session ends with work left open, write one. Only then: a handoff for finished work is noise.
- **`brain-template/AGENTS.md`:** the convention, the frontmatter and the folder note, so
  scaffolded brains carry it.
- **`create_brain` scaffolds** `handoffs/index.md` with the view above.

With part 1, an agent pinned to a brain finds that brain's handoffs without being told where to
look. With part 3, a new handoff in any brain shows in the all-brains feed.

### Tests

`pnpm test:structure` pins the scaffolded folder note, and gains an assertion that
`SERVER_INSTRUCTIONS` carries the handoff steering.
`pnpm test:views` gets a case for the handoff view's filter and sort.

## Order

| PR  | Part                                    | Depends on | Size   |
| --- | --------------------------------------- | ---------- | ------ |
| 1   | Connection id in props, pointer rule    |            | small  |
| 2   | Explicit pin header                     | 1          | small  |
| 3   | Trailers written and parsed             | 1          | small  |
| 4   | `view_activity` shows and filters agent | 3          | small  |
| 5   | `scope: 'all'` and since-last-looked    |            | medium |
| 6   | Handoff convention, template, steering  | 3 (label)  | small  |

PR 1 fixes a live defect and goes first. PR 5 needs nothing from the others and can run in
parallel. PR 6 works without part 2 (`from` is free text) but reads better with it.

## Open questions

- **Does `clientInfo.name` reach the server per request** under the 2026-07-28 protocol, given
  stateless serving? If it does, it is a better label than `client_name`, because one OAuth
  client may front several agents. Check `docs/references.md` and the SDK before PR 3.
- **Do hosts preserve custom headers and query strings on remote MCP URLs?** The pin is a
  header because Claude Code sends configured headers; a `?brain=` URL parameter would reach
  more hosts but may break OAuth protected-resource matching. Probe before widening.
- **Should a person be able to name a connection** ("work laptop Claude Code")? That needs a
  connections list in Connected apps and is the natural home for revoking one grant without the
  others.
- **Should `validate` flag stale open handoffs** (open for more than N days)? It overlaps with
  consolidation's staleness findings, so it waits for the shared findings queue.
