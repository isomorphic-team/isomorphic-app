// Brain MCP App tools — the in-client UI surface (MCP Apps / SEP-1865).
//
// Design principle: viewers experience the brain almost entirely INSIDE the
// MCP client. The Worker serves one self-contained ui:// HTML resource (the
// viewer/editor app, codegen'd from app/ into app-bundle.generated.ts), and
// these tools link to it via _meta.ui.resourceUri. UI-capable hosts
// (claude.ai, Claude Desktop) render the app in a sandboxed iframe and feed
// it the tool result; the app then navigates by calling the ordinary read
// tools back through the host, riding the same OAuth token — no new auth, no
// standalone web UX.
//
// Non-UI hosts (Claude Code terminal, Inspector) degrade gracefully: every
// tool also returns a plain text block, so the same call still works as chat.
//
// Write policy matches the librarian exactly (shared predicates): raw/ is
// immutable, index/log are tool-maintained. These tools are read-only; the
// in-client editor opens via edit_page and saves through the librarian's
// write_page, passing the blob sha from edit_page for optimistic concurrency.

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	registerAppResource,
	registerAppTool,
	RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { BRAIN_APP_HTML } from '../lib/app-bundle.generated.ts';
import type { D1Database } from '@cloudflare/workers-types';
import { MAX_SCAN_PAGES, type RepoRef, type BrainStore } from '../lib/brain-repo.ts';
import {
	ensureFresh,
	loadResolvedGraph,
	listIndexedPages,
	detectNeedsConfig
} from '../lib/brain-index.ts';
import { tryRenderViews, stripSnapshots } from '../lib/views.ts';
import type { BrainContext } from './librarian.ts';
import {
	type BrainConfig,
	isContentPath,
	isSourcePath,
	isToolMaintained,
	listNonPagePaths,
	pathPolicyOf
} from '../lib/brain-config.ts';
import type { TenantOpts } from '../lib/orgs.ts';

// The editability policy the in-client app needs to gate its own UI. Lives in
// brain-policy.ts (pathPolicyOf) so the tools OUTSIDE this file that also feed
// the file tree — list_pages, which is what the widget re-fetches after a brain
// switch — ship the identical shape.
const editPolicy = pathPolicyOf;

// Shared optional `brain` arg for the in-client view/edit tools. Unlike the data
// tools' one-shot `brain`, opening a brain in the app MAKES IT ACTIVE (sticky — see
// registerBrainApp in worker.ts), because the user is now looking at it and the
// viewer follows the active brain; subsequent bare calls stay on it.
const brainArg = z
	.string()
	.optional()
	.describe(
		'Which brain to open (name/handle). Defaults to the active brain; opening another makes it the active brain.'
	);

// A stable content fingerprint of the app bundle (FNV-1a 32-bit → base36). Not
// cryptographic — just enough to change when the bytes change and stay identical
// when they don't. Computed once at module load (per isolate), negligible cost.
function bundleFingerprint(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

// Version the ui:// resource URI by that fingerprint. MCP hosts (claude.ai) cache
// the ui:// resource by its URI, so a FIXED URI meant a redeployed UI could keep
// serving the old cached bytes (the "I shipped it but still see the old app"
// problem). Folding the bundle hash into the URI makes every real UI change land at
// a NEW URI — the host fetches fresh bytes — while an unchanged bundle keeps the
// same URI (so we don't bust the cache needlessly). The resource registration and
// every tool's _meta.ui.resourceUri both read this one constant, so they can't drift.
export const BRAIN_APP_URI = `ui://isomorphic-mind/brain-app.${bundleFingerprint(BRAIN_APP_HTML)}.html`;

// A catch-all template matching EVERY versioned URI we've ever minted
// (brain-app.<anyhash>.html). Registered alongside the concrete current-hash
// resource so that a read for an OLD hash still resolves. This is the deploy-
// safety net: a live host session caches the tools list with the hash that was
// current when it connected; after we ship a new bundle the concrete URI changes,
// so that session's next widget render would `resources/read` a hash we no longer
// register — a hard "problem displaying content" failure on EVERY deploy. The
// template serves the CURRENT bytes for any hash, so stale sessions render fine
// (with the new UI, even) instead of 404ing. Fresh sessions still get the new
// hash in _meta and hit the exact resource, so the byte-cache bust is preserved
// (exact match wins over templates — see McpServer read dispatch).
const BRAIN_APP_URI_TEMPLATE = 'ui://isomorphic-mind/brain-app.{v}.html';

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

// One node per content page; one edge per link between two pages. Sized to the
// in-client graph view (view_graph). Both shapes mirror what app/main.tsx expects.
interface GraphNode {
	id: string; // repo path — also the node's stable key
	title: string;
	group: string; // parent folder, so the app can color by area
	degree: number; // connection count, so the app can size hubs
}
interface GraphLink {
	source: string;
	target: string;
}

// Build the brain's link graph from the content index. loadResolvedGraph resolves
// markdown links via resolveRelative and [[wikilinks]] by path/filename/title — the SAME
// resolution the backlinks panel uses, so the graph can't disagree with it. Edges
// are undirected-deduped (A-B once, regardless of link direction/kind); nodes carry
// a degree so the renderer can size hubs. ensureFresh reconciles the index with the
// repo HEAD first, so the graph reflects the current brain, unbounded by page count.
async function buildGraph(
	db: D1Database,
	store: BrainStore,
	repoArgs: RepoRef,
	brainId: string,
	config: BrainConfig
) {
	const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
	const resolved = await loadResolvedGraph(db, brainId, config);
	// Dedupe the resolved directed edges into undirected connections and count each
	// node's degree so the renderer can size hubs.
	const edges: GraphLink[] = [];
	const edgeKeys = new Set<string>();
	const degree = new Map<string, number>();
	for (const e of resolved.edges) {
		if (e.source === e.target) continue;
		const key = e.source < e.target ? `${e.source} ${e.target}` : `${e.target} ${e.source}`;
		if (edgeKeys.has(key)) continue;
		edgeKeys.add(key);
		edges.push({ source: e.source, target: e.target });
		degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
		degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
	}

	const nodes: GraphNode[] = resolved.pages.map((p) => ({
		id: p.path,
		title: p.title,
		group: p.path.split('/').slice(0, -1).join('/'),
		degree: degree.get(p.path) ?? 0
	}));

	return { nodes, edges, truncated };
}

export function registerBrainApp(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	// ---------- the ui:// resource ----------
	// One read body, served at two registrations: the concrete current-hash URI
	// (for resources/list discovery + fresh sessions) and the version catch-all
	// template (so stale post-deploy sessions still resolve). Both echo the CURRENT
	// bytes; the template ignores the requested hash. `reqUri` is what the host
	// asked for, echoed back so the contents uri matches the request.
	const readAppBundle = (reqUri: string) => {
		// Observability for host-rendering gaps (ext-apps#671): this log firing
		// proves the host fetched the app; whether an iframe appears is then
		// entirely host-side. Logging the requested URI surfaces stale-hash reads
		// (a hash != BRAIN_APP_URI means a live session survived a deploy).
		console.log(`[brain-app] ui resource read (${BRAIN_APP_HTML.length} chars) uri=${reqUri}`);
		return {
			contents: [{ uri: reqUri, mimeType: RESOURCE_MIME_TYPE, text: BRAIN_APP_HTML }]
		};
	};

	registerAppResource(
		server,
		'brain-app',
		BRAIN_APP_URI,
		{ mimeType: RESOURCE_MIME_TYPE },
		async () => readAppBundle(BRAIN_APP_URI)
	);

	// Deploy safety net (see BRAIN_APP_URI_TEMPLATE): serve current bytes for any
	// previously-minted hash. `list: undefined` keeps it out of resources/list so
	// only the concrete resource is advertised for discovery.
	server.registerResource(
		'brain-app-versioned',
		new ResourceTemplate(BRAIN_APP_URI_TEMPLATE, { list: undefined }),
		{ mimeType: RESOURCE_MIME_TYPE },
		async (uri) => readAppBundle(uri.toString())
	);

	// ---------- view_page ----------
	registerAppTool(
		server,
		'view_page',
		{
			title: 'Open a brain page',
			// Deliberately does NOT name read_page. It used to say "prefer this over
			// read_page / use read_page only when...", which meant this description
			// contained the string "read_page" twice while read_page's own contained
			// it zero times: a tool search for "read_page" ranked THIS tool first and
			// an agent concluded it had no way to read a page. The read-vs-view
			// steering lives in the server instructions, which hosts load wholesale.
			description:
				'Open a brain page in the interactive Isomorphic viewer: rendered markdown, clickable links, browse and search, shown inside Claude. Use this whenever the user wants to LOOK AT or explore a page, AND whenever you cite or reference a specific brain page in an answer: call it on the referenced path so the user can open that page in Isomorphic instead of only reading pasted text. This is for showing a page to the USER; to fetch a page as text for your own reasoning, read it instead.',
			inputSchema: {
				path: z.string().describe('Page path, e.g. "wiki/customers/acme.md".'),
				brain: brainArg
			},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ path, brain }) => {
			const { store, repoArgs, config, activeBrain, db, brainId } = await getContext({ brain });
			const file = await store.readFile(repoArgs, path);
			if (!file) return fail(`"${path}" does not exist.`);
			// Derived views: replace each okf-view fence (and its cached snapshot)
			// with the live rendering computed from the content index, so the user
			// always sees current data. Falls back to the raw file if computing fails.
			const views = await tryRenderViews(file.content, path, {
				db,
				store,
				repoArgs,
				brainId,
				config
			});
			const markdown = views?.display ?? file.content;
			return {
				content: [{ type: 'text' as const, text: markdown }],
				structuredContent: {
					view: 'page',
					path,
					markdown,
					config: editPolicy(config),
					activeBrain
				}
			};
		}
	);

	// ---------- browse_brain ----------
	registerAppTool(
		server,
		'browse_brain',
		{
			title: 'Browse the brain',
			description:
				'Open the brain in the interactive Isomorphic viewer, shown inside Claude, so the user can browse its pages, follow links, and search. Use when the user wants to explore or "see" their brain as a whole rather than ask one specific question, or when your answer points them at several pages at once.',
			inputSchema: { brain: brainArg },
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ brain }) => {
			const { store, repoArgs, config, db, brainId, activeBrain } = await getContext({ brain });
			// Serve the page list from the content index (ensureFresh reconciles it with
			// HEAD first) — so it's instant and carries each page's display title, letting
			// the file tree label files by title instead of filename. The index already
			// holds exactly the brain's content pages (isContentPath), so no extra filter.
			await ensureFresh(db, store, repoArgs, brainId, config);
			const pages = await listIndexedPages(db, brainId);
			const paths = pages.map((p) => p.path);
			// Attachments listed apart from hidden files — see listNonPagePaths.
			const { assets, hidden } = await listNonPagePaths(store, repoArgs, config);
			const text = paths.length ? paths.join('\n') : 'The brain is empty.';
			// Empty could be a fresh brain or an adopted repo whose content isn't under the
			// configured roots — flag the latter so the app can offer to auto-configure.
			// Only content-AREA files count as "something to show": the hidden list now
			// includes system files that exist in any repo.
			const needsConfig =
				paths.length === 0 &&
				!hidden.some((p) => isContentPath(p, config)) &&
				(await detectNeedsConfig(store, repoArgs, config));
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: {
					view: 'browse',
					paths,
					pages,
					assets,
					hidden,
					config: editPolicy(config),
					activeBrain,
					needsConfig
				}
			};
		}
	);

	// ---------- view_activity ----------
	registerAppTool(
		server,
		'view_activity',
		{
			title: 'View recent changes',
			description:
				"Open the brain's activity log in Isomorphic — recent changes with who made each one and when (an audit trail). Pass a `path` to see one page's history instead of the whole brain. Use when the user asks what changed, who edited something, or wants to review recent activity.",
			inputSchema: {
				path: z
					.string()
					.optional()
					.describe(
						'Optional page path to show history for just that page, e.g. "wiki/concepts/vision.md".'
					),
				limit: z.number().optional().describe('How many changes to return (default 20, max 50).'),
				brain: brainArg
			},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ path, limit, brain }) => {
			const { store, repoArgs, config, activeBrain } = await getContext({ brain });
			const per_page = Math.min(Math.max(1, limit ?? 20), 50);
			// One call, no per-blob fanout; `path` scopes it to one page's history.
			const commits = await store.listCommits(repoArgs, { limit: per_page, path });
			const entries = commits.map((c) => {
				const message = c.message.split('\n')[0];
				// Our write tools embed the target path in the message, e.g.
				// "Edit Brand Voice (wiki/playbooks/brand-voice.md)" — surface it so the
				// app can link the entry straight to the page.
				const m = message.match(/\(([^()]+\.md)\)/);
				const touched = m && isContentPath(m[1], config) ? m[1] : undefined;
				return {
					sha: c.sha,
					shortSha: c.sha.slice(0, 7),
					message,
					path: touched,
					authorName: c.authorName,
					authorLogin: c.authorLogin,
					date: c.date,
					url: c.url
				};
			});
			const scopeLabel = path ? `"${path}"` : 'the brain';
			const text = entries.length
				? `Recent changes to ${scopeLabel}:\n${entries
						.map((e) => `- ${e.date.slice(0, 10)} — ${e.authorName}: ${e.message} (${e.shortSha})`)
						.join('\n')}`
				: `No recorded changes for ${scopeLabel} yet.`;
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: {
					view: 'activity',
					scope: { path },
					entries,
					config: editPolicy(config),
					activeBrain
				}
			};
		}
	);

	// ---------- view_graph ----------
	registerAppTool(
		server,
		'view_graph',
		{
			title: 'Open the brain graph',
			description:
				"Open the brain as an interactive graph in Isomorphic — every page is a node and every link (markdown link or [[wikilink]]) is an edge, laid out force-directed like Obsidian's graph view. Use when the user wants to SEE how their brain is connected, explore its structure, or find hubs and orphans, rather than read one page. Best viewed fullscreen. Pass a `path` to center and highlight one page and its neighbors.",
			inputSchema: {
				path: z
					.string()
					.optional()
					.describe('Optional page to center and highlight, e.g. "wiki/concepts/vision.md".'),
				brain: brainArg
			},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ path, brain }) => {
			const { store, repoArgs, config, db, brainId, activeBrain } = await getContext({ brain });
			const { nodes, edges, truncated } = await buildGraph(db, store, repoArgs, brainId, config);
			const focus = path && nodes.some((n) => n.id === path) ? path : undefined;
			const text =
				`Brain graph: ${nodes.length} page(s), ${edges.length} link(s).` +
				(truncated ? ` Only the first ${MAX_SCAN_PAGES} pages were scanned.` : '');
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: {
					view: 'graph',
					nodes,
					edges,
					focus,
					truncated,
					config: editPolicy(config),
					activeBrain
				}
			};
		}
	);

	// ---------- edit_page ----------
	registerAppTool(
		server,
		'edit_page',
		{
			title: 'Edit a brain page in the editor',
			description:
				'Open a brain page in the in-client editor so the USER can edit its body directly. Metadata stays managed automatically. For your own programmatic edits, use write_page instead.',
			inputSchema: {
				path: z.string().describe('Page path, e.g. "wiki/concepts/vision.md".'),
				brain: brainArg
			},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ path, brain }) => {
			const { store, repoArgs, config, activeBrain } = await getContext({ brain });
			if (isSourcePath(path, config))
				return fail(`"${path}" is source material — it can't be edited.`);
			if (isToolMaintained(path, config)) return fail(`"${path}" is maintained automatically.`);
			if (!path.endsWith('.md')) return fail('Only markdown pages can be edited.');
			if (!isContentPath(path, config))
				return fail(`"${path}" is outside this brain's editable content.`);
			const file = await store.readFile(repoArgs, path);
			if (!file) return fail(`"${path}" does not exist.`);
			// Derived views: the editor gets the okf-view fences but NOT the generated
			// snapshot regions — generated content must never round-trip through
			// ProseMirror (it would be editable and could be mangled). Snapshots are
			// recomputed on save. The sha is the file's real sha; stripping only
			// changes what the editor displays.
			const editable = stripSnapshots(file.content);
			return {
				content: [
					{
						type: 'text' as const,
						text: `Opened ${path} in the editor. Current contents:\n\n${editable}`
					}
				],
				structuredContent: {
					view: 'edit',
					path,
					markdown: editable,
					sha: file.sha,
					config: editPolicy(config),
					activeBrain
				}
			};
		}
	);
}
