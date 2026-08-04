// list_pages and read_page — the two content tools that both runtimes need.
//
// They lived inline in worker.ts's buildServer until the local runtime needed them
// too. Everything else in that method is either identity (whoami, which has no
// meaning without a signed-in user) or a register*Tools call that was already
// shared; these two were the only definitions the Worker kept to itself.
//
// Both take the same getContext every other suite takes, so they work unchanged
// against a GitHub-backed brain or a git repo on disk.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import type { TenantOpts } from '../lib/orgs.ts';
import { ensureFresh, listIndexedPages, detectNeedsConfig } from '../lib/brain-index.ts';
import { listHiddenPaths, pathPolicyOf, isContentPath } from '../lib/brain-config.ts';
import { tryRenderViews } from '../lib/views.ts';

export function registerCoreTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	// ---------- list_pages ----------
	server.registerTool(
		'list_pages',
		{
			title: 'List brain pages',
			annotations: { readOnlyHint: true },
			description:
				"List markdown pages in the brain. With no prefix, returns the brain's editable content (per its .isomorphic.json roots); pass a prefix to filter to a subtree. Paths are relative to the repo root.",
			inputSchema: {
				prefix: z
					.string()
					.optional()
					.describe('Path prefix to filter on (e.g. "wiki/" or "internal/frameworks/")'),
				brain: z
					.string()
					.optional()
					.describe('Which brain to target (name/handle). Defaults to the active brain.')
			}
		},
		async ({ prefix, brain }) => {
			const { store, repoArgs, config, db, brainId } = await getContext({ brain });

			// No prefix = "the brain's editable content", which is exactly what the
			// index holds — serve it from there (instant) and attach each page's title
			// in structuredContent so the app's file tree can label files by title.
			if (!prefix) {
				await ensureFresh(db, store, repoArgs, brainId, config);
				const pages = await listIndexedPages(db, brainId);
				// Everything that's NOT a content page (system files, .gitkeep markers,
				// source, the log): the app shows these only when "show hidden" is on.
				const hidden = await listHiddenPaths(store, repoArgs, config);
				// Empty could mean a fresh brain OR an adopted repo whose content isn't under
				// the configured roots — flag the latter so the app can offer to auto-configure.
				// Only content-AREA files count as "something to show" here: the hidden list
				// now includes system files that exist in any repo.
				const needsConfig =
					pages.length === 0 &&
					!hidden.some((p) => isContentPath(p, config)) &&
					(await detectNeedsConfig(store, repoArgs, config));
				return {
					content: [
						{
							type: 'text' as const,
							text:
								pages.length === 0
									? 'No markdown pages found.'
									: pages.map((p) => p.path).join('\n')
						}
					],
					// The app builds its file tree from THIS result after a brain switch
					// (the switcher calls switch_brain, then re-fetches with list_pages),
					// so the path policy has to ride along — otherwise the tree paints the
					// new brain with the previous brain's roles: every folder outside the
					// stale content root reads as hidden and every page reads as locked.
					structuredContent: { pages, hidden, needsConfig, config: pathPolicyOf(config) }
				};
			}

			// A prefix can target anything (including non-content like raw/), which the
			// index doesn't hold, so keep the live tree walk for that case.
			const head = await store.getHead(repoArgs);
			const paths = (await store.listTree(repoArgs, head))
				.map((e) => e.path)
				.filter((p) => p.startsWith(prefix))
				.sort();

			return {
				content: [
					{
						type: 'text' as const,
						text:
							paths.length === 0 ? `No markdown pages found under "${prefix}".` : paths.join('\n')
					}
				]
			};
		}
	);

	// ---------- read_page ----------
	server.registerTool(
		'read_page',
		{
			title: 'Read a brain page',
			annotations: { readOnlyHint: true },
			// Deliberately verbose and self-naming. This tool is the one an agent
			// looks for by name mid-task ("I need read_page"), and a terse
			// one-liner made it lose tool-search ranking to view_page, whose
			// description talked about read_page more than this one did. The
			// read-before-you-replace rule lives here too, at the point of need.
			description:
				"Read a page: read_page returns the page's raw markdown source (frontmatter and body) as text, fetched from the brain repo. Use it whenever you need a page's contents to reason over, quote, or edit. Read a page before any write_page call that passes `content`, since that replaces the whole body and would destroy text you have not seen (to change only part of a page, prefer write_page's non-destructive `append` / `edits` arguments, which need no prior read). This returns text to you and does not show anything to the user: use view_page when the goal is for the USER to see the page.",
			inputSchema: {
				path: z.string().describe('Path relative to the repo root, e.g. "AGENTS.md"'),
				brain: z
					.string()
					.optional()
					.describe('Which brain to target (name/handle). Defaults to the active brain.')
			}
		},
		async ({ path, brain }) => {
			const { store, repoArgs, db, brainId, config } = await getContext({ brain });
			const file = await store.readFile(repoArgs, path);
			if (!file) {
				return {
					isError: true,
					content: [{ type: 'text', text: `"${path}" is not a file.` }]
				};
			}
			const text = file.content;
			// Derived views: agents get the okf-view fence PLUS a freshly computed
			// rendering beneath it — the current data without losing sight of the
			// directive (so they don't hand-edit derived content). Falls back to
			// the raw file if computing fails.
			const views = await tryRenderViews(text, path, { db, store, repoArgs, brainId, config });
			return { content: [{ type: 'text', text: views?.snapshotted ?? text }] };
		}
	);
}
