---
name: ui-baselines
description: Regenerate the Playwright visual baselines under tests/ui/__screenshots__/ after an intended change to how the MCP App looks.
---

# Regenerate the visual baselines

Baselines are the expected output of `pnpm test:ui`'s visual project, committed per platform
(`darwin/` and `linux/`). CI compares against `linux/` and fails without it (`UI_STRICT=1`), so
a change that alters rendering regenerates BOTH. Regenerating accepts whatever the app renders
now, so do it only for a change that is meant to look different. Full detail: `dev/README.md`
§Visual baselines.

## 1. Confirm the diff is intended

Run `pnpm test:ui` first and read which screenshots changed. Every changed image should be
explained by the change on this branch. An unexplained one is a regression; stop and report it.

## 2. Regenerate for this platform

```sh
pnpm gen:app          # the tests drive the generated bundle, so it must be current
pnpm ui:baselines
```

Never a bare `--update-snapshots`: it silently keeps a changed baseline.

Then the Linux baselines, which CI's container compares against. They come from that same
container image, never from a Linux host of another kind. The exact `docker run` line is in
`dev/README.md`; its image tag must match `@playwright/test` (`pnpm test:wiring` pins it).

## 3. Verify

```sh
pnpm test:ui
```

Then list the changed PNGs in the pull request description, one line each on why.
