---
name: ui-baselines
description: Regenerate the Playwright visual baselines under tests/ui/__screenshots__/ after an intended change to how the MCP App looks.
disable-model-invocation: true
---

# Regenerate the visual baselines

Baselines are the expected output of `pnpm test:ui`'s visual project, committed per platform.
Regenerating accepts whatever the app renders now, so do it only for a change that is meant
to look different. Full detail: `dev/README.md` §Visual baselines.

## 1. Confirm the diff is intended

Run `pnpm test:ui` first and read which screenshots changed. Every changed image should be
explained by the change on this branch. An unexplained one is a regression; stop and report it.

## 2. Regenerate for this platform

```sh
pnpm gen:app          # the tests drive the generated bundle, so it must be current
pnpm ui:baselines
```

Never a bare `--update-snapshots`: it silently keeps a changed baseline.

Linux baselines (what CI's container compares against) come from that container. The exact
`docker run` line is in `dev/README.md`; its image tag must match `@playwright/test`
(`pnpm test:wiring` pins it).

## 3. Verify

```sh
pnpm test:ui
```

Then list the changed PNGs in the pull request description, one line each on why.
