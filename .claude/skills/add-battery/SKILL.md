---
name: add-battery
description: Add a new offline test battery (a scripts/test-*.ts file run as `pnpm test:<name>`) and wire it into package.json and CI. Use when a change needs tests that no existing battery owns.
argument-hint: "<name> <what it pins>"
---

# Add a test battery

Battery: $ARGUMENTS

Extend an existing battery when one already owns the area; `package.json` lists them all.
A new battery is for a new subsystem or a new kind of check.

## 1. The script

Create `scripts/test-<name>.ts`:

- Open with a header comment: the `pnpm test:<name>` line, then a numbered list of what the
  battery exists to catch. That list is the battery's contract; CLAUDE.md points readers to it.
- Use the shared checker: `import { checker } from './check.ts'`, then
  `const { check, done } = checker('<name> checks')`, and call `done()` last. It sets the exit
  code rather than calling `process.exit()`, so a `finally` teardown still runs.
- **Offline and fork-safe.** No network, no secrets, no real Cloudflare or GitHub. D1 runs
  over `node:sqlite` (`src/local/d1-sqlite.ts`); a brain is a git repo in a temp directory
  (the fs `BrainStore`).
- Test the function that DECIDES. If it sits where the script cannot call it, move it into
  `src/lib/` as a pure function first.

## 2. Wire it in both places

- `package.json`: add `"test:<name>": "tsx scripts/test-<name>.ts"`, and add
  `pnpm test:<name>` to the aggregate `test` script.
- `.github/workflows/ci.yml`: add `- run: pnpm test:<name>` to the `check` job, with a
  one-line comment on what it pins. Only a battery that needs a browser goes in `ui`, and
  `pnpm test:ui` is the only one today.

`pnpm test:wiring` fails the build if either list misses it.

## 3. Prove it tests something

Break the code under test on purpose, run `pnpm test:<name>`, and confirm the relevant
checks fail. Restore it and confirm green. A battery that stays green against broken code
is worse than none.

## 4. Verify

```sh
pnpm test:<name> && pnpm test:wiring && pnpm typecheck
```
