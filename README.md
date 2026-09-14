# Isomorphic

**A team knowledge base that lives in a GitHub repository, and that Claude, or any MCP client,
can search, read, edit, and render as an interactive app inside the conversation.**

Your knowledge is markdown in a git repo you own. Isomorphic is the layer that lets an LLM
maintain it: a Model Context Protocol server with a librarian's toolkit, a content index that
keeps reads fast at any size, computed views, and an in-client viewer and WYSIWYG editor so a
non-technical teammate never has to open GitHub.

![The page viewer: frontmatter as properties, a table and count computed from the pages that link here, and the linked references below](docs/images/viewer.png)

[Getting started](docs/getting-started.md) · [Self-hosting](docs/self-hosting.md) ·
[Architecture](docs/architecture.md) ·
[Licensing](docs/licensing.md) · [Contributing](CONTRIBUTING.md) ·
[Invariants](CLAUDE.md) · [Roadmap](docs/roadmap.md)

**Try it in two minutes, with no accounts:**

```sh
git clone https://github.com/isomorphic-team/isomorphic-app
cd isomorphic-app && pnpm install
pnpm try ~/Documents/notes     # any folder of markdown; an Obsidian vault works
```

The real MCP server, the real librarian tools, and the real content index, against a git
repository on your disk. No GitHub account, no Cloudflare account, no tokens. Connect it
with `claude mcp add --transport http isomorphic-local http://127.0.0.1:8788/mcp`, or open
`http://127.0.0.1:8788/b/local/notes` in a browser for the same viewer and editor with no
MCP host at all.

**To self-host for a team you need:** a Cloudflare account (Workers, D1, KV; the free tier is
enough for a small team), a GitHub repository for the brain, and a GitHub token or GitHub App.
For one person on one machine, `pnpm try` above needs only Node 24 and git. There is no Docker
image and no Postgres path; Cloudflare is the only supported deploy target for a shared
instance. [Self-hosting](docs/self-hosting.md) has the four paths, from two minutes to two hours.

## Why not a folder of markdown and a coding agent?

You can point Claude Code at a folder of notes today, and for one person that is a fine place
to start. Isomorphic is for what goes wrong after that:

- **Moving a page breaks every link to it.** `move_page` repoints each inbound link, markdown
  and wikilink alike, in the same commit. `delete_page` tells you what still points at the page.
- **An agent rewrites a whole page to change one paragraph.** `write_page` takes exact
  find-and-replace edits and appends. An anchor that matches zero or several times aborts the
  whole call, so a batch is never half-applied and a page is never silently clobbered.
- **Reads stop scaling.** A derived content index keeps search, backlinks, validation, and the
  graph to one or two queries on a 3,000-page brain, and checks the branch HEAD on every read so
  an edit made on github.com or by another agent is never served stale.
- **Listings drift.** A fenced `okf-view` block is a listing, table, or count computed from
  backlinks or frontmatter, recomputed on every read instead of maintained by hand.
- **Half the team will never open a terminal or GitHub.** The viewer and editor render inside
  the conversation and in a browser tab. Teammates sign in with an email link, nobody needs a
  GitHub account, and orgs, roles, invitations, and per-brain sharing are all in this repository.

## What works where

The server never calls a model. It is an MCP server; the client brings the model, and any
client that speaks the protocol works.

| Surface                                                                                          | Works with                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The tools:** search, read, write, move, validate, computed views, import, brain-authored tools | Any MCP client over Streamable HTTP, with OAuth 2.1 or a bearer token: claude.ai, Claude Code, Claude Desktop, the MCP Inspector, and anything else that speaks MCP.                                                                                                                               |
| **The in-conversation app:** viewer, WYSIWYG editor, file tree, graph, activity, roster          | Hosts that implement the [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) extension. claude.ai renders it; the MCP Inspector and VS Code Copilot do too, which is how we tell a host problem from a server problem. In a host without it the tools still work and return text. |
| **The same app in a browser tab**                                                                | Any browser, no MCP host: `/b/<owner>/<repo>/<path>` on a multi-tenant deployment, signed in with the same email link, and `/b/local/<folder>` from `pnpm try`.                                                                                                                                    |
| **Reading and editing the brain itself**                                                         | Anything that reads markdown: github.com, Obsidian, `grep`, a pull request. The brain is a plain git repository and needs none of this software.                                                                                                                                                   |

> Open source under [AGPL-3.0-only](LICENSE). Run it, fork it, deploy it for your own company,
> sell services around it. If you modify it and let others use your version over a network,
> you owe those users your changes. Your knowledge base is your data and the license does not
> reach it. [`docs/licensing.md`](docs/licensing.md) has the detail, including commercial
> licensing if the AGPL does not work for you.

---

## Why this exists

Writing knowledge down is a separate job from doing the work, which is why it does not get
done. LLMs are good at that separate job and bad at doing it into a database whose shape they
cannot see.

So the substrate is one markdown file per concept, in a normal git repository, in the
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).
You can read it on github.com, edit it in Obsidian, grep it, diff it, and review a change in a
pull request. If you stop using Isomorphic tomorrow you still have everything.

## What it does

**Reads that scale.** `search_pages`, `find_inbound_links`, `view_graph`, and `validate` query
a derived index in D1 rather than GitHub. The earlier live-scan path capped out around 40 pages
and cost hundreds of milliseconds; an index query is one or two local statements and is
unbounded. The index is a cache, never the source of truth: every read compares the branch HEAD
to the indexed commit first, so a page edited on github.com, by another agent, or by a merged
pull request is never served stale. No webhook required.

**Writes that do not lose your work.** `write_page` takes exact find-and-replace edits or an
append, so an agent changes a paragraph without rewriting the page. An anchor that matches zero
times or several times aborts the whole call, so a batch is never half-applied. `move_page`
repoints every inbound link, in both markdown and wikilink syntax, in the same commit.
`delete_page` reports what still points at what you are removing. Writes to a protected brain
open a pull request instead of committing.

**Views that compute.** A fenced ` ```okf-view ` block declares a listing, a table, or a count,
derived from backlinks or from the pages under a prefix, filtered and grouped by frontmatter.
Executing consumers always compute it live. A cached snapshot is written into the file so that
github.com and other plain-markdown readers still see a real table; it is allowed to go stale,
because whatever reads it cannot compute.

**An app, not a wall of text.** The viewer, editor, file tree, link graph, activity feed, and
member roster render inside Claude as an
[MCP App](https://modelcontextprotocol.io/extensions/apps/overview). The editor is ProseMirror
with a markdown round-trip golden test, so what it writes back is the markdown you would have
written by hand. The same bundle is served as a web app in a browser tab, for people who are
not in the conversation.

![The editor: a formatting toolbar, the page's properties, and the body as rich text, saved back as plain markdown](docs/images/editor.png)

**Tools your brain defines.** Any page under a `tools/` folder becomes an MCP tool in Claude's
tool list, declared in a small fenced block. Three read-only kinds: return an instruction
payload, run one whitelisted read, or render one view. Arguments are interpolated as data and
never evaluated, and a brain-authored tool cannot exceed its caller's access. These are written
conversationally, which means Claude authoring Claude's own future tools.

**Multi-tenant when you need it.** Orgs, roles (`viewer < editor < admin < owner`), a member
roster with email invitations, several brains per person, and magic-link sign-in so teammates
never need a GitHub account. All of it is in this repository and all of it is configuration
rather than a hosted-only tier. See
[the open-source boundary](docs/design/open-source-boundary.md).

**Non-destructive bulk import.** `sync_records` upserts from a spreadsheet or CRM without
clobbering human edits: only declared source-owned fields are written, deletions are proposed
rather than applied, and a page a human deleted is never silently resurrected.

## Use it

Add it to Claude as a custom connector. **Settings → Connectors → Add custom connector**,
and paste the MCP endpoint of an Isomorphic server. For the hosted service run by
Isomorphic:

```
https://mcp.isomorphic.sh/mcp
```

No client ID, no client secret, and no GitHub account. Claude registers itself and sends you
through an email magic link, then you ask it to create your first brain.
[**docs/getting-started.md**](docs/getting-started.md) has the full walkthrough, the same
steps against your own deployment, other MCP hosts, and what to check when it does not work.

## Run it locally in five minutes

No accounts, no Cloudflare, no GitHub App:

```sh
git clone https://github.com/isomorphic-team/isomorphic-app
cd isomorphic-app
pnpm install
pnpm setup:config       # generate wrangler.jsonc for local development
pnpm test               # the full suite, offline
pnpm app:dev            # http://localhost:5175, the real app UI over fixtures
```

To run a server against your own GitHub org, see
[**docs/self-hosting.md**](docs/self-hosting.md). The short version is `pnpm bootstrap`, which
registers a GitHub App from a manifest and scaffolds your first brain repository in one atomic
commit, in about three clicks.

## How it is built

Three programs share one `src/`:

- **The MCP Worker** (`src/worker.ts`) runs on Cloudflare Workers and is the product. Stateless
  Streamable HTTP: a fresh server and transport per request, answering on the same POST. D1 for
  the content index and the org tables, KV for OAuth state. It also serves the app as a web page.
- **The local runtime** (`src/local.ts`) is `pnpm try`: the same tools and the same app over a
  git repository on disk, on Node, with no accounts. One person, one machine, no org model.
- **The bootstrap server** (`src/bootstrap.ts`) runs once on Node to register the GitHub App and
  scaffold the first brain.

The split is load-bearing: anything under `src/lib/` is imported by both, so it **cannot use
`node:*` modules**. Four tsconfigs enforce it and `pnpm typecheck` runs all four.

A brain repository is:

```
your-brain/
├── AGENTS.md            # the contract agents read (see brain-template/AGENTS.md)
├── .isomorphic.json     # which paths are content, which are immutable source, where the log is
├── source/              # immutable source material
└── wiki/                # editable content, arbitrary folders, no fixed entity types
    └── log.md           # tool-maintained changelog
```

There is no entity taxonomy. Folders are whatever you want, because the brains this serves
belong to different companies who organize differently. `type:` in frontmatter is a free-form
string, required by OKF, and used to force the "is this a concept or a record" question. A
folder containing `index.md` **is** that page, which is how directory notes work.

[**`CLAUDE.md`**](CLAUDE.md) is the architecture document. Maintainers keep it current because
coding agents read it, and it explains why each design is what it is, including the failures
that produced the rule. Read the relevant section before changing something.
[`docs/references.md`](docs/references.md) lists the authoritative external sources, which move
faster than any model's training data.

## Commands

```sh
pnpm try <folder>       # local runtime: MCP over a git repo on disk, no accounts
pnpm doctor             # what this checkout has, and what to run next
pnpm setup:config       # generate wrangler.jsonc (--provision to create Cloudflare resources)
pnpm bootstrap          # one-shot GitHub App registration + brain scaffold
pnpm app:dev            # app UI dev server, no credentials needed
pnpm worker:dev         # the MCP Worker at http://localhost:8787/mcp
pnpm worker:deploy      # publish to Cloudflare
pnpm gen:app            # regenerate the ui:// bundle (after editing app/)
pnpm gen:templates      # regenerate the brain templates (after editing brain-template/)
pnpm db:migrate         # apply D1 migrations locally
pnpm test               # the full suite, offline
pnpm typecheck          # all four tsconfigs
pnpm format             # prettier
```

`pnpm test` includes two end-to-end batteries that drive the real tool handlers against a git
repo in a temp directory. The same two run against real GitHub with `--github`, which needs
platform App credentials and creates a disposable scratch repository it deletes afterwards.

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers how to get it running,
the three invariants that will bite you, and what we will and will not merge. Contributors sign
a [CLA](CLA.md), which is one bot comment and does not take your copyright.

[`docs/roadmap.md`](docs/roadmap.md) is what is planned. [`GOVERNANCE.md`](GOVERNANCE.md) says
who decides what.

Found a security problem? [`SECURITY.md`](SECURITY.md). Please do not open a public issue.

## License

[GNU AGPL-3.0-only](LICENSE), an [OSI-approved](https://opensource.org/licenses) open source
license. Self-host freely with no obligations. Modify it and let others use your version over a
network, and you owe those users your source. Your brain is your data and the license does not
reach it; neither does it reach MCP clients, which talk to the server over a protocol rather
than linking against it.

What the AGPL does and does not require, and why we chose it over Apache, FSL, and BSL:
[`docs/licensing.md`](docs/licensing.md).

Contributors sign a [CLA](CLA.md) so we can also offer Isomorphic commercially to organizations
that cannot ship copyleft. In exchange the CLA binds us to keep every contribution under an
OSI-approved license, permanently. If the AGPL does not work for you, **legal@isomorphic.sh**.
