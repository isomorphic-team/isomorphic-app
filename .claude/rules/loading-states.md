---
paths:
  - "src/lib/loading-lines.ts"
  - "app/views/LoadingView.tsx"
  - "app/styles.css"
  - "scripts/test-loading.ts"
  - "tests/ui/loading.spec.ts"
---

# Loading states (the rotating status line)

Every `{ kind: 'loading' }` renders through `LoadingView`: the caller's literal label first,
then phrases from `src/lib/loading-lines.ts` (pure, `pnpm test:loading`).

- **The label leads.** Rotation starts 2.4s in, so a quick load reads as a plain label.
- **Specific and library lines ALTERNATE**, opening on a specific one (the test pins the
  SLSLSL shape).
- **A slot is a REQUIREMENT.** A template naming `{brain}` / `{org}` / `{subject}` / `{pages}`
  is ineligible when that value is unknown, never rendered blank. The test walks every
  template's slots.
- **Personalization is local.** Only facts the widget already holds; nothing calls a tool to
  decorate a wait, and no person's name or email appears.
- **`task` is optional in the type, so typecheck cannot see an omission.** The test scans every
  app source for `kind: 'loading'` without a `task`.
- **Reduced motion:** CSS stops the fade and shimmer; JS never starts the timer. Only the label
  is announced; the rotating span is `aria-hidden`.
- **The spec records the rotation with a MutationObserver inside the frame** and asserts on
  ORDER. `page.clock.install()` does not pause `setTimeout` here (verified in both frames), and
  polling from the test fails silently under CI load. `test.use({ reducedMotion })` at describe
  level does not reach this page; the spec calls `page.emulateMedia`.
- **Waits that deliberately do NOT rotate:** button busy labels (`Creating…`, `Saving…`,
  `Sharing…`), and `.asset-loading` (an image skeleton). Silent refreshes (`refreshPage`,
  `revalidateBrowse`, `refreshBrowse`, entering or leaving the editor) keep content on screen.
- **Not built:** skeleton shells for page, tree and graph (`docs/roadmap.md`).
