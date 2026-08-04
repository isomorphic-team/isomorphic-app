# Isomorphic

**A team knowledge base that lives in a GitHub repository, and that Claude can search, read,
edit, and render as an interactive app inside the conversation.**

Your knowledge is markdown in a git repo you own. Isomorphic is the layer that lets an LLM
maintain it: a Model Context Protocol server with a librarian's toolkit, a content index that
keeps reads fast at any size, computed views, and an in-client viewer and WYSIWYG editor so a
non-technical teammate never has to open GitHub.

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
with `claude mcp add --transport http isomorphic-local http://127.0.0.1:8788/mcp`.

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

Isomorphic supplies what an LLM otherwise gets wrong: tools that repoint every inbound link
when a page moves, edits that cannot half-apply, a validator that catches twelve concepts
crammed into one page, and views that recompute instead of drifting.

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
written by hand.

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

Two programs share one `src/`:

- **The MCP Worker** (`src/worker.ts`) runs on Cloudflare Workers and is the product. Stateless
  Streamable HTTP: a fresh server and transport per request, answering on the same POST. D1 for
  the content index and the org tables, KV for OAuth state.
- **The bootstrap server** (`src/bootstrap.ts`) runs once on Node to register the GitHub App and
  scaffold the first brain.

The split is load-bearing: anything under `src/lib/` is imported by both, so it **cannot use
`node:*` modules**. Three tsconfigs enforce it and `pnpm typecheck` runs all three.

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
pnpm typecheck          # all three tsconfigs
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
