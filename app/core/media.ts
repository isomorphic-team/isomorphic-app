// Attachments in the app: getting stored images onto the screen, and getting a
// dropped file ready to upload.
//
// Two jobs, both shaped by constraints that live outside this file:
//
// 1. RENDERING. The iframe's CSP is `img-src 'self' data:` by default, and a brain
//    repo is usually private, so there is no URL we could point an <img> at. Images
//    therefore arrive as data URIs through read_media, one call per image, after the
//    markdown is already on the page. See docs/design/media-attachments.md §3.
//
// 2. UPLOADING. This is the ONLY place bytes can enter a brain: the model cannot
//    supply them (it sees images as visual tokens, not base64), so the file input and
//    the drop target in the app are the entire upload surface for the product.
//
// The size caps and the type allowlist come from src/lib/media.ts, shared with the
// Worker, so the app never offers an upload the server will refuse.

import { resolveRelative } from '../../src/lib/wiki.ts';
import { MAX_ATTACHMENT_BYTES, formatBytes, mediaTypeOf } from '../../src/lib/media.ts';
import { callTool, firstText } from './host.ts';
import { brainArgs } from './store.ts';

// Longest edge we upload. Matches the resolution tier current Claude models accept
// before they downscale server-side anyway, so going above it costs bytes in git and
// tokens in every future read while adding nothing the model can see.
const MAX_EDGE = 2576;

// Formats a canvas can re-encode. GIF is excluded because re-encoding drops the
// animation, and SVG/PDF because they are not raster at all — an oversized one of
// those is refused rather than silently flattened.
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

// path -> data URI. Navigating back to a page must not re-fetch every picture on it,
// and the same image on several pages is fetched once. Bounded by how many distinct
// attachments one session opens, which is small.
const assetCache = new Map<string, string>();
// In-flight requests, so a page with the same image twice makes one call.
const inflight = new Map<string, Promise<string | null>>();

async function loadAsset(repoPath: string): Promise<string | null> {
	const cached = assetCache.get(repoPath);
	if (cached) return cached;
	const running = inflight.get(repoPath);
	if (running) return running;

	const p = (async () => {
		try {
			const res = await callTool('read_media', { path: repoPath, ...brainArgs() });
			if (res.isError) return null;
			const sc = (res.structuredContent ?? {}) as { dataUri?: string };
			if (typeof sc.dataUri !== 'string') return null;
			assetCache.set(repoPath, sc.dataUri);
			return sc.dataUri;
		} catch {
			return null;
		} finally {
			inflight.delete(repoPath);
		}
	})();
	inflight.set(repoPath, p);
	return p;
}

// Swap every relative <img> in freshly rendered markdown for its bytes.
//
// Runs AFTER render rather than rewriting the markdown first, because the alternative
// is resolving and fetching every image before any text appears — a page with six
// screenshots would show nothing until the last one arrived. This way the prose is
// immediate and the pictures fill in.
async function hydrateImages(root: HTMLElement, pagePath: string): Promise<void> {
	const imgs = Array.from(root.querySelectorAll('img'));
	await Promise.all(
		imgs.map(async (img) => {
			const src = img.getAttribute('src') ?? '';
			// Absolute URLs are left alone: the CSP will refuse them, and silently
			// rewriting someone's link to a CDN would be a surprise, not a fix.
			if (!src || /^(data:|https?:|blob:)/i.test(src)) return;
			const repoPath = resolveRelative(pagePath, src);
			if (!mediaTypeOf(repoPath)) return;

			img.setAttribute('data-asset-path', repoPath);
			img.classList.add('asset-loading');
			const dataUri = await loadAsset(repoPath);
			img.classList.remove('asset-loading');
			if (dataUri) {
				img.setAttribute('src', dataUri);
			} else {
				// Never leave a broken-image glyph: say which file is missing, since the
				// most likely cause is a link to something that was moved or never
				// uploaded, and the filename is the only useful clue.
				img.classList.add('asset-missing');
				img.setAttribute('alt', `Missing attachment: ${repoPath}`);
				img.setAttribute('title', `Missing attachment: ${repoPath}`);
			}
		})
	);
}

// Drop a page's images from the cache, so a re-render after an edit re-fetches.
function forgetAssets(prefix?: string): void {
	if (!prefix) {
		assetCache.clear();
		return;
	}
	for (const key of [...assetCache.keys()]) if (key.startsWith(prefix)) assetCache.delete(key);
}

interface Prepared {
	data: string; // base64, no data: prefix
	filename: string;
	mimeType: string;
	bytes: number;
	// Set when the file was scaled down on the way out, so the UI can say so. Silently
	// altering someone's file and not mentioning it is the kind of thing people only
	// discover much later, when the detail they needed is gone.
	note?: string;
}

function base64FromDataUrl(dataUrl: string): string {
	const comma = dataUrl.indexOf(',');
	return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result));
		fr.onerror = () => reject(fr.error ?? new Error('Could not read the file.'));
		fr.readAsDataURL(blob);
	});
}

// Scale a raster image so its longest edge is at most MAX_EDGE, re-encoding to the
// SAME mime type — changing the type would break the extension/mime agreement the
// server enforces, and would mean the stored filename lied about its contents.
async function downscale(file: File, mimeType: string): Promise<Blob | null> {
	try {
		const bitmap = await createImageBitmap(file);
		const longest = Math.max(bitmap.width, bitmap.height);
		const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, w, h);
		bitmap.close?.();
		// Quality only applies to lossy types; PNG ignores it.
		const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, mimeType, 0.9));
		return blob;
	} catch {
		return null;
	}
}

// Turn a dropped or picked file into something attach_media will accept, or explain
// why it will not. Returning the reason as a string (rather than throwing) keeps the
// caller's error handling to one branch.
async function prepareUpload(file: File): Promise<Prepared | { error: string }> {
	const filename = file.name || 'attachment';
	// Trust the extension over the browser's reported type: the extension is what the
	// server validates against and what every later reader of the repo will see.
	const mimeType = mediaTypeOf(filename);
	if (!mimeType) {
		return { error: `${filename} is not a file type this brain accepts.` };
	}

	let blob: Blob = file;
	let note: string | undefined;

	if (RESIZABLE.has(mimeType)) {
		const bitmap = await createImageBitmap(file).catch(() => null);
		const tooWide = bitmap ? Math.max(bitmap.width, bitmap.height) > MAX_EDGE : false;
		bitmap?.close?.();
		if (tooWide || file.size > MAX_ATTACHMENT_BYTES) {
			const shrunk = await downscale(file, mimeType);
			if (shrunk && shrunk.size < file.size) {
				note = `Resized from ${formatBytes(file.size)} to ${formatBytes(shrunk.size)} before saving.`;
				blob = shrunk;
			}
		}
	}

	if (blob.size > MAX_ATTACHMENT_BYTES) {
		return {
			error: `${filename} is ${formatBytes(blob.size)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit. Every version of an attachment stays in the brain's history permanently, so large files are refused rather than stored.`
		};
	}

	const data = base64FromDataUrl(await readAsDataUrl(blob));
	return { data, filename, mimeType, bytes: blob.size, note };
}

// Upload one prepared file and attach it to a page. Returns the message the server
// gave us, so the caller can surface the real outcome (including "proposed" when the
// brain writes through pull requests) rather than inventing a success string.
async function attachToPage(
	pagePath: string,
	prepared: Prepared,
	alt?: string
): Promise<{ ok: boolean; message: string }> {
	const res = await callTool('attach_media', {
		page: pagePath,
		filename: prepared.filename,
		mime_type: prepared.mimeType,
		data: prepared.data,
		...(alt ? { alt } : {}),
		...brainArgs()
	});
	return { ok: !res.isError, message: firstText(res) };
}

export {
	MAX_EDGE,
	attachToPage,
	forgetAssets,
	hydrateImages,
	loadAsset,
	prepareUpload,
	type Prepared
};
