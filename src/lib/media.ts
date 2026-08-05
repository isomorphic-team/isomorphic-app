// Media attachments: the pure layer. What counts as an attachment, what it may
// weigh, what Claude can actually look at, and where an upload lands by default.
//
// No octokit, no D1, no `node:*` — both bundles import this. The Worker uses it to
// validate an upload before it becomes a commit; the app uses it to decide whether a
// markdown image link points at something it should render inline.
//
// See docs/design/media-attachments.md. The two constraints worth restating here,
// because they are the reason for every number below:
//
//   1. The model cannot hand us bytes. Uploads originate in the app iframe, so the
//      size limits are really limits on one `tools/call` payload, not on a stream.
//   2. Git keeps every version forever, in a repo the customer clones. An attachment
//      is not a cache entry; it is permanent history.

// Extension -> MIME. The registry is deliberately small: an allowlist, so an upload
// of an unknown or executable type is refused rather than stored and served back.
const MEDIA_TYPES: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf'
};

// What Claude itself can ingest as an image, per the vision docs. SVG is absent on
// purpose: it renders in the app but is not an accepted image type on the API, and
// PDF is a document rather than an image. Anything not in here is stored and shown,
// never returned to the model as image content.
const MODEL_VIEWABLE: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp'
]);

// 5 MiB. Sized from three ceilings at once, the tightest of which is the third:
//   - Claude accepts 10 MB of base64 per image; 5 MiB raw is ~6.7 MiB encoded, which
//     leaves room for the JSON envelope around it.
//   - One tools/call body has to carry it through the host and the Worker.
//   - It lands in git forever. A brain that accumulates 50 MB of screenshots has made
//     every future clone slower for everyone in the org, and no `git gc` undoes it.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// The extension of `path`, lowercased, without the dot. '' when there is none.
function extensionOf(path: string): string {
	const name = path.split('/').pop() ?? '';
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// The MIME type this path claims by its extension, or undefined if it is not a
// recognized attachment type. Extension-based on purpose: the repo is the source of
// truth and a git blob carries no content type, so the filename is all a later reader
// (ours, github.com, or an outside OKF consumer) has to go on.
export function mediaTypeOf(path: string): string | undefined {
	return MEDIA_TYPES[extensionOf(path)];
}

export function isMediaPath(path: string): boolean {
	return mediaTypeOf(path) !== undefined;
}

// Can this be handed to the model as an `image` content block?
export function isModelViewable(mimeType: string): boolean {
	return MODEL_VIEWABLE.has(mimeType);
}

// Decoded byte length of a base64 string, without decoding it. Used to reject an
// oversized upload BEFORE it is turned into a Uint8Array, so a 60 MB paste costs a
// string length check rather than 60 MB of isolate memory (the Worker has 128 MB).
export function base64Bytes(b64: string): number {
	const clean = b64.replace(/[\r\n]/g, '');
	if (clean.length === 0) return 0;
	const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
	return Math.floor((clean.length * 3) / 4) - padding;
}

// Standard base64, optional padding, nothing else. A malformed payload is a client
// bug and should say so here rather than commit garbage that renders as a broken
// image forever.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function isValidBase64(b64: string): boolean {
	const clean = b64.replace(/[\r\n]/g, '');
	return clean.length > 0 && clean.length % 4 === 0 && BASE64_RE.test(clean);
}

// Everything that must be true before an upload becomes a commit. Returns a
// human-readable reason, or null when the attachment is acceptable.
//
// The declared `mimeType` must agree with the path's extension. It would be easier to
// trust one and ignore the other, but they are read by different consumers later (the
// extension by every git client, the MIME by the app and the model), and letting them
// disagree is how a `.png` that is really a PDF ends up failing at display time with
// no explanation.
export function validateAttachment(input: {
	path: string;
	mimeType: string;
	data: string;
}): string | null {
	const declared = mediaTypeOf(input.path);
	if (!declared) {
		const known = [...new Set(Object.values(MEDIA_TYPES))].sort().join(', ');
		return `"${input.path}" is not a supported attachment type. Supported: ${known}.`;
	}
	if (declared !== input.mimeType) {
		return `"${input.path}" looks like ${declared} but was uploaded as ${input.mimeType}. Rename the file or fix the type so they agree.`;
	}
	if (!isValidBase64(input.data)) {
		return 'Attachment data is not valid base64.';
	}
	const bytes = base64Bytes(input.data);
	if (bytes === 0) return 'Attachment is empty.';
	if (bytes > MAX_ATTACHMENT_BYTES) {
		return `Attachment is ${formatBytes(bytes)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit. Resize or compress it first — every version of it stays in the brain's git history permanently.`;
	}
	return null;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A filename safe to put in a git tree and in a markdown link: lowercased, spaces and
// punctuation collapsed to dashes, extension preserved. Mirrors `slugify` in wiki.ts
// so an attachment and a page derived from the same title agree.
export function attachmentSlug(filename: string): string {
	const ext = extensionOf(filename);
	const base = ext ? filename.slice(0, filename.length - ext.length - 1) : filename;
	const slug =
		base
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80) || 'attachment';
	return ext ? `${slug}.${ext}` : slug;
}

// Where an attachment lands when the caller does not name a path: an `assets/` folder
// beside the page that references it.
//
// Co-located rather than one brain-wide `assets/` tree, because move_page on a FOLDER
// already moves everything under it — so a section of the brain keeps its pictures
// when it gets reorganized, and a plain markdown reader following `assets/foo.png`
// resolves it with no knowledge of our conventions.
export const ASSETS_DIR = 'assets';

export function defaultAttachmentPath(pagePath: string, filename: string): string {
	const dir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')) : '';
	const name = attachmentSlug(filename);
	return dir ? `${dir}/${ASSETS_DIR}/${name}` : `${ASSETS_DIR}/${name}`;
}

// The markdown to insert into a page so the attachment shows up. Ordinary image
// syntax, relative to the referencing page: nothing here is an Isomorphic extension,
// so the page still renders correctly on github.com and in any OKF reader.
export function attachmentMarkdown(pagePath: string, assetPath: string, alt: string): string {
	return `![${alt.replace(/[[\]]/g, '')}](${relativeAssetHref(pagePath, assetPath)})`;
}

// The shortest relative href from a page to an asset. Kept here rather than reusing
// wiki.ts's relativeHref so the app can compute it without pulling in the page layer.
export function relativeAssetHref(fromPath: string, assetPath: string): string {
	const from = fromPath.split('/').slice(0, -1);
	const to = assetPath.split('/');
	const file = to.pop()!;
	let i = 0;
	while (i < from.length && i < to.length && from[i] === to[i]) i++;
	const up = from.slice(i).map(() => '..');
	const down = to.slice(i);
	const parts = [...up, ...down, file];
	// A sibling path has to start with "./" or markdown readers treat it as a bare word.
	return up.length === 0 ? `./${parts.join('/')}` : parts.join('/');
}
