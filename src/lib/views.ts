// Derived views (FR-1, derived-views PRD) — live computed listings and counts.
//
// A page declares a computed view as a fenced ```okf-view block whose YAML body
// describes a query over the content index. Executing consumers (the app's page
// renderer, the MCP read tools) compute the result fresh at read time, so the
// view can never go stale: deleting/moving a linked page changes the rendering
// on the next read with no rebuild step. Non-executing consumers (github.com,
// raw OKF) see the fence plus a CACHED STATIC RENDERING kept directly beneath it
// between snapshot markers (decided 2026-07-22: GitHub must show a real table, at
// the accepted cost of the snapshot being stale between writes). The snapshot is
// cosmetic fallback ONLY — executing consumers ignore and recompute it — and is
// refreshed whenever its page is written through our tools.
//
// View kinds: `backlinks` (pages linking here, optionally filtered by the linking
// page's frontmatter), `pages` (content pages under a `under:` prefix), `folders`
// (the direct sub-folders under `under:`, each represented by its folder note),
// and `count` (the cardinality of any of the above). Directive example:
//
//   ```okf-view
//   kind: backlinks
//   filter: { type: Contact }
//   as: table
//   columns: [title, roles, email]
//   ```
//
// This module is the INDEX-COUPLED half: resolution + rendering + the tools'
// entry point. The pure layer (spec parsing, segmentation, snapshot handling)
// lives in view-directives.ts so the app bundle can import it without dragging
// in octokit/D1; everything there is re-exported here for convenience.
//
// Worker-safe (no node:*). Callers MUST ensureFresh() before building a context.

import type { D1Database } from '@cloudflare/workers-types';
import type { BrainConfig } from './brain-config.ts';
import type { RepoRef, BrainStore } from './brain-repo.ts';
import {
	type ResolvedGraph,
	type PageFields,
	ensureFresh,
	loadResolvedGraph,
	loadFieldsFor,
	loadAllFields,
	backlinksTo
} from './brain-index.ts';
import { relativeHref, resolveRelative } from './wiki.ts';
import {
	type ViewSpec,
	type ParsedView,
	FOLDER_NOTE_NAMES,
	SNAPSHOT_BEGIN,
	SNAPSHOT_END,
	hasViews,
	segmentViews
} from './view-directives.ts';

export * from './view-directives.ts';

// ---------- resolution ----------

// Everything a view needs from the index, loaded once per page render. Callers
// MUST await ensureFresh() first — the context is only as fresh as the index.
export interface ViewContext {
	resolved: ResolvedGraph;
	fieldsFor: (paths: string[]) => Promise<Map<string, PageFields>>;
}

export async function buildViewContext(
	db: D1Database,
	brainId: string,
	config: BrainConfig
): Promise<ViewContext> {
	const resolved = await loadResolvedGraph(db, brainId, config);
	return {
		resolved,
		fieldsFor: async (paths) => {
			// Small candidate sets (one page's backlinks): chunked IN queries. Large
			// sets (kind: pages over the brain): one whole-brain statement, filtered
			// in memory — cheaper than dozens of IN chunks (AC-5: 1-2 statements).
			if (paths.length <= 100) return loadFieldsFor(db, brainId, paths);
			const all = await loadAllFields(db, brainId);
			const wanted = new Set(paths);
			return new Map([...all].filter(([p]) => wanted.has(p)));
		}
	};
}

interface ViewRow {
	path: string;
	title: string;
	fields: PageFields;
}

function matchesFilter(fields: PageFields, filter: Record<string, string[]>): boolean {
	for (const [key, wanted] of Object.entries(filter)) {
		const have = (fields.get(key) ?? []).map((v) => v.toLowerCase());
		if (!wanted.some((w) => have.includes(w.toLowerCase()))) return false;
	}
	return true;
}

function compareRows(a: ViewRow, b: ViewRow, sort: string): number {
	if (sort === 'title') return a.title.localeCompare(b.title);
	const av = a.fields.get(sort)?.[0] ?? '';
	const bv = b.fields.get(sort)?.[0] ?? '';
	const an = Number(av);
	const bn = Number(bv);
	// Numeric compare when both sides are cleanly numeric; else lexicographic.
	if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
	if (av === '' && bv !== '') return 1; // missing sorts last
	if (bv === '' && av !== '') return -1;
	return av.localeCompare(bv) || a.title.localeCompare(b.title);
}

// Resolve a directive path arg: ./-relative to the containing page, else
// root-relative.
function resolveArgPath(pagePath: string, arg: string): string {
	return /^\.\.?\//.test(arg) ? resolveRelative(pagePath, arg) : arg.replace(/^\/+/, '');
}

// The directory a page lives in, as a "prefix/" (or '' at the brain root).
function dirOf(pagePath: string): string {
	const i = pagePath.lastIndexOf('/');
	return i < 0 ? '' : pagePath.slice(0, i + 1);
}

// Display title for a folder that has no folder note — mirror the indexer's
// deslug so a bare "my-projects" folder reads as "my projects".
function folderTitle(name: string): string {
	return name.replace(/[-_]/g, ' ');
}

// kind: folders — the direct sub-folders under `prefix`, each represented by its
// folder note (index.md > README.md). A sub-folder with no note still appears,
// as an unlinked row titled from its name (path '' → linkTo renders plain text),
// so a directory index is complete and honest during a mid-migration folder.
// A "direct sub-folder" is any first path segment beneath `prefix` that has at
// least one indexed page under it (empty/asset-only dirs never surface).
function folderCandidates(
	spec: ViewSpec,
	pagePath: string,
	ctx: ViewContext
): { path: string; title: string }[] {
	// Scope prefix ends in '/' (or '' at the brain root). `under` defaults to the
	// containing page's own directory, so a folder note's `kind: folders` lists
	// its siblings' sub-folders with no argument.
	const scope = spec.under
		? resolveArgPath(pagePath, spec.under).replace(/\/*$/, '/')
		: dirOf(pagePath);
	const titleByPath = new Map(ctx.resolved.pages.map((p) => [p.path, p.title]));
	const names = new Set<string>();
	for (const p of ctx.resolved.pages) {
		if (p.path === pagePath) continue;
		if (scope && !p.path.startsWith(scope)) continue;
		const rest = scope ? p.path.slice(scope.length) : p.path;
		const slash = rest.indexOf('/');
		if (slash > 0) names.add(rest.slice(0, slash));
	}
	return [...names].map((name) => {
		const folder = scope + name + '/';
		const notePath = FOLDER_NOTE_NAMES.map((n) => folder + n).find((np) => titleByPath.has(np));
		return notePath
			? { path: notePath, title: titleByPath.get(notePath)! }
			: { path: '', title: folderTitle(name) };
	});
}

// Run one view's query: pick the source set (backlinks of a page, or pages
// under a scope), attach fields, filter, sort. All renderings share this.
async function resolveRows(spec: ViewSpec, pagePath: string, ctx: ViewContext): Promise<ViewRow[]> {
	let candidates: { path: string; title: string }[];
	if (spec.kind === 'backlinks') {
		const target = spec.of ? resolveArgPath(pagePath, spec.of) : pagePath;
		candidates = backlinksTo(ctx.resolved, target);
	} else if (spec.kind === 'folders') {
		candidates = folderCandidates(spec, pagePath, ctx);
	} else {
		// kind: pages — the brain's content pages, optionally scoped by `under`.
		// The containing page always excludes itself (an index never lists itself).
		const prefix = spec.under
			? resolveArgPath(pagePath, spec.under).replace(/\/*$/, '/')
			: undefined;
		candidates = ctx.resolved.pages.filter(
			(p) => p.path !== pagePath && (!prefix || p.path.startsWith(prefix))
		);
	}
	const needFields =
		Object.keys(spec.filter).length > 0 ||
		spec.columns.some((c) => c !== 'title') ||
		spec.sort !== 'title' ||
		spec.describe !== undefined ||
		spec.groupBy !== undefined;
	const fieldsByPath = needFields
		? await ctx.fieldsFor(candidates.map((c) => c.path))
		: new Map<string, PageFields>();
	const rows = candidates
		.map((c) => ({
			path: c.path,
			title: c.title,
			fields: fieldsByPath.get(c.path) ?? new Map<string, string[]>()
		}))
		.filter((r) => matchesFilter(r.fields, spec.filter));
	rows.sort((a, b) => compareRows(a, b, spec.sort));
	if (spec.order === 'desc') rows.reverse();
	return rows;
}

// ---------- rendering ----------

function escapeCell(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// A markdown link to a row's page. CommonMark ends a bare link destination at
// the first space, so a path containing spaces or parens (common in Obsidian
// vaults — "Acme Care Platform/index.md") must be wrapped in <>. Slug-based paths
// (no such chars) are left bare, so existing snapshots stay byte-identical.
function linkTo(row: ViewRow, fromPath: string): string {
	// A folder with no folder note (kind: folders) has no page to link to — show
	// its name as plain text so the index stays complete without a dead link.
	if (!row.path) return escapeCell(row.title);
	const href = relativeHref(fromPath, row.path);
	const dest = /[ ()]/.test(href) ? `<${href.replace(/[<>]/g, '')}>` : href;
	return `[${escapeCell(row.title)}](${dest})`;
}

// One flat run of rows as the chosen shape (grouping handled by the caller).
function renderFlat(spec: ViewSpec, rows: ViewRow[], fromPath: string): string {
	if (spec.as === 'table') {
		const header = spec.columns.map((c) => (c === 'title' ? 'Title' : escapeCell(c)));
		const out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
		for (const r of rows) {
			const cells = spec.columns.map((c) =>
				c === 'title' ? linkTo(r, fromPath) : escapeCell((r.fields.get(c) ?? []).join(', '))
			);
			out.push(`| ${cells.join(' | ')} |`);
		}
		return out.join('\n');
	}
	return rows
		.map((r) => {
			const desc = spec.describe ? (r.fields.get(spec.describe) ?? []).join(', ') : '';
			return desc ? `- ${linkTo(r, fromPath)} - ${escapeCell(desc)}` : `- ${linkTo(r, fromPath)}`;
		})
		.join('\n');
}

// Order rows into group-by buckets: alphabetical by group value, pages missing
// the key last under "(none)". A page with a LIST value appears in each group.
function groupRows(rows: ViewRow[], key: string): [string, ViewRow[]][] {
	const groups = new Map<string, ViewRow[]>();
	for (const r of rows) {
		const values = r.fields.get(key) ?? [];
		for (const g of values.length ? values : ['(none)']) {
			groups.set(g, [...(groups.get(g) ?? []), r]);
		}
	}
	return [...groups.entries()].sort(([a], [b]) =>
		a === '(none)' ? 1 : b === '(none)' ? -1 : a.localeCompare(b)
	);
}

function renderRows(spec: ViewSpec, rows: ViewRow[], fromPath: string): string {
	if (spec.as === 'count') {
		if (spec.groupBy) {
			// Per-group tallies, e.g. orgs per sector.
			return groupRows(rows, spec.groupBy)
				.map(([g, rs]) => `- ${escapeCell(g)}: **${rs.length}**`)
				.join('\n');
		}
		return spec.label ? `**${rows.length}** ${spec.label}` : `**${rows.length}**`;
	}
	if (rows.length === 0) return '*No matching pages.*';
	if (spec.groupBy) {
		return groupRows(rows, spec.groupBy)
			.map(([g, rs]) => `### ${g}\n\n${renderFlat(spec, rs, fromPath)}`)
			.join('\n\n');
	}
	return renderFlat(spec, rows, fromPath);
}

function renderOne(view: ParsedView, pagePath: string, ctx: ViewContext): Promise<string> {
	if (!view.spec) return Promise.resolve(`*This view could not be computed: ${view.error}.*`);
	return resolveRows(view.spec, pagePath, ctx).then((rows) =>
		renderRows(view.spec!, rows, pagePath)
	);
}

export interface RenderedViews {
	// Content for HUMAN display (the app's page renderer): each fence + snapshot
	// replaced by just the freshly computed rendering.
	display: string;
	// Content for the FILE (write path) and for agents (read_page): fence kept,
	// snapshot region replaced with the fresh rendering between markers.
	snapshotted: string;
	// How many view directives the page contains.
	count: number;
}

// The tools' one-call entry point: freshness guard + context + render. Returns
// null when the page has no views, and null on ANY failure (index unavailable,
// unexpected data) so callers always have the raw content to fall back to — a
// view must never make a page unreadable or block a save.
export interface ViewDeps {
	db: D1Database;
	store: BrainStore;
	repoArgs: RepoRef;
	brainId: string;
	config: BrainConfig;
}

export async function tryRenderViews(
	content: string,
	pagePath: string,
	deps: ViewDeps
): Promise<RenderedViews | null> {
	if (!hasViews(content)) return null;
	try {
		await ensureFresh(deps.db, deps.store, deps.repoArgs, deps.brainId, deps.config);
		const ctx = await buildViewContext(deps.db, deps.brainId, deps.config);
		return await renderViews(content, pagePath, ctx);
	} catch (err) {
		console.warn(`[views] failed to compute views for ${pagePath}:`, err);
		return null;
	}
}

// Compute every view on a page. Deterministic for a given index state, so
// re-snapshotting an unchanged brain yields byte-identical content (idempotent
// writes). Callers gate on hasViews() and MUST ensureFresh() first.
export async function renderViews(
	content: string,
	pagePath: string,
	ctx: ViewContext
): Promise<RenderedViews> {
	const segments = segmentViews(content);
	const display: string[] = [];
	const snapshotted: string[] = [];
	let count = 0;
	for (const s of segments) {
		if (s.type === 'text') {
			display.push(s.text);
			snapshotted.push(s.text);
			continue;
		}
		count++;
		const rendered = await renderOne(s.view, pagePath, ctx);
		display.push(rendered);
		snapshotted.push(`${s.fence}\n\n${SNAPSHOT_BEGIN}\n${rendered}\n${SNAPSHOT_END}`);
	}
	return { display: display.join('\n'), snapshotted: snapshotted.join('\n'), count };
}
