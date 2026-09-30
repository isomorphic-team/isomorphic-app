import { useEffect, useRef, useState } from 'preact/hooks';
import { parseFrontmatter, type Frontmatter } from '../../src/lib/wiki.ts';
import { displayFromSnapshots } from '../../src/lib/view-directives.ts';
import { isUsableFieldKey, OKF_PAGE_STATUSES } from '../../src/lib/page-patch.ts';
import type { Backref } from '../core/types.ts';
import { callTool } from '../core/host.ts';
import { brainArgs, bump, isEditablePath } from '../core/store.ts';
import {
	refreshPage,
	navigateTo,
	renderMarkdown,
	onProseClick,
	openEditor
} from '../core/actions.ts';
import { renderAge } from '../core/util.ts';
import { RefreshIcon } from '../core/icons.tsx';
import { hydrateImages } from '../core/media.ts';
import { toast } from '../core/toast.tsx';
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

// How a row is written back, when it can be written back at all. `field` goes
// through write_page's `fields` (brain-owned metadata); `arg` goes through the
// argument that owns that key, because setting those does more than write a value
// (a retitle repoints links, status is a lifecycle enum). Same split the tool
// enforces, so the panel can never offer an edit the write would refuse.
type EditSpec = {
	key: string;
	value: string;
	kind: 'field' | 'arg';
	list?: boolean;
	options?: string[];
};
type Row = { key: string; label: string; value: preact.ComponentChildren; edit?: EditSpec };

// The frontmatter keys write_page sets through their own argument rather than `fields`.
const PROPERTY_ARG_KEYS: readonly string[] = ['type', 'status', 'description'];

/** A pending property value: text, a list, or null to remove the key. */
type PropertyValue = string | string[] | null;
type PropertyChange = (key: string, value: PropertyValue) => void;

// Parse what the author typed into the value the write will carry: a list splits on
// commas, and an emptied `field` means remove.
function parsePropertyInput(spec: EditSpec, raw: string): PropertyValue {
	const trimmed = raw.trim();
	if (spec.list)
		return trimmed
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	return trimmed === '' ? null : trimmed;
}

// The pending changes applied over the page's frontmatter: what the editor shows.
function applyPropertyChanges(
	fm: Frontmatter | null,
	changes: Record<string, PropertyValue>
): Frontmatter | null {
	if (!Object.keys(changes).length) return fm;
	const next: Frontmatter = { ...(fm ?? {}) };
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return next;
}

// The pending changes as write_page arguments, split the way the tool takes them.
function propertyWriteArgs(changes: Record<string, PropertyValue>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const fields: Record<string, PropertyValue> = {};
	for (const [key, value] of Object.entries(changes)) {
		if (PROPERTY_ARG_KEYS.includes(key)) args[key] = value;
		else fields[key] = value;
	}
	if (Object.keys(fields).length) args.fields = fields;
	return args;
}

function PropertyRow({ row, onChange }: { row: Row; onChange?: PropertyChange }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(row.edit?.value ?? '');
	const editable = !!onChange && !!row.edit;

	function commit(next: string) {
		setEditing(false);
		if (!onChange || !row.edit) return;
		if (next.trim() === row.edit.value.trim()) return;
		// write_page ignores an empty title/type/description/status, so an empty
		// value here would save as the old one.
		if (!next.trim() && row.edit.kind === 'arg') {
			toast(`${row.label} cannot be emptied here.`, true);
			setDraft(row.edit.value);
			return;
		}
		onChange(row.edit.key, parsePropertyInput(row.edit, next));
	}

	return (
		<div class="group contents">
			<dt class={`pt-px ${eyebrow}`}>{row.label}</dt>
			<dd class="min-w-0 break-words text-fg">
				{editing && row.edit ? (
					row.edit.options ? (
						<select
							autofocus
							value={draft}
							class="rounded-md border border-border bg-transparent px-1 py-0.5 text-sm text-fg"
							onChange={(e) => commit((e.target as HTMLSelectElement).value)}
							onBlur={() => setEditing(false)}
						>
							{row.edit.options.map((o) => (
								<option key={o} value={o}>
									{o}
								</option>
							))}
						</select>
					) : (
						<input
							autofocus
							value={draft}
							class="w-full rounded-md border border-border bg-transparent px-1 py-0.5 text-sm text-fg"
							onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
								if (e.key === 'Escape') setEditing(false);
							}}
							onBlur={(e) => commit((e.target as HTMLInputElement).value)}
						/>
					)
				) : (
					<span class="flex items-baseline gap-2">
						{editable ? (
							<button
								type="button"
								onClick={() => {
									setDraft(row.edit?.value ?? '');
									setEditing(true);
								}}
								class="cursor-pointer rounded border-none bg-transparent p-0 text-left text-sm text-fg hover:bg-chip"
							>
								{row.value}
							</button>
						) : (
							row.value
						)}
						{editable && row.edit?.kind === 'field' && (
							<button
								type="button"
								title={`Remove ${row.label}`}
								aria-label={`Remove ${row.label}`}
								onClick={() => onChange!(row.key, null)}
								class="cursor-pointer border-none bg-transparent p-0 text-xs text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
							>
								×
							</button>
						)}
					</span>
				)}
			</dd>
		</div>
	);
}

// Add a key the brain has not used on this page yet. The key rule is imported from
// the write path rather than restated, so the panel cannot accept a name the tool
// would reject (or one whose row would vanish on the next read).
function AddProperty({ onChange }: { onChange: PropertyChange }) {
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState('');
	const [value, setValue] = useState('');

	function submit() {
		const name = key.trim();
		if (!name) return;
		// An empty value is the REMOVE case: the property would never appear.
		if (!value.trim()) {
			toast('Give the property a value.', true);
			return;
		}
		if (!isUsableFieldKey(name)) {
			toast(
				`"${name}" cannot be used as a property name here: use letters, digits, dashes and underscores, and not title / type / description / status / updated.`,
				true
			);
			return;
		}
		onChange(name, value.trim());
		setOpen(false);
		setKey('');
		setValue('');
	}

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				class={`mt-2 cursor-pointer border-none bg-transparent p-0 text-left ${eyebrow} hover:text-fg`}
			>
				+ Add property
			</button>
		);
	}
	return (
		<div class="mt-2 flex items-center gap-2">
			<input
				autofocus
				placeholder="name"
				value={key}
				onInput={(e) => setKey((e.target as HTMLInputElement).value)}
				class="w-32 rounded-md border border-border bg-transparent px-1 py-0.5 text-sm text-fg"
			/>
			<input
				placeholder="value"
				value={value}
				onInput={(e) => setValue((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') submit();
					if (e.key === 'Escape') setOpen(false);
				}}
				class="min-w-0 flex-1 rounded-md border border-border bg-transparent px-1 py-0.5 text-sm text-fg"
			/>
			<button
				type="button"
				onClick={submit}
				class={`cursor-pointer border-none bg-transparent p-0 ${eyebrow} hover:text-fg`}
			>
				Add
			</button>
		</div>
	);
}

// The page's frontmatter as a structured properties panel (Notion-style), NOT
// pills: a label/value grid that reads any brain's free-form frontmatter. Known
// fields get a stable order and light treatment (a status dot, tabular dates);
// everything else is rendered generically so no metadata is hidden.
//
// Read-only in the viewer. The editor passes `onChange`, which makes the rows
// editable as a draft that its Save writes together with the body.
function PageProperties({ fm, onChange }: { fm: Frontmatter | null; onChange?: PropertyChange }) {
	const rows: Row[] = [];
	// `title` is rendered as the page heading, so it never appears as a property.
	const seen = new Set<string>(['title']);
	const add = (key: string, label: string, value: preact.ComponentChildren, edit?: EditSpec) => {
		seen.add(key);
		rows.push({ key, label, value, edit });
	};

	if (fm) {
		if (typeof fm.status === 'string' && fm.status.trim()) {
			const knownStatus = (OKF_PAGE_STATUSES as readonly string[]).includes(fm.status);
			const legacyPublished = fm.status === 'published';
			const statusColor =
				fm.status === 'draft'
					? 'bg-[#b05c00]'
					: fm.status === 'stable' || fm.status === 'published'
						? 'bg-[#0a7d33]'
						: 'bg-[#737373]';
			add(
				'status',
				'Status',
				<span class="inline-flex items-center gap-1.5">
					<span class={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
					<span class="capitalize">{fm.status}</span>
				</span>,
				// Legacy `published` remains editable only as a migration source: keeping
				// it in the options lets the select represent its current value, while any
				// actual change lands on an OKF status. Other vocabularies stay read-only.
				knownStatus || legacyPublished
					? {
							key: 'status',
							value: fm.status,
							kind: 'arg',
							options: [...(legacyPublished ? ['published'] : []), ...OKF_PAGE_STATUSES]
						}
					: undefined
			);
		}
		for (const key of ['created', 'updated', 'date']) {
			const v = (fm as Record<string, unknown>)[key];
			if (typeof v === 'string' && v.trim())
				add(
					key,
					humanizeKey(key),
					<span class="tabular-nums">{v}</span>,
					// `updated` is stamped by the writer on every save.
					key === 'updated' ? undefined : { key, value: v, kind: 'field' }
				);
		}
		if (Array.isArray(fm.tags) && fm.tags.length) {
			const tags = fm.tags.filter((t): t is string => typeof t === 'string');
			if (tags.length)
				add('tags', 'Tags', tags.join(', '), {
					key: 'tags',
					value: tags.join(', '),
					kind: 'field',
					list: true
				});
		}
		// Sources render as a count and are often the nested OKF block the write path
		// keeps verbatim, so they are shown and never edited from here.
		if (Array.isArray(fm.sources) && fm.sources.length)
			add('sources', 'Sources', `${fm.sources.length} source${fm.sources.length === 1 ? '' : 's'}`);
		if (typeof fm.description === 'string' && fm.description.trim())
			add('description', 'Description', fm.description.trim(), {
				key: 'description',
				value: fm.description.trim(),
				kind: 'arg'
			});

		// Any remaining scalar frontmatter, so arbitrary brains still show their metadata.
		for (const [key, value] of Object.entries(fm)) {
			if (seen.has(key)) continue;
			const text = scalarText(value);
			if (!text) continue;
			const list = Array.isArray(value);
			add(
				key,
				humanizeKey(key),
				text,
				// `type` is OKF's required field and has its own argument; everything else
				// on a page is brain-owned and goes through `fields`.
				PROPERTY_ARG_KEYS.includes(key)
					? { key, value: text, kind: 'arg' }
					: isUsableFieldKey(key)
						? { key, value: text, kind: 'field', list }
						: undefined
			);
		}
	}

	if (!rows.length && !onChange) return null;
	// One Notion-style treatment in BOTH view and edit: no boxed card, just the
	// label/value grid with a divider under it. Identical across modes so the
	// frontmatter doesn't restyle/jump when you enter or leave the editor.
	return (
		<div class="mb-5 border-b border-border pb-4">
			<dl class="grid grid-cols-[minmax(0,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
				{rows.map((r) => (
					<PropertyRow key={r.key} row={r} onChange={onChange} />
				))}
			</dl>
			{onChange && <AddProperty onChange={onChange} />}
		</div>
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

// How often the header's age label is allowed to fall behind the clock. Nothing
// re-renders the app while somebody reads, so without this the label would freeze at
// whatever it said when the page mounted and go on claiming a render was fresh long
// after it stopped being: exactly the wrong lie for a control whose whole job is
// reporting age. Local only, no tool call.
const AGE_TICK_MS = 30_000;

function PageView({ path, markdown }: { path: string; markdown: string }) {
	useEffect(() => {
		const id = setInterval(bump, AGE_TICK_MS);
		return () => clearInterval(id);
	}, []);
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

export {
	PageView,
	PageProperties,
	LinkedReferences,
	humanizeKey,
	scalarText,
	applyPropertyChanges,
	propertyWriteArgs,
	type PropertyValue
};

declare module '../core/view-registry.ts' {
	interface ViewProps {
		// `sha` is the blob this render is OF and `fetchedAt` is when it was taken.
		// Both optional: a render can arrive from a Worker that predates them, and a
		// viewer that cannot vouch for its own age says nothing rather than guessing.
		page: { path: string; markdown: string; sha?: string; fetchedAt?: number };
	}
}

export default defineView('page', (v) => <PageView path={v.path} markdown={v.markdown} />, {
	actions: (v) => {
		const age = renderAge(v.fetchedAt, Date.now());
		return [
			// Reloads in place. The age rides ON the control rather than sitting apart
			// from it, because the two are one thought ("this is how old what you are
			// reading is, press to fix that"), and it appears only once the render is old
			// enough for the answer to be worth the space (see renderAge).
			{
				key: 'refresh',
				icon: <RefreshIcon />,
				label: age ?? undefined,
				title: age ? `Refresh this page (fetched ${age} ago)` : 'Refresh this page',
				onClick: () => void refreshPage()
			},
			// Same policy verdict the Worker's write tools use, so the app can never offer
			// an Edit that a write would reject.
			...(isEditablePath(v.path)
				? [{ key: 'edit', label: 'Edit', onClick: () => openEditor(v.path) }]
				: [])
		];
	}
});
