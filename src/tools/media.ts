// attach_media and read_media: putting files into a brain, and getting them back
// out — to the app as a data URI, to the model as an image it can actually look at.
//
// Read docs/design/media-attachments.md before changing either of these. The one
// thing that shapes the whole surface: THE MODEL CANNOT HAND US BYTES. Tool arguments
// are JSON produced by the model, and a model shown an image holds visual tokens, not
// base64 — it cannot reproduce a file it was never given as text, and no host passes a
// conversation attachment into a tool call. So attach_media is called by the Isomorphic
// app (a real browser context with a real file input), and its description says so, or
// an agent burns a turn trying to synthesize a PNG.
//
// Only two tools, and move/delete are handled by the EXISTING move_page / delete_page
// rather than gaining media twins. That is deliberate: this repo has documented
// pressure against growing the tool surface (42 -> 30, with two merges recorded in
// CLAUDE.md), and those two already do the right thing for an attachment now that the
// index records asset links.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { fail, landed } from './librarian.ts';
import type { TenantOpts } from '../lib/orgs.ts';
import { isContentPath, isSourcePath, isToolMaintained, logPathOf } from '../lib/brain-policy.ts';
import { insertLogEntry, todayIso } from '../lib/wiki.ts';
import {
	MAX_ATTACHMENT_BYTES,
	attachmentMarkdown,
	base64Bytes,
	defaultAttachmentPath,
	formatBytes,
	isModelViewable,
	mediaTypeOf,
	validateAttachment
} from '../lib/media.ts';

const brainArg = z
	.string()
	.optional()
	.describe('Which brain to target (name/handle). Defaults to the active brain.');

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
				// Self-naming and explicit about who calls it, for the same reason
				// read_page's description is verbose: an agent that goes looking for this
				// tool needs to learn from the description alone that it cannot supply the
				// argument, rather than trying and failing.
				"attach_media stores an uploaded file (an image, a PDF) in the brain and optionally adds it to a page. It requires the file's raw bytes as base64, which means it is normally called by the Isomorphic app when someone drops a file into the panel — NOT by you. You cannot produce the `data` argument from an image in the conversation: you can see that image, but you do not have its bytes. If a user asks you to save a picture they attached to the chat, tell them to drop it into the Isomorphic panel instead.",
			inputSchema: {
				data: z
					.string()
					.describe(
						'The file\'s bytes, base64-encoded (no "data:" prefix). Supplied by the app, not by the model.'
					),
				filename: z
					.string()
					.describe('Original filename, used to derive the stored name and the file type.'),
				mime_type: z
					.string()
					.describe('The file\'s MIME type, e.g. "image/png". Must agree with the extension.'),
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
		async ({ data, filename, mime_type, page, path, alt, brain }) => {
			const ctx = await getContext({ requires: 'editor', brain });
			const { store, repoArgs, config, author } = ctx;

			if (!page && !path) {
				return fail('Give a `page` to attach the file to, or an explicit `path` to store it at.');
			}
			const pagePath = page ? normalizePath(page) : '';
			if (pagePath && !pagePath.endsWith('.md')) {
				return fail(`"${pagePath}" is not a page. Pass a path ending in .md, or use \`path\`.`);
			}

			const target = normalizePath(
				path ? path : defaultAttachmentPath(pagePath, filename.trim() || 'attachment')
			);

			// Same three guards every write tool applies, in the same order, so an
			// attachment cannot reach somewhere a page could not.
			if (isSourcePath(target, config))
				return fail(`"${target}" is source material — it can't be written to.`);
			if (isToolMaintained(target, config)) return fail(`"${target}" is maintained automatically.`);
			if (!isContentPath(target, config))
				return fail(`"${target}" is outside this brain's editable content.`);

			const clean = stripDataUrl(data).trim();
			const problem = validateAttachment({ path: target, mimeType: mime_type, data: clean });
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
				const link = attachmentMarkdown(pagePath, target, alt?.trim() || filename.trim());
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
				message: `Attach ${target}${appendedTo ? ` to ${appendedTo}` : ''}\n\n${formatBytes(bytes)} ${mime_type}. Logged in the same change.`,
				writes,
				branchPrefix: 'isomorphic/attach',
				prTitle: `Attach ${target}`,
				prBody: `Add \`${target}\` (${formatBytes(bytes)})${appendedTo ? ` and reference it from \`${appendedTo}\`` : ''}. Proposed via the Isomorphic brain tools.`
			});

			const where = appendedTo ? ` and added it to "${appendedTo}"` : '';
			return landed(
				outcome,
				`Stored ${target} (${formatBytes(bytes)})${where}. The change was logged.`,
				`Proposed storing ${target} (${formatBytes(bytes)})${where}.`
			);
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
				brain: brainArg
			}
		},
		async ({ path, brain }) => {
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
			const structuredContent = {
				path: target,
				mimeType,
				size: file.size,
				dataUri: `data:${mimeType};base64,${file.contentBase64}`
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
