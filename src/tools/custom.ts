// User-defined tools ("brain-tools"): discovery + registration + execution.
//
// A tool is a content page under a `tools/` folder (see isToolPagePath). At
// connection time we discover the active brain's tool pages via the content
// index, parse each into a CustomToolDef (src/lib/custom-tools.ts, pure), and
// register one MCP tool per def. The tool list is therefore PER-BRAIN and rebuilt
// every request — switching brains swaps the custom toolset. Because the stateless
// transport can't push tools/list_changed, a newly-authored tool only appears
// after the host re-lists (the librarian nudges the user to reconnect on write).
//
// Execution never leaves the brain and never writes:
//   - prompt  : return the interpolated instructions to the model (a saved skill)
//   - op      : run ONE whitelisted read primitive, append its result
//   - view    : render ONE okf-view directive (optionally opened in the widget)
// Arguments are interpolated as data ({{name}}), never evaluated.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TenantOpts } from '../lib/orgs.ts';
import type { BrainContext } from './librarian.ts';
import {
	ensureFresh,
	listIndexedPages,
	searchIndex,
	loadResolvedGraph,
	backlinksTo
} from '../lib/brain-index.ts';
import { tryRenderViews } from '../lib/views.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	parseToolDef,
	zodShapeFor,
	fill,
	isToolPagePath,
	type CustomToolDef,
	type OpName
} from '../lib/custom-tools.ts';

// Keep the tool list from bloating the host's context: every custom tool is
// tokens on every turn, and too many degrade first-party tool selection. Beyond
// this, extra tool pages are reported by `validate`, not registered.
const MAX_CUSTOM_TOOLS = 25;

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({
	isError: true,
	content: [{ type: 'text' as const, text }]
});

export interface CustomToolLoad {
	defs: CustomToolDef[];
	/** Pages that looked like tools but couldn't register — surfaced by validate. */
	errors: { sourcePath: string; error: string }[];
}

// Discover + parse the active brain's tool pages. Cheap when there are none
// (one indexed-page listing, no blob fetches). Fail-open: a malformed page is an
// error entry, never a thrown request.
export async function loadCustomToolDefs(ctx: BrainContext): Promise<CustomToolLoad> {
	const { db, store, repoArgs, brainId, config } = ctx;
	await ensureFresh(db, store, repoArgs, brainId, config);
	const toolPages = (await listIndexedPages(db, brainId)).filter((p) => isToolPagePath(p.path));
	if (toolPages.length === 0) return { defs: [], errors: [] };

	const blobs = await Promise.all(
		toolPages.map((p) =>
			store
				.readFile(repoArgs, p.path)
				.then((f) => ({ path: p.path, content: f?.content ?? null }))
				.catch(() => ({ path: p.path, content: null }))
		)
	);

	const defs: CustomToolDef[] = [];
	const errors: { sourcePath: string; error: string }[] = [];
	const seen = new Set<string>();
	for (const { path, content } of blobs) {
		if (content === null) continue; // vanished between index and fetch — skip quietly
		const res = parseToolDef(path, content);
		if (!res.def) {
			errors.push({ sourcePath: path, error: res.error });
			continue;
		}
		if (seen.has(res.def.name)) {
			errors.push({
				sourcePath: path,
				error: `duplicate tool name "${res.def.name}" — rename this page.`
			});
			continue;
		}
		if (defs.length >= MAX_CUSTOM_TOOLS) {
			errors.push({
				sourcePath: path,
				error: `custom-tool cap (${MAX_CUSTOM_TOOLS}) reached — not registered.`
			});
			continue;
		}
		seen.add(res.def.name);
		defs.push(res.def);
	}
	return { defs, errors };
}

export function registerCustomTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	defs: CustomToolDef[]
) {
	for (const def of defs) {
		const config: Record<string, unknown> = {
			title: def.displayTitle,
			description: def.description,
			inputSchema: zodShapeFor(def.params),
			annotations: { readOnlyHint: true }
		};
		// Widget tools open their result in the in-client viewer, like view_page.
		if (def.widget) config._meta = { ui: { resourceUri: BRAIN_APP_URI } };

		server.registerTool(def.name, config as never, async (rawArgs: unknown) => {
			const args = (rawArgs ?? {}) as Record<string, unknown>;
			const brain = typeof args.brain === 'string' ? args.brain : undefined;
			const ctx = await getContext({ brain });
			try {
				if (def.view !== undefined) return await runView(def, args, ctx);
				if (def.op) return await runOp(def, args, ctx);
				return ok(fill(def.instructions, args));
			} catch (err) {
				return fail(`Tool "${def.name}" failed: ${(err as Error).message}`);
			}
		});
	}
}

// ---------- view mode ----------

async function runView(def: CustomToolDef, args: Record<string, unknown>, ctx: BrainContext) {
	const directive = fill(def.view ?? '', args);
	// Wrap as a synthetic okf-view page and hand it to the same engine view_page
	// uses, so a custom view can't disagree with a page-embedded one. tryRenderViews
	// runs ensureFresh internally and fails open (null → raw fence).
	const synthetic = '```okf-view\n' + directive + '\n```\n';
	const rendered = await tryRenderViews(synthetic, def.sourcePath, {
		db: ctx.db,
		store: ctx.store,
		repoArgs: ctx.repoArgs,
		brainId: ctx.brainId,
		config: ctx.config
	});
	const preamble = def.instructions ? fill(def.instructions, args) + '\n\n' : '';
	const markdown = preamble + (rendered?.display ?? synthetic);

	if (def.widget) {
		return {
			content: [{ type: 'text' as const, text: markdown }],
			structuredContent: {
				view: 'page',
				path: def.sourcePath,
				markdown,
				config: { paths: ctx.config.paths },
				activeBrain: ctx.activeBrain
			}
		};
	}
	return ok(markdown);
}

// ---------- bound-operation mode ----------

async function runOp(def: CustomToolDef, args: Record<string, unknown>, ctx: BrainContext) {
	const opArgs: Record<string, string> = {};
	for (const [k, v] of Object.entries(def.opArgs)) opArgs[k] = fill(v, args);
	const preamble = def.instructions ? fill(def.instructions, args) + '\n\n---\n' : '';
	const body = await execOp(def.op as OpName, opArgs, ctx);
	return ok(preamble + body);
}

async function execOp(op: OpName, a: Record<string, string>, ctx: BrainContext): Promise<string> {
	const { db, store, repoArgs, brainId, config } = ctx;
	switch (op) {
		case 'search_pages': {
			const query = (a.query ?? '').trim();
			if (query.length < 2) return 'search_pages needs a "query" arg of at least 2 characters.';
			await ensureFresh(db, store, repoArgs, brainId, config);
			const hits = await searchIndex(db, brainId, query, a.prefix || undefined, 50);
			if (hits.length === 0) return `No matches for "${query}".`;
			return (
				`${hits.length} match(es) for "${query}":\n` +
				hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
			);
		}
		case 'read_page': {
			const path = (a.path ?? '').trim();
			if (!path) return 'read_page needs a "path" arg.';
			const file = await store.readFile(repoArgs, path);
			if (!file) return `"${path}" does not exist.`;
			const views = await tryRenderViews(file.content, path, {
				db,
				store,
				repoArgs,
				brainId,
				config
			});
			return views?.snapshotted ?? file.content;
		}
		case 'find_inbound_links': {
			const path = (a.path ?? '').trim();
			if (!path) return 'find_inbound_links needs a "path" arg.';
			await ensureFresh(db, store, repoArgs, brainId, config);
			const resolved = await loadResolvedGraph(db, brainId, config);
			const refs = backlinksTo(resolved, path);
			if (refs.length === 0) return `No pages link to "${path}".`;
			return (
				`${refs.length} page(s) link to "${path}":\n` + refs.map((r) => `- ${r.path}`).join('\n')
			);
		}
		case 'list_pages': {
			await ensureFresh(db, store, repoArgs, brainId, config);
			const pages = await listIndexedPages(db, brainId);
			const prefix = (a.prefix ?? '').trim();
			const filtered = prefix ? pages.filter((p) => p.path.startsWith(prefix)) : pages;
			if (filtered.length === 0) return prefix ? `No pages under "${prefix}".` : 'No pages.';
			return filtered.map((p) => p.path).join('\n');
		}
	}
}
