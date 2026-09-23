<!--
Thanks for contributing. Delete anything below that does not apply; this is a checklist,
not a form to fill in exhaustively.

First-time contributors: a bot will ask you to sign the CLA. One comment and you are done,
for this and every future PR. See CLA.md and docs/licensing.md for why it exists.
Typo and docs-only fixes need no signature.
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Anything a reviewer would not guess

<!--
The non-obvious constraint you hit, the approach you rejected, the thing you are unsure
about. "Nothing" is a fine answer.
-->

## Checklist

- [ ] `pnpm typecheck` passes (all four tsconfigs: node, worker, app, tests)
- [ ] `pnpm test` passes
- [ ] `pnpm format` run
- [ ] Ran `pnpm gen:app` if I touched `app/` or anything under `src/lib/` that it imports
- [ ] Ran `pnpm gen:templates` if I touched `brain-template/`
- [ ] No `node:*` import added to anything under `src/lib/` (that code runs on Workers)
- [ ] Fixed any sentence this change makes false: in `CLAUDE.md`, a `.claude/rules/` file (CI
      lists the ones covering the files touched), a doc, or a comment
- [ ] No customer, client, or personal names, and no real deployment identifiers, anywhere in
      the diff, the commit messages, or this description (use `Acme`, `example-org`)
- [ ] Updated a golden test's expectation, and said below why the old one was wrong, if I
      changed behavior deliberately

## If this touches a brain's content

- [ ] Existing brains keep working unchanged, including ones edited outside this codebase
- [ ] Covered by `pnpm test:structure` or `pnpm test:roundtrip`
- [ ] `pnpm test:e2e-librarian` passes (it runs offline; CI runs it too)
- [ ] If this changes `githubStore`, a maintainer should also run it with `--github`

## If this adds a dependency

- [ ] License is permissive (MIT, ISC, BSD, Apache 2.0) and named below
- [ ] It is imported by the Worker, and I checked the bundle size impact / it is dev-only
