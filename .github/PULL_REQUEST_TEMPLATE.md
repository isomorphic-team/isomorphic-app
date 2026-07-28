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

- [ ] `pnpm typecheck` passes (all three tsconfigs: node, worker, app)
- [ ] `pnpm test` passes
- [ ] `pnpm format` run
- [ ] Ran `pnpm gen:app` if I touched `app/` or anything under `src/lib/` that it imports
- [ ] Ran `pnpm gen:templates` if I touched `brain-template/`
- [ ] No `node:*` import added to anything under `src/lib/` (that code runs on Workers)
- [ ] Updated `CLAUDE.md` if this change makes a statement in it wrong
- [ ] Updated a golden test's expectation, and said below why the old one was wrong, if I
      changed behavior deliberately

## If this touches a brain's content

- [ ] Existing brains keep working unchanged, including ones edited outside this codebase
- [ ] Covered by `pnpm test:structure` or `pnpm test:roundtrip`
- [ ] I ran `pnpm exec tsx scripts/e2e-librarian.ts` against real GitHub, **or** I could not
      and a maintainer should

## If this adds a dependency

- [ ] License is permissive (MIT, ISC, BSD, Apache 2.0) and named below
- [ ] It is imported by the Worker, and I checked the bundle size impact / it is dev-only
