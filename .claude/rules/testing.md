---
paths:
  - "scripts/test-*.ts"
  - "scripts/e2e-*.ts"
  - "scripts/{check,roundtrip-check}.ts"
  - "tests/**"
  - "playwright.config.ts"
  - "dev/harness.ts"
---

# The batteries

The policy (a test with every change, break it to prove it, test the thing that decides) is
in CLAUDE.md. Adding a battery: the `add-battery` skill. Each battery's header lists what it
exists to catch.

## `pnpm test:ui` is the only browser battery

It drives the REAL generated bundle over the local host harness (`dev/harness.ts`; projects in
`playwright.config.ts`, including `web` for the web host), so it covers what every other
battery is blind to: routes mount, the tree, folder notes and brain switching wire up, the
editor round-trips, and how the app LOOKS in three display modes and two themes. It does not
re-assert tool semantics.

- It **skips green** (loudly) without Chromium or without baselines for this platform; CI sets
  `UI_STRICT=1` so a missing browser cannot hide a broken container.
- Determinism needs **two** frozen clocks (`?now=` for fixtures, `page.clock.setFixedTime` for
  the app's relative times). `page.clock.install()` does NOT pause `setTimeout` here.
- Regenerate baselines with `pnpm ui:baselines` (the `ui-baselines` skill), never a bare
  `--update-snapshots` (it silently keeps changed ones). Details: `dev/README.md`.

## The end-to-end batteries run in CI

`pnpm test:e2e-librarian` and `pnpm test:e2e-import` drive the real MCP tool handlers through a
real content index on `node:sqlite` against a real brain: by default the fs + git `BrainStore`
in a temp directory, no network. They gate the write path and the org-scope tools that decide
where a brain lands. `--github` runs the same assertions against a disposable scratch repo on
the platform org (needs `.dev.vars` with platform App creds); that is the only coverage of the
GitHub adapter, so run it when `githubStore` changes.
