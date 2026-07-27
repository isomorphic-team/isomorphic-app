# isomorphic-mind

LLM-maintained knowledge base. Content only — the platform that compiles and queries this lives in [`isomorphic-app`](https://github.com/isomorphic-team/isomorphic-app).

## How it works

- Write pages under `wiki/`, organized however suits this brain — folders are arbitrary, there are no fixed entity types.
- Keep immutable source material (transcripts, emails, docs) under `source/`; the platform treats it as read-only, and pages can cite it.
- Read and edit via Claude.ai (MCP / the Isomorphic app), the static site, or Obsidian.

See [`AGENTS.md`](./AGENTS.md) for the schema.

## Your content is yours

This repository is your knowledge base, not part of the Isomorphic software. Isomorphic is
licensed under the GNU AGPL-3.0, and that copyleft does **not** reach what you write here:
your pages are data, not a derivative work of the software. Pick whatever license you like
for this repo, or none.

Pages are ordinary markdown in the
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
so they stay readable, greppable, and editable without any of the platform's tooling. Clone
this repo and you have everything, whether or not you keep using Isomorphic.
