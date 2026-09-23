---
paths:
  - "src/lib/render.ts"
  - "app/views/PageView.tsx"
  - "scripts/test-render.ts"
---

# One markdown renderer (`src/lib/render.ts`)

Markdown-to-HTML lives in `src/lib/`, pure and Worker-safe, so every surface that shows a page
produces the same HTML. `pnpm test:render` is the golden test (output parity plus
sanitization).

- **It sanitizes, because `marked` does not.** Served from our origin beside a session cookie,
  an unsanitized page body is stored XSS. **Every change to the policy constants is a security
  change:** break the sanitizer deliberately and confirm the battery goes red.
- **Raw HTML is a tag allowlist with ZERO attributes.** No attributes means no `on*`, no
  `style`, no `href`/`src`. `a` and `img` are deliberately NOT on it: markdown's own link and
  image syntax goes through the scheme check, and a raw `<a href="javascript:…">` would bypass
  it. Unlisted tags are **escaped, never dropped**, so the author sees them.
- **Scheme checks decode entities first** (`isSafeUrl`): `&#106;avascript:` and
  `javascript&colon;` reach the browser as `javascript:`.
- **Three hooks; returning `null` means refuse.** `wikilink`, `href` (the reader's horizon
  rule: FLATTEN to plain text rather than 404, since a dead link still advertises a page the
  reader was not given), `image` (falls back to alt text). The app relies on the defaults: the
  `#wikilink=` sentinel that `onProseClick` parses, and an untouched repo-relative image `src`.
  **Changing a default breaks app navigation**; the sentinel string is asserted.
- **Overrides are a plain object, not a `Renderer` subclass.** `Marked.use` throws on any
  non-method property and calls each override with its own renderer as `this`. Setting
  `token.href` and returning `false` falls back to marked's default rendering, so this module
  never reproduces marked's escaping.
- **Wikilinks are rewritten outside code only**, through `maskCode` (`wiki.ts`), the same
  function link extraction uses.
