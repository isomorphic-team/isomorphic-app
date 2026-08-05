# Media attachments: uploading, viewing, and passing images through MCP

Status: design, not built. Written 2026-08-05.

The ask: let people upload images (and possibly other file types) into a brain, see them
in the app, and have Claude actually look at them. The brain stays what it is: an ordinary
git repository on GitHub.

This document exists because the obvious implementation is wrong in a specific way, and
the reason is worth writing down before anyone spends a week on it.

---

## 1. The constraint that shapes everything: the model cannot hand us bytes

The natural mental model is "the user drops an image into the Claude conversation and says
'save this to my brain', and Claude calls a tool with the image." **That path does not
exist, and no amount of tool design creates it.**

MCP tool arguments are JSON, produced by the model. A model that has been shown an image
perceives it as visual tokens, not as a byte string: it cannot reproduce the file's base64
because it never had the base64. There is no MCP mechanism by which a host passes a user's
conversation attachment into a tool call. Elicitation (SDK 1.29, protocol 2025-11-25) has
exactly two forms, `ElicitRequestFormParams` and `ElicitRequestURLParams`; the form variant
carries primitives, and neither carries a file.

So the byte-carrying path has to originate somewhere that actually holds bytes. There are
three candidates, and only one is good:

| Path                                                           | Verdict                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Model re-emits an attached image as base64 in a tool argument  | **Impossible.** Not a limitation to work around; the model does not have the bytes.                  |
| The MCP App iframe reads a local file and calls a tool with it | **The design.** The iframe is a real browser context with a real file input.                         |
| URL ingest: the model passes a URL, the Worker fetches it      | **Useful secondary path.** Works for images already on the web, not for anything on the user's disk. |

Everything below follows from that. The upload surface is the app, not the conversation.
The conversation is where images are _read_, not where they are _written_.

**This is the single most important thing to get agreement on before building**, because it
sets the user-facing story: "drag an image into the Isomorphic panel", not "paste an image
to Claude and ask it to file it."

---

## 2. What MCP can carry back to the model

Verified against the spec and the installed SDK (`@modelcontextprotocol/sdk` 1.29.0), not
from memory:

- A tool result's `content` array may contain `{ type: "image", data: <base64>, mimeType }`.
  `ImageContentSchema` is present in the SDK. This is how an image reaches the model.
- `{ type: "audio", ... }` exists with the same shape.
- `{ type: "resource", resource: { uri, mimeType, blob } }` carries arbitrary binary as an
  embedded resource, and `{ type: "resource_link", uri, ... }` carries a reference.

Claude's own image ingestion limits then apply to whatever we return (from the vision docs,
current as of this writing):

- Formats: **JPEG, PNG, GIF, WebP**. Animation is ignored; only the first frame is used.
- **10 MB per image, base64-encoded**, on the Claude API. Max dimensions 8000x8000 px.
- Visual tokens are `ceil(width / 28) * ceil(height / 28)`. Current models cap at a 2576 px
  long edge / 4784 visual tokens and downscale anything larger; older ones cap at 1568 px /
  1568 tokens. A 4K screenshot therefore costs roughly 4784 tokens, about 3x what the same
  image cost a generation ago.
- More than 20 images in one request triggers a stricter per-image dimension limit (resize
  to 2000 px to stay safe).

Consequence for us: an image we hand back is not free, and a brain that returns six
full-resolution screenshots to answer one question has spent ~30k tokens of the user's
context. Size discipline is a product requirement, not an optimization.

---

## 3. What the app iframe can display

The MCP Apps spec mandates a restrictive default CSP for the view:

```
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; media-src 'self' data:; connect-src 'none';
```

So by default the widget can render an image **only** from a `data:` URI. A server may widen
this by declaring `_meta.ui.csp` on the `ui://` resource:

```json
{
	"_meta": {
		"ui": {
			"csp": {
				"connectDomains": ["https://api.example.com"],
				"resourceDomains": ["https://cdn.example.com"]
			}
		}
	}
}
```

Claude documents support for exactly this shape, and states that by default all external
origins are blocked. The spec's rule for hosts is "MAY further restrict but MUST NOT allow
undeclared domains."

That gives two viable display strategies, and the choice is not obvious:

**(a) Inline `data:` URIs.** The app asks the server for an asset's bytes and renders
`<img src="data:image/png;base64,...">`. Works under the default CSP, works for private
repos, works offline against `pnpm try`. Costs payload size on every view.

**(b) Declare `resourceDomains` and load from GitHub.** Cheaper payloads, but a brain repo
is usually **private**, so `raw.githubusercontent.com` will 404 without credentials. The
authenticated form is a short-lived signed `download_url` from the Contents API, which
redirects to a different host than the one you would naturally declare, and expires in
minutes. That is a fragile thing to pin a CSP allowlist to.

**Decision: (a) for v1.** Correct under every deployment (private repos, self-hosters,
local `pnpm try`), no host-specific allowlist, no expiring URLs. Revisit (b) only if payload
size measurably hurts, and only after verifying which host GitHub's signed URLs actually
redirect to.

Two host facts that constrain the UI: on mobile, Claude renders apps in a native WebView
with **no camera access**, so "take a photo" is out; and inline cards are height-capped with
no nested scrolling, so a gallery belongs in fullscreen.

---

## 4. What git can store, and what that costs

The brain is a GitHub repo, so an image is a git blob. Three facts matter:

1. **`createTree` with inline `content` is UTF-8 only.** The repo's entire write path
   (`commitFiles` / `commitOrPR` in `src/lib/brain-repo.ts`) builds tree entries with
   `{ path, mode, type: 'blob', content }`, where `content` is a JS string. Binary cannot go
   through it. Binary requires `createBlob({ encoding: 'base64' })` first, then a tree entry
   referencing the returned `sha`. **This is a real change to the storage seam**, not a
   detail: `FileWrite` grows an encoding, `BrainStore` grows a blob-creating step, and the
   on-disk adapter (`src/local/brain-store-fs.ts`, which currently writes every file with
   `'utf8'`) has to decode base64 to a Buffer.
2. **GitHub's blob API handles up to 100 MB**, and accepts `utf-8` or `base64` encodings. Not
   the binding limit for us.
3. **Git keeps every version forever.** A 4 MB screenshot re-uploaded five times is 20 MB of
   permanent history in a repo the customer owns and clones. There is no `git gc` that
   recovers it. This is the argument for a hard per-file cap and for _not_ generating
   derivative thumbnails into the repo.

The Cloudflare side is not the constraint: incoming request bodies are capped at 100 MB
(Free/Pro), the isolate has 128 MB of memory, and base64 inflates by a third.

**Decision: 5 MiB hard cap per file.** It is ~6.7 MiB base64, comfortably under Claude's
10 MB base64 image ceiling with room for the JSON envelope, modest as a single `tools/call`
body, and defensible as permanent git history. The app should downscale before upload rather
than reject outright, and say so visibly when it does.

**Decision: no thumbnails in the repo.** One blob per image. Any resizing happens in the
browser before upload (canvas), so the repo holds exactly what the user meant to keep.

---

## 5. Where assets live, and what the path policy calls them

`src/lib/brain-policy.ts` already models every path as one of four roles: `content`
(editable pages), `source` (evidence, immutable to our tools), `log`, `system`. An image is
a fifth kind of thing: writable by our tools, but not a page.

Two options were considered. Adding a fifth role `asset` is the tidier model, but it changes
a wire contract the app and Worker share (`pnpm test:policy` pins it), and it forces every
existing brain's config to grow a new prefix before images work.

**Decision: no new role.** Assets live under the existing `content` roots, and are
distinguished by _not_ ending in `.md`. The codebase is already shaped for this: page tools
enforce the `.md` extension at the call site (seven places in `librarian.ts`, plus
`apps.ts:415`), and the content index already filters `e.path.endsWith('.md')`. A new pure
predicate `isAssetPath(path, cfg)` (role is `content`, extension is a known media type, not
a dotfile) sits beside `isContentPath` and carries the distinction.

**Decision: co-locate by default.** An image uploaded while viewing `wiki/vendors/acme.md`
lands at `wiki/vendors/assets/<slug>.<ext>`. The caller may override the path. Co-location
means `move_page` on a folder already carries the folder's images with it, and a portable
OKF reader following `![](assets/foo.png)` resolves it correctly.

**OKF stays intact.** Images are referenced with ordinary markdown image syntax. The page
remains the concept document; the image is an attachment it references. Nothing about
`type:`, page granularity, or reserved names changes.

---

## 6. The one-line change that makes assets first-class in the link graph

This is the integration point most likely to be missed, and the codebase turns out to be
most of the way there already. Read in order:

1. **Extraction already covers images.** `MD_LINK_RE` in `src/lib/wiki.ts:253` is
   `/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g`. The leading `!?` means `![alt](img.png)`
   is captured exactly like `[text](page.md)`, and both land in `brain_links` as raw targets.
2. **Rewriting already covers images.** `rewriteMdLinks` and `rebaseMdLinks` run over the
   same regex, so once they are handed the right target they repoint an image reference
   correctly. Moving a _page_ that displays an image already rebases that image's relative
   href.
3. **Resolution deliberately drops them.** In `loadResolvedGraph`
   (`src/lib/brain-index.ts:529`):

   ```js
   const target = resolveRelative(l.source, l.raw_target);
   if (!target.endsWith('.md')) continue; // asset / non-page — out of scope
   ```

   Someone already thought about this: the filter is what stops today's occasional image or
   PDF link from being reported as a broken link by `validate`. It is the correct behavior
   for a brain with no asset model.

The consequence for this feature is narrow and specific. Because non-`.md` targets never
become edges, **`backlinksTo` returns nothing for an asset**, so:

- `move_page` on an image finds zero inbound linkers and repoints nothing, silently breaking
  every page that displays it, and
- `delete_page` on an image reports "not referenced" and takes the picture off five pages.

**Requirement: admit asset targets into the resolved graph** (as edges to a known asset)
while keeping unknown non-page targets out of `broken`. The existing repointing and
"still referenced" machinery then covers assets with no further change, because points 1 and
2 above already work. This means the index must also know which assets exist, which is the
same question as whether `brain_pages` grows asset rows or a sibling table holds them.

The subtlety to preserve: an image link that resolves to **no** stored asset must stay out
of `broken` unless we are confident we track every asset, or the first brain with a stray
`.pdf` link starts failing `validate`. `pnpm test:index` and `pnpm test:structure` are where
both halves get pinned.

---

## 7. Tool surface

The repo has explicit, documented pressure against growing the tool surface (42 tools down
to 30, with two merges recorded in `CLAUDE.md`). So: **two new tools, two extended.**

| Tool                   | Scope            | Notes                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach_media` (new)   | write, `editor`+ | Takes `path` (optional, defaults to co-located), `data` (base64), `mimeType`, optional `page` to append the reference to. Validates type, size, and dimensions; commits the blob and the page edit as one bundle, the way every other write here lands. |
| `read_media` (new)     | read, `viewer`+  | Returns the asset as an MCP `image` content block for the model, or as a data URI in `structuredContent` for the app. This is the tool the widget calls lazily, once per `<img>` on a page.                                                             |
| `move_page` (extend)   | unchanged        | Accept asset paths; drop the `.md` assertion for that branch. Link repointing already does the right thing once §6 holds.                                                                                                                               |
| `delete_page` (extend) | unchanged        | Same. The "still referenced" heads-up becomes genuinely important here.                                                                                                                                                                                 |

`attach_media` is registered as a normal tool because the AppBridge routes widget calls
through the host's `tools/call`, so an unregistered tool is not callable from the iframe.
Its description should say plainly that it needs file bytes and is normally invoked by the
Isomorphic app, so an agent does not burn a turn trying to synthesize base64. That follows
the description rule already written down for `read_page` vs `view_page`: each tool's
description stands alone and names itself, and cross-tool steering lives in
`SERVER_INSTRUCTIONS`.

**Usage analytics:** every new tool name needs a `TOOL_KINDS` entry, or `pnpm test:usage`
fails by design. `attach_media` is an `edit`; `read_media` is a `read`.

---

## 8. Other content types

The ask says "maybe other content". Split it:

- **Images (JPEG/PNG/GIF/WebP): fully supported.** Stored, displayed, and returned to the
  model as `image` content.
- **Everything else: stored and displayed, not returned to the model in v1.** PDFs are the
  interesting case: the Claude API supports PDF document blocks, but whether _this host_
  turns an MCP embedded `resource` blob into a document block for the model is **not
  verified**, and building on an unverified host behavior is how the SSE-teardown bug
  happened. A PDF should upload, appear in the tree, and be linkable; asking Claude to read
  it can come after someone confirms the host behavior against a known-good client.

---

## 9. Implementation plan

Ordered so each step is independently reviewable and the risky part comes early.

**Phase 0: verify the two unknowns.** Before writing feature code:

- Confirm a sandboxed MCP App iframe in Claude permits `<input type="file">` and drag-drop.
  The spec says views are sandboxed and leaves the exact attributes to the host. If file
  input is blocked, the entire upload path in §1 collapses and the design needs rethinking.
  Test in `pnpm app:dev` first, then in the real host, since those can disagree (see
  ext-apps#671 in `docs/references.md`).
- Confirm the host renders an `image` content block from a tool result and passes it to the
  model. Verify with a stub tool before building storage.

**Phase 1: binary storage.** Extend `FileWrite` and `BrainStore` for base64 writes;
implement `createBlob` + tree-by-sha in `githubStore`; implement Buffer decoding in the
fs adapter. Pure-ish, testable, no UI. Add binary round-trip coverage to the e2e battery
(`scripts/e2e-librarian.ts`) since it already drives real GitHub.

**Phase 2: policy and index.** `isAssetPath`; image links in the link graph; asset entries
in the file tree. Extend `pnpm test:policy` and `pnpm test:index`.

**Phase 3: tools.** `attach_media`, `read_media`, the `move_page`/`delete_page` extensions,
`TOOL_KINDS` entries, and scope coverage in `pnpm test:scope` (write gates on `editor`, read
on `viewer`).

**Phase 4: app.** Drag-and-drop and a file picker in the page view; client-side downscale
with a visible notice; lazy `read_media` per image; asset rows in the file tree. Remember
`pnpm gen:app` or the deployed bundle goes stale silently.

**Phase 5: URL ingest** (optional). A `url` argument on `attach_media` so the Worker fetches
an image the model found on the web. Needs an egress allowlist decision and a size guard
before the fetch, not after.

---

## 10. Explicitly not built

- Thumbnails, derivatives, or any image processing server-side (§4).
- Git LFS. It moves bytes outside the tree, so a plain clone stops being the whole brain,
  which is the thing this product sells.
- Returning PDFs or other documents to the model (§8).
- Camera capture (no camera in the mobile WebView, per Claude's design guidelines).
- Search over image content, OCR, or any derived text.
- A per-brain storage quota. Worth adding as a `validate` advisory once real usage exists.

---

## 11. Open questions for the owner

1. **Is the app-only upload path acceptable as the product story?** It is a real constraint,
   not a shortcut, but it means "Claude, save this screenshot to the brain" will not work,
   and that is the phrasing a user will try first. The mitigation is a good error message
   from `attach_media` pointing at the panel.
2. **5 MiB cap, or lower?** Permanent git history argues for lower; screenshots of dense
   dashboards argue for higher.
3. **Should `validate` gain an advisory for orphaned assets** (an image no page references)?
   It fits the existing pattern of advisory-only structure notes.
