---
paths:
  - "src/lib/media.ts"
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
  SVG and PDF are stored and shown, never returned as image content). `include_data` is for the
  app, which renders images as data URIs because the iframe CSP allows only `'self'` and
  `data:` and brain repos are usually private. It reads through `BrainStore.readBinary`.
- **No media twins of move and delete.** `move_page` and `delete_page` handle non-page files:
  the index records links to non-page content files (`fileEdges` via `src/lib/links.ts`), so a
  move repoints them and a delete warns about pages still linking. Do not grow the tool surface
  for this.
- The renderer leaves repo-relative image `src` untouched; `app/core/media.ts` swaps it for a
  data URI after render.
