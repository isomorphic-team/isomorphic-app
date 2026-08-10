# AGENTS.md

The schema for this brain. Read this before writing.

## Three layers

- **`source/`** — immutable source material (transcripts, docs, emails, articles). Read by agents, never modified by them. (Roles are declared in `.isomorphic.json`; a brain can name this area anything.)
- **`wiki/`** — LLM- and human-maintained synthesis, in **arbitrary folder structure**. Organize it however fits this brain — there are no predefined folders or entity types. Written via the librarian tools (`write_page`, `move_page`, `delete_page`).
- **This file** — the conventions below.

## Structure

`wiki/` is a free-form wiki. Create pages at any path (`write_page` takes the target path), nest folders as deep as you like, and name folders however suits the content. Grow structure as the brain grows; don't impose a taxonomy up front.

**Folders are free. Granularity is not.** This brain follows the [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF): where the folders go is your call, but **one page = one concept**.

- Anything another page should be able to link to gets its own file: a person, a vendor, a system, an event series, a project, a decision.
- If you are about to write a list of named things as headings or bullets inside one page, write **a page per thing** and link to them from the parent instead.
- The test: once written, can something link to it? Can search return it as a result? Can a view filter on it? If not, it needs a file.
- **Concept vs. record.** The recurring, named thing is a concept and gets a page ("Annual Meeting", the series). A dated instance is a record ("16th Annual Meeting, March 2026") and lives inside the concept's page, in `source/`, or in an imported dataset. Being told not to store instance data is not a reason to leave the concept without a page.

**Match what is already there.** Before adding to an existing folder, read a sibling page and follow it: same `type:` values, same frontmatter keys, same granularity. A brain that gives every vendor its own file and then gets one page holding twelve events is worse off than either convention applied consistently. Run `validate` after a restructure; it reports drift as advisory notes.

One page is **maintained automatically — never edit it directly**:

- `wiki/log.md` — append-only changelog. Every create, update, move, publish, and delete is logged.

## Folder notes

A folder's overview page is named **`index.md`** (`README.md` is accepted as a fallback on
vaults that already use it). A page at `<folder>/index.md` **is** that folder: clicking the
folder in the app opens it instead of just expanding, its row is hidden as a redundant
sibling, and `kind: folders` views link each sub-folder through its note.

There is no special file type or frontmatter; the filename is the whole convention. Name it
anything else (`overview.md`, `vendors.md`, `about.md`) and it is just a loose page sitting
next to its siblings, and the folder stays note-less.

So: when you create a folder of related pages, give it `<folder>/index.md`. A folder note is
a good place for an `okf-view` directory listing so it stays current on its own:

````markdown
```okf-view
kind: pages
under: vendors/
as: table
columns: title, description
```
````

## Page conventions

Frontmatter is free-form and every key but one is optional. When a page has it, the librarian tools preserve and merge it, and bump `updated` on save. A common shape:

```yaml
---
type: Customer # the one field OKF requires — see below
title: Acme Corp
description: Rocket-parts customer, mid-market, US west
status: draft # draft | published — publishing is a deliberate act, not an edit
updated: 2026-07-06 # bumped automatically on every save
sources:
  - source/2026-04-26-acme-pricing.md
---
```

**`type:` — set it on every concept page.** A short, free-form noun phrase saying what kind of thing the page is (`Customer`, `Vendor`, `Event Series`, `Person`, `Meeting Note`). It is **not a fixed taxonomy**: no list to pick from, nothing to register. Reuse the types this brain already uses (check a sibling page), coin a new one when nothing fits. `write_page` takes it as an argument.

It earns its place twice over. It is the only field OKF requires, so it is what makes this brain readable by any OKF consumer. And naming the type is the question that catches bad granularity: if you cannot say what type a thing is, it usually belongs inside another page; if you can, it usually deserves its own.

Folder notes (`index.md`) need no `type` — OKF reserves them as listings rather than concepts.

**A page's name** is its `title:` if it has one, otherwise its first `# H1`, otherwise its filename (or, for a folder note, the folder's name — an `index.md` is never called "index"). Set `title:` when the display name differs from the heading; otherwise just write the H1 and they can't disagree.

**One page, one title.** Two pages sharing a title makes `[[That Title]]` ambiguous: it reaches exactly one of them and the others become unreachable by name. `validate` reports duplicates.

Links: `[[Other Page]]` wikilinks (matched against a page's path, filename, or title, ignoring case and punctuation, so `[[2026-06-26 Weekly Sync]]`, `[[Meetings/2026-06-26 Weekly Sync]]` and `[[Weekly Sync#Notes]]` all reach the same page) and relative markdown links both work and stay resolving through `move_page` / `delete_page`. `validate` reports any that break. (Wikilinks are an Isomorphic convenience, not part of OKF — a plain markdown link is what an outside OKF reader will follow, so prefer markdown links for anything meant to travel.)

**Track whatever this brain needs, in whatever keys it uses.** Beyond `type:`, frontmatter is yours: `done`, `owner`, `due`, `priority`, `stage`, `client`. Every flat key is indexed, so anything written here is immediately filterable by `okf-view` `filter:` and `group-by:`. Set or remove one with `write_page`'s `fields` argument (`{done: "2026-08-10"}`, or `null` to remove a key), which **leaves the page body untouched** and so needs no prior read. Key names use letters, digits, dashes and underscores. `title` / `type` / `description` / `status` are set by their own arguments instead, because changing them does more than write a value.

**Nested frontmatter is preserved, not interpreted.** The keys the tools understand are flat: a string, or a list of strings. OKF's richer provenance shapes (`sources:` as a list of `resource:`/`title:` mappings, `generated: {by, at}`, `verified:`) are kept **verbatim** — a page carrying them can be edited and saved through the tools without losing a byte. What you cannot do is query them: nested values aren't indexed, so `okf-view` `filter:` and `group-by:` can't see inside them. Write the keys you want to filter on flat, and let the nested provenance ride along.

## Lifecycle

Pages can carry `status: draft` (not yet settled) vs `published` (the trusted layer). To publish, set `status: published` (via `write_page`). Prefer editing published pages over forking new drafts of the same thing.

## Workflows

- **Source material.** Keep transcripts, emails, and docs under `source/` (add them via GitHub); the platform treats that area as read-only and pages cite it in `sources:`.
- **Query / browse.** The MCP server reads `wiki/` and serves answers with citations; the in-client app browses the wiki as a file tree.
- **Librarian.** `write_page` (create or update, at a path you choose) / `move_page` / `delete_page` land instantly and atomically; every change is logged. `move_page` and `delete_page` also take a folder path to move or delete a whole subtree. `validate` checks for broken links; run it after big restructures.
- **Editing part of a page.** `write_page`'s `content` argument **replaces the whole body**, so it destroys anything you haven't read. To change part of a page, pass `edits` (a list of exact `find` / `replace` pairs) or `append` (text added at the end) instead: they touch only what you name, leave the rest byte-identical, and need no prior read. An anchor that matches zero times or more than once fails the whole call rather than guessing, so nothing is half-applied. Anchors match the body only; frontmatter is changed with `fields` or the `title` / `type` / `description` / `status` arguments. An anchor also cannot target the generated text inside an `okf-view` snapshot, which is recomputed on every save. Read the page first (`read_page`) only when you genuinely want a full rewrite via `content`.
- **Setting fields.** `write_page`'s `fields` changes a page's metadata without touching its text. Reach for it instead of rewriting a page to change a `done:` or an `owner:`. Changing the same field across many pages is one call per page today.

## Custom tools

A page under a **`tools/`** folder (e.g. `wiki/tools/standup-digest.md`) becomes a **tool in Claude's tool list**, named `tool_<filename>`. Create one with `write_page` like any page. The behavior is declared in a fenced ` ```tool ` block; the page body around it is the instruction the model receives when the tool runs. A tool is **read-only** — it can search/read/summarize this brain, never write it — and its arguments are substituted as data (`{{arg}}`), never executed.

Three kinds:

- **Prompt** — no fence (or a fence with only `input:`). The body is returned to the model as instructions. A saved skill.
- **Bound-op** — the fence names one whitelisted read (`op: search_pages | read_page | find_inbound_links | list_pages`) with `arg:` values; its result is appended under the body.
- **View** — the fence carries a `view:` okf-view directive; the rendered result is returned (add `widget` to open it in the viewer).

````markdown
---
description: Summarize this week's changes under a project.
---

Group the results below by author and write a terse bulleted digest.

```tool
input: project (string) project folder, e.g. acme
input: days (number, default=7) look-back window
op: search_pages
arg: prefix = projects/{{project}}/
arg: query = {{project}}
```
````

Grammar: `input: <name> (<type>[, default=<v>][, optional]) <description>` where `<type>` is `string | number | boolean | enum: a|b|c`; `op:` + `arg: key = value`; `widget`; `view:` (everything after it is the directive). `op` and `view` are mutually exclusive. Malformed tool pages are reported by `validate`.

**New, renamed, or deleted tools only appear after you reconnect the Isomorphic connector in Claude** (the tool list is fetched once per connection). Editing an existing tool's behavior takes effect on its next call with no reconnect.

## Privacy

Anything under `wiki/private/` (or `source/private/`) is invisible to the public-facing MCP server. The path is the ACL.
