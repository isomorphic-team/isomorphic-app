---
paths:
  - "src/lib/feedback.ts"
  - "src/tools/feedback.ts"
  - "src/manifest.ts"
  - "scripts/test-feedback.ts"
---

# Product feedback (`submit_feedback`)

Files a user's bug or idea as an issue on a GitHub tracker from inside the conversation.
`src/tools/feedback.ts` + the pure `src/lib/feedback.ts`, `pnpm test:feedback`.

- **It does NOT use the platform GitHub App.** `src/manifest.ts` declares no `issues`
  permission and must not gain one: it would widen every customer installation for nothing.
  Filing uses a separate narrow credential, `FEEDBACK_TOKEN` (Issues: write on one repo).
- **Destination is config, never identity** (`FEEDBACK_REPO`). Unset, the tool is not
  registered, so a fork neither files into our tracker nor advertises a tool that can only
  apologize.
- **The tracker is public, so nothing identifying is published.** The issue carries the user's
  words plus an opaque `ISO-XXXXXXXX` id; who filed it goes to a private D1 row
  (`feedback_reports`). **`composeIssue` takes no identity argument** and the test asserts its
  arity: "include the reporter so we can follow up" is a privacy regression.
- **The confirm gate is the real backstop, not the redaction.** Without `confirm: true` nothing
  is posted and the exact title and body come back for the user to read. `redact()` strips only
  shapes never legitimately in a report (PEM blocks, bearer headers, `gh*_` / `re_` / `sk-`
  tokens, JWTs, emails) and leaves shas, paths and error text alone.
- **Identity is read straight off the token props, not through `tenantContext`**, which throws
  for a user with no brain: that user is exactly the one with something to report. Also fail
  open on the duplicate search and the rate-limit count.
