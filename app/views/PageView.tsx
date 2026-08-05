import { useEffect, useRef, useState } from 'preact/hooks';
import { parseFrontmatter, type Frontmatter } from '../../src/lib/wiki.ts';
import { displayFromSnapshots } from '../../src/lib/view-directives.ts';
import type { Backref } from '../core/types.ts';
import { callTool } from '../core/host.ts';
import { brainArgs, isEditablePath } from '../core/store.ts';
import { navigateTo, renderMarkdown, onProseClick, openEditor } from '../core/actions.ts';
import { hydrateImages } from '../core/media.ts';
import { defineView } from '../core/view-registry.ts';
import { eyebrow } from '../ui/typography.ts';

// Turn a frontmatter key into a readable label: "created_at" → "Created at".
function humanizeKey(key: string): string {
	const s = key.replace(/[_-]+/g, ' ').trim();
	return s.charAt(0).toUpperCase() + s.slice(1);
}

// Coerce a frontmatter value to display text; returns null for shapes we don't
// render inline (nested objects, empty arrays), so the caller can skip the row.
function scalarText(value: unknown): string | null {
	if (Array.isArray(value)) {
		const parts = value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
		return parts.length ? parts.join(', ') : null;
	}
	if (typeof value === 'string') return value.trim() || null;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

// The page's frontmatter as a structured properties panel (Notion-style), NOT
// pills: a label/value grid that reads any brain's free-form frontmatter. Known
// fields get a stable order and light treatment (a status dot, tabular dates);
// everything else is rendered generically so no metadata is hidden.
function PageProperties({ fm }: { fm: Frontmatter | null }) {
	if (!fm) return null;
	const rows: { key: string; label: string; value: preact.ComponentChildren }[] = [];
	// `title` is rendered as the page heading, so it never appears as a property.
	const seen = new Set<string>(['title']);
	const add = (key: string, label: string, value: preact.ComponentChildren) => {
		seen.add(key);
		rows.push({ key, label, value });
	};

	if (typeof fm.status === 'string' && fm.status.trim()) {
		const published = fm.status === 'published';
		add(
			'status',
			'Status',
			<span class="inline-flex items-center gap-1.5">
				<span class={`h-1.5 w-1.5 rounded-full ${published ? 'bg-[#0a7d33]' : 'bg-[#b05c00]'}`} />
				<span class="capitalize">{fm.status}</span>
			</span>
		);
	}
	for (const key of ['created', 'updated', 'date']) {
		const v = (fm as Record<string, unknown>)[key];
		if (typeof v === 'string' && v.trim())
			add(key, humanizeKey(key), <span class="tabular-nums">{v}</span>);
	}
	if (Array.isArray(fm.tags) && fm.tags.length) {
		const tags = fm.tags.filter((t): t is string => typeof t === 'string');
		if (tags.length) add('tags', 'Tags', tags.join(', '));
	}
	if (Array.isArray(fm.sources) && fm.sources.length)
		add('sources', 'Sources', `${fm.sources.length} source${fm.sources.length === 1 ? '' : 's'}`);
	if (typeof fm.description === 'string' && fm.description.trim())
		add('description', 'Description', fm.description.trim());

	// Any remaining scalar frontmatter, so arbitrary brains still show their metadata.
	for (const [key, value] of Object.entries(fm)) {
		if (seen.has(key)) continue;
		const text = scalarText(value);
		if (text) add(key, humanizeKey(key), text);
	}

	if (!rows.length) return null;
	// One Notion-style treatment in BOTH view and edit: no boxed card, just the
	// label/value grid with a divider under it. Identical across modes so the
	// frontmatter doesn't restyle/jump when you enter or leave the editor.
	return (
		<dl class="mb-5 grid grid-cols-[minmax(0,max-content)_1fr] gap-x-4 gap-y-1.5 border-b border-border pb-4 text-sm">
			{rows.map((r) => (
				<div key={r.key} class="contents">
					<dt class={`pt-px ${eyebrow}`}>{r.label}</dt>
					<dd class="min-w-0 break-words text-fg">{r.value}</dd>
				</div>
			))}
		</dl>
	);
}

// Backlinks panel: the pages that link INTO this one (Obsidian's "Linked
// references"). Fetches find_inbound_links lazily per page; each ref navigates.
function LinkedReferences({ path }: { path: string }) {
	const [state, setState] = useState<{ loading: boolean; refs: Backref[]; truncated: boolean }>({
		loading: true,
		refs: [],
		truncated: false
	});

	useEffect(() => {
		let cancelled = false;
		setState({ loading: true, refs: [], truncated: false });
		callTool('find_inbound_links', { path, ...brainArgs() })
			.then((result) => {
				if (cancelled || result.isError) {
					if (!cancelled) setState({ loading: false, refs: [], truncated: false });
					return;
				}
				const sc = (result.structuredContent ?? {}) as { refs?: Backref[]; truncated?: boolean };
				setState({
					loading: false,
					refs: Array.isArray(sc.refs) ? sc.refs : [],
					truncated: !!sc.truncated
				});
			})
			.catch(() => {
				if (!cancelled) setState({ loading: false, refs: [], truncated: false });
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	// While loading, stay invisible rather than flashing an empty shell.
	if (state.loading) return null;

	return (
		<section class="mt-8 border-t border-border pt-4">
			<h2 class={`mb-2.5 ${eyebrow}`}>
				Linked references{state.refs.length ? ` · ${state.refs.length}` : ''}
			</h2>
			{state.refs.length === 0 ? (
				<p class="text-sm text-muted">No other page links here yet.</p>
			) : (
				<ul class="flex flex-col gap-0.5">
					{state.refs.map((r) => (
						<li key={r.path}>
							<button
								type="button"
								onClick={() => navigateTo(r.path)}
								class="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-md border-none bg-transparent px-2 py-1 text-left text-sm text-fg hover:bg-chip"
							>
								<span class="truncate">{r.title}</span>
								<span class="shrink-0 tabular-nums text-xs text-muted">
									{r.mdCount + r.wikiCount}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{state.truncated && (
				<p class="mt-2 text-xs text-muted">
					This brain is large; only part of it was scanned, so some references may be missing.
				</p>
			)}
		</section>
	);
}

// The rendered markdown, with its images filled in afterwards.
//
// Hydration runs in an effect rather than during render because the bytes arrive from
// a tool call: rewriting the markdown up front would hold the whole page back until
// the last picture landed. Keyed on the body too, so a save that changes an image
// re-runs it.
function MarkdownBody({ path, body }: { path: string; body: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (ref.current) void hydrateImages(ref.current, path);
	}, [path, body]);
	return <div ref={ref} dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />;
}

function PageView({ path, markdown }: { path: string; markdown: string }) {
	const { frontmatter, body: rawBody } = parseFrontmatter(markdown);
	// Derived views: content from read_page carries okf-view fences with freshly
	// computed snapshots beneath them (the server recomputes at read time) —
	// unwrap to the display form (snapshot shown, fence hidden). Content from
	// view_page is already display-form and passes through unchanged.
	const body = displayFromSnapshots(rawBody);
	const title = typeof frontmatter?.title === 'string' ? frontmatter.title : null;
	const showTitle = title && !/^#\s/m.test(body);
	return (
		<div>
			<PageProperties fm={frontmatter} />
			<article class="prose max-w-none" onClick={onProseClick(path)}>
				{showTitle && <h1>{title}</h1>}
				<MarkdownBody path={path} body={body} />
			</article>
			<LinkedReferences path={path} />
		</div>
	);
}

export { PageView, PageProperties, LinkedReferences, humanizeKey, scalarText };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		page: { path: string; markdown: string };
	}
}

export default defineView('page', (v) => <PageView path={v.path} markdown={v.markdown} />, {
	// Same policy verdict the Worker's write tools use, so the app can never offer an
	// Edit that a write would reject.
	actions: (v) =>
		isEditablePath(v.path)
			? [{ key: 'edit', label: 'Edit', onClick: () => openEditor(v.path) }]
			: []
});
