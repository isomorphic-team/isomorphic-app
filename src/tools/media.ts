// attach_media and read_media: putting files into a brain, and getting them back
// out: to the app as a data URI, to the model as an image it can actually look at.
//
// Read docs/design/media-attachments.md before changing either of these. The one
// thing that shapes the whole surface: THE MODEL CANNOT HAND US BYTES. Tool arguments
// are JSON produced by the model, and a model shown an image holds visual tokens, not
// base64 — it cannot reproduce a file it was never given as text, and no host passes a
// conversation attachment into a tool call. So `data` is filled in by the Isomorphic
// app (a real browser context with a real file input), and the description says so, or
// an agent burns a turn trying to synthesize a PNG.
//
// `url` is the way out of that for a model, and the only one: it names a location and
// the server does the downloading, so the bytes never cross the model's output at all.
// It does not replace the app path, which still owns every file that exists only on
// someone's disk.
//
// Only two tools: move/delete are handled by the EXISTING move_page / delete_page
// rather than gaining media twins, to keep the tool surface small. Those two already
// do the right thing for an attachment, since the index records links to files.

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { landed } from './librarian.ts';
import type { TenantOpts } from '../lib/orgs.ts';
import { isContentPath, isSourcePath, isToolMaintained, logPathOf } from '../lib/brain-policy.ts';
import { insertLogEntry, todayIso } from '../lib/wiki.ts';
import { commitOpts } from '../lib/change-record.ts';
import {
	MAX_ATTACHMENT_BYTES,
	attachmentMarkdown,
	base64Bytes,
	defaultAttachmentPath,
	fetchRemoteAttachment,
	formatBytes,
	isModelViewable,
	isTextExtractable,
	mediaTypeOf,
	uniqueAttachmentPath,
	validateAttachment
} from '../lib/media.ts';
import { brainArg, fail } from './shared.ts';
import type { ReadMediaWire } from '../lib/tool-payloads.ts';
import { issueAssetLink, type AssetLinkIssuer } from '../lib/asset-link.ts';
import { extractDocumentText, parsePartRange, sliceDocument } from '../lib/document-text.ts';
import { toolAnnotations } from '../lib/tool-annotations.ts';

// Strip a `data:` URL wrapper if a caller sends one. The app reads files with
// FileReader, whose readAsDataURL output is the most likely thing to arrive by
// accident, and silently storing the prefix would produce a file that is corrupt in a
// way nobody can see until it fails to render.
function stripDataUrl(data: string): string {
	const m = /^data:[^;,]*(;base64)?,/.exec(data);
	return m ? data.slice(m[0].length) : data;
}

function normalizePath(path: string): string {
	return path.trim().replace(/^\/+/, '');
}

export interface MediaToolOptions {
	// Where signed download links come from, or undefined when this deployment has no
	// public origin or no secret to sign with. read_media still works without them.
	assetLinks?: () => Promise<AssetLinkIssuer | undefined>;
	// Unix seconds. Tests pin it.
	now?: () => number;
}

export function registerMediaTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	options: MediaToolOptions = {}
) {
	const nowSeconds = options.now ?? (() => Math.floor(Date.now() / 1000));
	// ---------- attach_media ----------
	server.registerTool(
		'attach_media',
		{
			...toolAnnotations('Attach a file to the brain', 'additive'),
			description:
				// Self-naming and explicit about which argument belongs to whom, for the
				// same reason read_page's description is verbose: an agent that goes
				// looking for this tool needs to learn from the description alone which
				// half of it it can actually call, rather than trying and failing.
				'attach_media stores a file (an image, a PDF) in the brain and optionally adds it to a page. There are two ways to supply the file and only one of them is yours. Pass `url` and the server downloads the file itself: that is how YOU attach something, and it works for anything reachable at a public https address (a diagram, a photo, a PDF), including pages your own sandbox cannot reach. `data` takes raw base64 and is supplied by the Isomorphic app when someone drops a file into the panel, NOT by you: you cannot produce it from an image in the conversation, because you can see that image but do not have its bytes. So if the file is one the user attached to the chat, or one you produced yourself with no public URL, tell them to drop it into the Isomorphic panel instead.',
			inputSchema: z.object({
				url: z
					.string()
					.optional()
					.describe(
						'Public https URL to download the file from. The server fetches it, so you never handle the bytes. Use this one.'
					),
				data: z
					.string()
					.optional()
					.describe(
						'The file\'s bytes, base64-encoded (no "data:" prefix). Supplied by the app, not by the model. Give this or `url`, not both.'
					),
				filename: z
					.string()
					.optional()
					.describe(
						'Filename used to derive the stored name and the file type. Required with `data`; with `url` it defaults to the name in the URL.'
					),
				mime_type: z
					.string()
					.optional()
					.describe(
						'The file\'s MIME type, e.g. "image/png". Must agree with the extension. Required with `data`; with `url` it comes from the response.'
					),
				page: z
					.string()
					.optional()
					.describe(
						'Page to attach it to, e.g. "wiki/vendors/acme.md". The file lands in an assets/ folder beside that page and a markdown image link is appended to it.'
					),
				path: z
					.string()
					.optional()
					.describe(
						'Explicit destination path for the file, overriding the default placement beside `page`.'
					),
				alt: z
					.string()
					.optional()
					.describe('Alt text for the inserted image link. Defaults to the filename.'),
				brain: brainArg
			})
		},
		async ({ url, data, filename, mime_type, page, path, alt, brain }) => {
			const ctx = await getContext({ requires: 'editor', brain });
			const { store, repoArgs, config, author } = ctx;

			if (!page && !path) {
				return fail('Give a `page` to attach the file to, or an explicit `path` to store it at.');
			}
			const pagePath = page ? normalizePath(page) : '';
			if (pagePath && !pagePath.endsWith('.md')) {
				return fail(`"${pagePath}" is not a page. Pass a path ending in .md, or use \`path\`.`);
			}

			// Resolve the bytes before the destination, because with `url` the filename
			// (and so the default path, and so the collision check) comes from what the
			// server downloaded rather than from anything the caller said.
			if (!url && !data) {
				return fail("Give a `url` for the server to fetch, or `data` with the file's bytes.");
			}
			if (url && data) {
				return fail('Give either `url` or `data`, not both.');
			}

			let name = (filename ?? '').trim();
			let mime = (mime_type ?? '').trim();
			let clean: string;

			if (url) {
				// The editor gate above has already run, so this fetch is never anonymous.
				const fetched = await fetchRemoteAttachment(url, { filename: name });
				if ('error' in fetched) return fail(fetched.error);
				clean = fetched.data;
				name = fetched.filename;
				mime = mime || fetched.mimeType;
			} else {
				if (!name) {
					return fail('Give a `filename` so the file can be named and typed.');
				}
				if (!mime) {
					return fail("Give a `mime_type` that agrees with the filename's extension.");
				}
				clean = stripDataUrl(data ?? '').trim();
			}

			const desired = normalizePath(
				path ? path : defaultAttachmentPath(pagePath, name || 'attachment')
			);

			// Same three guards every write tool applies, in the same order, so an
			// attachment cannot reach somewhere a page could not.
			if (isSourcePath(desired, config))
				return fail(`"${desired}" is source material — it can't be written to.`);
			if (isToolMaintained(desired, config))
				return fail(`"${desired}" is maintained automatically.`);
			if (!isContentPath(desired, config))
				return fail(`"${desired}" is outside this brain's editable content.`);

			// Never write over a file that is already there. One tree read rather than a
			// blob read: existence is all this needs, and readBinary would pull down the
			// whole of whatever it collided with.
			const head = await store.writeHead(repoArgs, config);
			const taken = new Set(
				(await store.listTree(repoArgs, head, { extension: '*' })).map((e) => e.path)
			);
			const target = uniqueAttachmentPath(desired, (p) => taken.has(p));
			if (!target)
				return fail(
					`"${desired}" already exists, and so does every numbered variant of it. Give an explicit \`path\` with a different name.`
				);

			const problem = validateAttachment({ path: target, mimeType: mime, data: clean });
			if (problem) return fail(problem);

			const bytes = base64Bytes(clean);
			const writes: { path: string; content: string; encoding?: 'utf-8' | 'base64' }[] = [
				{ path: target, content: clean, encoding: 'base64' }
			];

			// Attaching to a page means appending the link to it, in the same commit as
			// the file. Two commits would leave a window where the brain holds an image
			// nothing references, which is exactly what an orphan-sweeper would delete.
			let appendedTo = '';
			if (pagePath) {
				const existing = await store.readFile(repoArgs, pagePath, head.commitSha);
				if (!existing) return fail(`No page at "${pagePath}".`);
				const link = attachmentMarkdown(pagePath, target, alt?.trim() || name);
				const body = existing.content.endsWith('\n')
					? `${existing.content}\n${link}\n`
					: `${existing.content}\n\n${link}\n`;
				writes.push({ path: pagePath, content: body });
				appendedTo = pagePath;
			}

			const today = todayIso();
			const log = await store.readFile(repoArgs, logPathOf(config), head.commitSha);
			if (log) {
				writes.push({
					path: logPathOf(config),
					content: insertLogEntry(
						log.content,
						today,
						`Attached \`${target}\`${appendedTo ? ` to "${appendedTo}"` : ''}.`
					)
				});
			}

			const outcome = await store.commitOrPR(repoArgs, {
				...commitOpts(config, author),
				message: `Attach ${target}${appendedTo ? ` to ${appendedTo}` : ''}\n\n${formatBytes(bytes)} ${mime}${url ? `, fetched from ${url}` : ''}. Logged in the same change.`,
				writes,
				head,
				branchPrefix: 'isomorphic/attach',
				prTitle: `Attach ${target}`,
				prBody: `Add \`${target}\` (${formatBytes(bytes)})${appendedTo ? ` and reference it from \`${appendedTo}\`` : ''}. Proposed via the Isomorphic brain tools.`
			});

			const where = appendedTo ? ` and added it to "${appendedTo}"` : '';
			// Say so when the name changed. A caller that inserted a link before uploading
			// (the editor does) is pointing at the name it asked for, and a rename it is
			// never told about is a broken image it cannot explain.
			const renamed =
				target === desired
					? ''
					: ` It was named ${target.split('/').pop()} because ${desired.split('/').pop()} was taken.`;
			const result = landed(
				ctx,
				outcome,
				`Stored ${target} (${formatBytes(bytes)})${where}. The change was logged.${renamed}`,
				`Proposed storing ${target} (${formatBytes(bytes)})${where}.${renamed}`
			);
			// The path is the one thing a programmatic caller cannot recompute: it depends
			// on what was already in the repo.
			return { ...result, structuredContent: { path: target, bytes, mimeType: mime } };
		}
	);

	// ---------- read_media ----------
	server.registerTool(
		'read_media',
		{
			...toolAnnotations('Read an attached file', 'read'),
			// A full description, not a terse one: this is the tool an agent hunts for when
			// a page links a PDF or a deck, and "images only" wording made it look useless.
			description:
				'read_media reads a file stored in the brain (an image, a PDF, a Word document, a PowerPoint deck) by its path. For an image type Claude can see (PNG, JPEG, GIF, WebP) it returns the picture itself. For a PDF, DOCX or PPTX it returns the text, by page, section or slide, with `pages` to choose which ("3", "2-5", "10-"); a long document comes back in parts and the reply says how to continue. It also returns a download link, valid for 15 minutes, that opens the original file in a browser or can be fetched into a workspace. Use it when a page references a file and the question depends on what the file says or shows.',
			inputSchema: z.object({
				path: z
					.string()
					.describe('Path of the stored file, e.g. "wiki/vendors/assets/contract.pdf".'),
				pages: z
					.string()
					.optional()
					.describe(
						'Documents only: which pages (PDF), slides (PPTX) or sections (DOCX) to return, 1-based: "3", "2-5", or "10-" for 10 to the end. Omit to start at the beginning.'
					),
				include_data: z
					.boolean()
					.optional()
					.describe(
						'Include the raw bytes as a data URI in the structured result. Set by the Isomorphic app, which needs them to render the image. Leave it off: you are handed the picture or the text itself.'
					),
				brain: brainArg
			})
		},
		async ({ path, pages, include_data, brain }) => {
			const { store, repoArgs, config, brainId, actorUserId } = await getContext({ brain });
			const target = normalizePath(path);

			const mimeType = mediaTypeOf(target);
			if (!mimeType) {
				return fail(
					`"${target}" is not a supported attachment. read_media serves images, PDFs, Word documents and PowerPoint decks; use read_page for markdown.`
				);
			}
			if (!isContentPath(target, config)) {
				return fail(`"${target}" is outside this brain's content.`);
			}

			const file = await store.readBinary(repoArgs, target);
			if (!file) return fail(`No file at "${target}".`);

			// The cap is a storage rule, but it protects reads too: something committed
			// outside our tools can be any size, and turning a 40 MB blob into base64 in
			// a 128 MB isolate is how a read takes the whole request down.
			if (file.size > MAX_ATTACHMENT_BYTES) {
				return fail(
					`"${target}" is ${formatBytes(file.size)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit this brain serves.`
				);
			}

			// A link is a convenience: a deployment with no public origin or secret, or a
			// signing failure, still answers with the content.
			const issuer = options.assetLinks
				? await options.assetLinks().catch(() => undefined)
				: undefined;
			const link = issuer
				? await issueAssetLink(
						issuer,
						{ brainId, path: target, ...(actorUserId ? { userId: actorUserId } : {}) },
						nowSeconds()
					).catch(() => undefined)
				: undefined;

			// structuredContent carries the data URI for the app, which renders it under
			// the iframe's default CSP (img-src 'self' data:) with no external origin. See
			// docs/design/media-attachments.md §3.
			//
			// Only for the app, though, which is why it is opt-in. Hosts put
			// structuredContent in front of the model alongside the content blocks, so
			// sending it unconditionally would spend a second, larger copy of every image
			// as base64 text the model cannot use, long enough to truncate the response.
			// Document text stays out of it for the same reason: it rides in `content`.
			const structuredContent = {
				path: target,
				mimeType,
				size: file.size,
				...(include_data ? { dataUri: `data:${mimeType};base64,${file.contentBase64}` } : {}),
				...(link ? { downloadUrl: link.url, expiresAt: link.expiresAt } : {})
			} satisfies ReadMediaWire;

			const name = target.split('/').pop() ?? target;
			const content: CallToolResult['content'] = [];
			// The same shape a mail connector uses for an attachment: a resource_link the
			// host can show as a file, then the content, then a line restating the link
			// for hosts that drop resource_link blocks.
			if (link) {
				content.push({
					type: 'resource_link',
					uri: link.url,
					name,
					mimeType,
					description: `${formatBytes(file.size)}. Signed download link, expires ${link.expiresAt}.`
				});
			}
			const linkLine = link
				? ` Download or open it: ${link.url} (works for anyone holding it while you keep access to this brain, expires ${link.expiresAt}).`
				: '';

			if (isModelViewable(mimeType)) {
				content.push(
					{ type: 'image', data: file.contentBase64, mimeType },
					{ type: 'text', text: `${target} (${mimeType}, ${formatBytes(file.size)}).${linkLine}` }
				);
				return { content, structuredContent };
			}

			// The app asks for bytes to display, never for text: skip the parse.
			if (!isTextExtractable(mimeType) || include_data) {
				content.push({
					type: 'text',
					text: `"${target}" is a ${mimeType} file of ${formatBytes(file.size)}. It is stored in the brain and the Isomorphic app can display it, but Claude cannot read its contents directly.${linkLine}`
				});
				return { content, structuredContent };
			}

			let text: string;
			try {
				const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
				const doc = await extractDocumentText(bytes, mimeType);
				const plural = `${doc.unit}s`;
				if (doc.parts.length === 0) {
					text = `${target} (${mimeType}, ${formatBytes(file.size)}) has no ${plural} with text.${linkLine}`;
				} else {
					const range = parsePartRange(pages, doc.parts.length);
					if ('error' in range) return fail(`pages: ${range.error}`);
					const slice = sliceDocument(doc, range);
					const anyText = doc.parts.slice(range.start, slice.last).some((p) => p.trim());
					const header = `${target} (${mimeType}, ${formatBytes(file.size)}): ${plural} ${slice.first}-${slice.last} of ${slice.total}.`;
					const more = slice.next
						? `\n\nStopped at the length limit. Continue with read_media pages: "${slice.next}".`
						: '';
					// A scanned PDF has pages but no text layer, and there is no OCR here.
					const empty = anyText
						? ''
						: `\n\nNone of these ${plural} has a text layer (it is probably scanned). Open the file from the link to see it.`;
					text = `${header}${linkLine}\n\n${slice.text}${more}${empty}`;
				}
			} catch (e) {
				text = `${target} (${mimeType}, ${formatBytes(file.size)}) is stored in the brain, but its text could not be read: ${e instanceof Error ? e.message : String(e)}.${linkLine}`;
			}
			content.push({ type: 'text', text });
			return { content, structuredContent };
		}
	);
}
