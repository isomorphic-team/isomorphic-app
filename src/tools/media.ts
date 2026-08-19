// attach_media and read_media: putting files into a brain, and getting them back
// out — to the app as a data URI, to the model as an image it can actually look at.
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
// someone's disk. Added for issue #20, where an agent could find, fetch, crop and
// compress a floor plan and then had no way to hand over 14 KB of PNG.
//
// Only two tools, and move/delete are handled by the EXISTING move_page / delete_page
// rather than gaining media twins. That is deliberate: this repo has documented
// pressure against growing the tool surface (42 -> 30, with two merges recorded in
// CLAUDE.md), and those two already do the right thing for an attachment now that the
// index records asset links.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { landed } from './librarian.ts';
import type { TenantOpts } from '../lib/orgs.ts';
import { isContentPath, isSourcePath, isToolMaintained, logPathOf } from '../lib/brain-policy.ts';
import { insertLogEntry, todayIso } from '../lib/wiki.ts';
import {
	MAX_ATTACHMENT_BYTES,
	attachmentMarkdown,
	base64Bytes,
	defaultAttachmentPath,
	fetchRemoteAttachment,
	formatBytes,
	isModelViewable,
	mediaTypeOf,
	uniqueAttachmentPath,
	validateAttachment
} from '../lib/media.ts';
import { brainArg, fail } from './shared.ts';

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

export function registerMediaTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	// ---------- attach_media ----------
	server.registerTool(
		'attach_media',
		{
			title: 'Attach a file to the brain',
			description:
				// Self-naming and explicit about which argument belongs to whom, for the
				// same reason read_page's description is verbose: an agent that goes
				// looking for this tool needs to learn from the description alone which
				// half of it it can actually call, rather than trying and failing.
				'attach_media stores a file (an image, a PDF) in the brain and optionally adds it to a page. There are two ways to supply the file and only one of them is yours. Pass `url` and the server downloads the file itself: that is how YOU attach something, and it works for anything reachable at a public https address (a diagram, a photo, a PDF), including pages your own sandbox cannot reach. `data` takes raw base64 and is supplied by the Isomorphic app when someone drops a file into the panel, NOT by you: you cannot produce it from an image in the conversation, because you can see that image but do not have its bytes. So if the file is one the user attached to the chat, or one you produced yourself with no public URL, tell them to drop it into the Isomorphic panel instead.',
			inputSchema: {
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
			}
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
			const head = await store.getHead(repoArgs, config.defaultBranch);
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
				const existing = await store.readFile(repoArgs, pagePath);
				if (!existing) return fail(`No page at "${pagePath}".`);
				const link = attachmentMarkdown(pagePath, target, alt?.trim() || name);
				const body = existing.content.endsWith('\n')
					? `${existing.content}\n${link}\n`
					: `${existing.content}\n\n${link}\n`;
				writes.push({ path: pagePath, content: body });
				appendedTo = pagePath;
			}

			const today = todayIso();
			const log = await store.readFile(repoArgs, logPathOf(config));
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
				writeMode: config.writeMode,
				defaultBranch: config.defaultBranch,
				author,
				autoMerge: config.autoMerge,
				mergeMethod: config.mergeMethod,
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
			title: 'Read an attached file',
			annotations: { readOnlyHint: true },
			description:
				'read_media fetches a file stored in the brain (an image, a PDF) by its path. For an image type Claude can see (PNG, JPEG, GIF, WebP) it returns the picture itself, so you can look at it and describe or reason about it. The app also calls this to render images inside a page. Use it when a page references an image and the question depends on what the image actually shows.',
			inputSchema: {
				path: z.string().describe('Path of the stored file, e.g. "wiki/vendors/assets/logo.png".'),
				include_data: z
					.boolean()
					.optional()
					.describe(
						'Include the raw bytes as a data URI in the structured result. Set by the Isomorphic app, which needs them to render the image. Leave it off: you are handed the picture itself.'
					),
				brain: brainArg
			}
		},
		async ({ path, include_data, brain }) => {
			const { store, repoArgs, config } = await getContext({ brain });
			const target = normalizePath(path);

			const mimeType = mediaTypeOf(target);
			if (!mimeType) {
				return fail(
					`"${target}" is not a supported attachment. read_media serves images and PDFs; use read_page for markdown.`
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

			// structuredContent carries the data URI for the app, which renders it under
			// the iframe's default CSP (img-src 'self' data:) with no external origin and
			// no expiring signed URL. See docs/design/media-attachments.md §3.
			//
			// Only for the app, though, which is why it is opt-in. Hosts put
			// structuredContent in front of the model alongside the content blocks, so
			// sending it unconditionally spent a second, larger copy of every image as
			// text: a 150 KB PNG became ~200 KB of base64 that read as nothing, on top of
			// the image block the model can actually see, and long enough to truncate the
			// response it was attached to. Reported as issue #20.
			const structuredContent = {
				path: target,
				mimeType,
				size: file.size,
				...(include_data ? { dataUri: `data:${mimeType};base64,${file.contentBase64}` } : {})
			};

			if (!isModelViewable(mimeType)) {
				// Stored and displayable, but not something to hand the model. Whether this
				// host turns an embedded resource blob into a document block is unverified,
				// and guessing would produce a silently empty read.
				return {
					content: [
						{
							type: 'text' as const,
							text: `"${target}" is a ${mimeType} file of ${formatBytes(file.size)}. It is stored in the brain and the Isomorphic app can display it, but it is not an image type Claude can look at directly.`
						}
					],
					structuredContent
				};
			}

			return {
				content: [
					{ type: 'image' as const, data: file.contentBase64, mimeType },
					{ type: 'text' as const, text: `${target} (${mimeType}, ${formatBytes(file.size)})` }
				],
				structuredContent
			};
		}
	);
}
