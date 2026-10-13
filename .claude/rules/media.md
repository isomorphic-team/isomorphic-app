---
paths:
  - "src/lib/media.ts"
  - "src/lib/{document-text,asset-link}.ts"
  - "src/tools/media.ts"
  - "app/core/{media,editor-media}.ts"
  - "app/views/AssetView.tsx"
  - "scripts/test-media.ts"
---

# Media attachments (`attach_media`, `read_media`)

Design: `docs/design/media-attachments.md`. Pure layer `src/lib/media.ts` (imported by both
bundles), tools `src/tools/media.ts`, app side `app/core/media.ts` + `editor-media.ts`,
`pnpm test:media`.

- **The model cannot hand us bytes.** A model shown an image holds visual tokens, not base64,
  and no host passes a conversation attachment into a tool call. So `attach_media` takes
  either `data` (base64, supplied by the app from a real file input or drop) or `url` (the
  server downloads it; the model's only route). The description says which argument belongs
  to whom; keep it that way or agents burn turns synthesizing PNGs.
- **URL fetches are SSRF-guarded:** https only, private and loopback addresses refused
  (`fetchUrlProblem`), redirects followed by hand so every hop is re-checked, and the body read
  with a hard cap even when `Content-Length` lies.
- **An attachment is permanent git history** in a repo the customer clones.
  `MAX_ATTACHMENT_BYTES` is 5 MiB; the type registry is an allowlist, so unknown or executable
  types are refused. The app downscales before upload.
- **Placement:** beside `page` in an `assets/` folder, with a markdown image link appended to
  the page; `path` overrides.
- **`read_media`** returns the picture itself for types Claude can see (PNG, JPEG, GIF, WebP;
  SVG is stored and shown, never returned as image content). PDF, DOCX and PPTX come back as
  text by page, section or slide (`src/lib/document-text.ts`, Worker-only, so pdf.js stays out
  of the app bundle), capped at `DOCUMENT_TEXT_BUDGET` per reply with a `pages` continuation.
  Text rides in `content`, never `structuredContent`. `include_data` is for the app, which
  renders images as data URIs because the iframe CSP allows only `'self'` and `data:` and brain
  repos are usually private; with it set, no text is extracted. It reads through
  `BrainStore.readBinary`.
- **Signed file links** (`src/lib/asset-link.ts`): every read leads with a `resource_link` to
  `/files/<token>/<name>`, an HMAC over (brain id, path, issuing user, expiry) valid for
  `ASSET_LINK_TTL_SECONDS` (15 minutes), and restates the URL in text for hosts that drop
  that block. The token is the credential, so the route sits ahead of the OAuth provider in
  both auth modes, and each fetch re-checks the issuing user through `listAccessibleBrains`
  (`brainForClaim`): revoking access kills their live links. Keyed from `AUTH_SECRET` (oauth)
  or `MCP_BEARER_TOKEN` (static); issued only when `PUBLIC_BASE_URL` is set. PDFs and raster
  images open inline with no sandbox CSP on PDF (Chrome's viewer refuses one); everything
  else, SVG included, downloads under a sandbox CSP.
- **No media twins of move and delete.** `move_page` and `delete_page` handle non-page files:
  the index records links to non-page content files (`fileEdges` via `src/lib/links.ts`), so a
  move repoints them and a delete warns about pages still linking. Do not grow the tool surface
  for this.
- The renderer leaves repo-relative image `src` untouched; `app/core/media.ts` swaps it for a
  data URI after render.
