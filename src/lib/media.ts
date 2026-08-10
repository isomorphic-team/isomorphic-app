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

import { relativeHref } from './wiki.ts';

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
//
// Trimmed first: a filename arriving from a browser file picker can carry trailing
// whitespace, and without the trim `"shot.png "` yields the extension `"png "`, which
// matches nothing in the registry and rejects a perfectly good upload.
//
// `dot <= 0` rather than `dot < 0`, so a dotfile like `.gitkeep` has NO extension
// rather than an extension of "gitkeep". Every caller depends on that one rule, which
// is why this is the only place it is written down.
function extensionOf(path: string): string {
	const name = (path.split('/').pop() ?? '').trim();
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
	const trimmed = filename.trim();
	const ext = extensionOf(trimmed);
	// A degenerate name like ".png" has no extension by the dotfile rule above, so it
	// slugs to "png" and then fails validateAttachment for having no supported type.
	// That is the intended outcome: better to tell the uploader to name the file than
	// to invent a name and store bytes under something they never chose.
	const base = ext ? trimmed.slice(0, trimmed.length - ext.length - 1) : trimmed;
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

// How many numbered variants of one filename we will try before giving up.
const MAX_ATTACHMENT_VARIANTS = 50;

// A path nothing occupies yet: `logo.png` -> `logo-2.png` -> `logo-3.png`.
//
// Storing an attachment used to overwrite whatever already sat at the path, silently.
// Two screenshots pasted a moment apart, or two people attaching `diagram.png` to the
// same page, meant the first file was gone — and because every page linking to it kept
// linking to the same path, those pages quietly started showing the OTHER picture.
// Nothing in the transcript said so.
//
// The caller cannot prevent this: only the repo knows what is already there. So the
// server picks the free name and REPORTS it back, and the app corrects the link it
// optimistically inserted. Returns '' when even the variants are taken, which the
// tool turns into a plain refusal rather than a silent clobber.
export function uniqueAttachmentPath(target: string, taken: (path: string) => boolean): string {
	if (!taken(target)) return target;
	const slash = target.lastIndexOf('/');
	const dir = slash >= 0 ? target.slice(0, slash + 1) : '';
	const name = target.slice(slash + 1);
	// Leading dot = a dotfile, not an extension (same rule as extensionOf above).
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let n = 2; n <= MAX_ATTACHMENT_VARIANTS; n++) {
		const candidate = `${dir}${stem}-${n}${ext}`;
		if (!taken(candidate)) return candidate;
	}
	return '';
}

// The markdown to insert into a page so the attachment shows up. Ordinary image
// syntax, relative to the referencing page: nothing here is an Isomorphic extension,
// so the page still renders correctly on github.com and in any OKF reader.
//
// The href comes from wiki.ts's relativeHref rather than a local implementation, and
// that is load-bearing rather than tidiness. move_page repoints links through
// rewriteMdLinks, which uses relativeHref; a second function here that formatted the
// same path differently (a leading "./", say) meant a link silently changed shape the
// first time its image was moved. The e2e round trip caught exactly that.
export function attachmentMarkdown(pagePath: string, assetPath: string, alt: string): string {
	const label = alt.replace(/[[\]]/g, '');
	const href = relativeHref(pagePath, assetPath);
	// Images embed; anything else links. A PDF written as `![](…)` renders as a broken
	// image in every markdown reader there is, including github.com — the embed syntax
	// is not a generic "attachment" marker, it means "show this picture here".
	return isEmbeddable(assetPath) ? `![${label}](${href})` : `[${label}](${href})`;
}

// Can this be shown inline on a page? Every image type, including SVG (which renders
// fine in an <img>) and GIF. Distinct from isModelViewable, which is the narrower
// question of what Claude can ingest.
export function isEmbeddable(path: string): boolean {
	return (mediaTypeOf(path) ?? '').startsWith('image/');
}

// ---------------------------------------------------------------------------
// URL ingest: the one path by which a MODEL can attach a file.
//
// The rest of this file assumes bytes originate in the app, because a model shown an
// image holds visual tokens rather than base64. A URL is the exception: the model
// names a location, the server does the downloading, and the bytes never pass through
// the model's output. Issue #20 is what this answers.
//
// Fetching a caller-supplied URL from the server makes the Worker a fetch client for
// anyone with `editor` on a brain, so the guards below are the security boundary, not
// hygiene. Their honest limit: they check the URL, and a public hostname that resolves
// to a private address defeats a hostname check. Cloudflare's fetch egresses to the
// public internet rather than into any network of ours, and the local runtime binds to
// loopback, so that residual case reaches nothing either deployment owns.
// ---------------------------------------------------------------------------

// Type -> canonical extension, inverted from MEDIA_TYPES with first-wins, so
// image/jpeg yields `jpg` and neither map can drift from the other.
const EXTENSION_FOR_TYPE: Readonly<Record<string, string>> = (() => {
	const out: Record<string, string> = {};
	for (const [ext, type] of Object.entries(MEDIA_TYPES)) if (!(type in out)) out[type] = ext;
	return out;
})();

export function extensionForType(mimeType: string): string | undefined {
	return EXTENSION_FOR_TYPE[mimeType];
}

// A Content-Type header reduced to a bare type: parameters dropped, lowercased, and
// `image/jpg` folded onto `image/jpeg` (not a registered type, but widely served).
export function normalizeContentType(header: string | null | undefined): string {
	const bare = (header ?? '').split(';')[0].trim().toLowerCase();
	return bare === 'image/jpg' ? 'image/jpeg' : bare;
}

// Hostnames that name something local no matter what they resolve to.
const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
	'localhost',
	'metadata',
	'metadata.google.internal',
	'instance-data'
]);

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

function isPrivateIPv4(host: string): boolean {
	const parts = host.split('.');
	if (parts.length !== 4) return false;
	const n = parts.map((p) => Number(p));
	if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
	const [a, b] = n;
	return (
		a === 0 || // this network
		a === 10 || // private
		a === 127 || // loopback
		(a === 169 && b === 254) || // link-local, incl. cloud metadata at 169.254.169.254
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) || // private
		(a === 192 && b === 0) || // protocol assignments
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast and reserved
	);
}

// An IPv6 address as its eight 16-bit groups, or null if it is not one. Expanded
// rather than pattern-matched because the URL parser rewrites what it is given:
// `[::ffff:127.0.0.1]` arrives as `[::ffff:7f00:1]`, so matching on the dotted form
// would miss the mapped-loopback spelling entirely.
function ipv6Groups(raw: string): number[] | null {
	let text = raw.replace(/^\[|\]$/g, '').toLowerCase();
	if (!text.includes(':')) return null;
	// A trailing dotted quad is the low 32 bits written the other way round.
	const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (dotted) {
		const p = dotted[1].split('.').map(Number);
		if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		const hi = ((p[0] << 8) | p[1]).toString(16);
		const lo = ((p[2] << 8) | p[3]).toString(16);
		text = `${text.slice(0, dotted.index)}${hi}:${lo}`;
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const toGroups = (s: string) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
	const head = toGroups(halves[0]);
	const tail = halves.length === 2 ? toGroups(halves[1]) : [];
	const groups =
		halves.length === 2
			? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
			: head;
	if (groups.length !== 8) return null;
	if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
	return groups;
}

function isPrivateIPv6(host: string): boolean {
	const g = ipv6Groups(host);
	if (!g) return false;
	if (g.every((x) => x === 0)) return true; // :: unspecified
	if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
	// IPv4-mapped (::ffff:a.b.c.d) is an IPv4 destination wearing IPv6 syntax, so it
	// gets the IPv4 ranges rather than a second copy of them.
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
		return isPrivateIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.'));
	}
	if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	return false;
}

// Why this URL cannot be fetched, or null when it can be. Split out from the fetch so
// every redirect hop is checked by the same rule the original URL was.
export function fetchUrlProblem(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return `"${raw}" is not a valid URL. Give a full https:// address.`;
	}
	if (url.protocol !== 'https:') {
		return `Attachments can only be fetched over https, and "${raw}" is ${url.protocol.replace(':', '')}.`;
	}
	if (url.username || url.password) {
		return 'The URL carries credentials. Attachments are fetched from public URLs only.';
	}
	// The WHATWG parser normalizes decimal, octal, and hex IPv4 forms to dotted quads,
	// so http://2130706433/ arrives here as 127.0.0.1 and the range check below sees it.
	const host = url.hostname.toLowerCase();
	if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
		return `"${host}" is a local address. Attachments are fetched from public URLs only.`;
	}
	if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
		return `"${host}" is a private address. Attachments are fetched from public URLs only.`;
	}
	return null;
}

// The filename a URL implies: its last path segment, percent-decoded. '' when the path
// names no file, in which case the caller derives a name from the served type.
export function filenameFromUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return '';
	}
	const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
	try {
		return decodeURIComponent(last).trim();
	} catch {
		return last.trim();
	}
}

// Base64 without Buffer (Worker) and without blowing the argument limit: 32 KiB of
// char codes per spread, which a 5 MiB file crosses 160 times.
export function base64FromBytes(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export interface FetchedAttachment {
	data: string; // base64, no data: prefix
	bytes: number;
	mimeType: string;
	filename: string;
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

// Read a response body, stopping the moment it exceeds `limit`. Content-Length is
// checked first because an honest server saves the download entirely, but a header is
// a claim: this is the check that holds when the claim is absent or false.
async function readCapped(res: Response, limit: number): Promise<Uint8Array | { error: string }> {
	const tooBig = {
		error: `The file is larger than the ${formatBytes(limit)} limit. Resize or compress it first, or attach a smaller version.`
	};
	if (!res.body) {
		const buf = new Uint8Array(await res.arrayBuffer());
		return buf.byteLength > limit ? tooBig : buf;
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return tooBig;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

// Download an attachment the caller named by URL. Redirects are followed by hand so
// that each hop passes fetchUrlProblem: `redirect: 'follow'` would validate the first
// URL and then let a 302 point anywhere.
//
// `fetchImpl` is injectable so the golden test can drive every branch without network.
export async function fetchRemoteAttachment(
	raw: string,
	opts: { filename?: string; fetchImpl?: typeof fetch } = {}
): Promise<FetchedAttachment | { error: string }> {
	const doFetch = opts.fetchImpl ?? fetch;
	let current = raw.trim();
	let res: Response | undefined;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const problem = fetchUrlProblem(current);
		if (problem) return { error: problem };
		let hopRes: Response;
		try {
			hopRes = await doFetch(current, {
				redirect: 'manual',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { accept: 'image/*,application/pdf' }
			});
		} catch (e) {
			return { error: `Could not fetch ${current}: ${e instanceof Error ? e.message : String(e)}` };
		}
		if (hopRes.status >= 300 && hopRes.status < 400) {
			const location = hopRes.headers.get('location');
			if (!location) return { error: `${current} redirected without saying where.` };
			try {
				current = new URL(location, current).toString();
			} catch {
				return { error: `${current} redirected to something that is not a URL.` };
			}
			continue;
		}
		res = hopRes;
		break;
	}
	if (!res) return { error: `${raw} redirected more than ${MAX_REDIRECTS} times.` };
	if (!res.ok) {
		return {
			error: `Fetching ${raw} returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`
		};
	}

	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
		return {
			error: `${raw} is ${formatBytes(declared)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit. Resize or compress it first, or attach a smaller version.`
		};
	}

	const body = await readCapped(res, MAX_ATTACHMENT_BYTES);
	if ('error' in body) return body;
	if (body.byteLength === 0) return { error: `${raw} returned an empty file.` };

	// The served type and the name have to agree, the same rule validateAttachment
	// applies to an upload. A URL that answers with an HTML login wall or error page is
	// the common case this catches, and it catches it before anything is committed.
	const served = normalizeContentType(res.headers.get('content-type'));
	let filename = (opts.filename ?? '').trim() || filenameFromUrl(current);
	let mimeType = mediaTypeOf(filename) ?? '';

	if (!mimeType) {
		const ext = served ? extensionForType(served) : undefined;
		if (!ext) {
			const what = served ? `is served as ${served}` : 'does not say what type it is';
			return {
				error: `${raw} ${what} and its name gives no usable extension, so there is nothing to store it as. Supported: ${[...new Set(Object.values(MEDIA_TYPES))].sort().join(', ')}.`
			};
		}
		filename = `${filename || 'attachment'}.${ext}`;
		mimeType = served;
	} else if (served && served !== mimeType) {
		return {
			error: `${raw} is served as ${served} but is named like ${mimeType}. Pass an explicit \`path\` with the right extension if the server is mislabelling it.`
		};
	}

	return { data: base64FromBytes(body), bytes: body.byteLength, mimeType, filename };
}
