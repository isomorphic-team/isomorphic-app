// ---------- file tree (browse) ----------
//
// An Obsidian-style file explorer. The action buttons (new note, new folder, sort,
// expand/collapse-all, show-hidden) don't live in the body — they slide into the nav
// header contextually while this view is open, exactly like the editor's formatting
// toolbar. The seam is `treeCtl` (mirrors `editCtl` in EditView): FileTree binds its
// handlers + toggle state here, and the Header (main.tsx) renders them. Per-item
// actions (rename, delete, new note/folder in a folder) live in one hover `⋯` menu.

import { useEffect, useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { slugify } from '../../src/lib/wiki.ts';
import { isHiddenName, rootsOf } from '../../src/lib/brain-policy.ts';
import { defineView } from '../core/view-registry.ts';
import type { TreeNode, TreeActions } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import {
	brainPolicy,
	brainArgs,
	activeBrainCanManage,
	isEditablePath,
	bump
} from '../core/store.ts';
import { navigateTo, refreshBrowse } from '../core/actions.ts';
import { FOLDER_NOTE_NAMES } from '../core/util.ts';
import { toast, askConfirm } from '../core/toast.tsx';
import {
	ChevronIcon,
	FolderIcon,
	FileIcon,
	PencilIcon,
	TrashIcon,
	NewNoteIcon,
	NewFolderIcon,
	MoreIcon,
	LockIcon
} from '../core/icons.tsx';

// Shared handle to the live file tree so the nav header can host its toolbar while
// the tree itself stays in the body. FileTree populates the handlers + toggle state
// each render (via the bind effect); the header reads them. `bound` gates the header
// toolbar so it appears only while a tree is actually mounted.
const treeCtl: {
	bound: boolean;
	canManage: boolean;
	hasHidden: boolean;
	showHidden: boolean;
	sortDesc: boolean;
	allExpanded: boolean;
	newNote: () => void;
	newFolder: () => void;
	toggleSort: () => void;
	toggleExpandAll: () => void;
	toggleHidden: () => void;
} = {
	bound: false,
	canManage: false,
	hasHidden: false,
	showHidden: false,
	sortDesc: false,
	allExpanded: false,
	newNote: () => {},
	newFolder: () => {},
	toggleSort: () => {},
	toggleExpandAll: () => {},
	toggleHidden: () => {}
};

// Build the folder/file tree from the visible content pages plus the `hidden`
// list (everything else in the repo: system files like .isomorphic.json, .gitkeep
// markers, immutable source, the log). A FILE is hidden iff it came from that
// list; a FOLDER is hidden iff no content page could live under it (source/
// ignored/dot-named) — so a content folder persisted only by a `.gitkeep` still
// shows, while raw/ appears only with "show hidden" on.
function buildTree(paths: string[], hidden: string[], sortDesc: boolean): TreeNode[] {
	const hiddenSet = new Set(hidden);
	const root: TreeNode = { name: '', path: '', dir: true, children: [], hidden: false };
	for (const p of [...paths, ...hidden]) {
		const parts = p.split('/').filter(Boolean);
		let node = root;
		parts.forEach((part, i) => {
			const isFile = i === parts.length - 1;
			let child = node.children.find((c) => c.name === part && c.dir === !isFile);
			if (!child) {
				const path = parts.slice(0, i + 1).join('/');
				child = {
					name: part,
					path,
					dir: !isFile,
					children: [],
					hidden: isFile
						? hiddenSet.has(path)
						: isHiddenName(part) || !isEditablePath(`${path}/x.md`)
				};
				node.children.push(child);
			}
			node = child;
		});
	}
	// Folders first, then files, alphabetical — the sort button flips direction.
	const dir = sortDesc ? -1 : 1;
	const sort = (n: TreeNode) => {
		n.children.sort((a, b) =>
			a.dir === b.dir ? a.name.localeCompare(b.name) * dir : a.dir ? -1 : 1
		);
		n.children.forEach(sort);
	};
	sort(root);
	return root.children;
}

// A folder path plus every folder above it ("wiki/playbook" → ["wiki",
// "wiki/playbook"]) — the chain to expand so a revealed folder is actually on screen,
// its own contents included.
function ancestorChain(folder?: string): string[] {
	const segs = (folder ?? '').split('/').filter(Boolean);
	return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

// Every folder path in the tree — for expand/collapse-all.
function collectFolders(nodes: TreeNode[], out: string[] = []): string[] {
	for (const n of nodes) {
		if (n.dir) {
			out.push(n.path);
			collectFolders(n.children, out);
		}
	}
	return out;
}

// A folder note (<folder>/index.md) seeded with a directory-index view, so the
// folder materializes with a real page that lists whatever it holds (git has no
// empty folders, and a bare .gitkeep folder carries no meaning). Shared by "New
// folder" and the "Add folder note" affordance.
function folderNoteSeed(folder: string): { path: string; title: string; content: string } {
	const base = folder.replace(/\/+$/, '');
	const name = base.split('/').pop()!;
	const title = name.charAt(0).toUpperCase() + name.slice(1);
	const content = `\`\`\`okf-view\nkind: pages\nunder: ${base}/\ndescribe: description\n\`\`\`\n`;
	return { path: `${base}/index.md`, title, content };
}

// The inline "new note"/"new folder" input row. Shown under its parent folder (or at
// the tree root). Commits on Enter, cancels on Escape or empty blur.
function AddInput({
	kind,
	depth,
	value,
	setValue,
	commit,
	cancel,
	busy
}: {
	kind: 'note' | 'folder';
	depth: number;
	value: string;
	setValue: (v: string) => void;
	commit: () => void;
	cancel: () => void;
	busy: boolean;
}) {
	return (
		<div
			style={{ paddingLeft: `${6 + depth * 14 + 18}px` }}
			class="flex items-center gap-1.5 py-1 pr-2"
		>
			{kind === 'folder' ? <FolderIcon /> : <FileIcon />}
			<input
				autofocus
				value={value}
				disabled={busy}
				placeholder={kind === 'folder' ? 'Folder name…' : 'Note name (or sub/path)…'}
				onInput={(e) => setValue((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') commit();
					if (e.key === 'Escape') cancel();
				}}
				onBlur={() => !value.trim() && cancel()}
				class="flex-1 rounded border border-accent bg-bg px-1 py-0.5 text-[13.5px] text-fg outline-none"
			/>
		</div>
	);
}

// The per-row hover menu (⋯). Wrapped in a [data-row-menu] span so the tree's single
// outside-click listener can tell an in-menu click from an outside one.
function RowMenu({
	open,
	toggle,
	items
}: {
	open: boolean;
	toggle: () => void;
	items: {
		label: string;
		icon?: preact.ComponentChildren;
		danger?: boolean;
		onClick: () => void;
	}[];
}) {
	return (
		<span data-row-menu class="relative shrink-0">
			<button
				type="button"
				title="More"
				onClick={(e) => {
					e.stopPropagation();
					toggle();
				}}
				class={`rounded px-1 py-0.5 text-muted hover:text-fg ${
					open ? 'text-fg' : 'opacity-0 group-hover:opacity-100'
				}`}
			>
				<MoreIcon />
			</button>
			{open && (
				<div class="absolute top-full right-0 z-30 mt-0.5 min-w-[168px] overflow-hidden rounded-md border border-border bg-bg py-1 shadow-lg">
					{items.map((it) => (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								it.onClick();
							}}
							class={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-chip ${
								it.danger ? 'text-[#d33]' : 'text-fg'
							}`}
						>
							{it.icon && <span class="w-4 text-muted">{it.icon}</span>}
							<span class="flex-1">{it.label}</span>
						</button>
					))}
				</div>
			)}
		</span>
	);
}

function TreeItem({
	node,
	depth,
	expanded,
	toggle,
	actions,
	titleByPath
}: {
	node: TreeNode;
	depth: number;
	expanded: Set<string>;
	toggle: (path: string) => void;
	actions: TreeActions;
	titleByPath: Record<string, string>;
}) {
	// Hidden entries (system files, source, dotfiles) only render with "show hidden" on.
	if (node.hidden && !actions.showHidden) return null;
	// Content-area test: a folder is editable if a page could live under it.
	const editable = isEditablePath(node.dir ? `${node.path}/x.md` : node.path);

	// ---- inline rename (files and folders) ----
	if (actions.editing?.path === node.path) {
		const pad = `${6 + depth * 14 + (node.dir ? 4 : 18)}px`;
		return (
			<div style={{ paddingLeft: pad }} class="flex items-center gap-1.5 py-1 pr-2">
				{node.dir ? <FolderIcon /> : <FileIcon />}
				<input
					autofocus
					value={actions.editValue}
					onInput={(e) => actions.setEditValue((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') actions.commitRename();
						if (e.key === 'Escape') actions.cancelRename();
					}}
					onBlur={() => actions.cancelRename()}
					class="flex-1 rounded border border-accent bg-bg px-1 py-0.5 text-[13.5px] text-fg outline-none"
				/>
			</div>
		);
	}

	// ---- folder row ----
	if (node.dir) {
		const open = expanded.has(node.path);
		// Only editable folders accept a drop (dropping into read-only source would fail).
		const isDrop = actions.dropTarget === node.path && editable;
		// Folder note (Obsidian-style): a folder with a direct index.md/README.md
		// child IS that page — clicking the folder name opens it (and expands), the
		// chevron still only expands/collapses, and that row is hidden from the
		// children (it would read as a redundant sibling of its own folder).
		const folderPage = FOLDER_NOTE_NAMES.map(
			(n) => node.children.find((c) => !c.dir && c.name === n)?.path
		).find(Boolean);
		const children = node.children.filter(
			(c) => c.path !== folderPage && (actions.showHidden || !c.hidden)
		);
		const dim = node.hidden || !editable;
		// The folder the tree was opened at: marked so the tree can scroll to it, and
		// tinted so the eye lands where the click pointed.
		const focused = actions.focus === node.path;
		return (
			<div>
				<div
					{...(focused ? { 'data-tree-focus': true } : {})}
					class={`group flex items-center rounded ${
						isDrop ? 'bg-accent/20 ring-1 ring-accent' : focused ? 'bg-chip' : 'hover:bg-chip'
					}`}
					onDragOver={(e) => {
						if (actions.dragging && editable) {
							e.preventDefault();
							actions.onDragOverFolder(node.path);
						}
					}}
					onDrop={(e) => {
						if (!editable) return;
						e.preventDefault();
						actions.onDropFolder(node.path);
					}}
				>
					{/* The chevron + folder icon are the drag handle — grab them to move the
					    folder. Clicking them still toggles; the name toggles too but isn't a
					    handle, so the row body stays for clicking / selecting. */}
					<span
						draggable={editable}
						onDragStart={(e) => {
							e.stopPropagation();
							actions.onDragStart(node.path, true);
						}}
						onDragEnd={actions.onDragEnd}
						onClick={() => toggle(node.path)}
						style={{ paddingLeft: `${6 + depth * 14}px` }}
						class={`flex shrink-0 items-center gap-1.5 py-1 ${editable ? 'cursor-grab' : ''}`}
					>
						<ChevronIcon open={open} />
						<FolderIcon />
					</span>
					<button
						type="button"
						onClick={() => {
							if (folderPage) {
								if (!open) toggle(node.path);
								navigateTo(folderPage);
							} else {
								toggle(node.path);
							}
						}}
						class={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left text-[13.5px] ${folderPage ? 'hover:text-accent' : ''}`}
					>
						<span class={`truncate ${dim ? 'text-muted' : ''}`}>{node.name}</span>
						{!editable && <LockIcon />}
					</button>
					{editable && (
						<RowMenu
							open={actions.openMenu === node.path}
							toggle={() => actions.setOpenMenu(actions.openMenu === node.path ? null : node.path)}
							items={[
								{
									label: 'New note',
									icon: <NewNoteIcon />,
									onClick: () => actions.startAdd('note', node.path)
								},
								{
									label: 'New folder',
									icon: <NewFolderIcon />,
									onClick: () => actions.startAdd('folder', node.path)
								},
								// One-click "page for this folder" — only offered while it has none.
								...(!folderPage
									? [
											{
												label: 'Folder note',
												icon: <FileIcon />,
												onClick: () => actions.addFolderNote(node.path)
											}
										]
									: []),
								{
									label: 'Rename',
									icon: <PencilIcon />,
									onClick: () => actions.startRename(node.path, node.name, true)
								},
								{
									label: 'Delete',
									icon: <TrashIcon />,
									danger: true,
									onClick: () => actions.askDelete(node.path, true, node.name)
								}
							]}
						/>
					)}
				</div>
				{open && (
					<>
						{actions.add?.parent === node.path && (
							<AddInput
								kind={actions.add.kind}
								depth={depth + 1}
								value={actions.addValue}
								setValue={actions.setAddValue}
								commit={actions.commitAdd}
								cancel={actions.cancelAdd}
								busy={actions.busy}
							/>
						)}
						{children.map((c) => (
							<TreeItem
								key={c.path}
								node={c}
								depth={depth + 1}
								expanded={expanded}
								toggle={toggle}
								actions={actions}
								titleByPath={titleByPath}
							/>
						))}
					</>
				)}
			</div>
		);
	}

	// ---- file row ----
	// Non-page files (.gitkeep, .isomorphic.json, source assets) render as inert
	// rows: nothing to open, drag, or act on — they're just visible under "show
	// hidden" so the repo's full shape is browsable.
	const isPage = node.path.endsWith('.md');
	const pad = `${6 + depth * 14 + 18}px`;
	const dim = node.hidden || !editable;
	return (
		<div class="group flex items-center rounded pr-2 hover:bg-chip">
			{/* The file icon is the drag handle; clicking it (or the name) opens the page. */}
			<span
				draggable={editable && isPage}
				onDragStart={() => isPage && actions.onDragStart(node.path, false)}
				onDragEnd={actions.onDragEnd}
				onClick={() => isPage && navigateTo(node.path)}
				style={{ paddingLeft: pad }}
				class={`flex shrink-0 items-center py-1 ${editable && isPage ? 'cursor-grab' : ''}`}
			>
				<FileIcon />
			</span>
			<button
				type="button"
				onClick={() => isPage && navigateTo(node.path)}
				class={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left text-[13.5px] ${isPage ? 'hover:text-accent' : 'cursor-default'}`}
			>
				<span class={`truncate ${dim ? 'text-muted' : ''}`}>
					{titleByPath[node.path] ?? node.name.replace(/\.md$/, '')}
				</span>
				{!editable && <LockIcon />}
			</button>
			{editable && isPage && (
				<RowMenu
					open={actions.openMenu === node.path}
					toggle={() => actions.setOpenMenu(actions.openMenu === node.path ? null : node.path)}
					items={[
						{
							label: 'Rename',
							icon: <PencilIcon />,
							onClick: () => actions.startRename(node.path, node.name, false)
						},
						{
							label: 'Delete',
							icon: <TrashIcon />,
							danger: true,
							onClick: () => actions.askDelete(node.path, false, node.name)
						}
					]}
				/>
			)}
		</div>
	);
}

function FileTree({
	paths,
	titleByPath = {},
	hidden = [],
	needsConfig = false,
	focus
}: {
	paths: string[];
	titleByPath?: Record<string, string>;
	hidden?: string[];
	needsConfig?: boolean;
	focus?: string;
}) {
	const [sortDesc, setSortDesc] = useState(false);
	const [showHidden, setShowHidden] = useState(false);
	const tree = useMemo(() => buildTree(paths, hidden, sortDesc), [paths, hidden, sortDesc]);
	const allFolders = useMemo(() => collectFolders(tree), [tree]);

	// Start collapsed — a fully-expanded tree is very tall (and inline would fill the
	// card) — EXCEPT when the tree was opened at a folder (`focus`), where landing
	// collapsed at the root is exactly the "that's not where I clicked" bug.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestorChain(focus)));
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ path: string; dir: boolean } | null>(null);
	const [editValue, setEditValue] = useState('');
	const [add, setAdd] = useState<{ kind: 'note' | 'folder'; parent: string } | null>(null);
	const [addValue, setAddValue] = useState('');
	const [dragging, setDragging] = useState<{ path: string; dir: boolean } | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [configuring, setConfiguring] = useState(false);

	// New top-level pages/folders land under the brain's first content root (e.g.
	// "wiki/", or the repo root for a whole-repo brain) — the only way to seed an
	// empty brain (no folders to hover).
	const contentRoots = rootsOf(brainPolicy, 'content');
	const rootBase = (contentRoots[0] ?? '').replace(/\/$/, '');
	const canManage = contentRoots.length > 0;
	const allExpanded = allFolders.length > 0 && allFolders.every((p) => expanded.has(p));

	// Re-reveal when the target folder changes on an already-mounted tree (the initial
	// state above only covers a fresh mount), then bring the row into view. Expansion is
	// additive: whatever the user opened by hand stays open.
	useEffect(() => {
		if (!focus) return;
		setExpanded((prev) => new Set([...prev, ...ancestorChain(focus)]));
	}, [focus]);
	useEffect(() => {
		if (!focus) return;
		document
			.querySelector('[data-tree-focus]')
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [focus, tree]);

	// One outside-click listener closes any open row menu (its own button + items
	// stopPropagation; anything else closes it).
	useEffect(() => {
		if (!openMenu) return;
		const onDoc = (e: MouseEvent) => {
			if (!(e.target as HTMLElement).closest('[data-row-menu]')) setOpenMenu(null);
		};
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [openMenu]);

	const toggle = (path: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			next.has(path) ? next.delete(path) : next.add(path);
			return next;
		});

	function startAdd(kind: 'note' | 'folder', parent: string) {
		setOpenMenu(null);
		setEditing(null);
		setAddValue('');
		setAdd({ kind, parent });
		if (parent) setExpanded((p) => new Set(p).add(parent));
	}

	async function commitAdd() {
		if (!add) return;
		const raw = addValue.trim();
		if (!raw || busy) return;
		const base = add.parent || rootBase;
		setBusy(true);
		if (add.kind === 'folder') {
			// Preserve the typed name (Obsidian-style folders keep spaces/caps); nesting
			// with "/" is allowed and write_page creates every level.
			const sub = raw
				.split('/')
				.map((s) => s.trim())
				.filter(Boolean)
				.join('/');
			const folder = base ? `${base}/${sub}` : sub;
			// A folder is materialized by its folder note (index.md), not an empty
			// .gitkeep — the folder appears in the tree with a page that indexes it.
			const seed = folderNoteSeed(folder);
			const res = await callTool('write_page', { ...seed, mode: 'create', ...brainArgs() });
			setBusy(false);
			setAdd(null);
			setAddValue('');
			if (res.isError) return toast(firstText(res), true);
			toast('Folder created ✓');
			setExpanded((p) => new Set(p).add(folder));
			refreshBrowse();
			return;
		}
		// A note: accept "sub/path/name" to nest; slug each segment.
		const segs = raw
			.split('/')
			.map((s) => slugify(s))
			.filter(Boolean);
		if (!segs.length) {
			setBusy(false);
			return;
		}
		const path = base ? `${base}/${segs.join('/')}.md` : `${segs.join('/')}.md`;
		const title = raw.split('/').pop()!.trim();
		const res = await callTool('write_page', {
			path,
			title,
			content: '',
			mode: 'create',
			...brainArgs()
		});
		setBusy(false);
		setAdd(null);
		setAddValue('');
		if (res.isError) return toast(firstText(res), true);
		toast('Created ✓');
		// Stay in the tree (don't jump into the new note's page); it appears in place.
		refreshBrowse();
	}

	function cancelAdd() {
		setAdd(null);
		setAddValue('');
	}

	// One-click folder note: <folder>/index.md pre-seeded with a directory-index
	// view, so the note lists exactly what's in the folder, forever, with
	// descriptions pulled from frontmatter.
	async function addFolderNote(folder: string) {
		if (busy) return;
		setOpenMenu(null);
		const seed = folderNoteSeed(folder);
		setBusy(true);
		const res = await callTool('write_page', { ...seed, mode: 'create', ...brainArgs() });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast('Folder note created ✓');
		navigateTo(seed.path);
	}

	function startRename(path: string, name: string, dir: boolean) {
		setOpenMenu(null);
		setAdd(null);
		setEditValue(dir ? name : name.replace(/\.md$/, ''));
		setEditing({ path, dir });
	}

	async function commitRename() {
		if (!editing) return;
		const value = editValue.trim();
		if (!value || busy) return;
		setBusy(true);
		// move_page renames both: a folder path (no .md) renames the whole subtree.
		const res = await callTool('move_page', {
			path: editing.path,
			new_title: value,
			...brainArgs()
		});
		setBusy(false);
		setEditing(null);
		if (res.isError) return toast(firstText(res), true);
		toast('Renamed ✓');
		refreshBrowse();
	}

	async function askDelete(path: string, dir: boolean, name: string) {
		setOpenMenu(null);
		const label = dir ? name : name.replace(/\.md$/, '');
		const ok = await askConfirm({
			title: `Delete ${dir ? 'folder' : 'note'} “${label}”?`,
			body: dir
				? 'Everything inside this folder will be deleted. This cannot be undone.'
				: 'This cannot be undone.',
			confirmLabel: 'Delete'
		});
		if (!ok) return;
		setBusy(true);
		// delete_page deletes both: a folder path (no .md) deletes the whole subtree.
		const res = await callTool('delete_page', { path, ...brainArgs() });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast('Deleted ✓');
		refreshBrowse();
	}

	async function onDropFolder(folder: string) {
		const src = dragging;
		setDropTarget(null);
		setDragging(null);
		if (!src) return;
		const name = src.path.split('/').pop()!;
		const dest = `${folder.replace(/\/+$/, '')}/${name}`;
		// No-op, or dropping a folder into itself / a descendant.
		if (dest === src.path || folder === src.path) return;
		if (src.dir && folder.startsWith(`${src.path}/`)) return;
		setBusy(true);
		// move_page moves both files and folders (a folder path moves the whole subtree).
		const res = await callTool('move_page', { path: src.path, new_path: dest, ...brainArgs() });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast('Moved ✓');
		refreshBrowse();
	}

	// Bind the nav-header toolbar to this tree (mirrors editCtl). Re-runs whenever the
	// toggle state the header renders from changes, and unbinds on unmount so the
	// header drops the toolbar when we leave the view.
	useLayoutEffect(() => {
		treeCtl.bound = true;
		treeCtl.canManage = canManage;
		treeCtl.hasHidden = hidden.length > 0;
		treeCtl.showHidden = showHidden;
		treeCtl.sortDesc = sortDesc;
		treeCtl.allExpanded = allExpanded;
		treeCtl.newNote = () => startAdd('note', '');
		treeCtl.newFolder = () => startAdd('folder', '');
		treeCtl.toggleSort = () => setSortDesc((s) => !s);
		treeCtl.toggleHidden = () => setShowHidden((s) => !s);
		treeCtl.toggleExpandAll = () =>
			setExpanded((prev) =>
				prev.size > 0 && allFolders.every((p) => prev.has(p)) ? new Set() : new Set(allFolders)
			);
		bump();
		return () => {
			treeCtl.bound = false;
			bump();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [canManage, hidden.length, showHidden, sortDesc, allExpanded, allFolders]);

	// Auto-configure the active brain (writes .isomorphic.json for the whole repo), then
	// reload — the index rebuilds against the new roots and the pages appear.
	async function runConfigure() {
		if (configuring) return;
		setConfiguring(true);
		const res = await callTool('configure_brain', { ...brainArgs() });
		setConfiguring(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		refreshBrowse();
	}

	const actions: TreeActions = {
		showHidden,
		focus,
		busy,
		openMenu,
		setOpenMenu,
		editing,
		editValue,
		setEditValue,
		startRename,
		commitRename,
		cancelRename: () => setEditing(null),
		askDelete,
		add,
		addValue,
		setAddValue,
		startAdd,
		commitAdd,
		cancelAdd,
		addFolderNote,
		dragging,
		dropTarget,
		onDragStart: (path, dir) => setDragging({ path, dir }),
		onDragEnd: () => {
			setDragging(null);
			setDropTarget(null);
		},
		onDragOverFolder: (path) => setDropTarget(path),
		onDropFolder
	};

	const roots = tree.filter((n) => showHidden || !n.hidden);

	// No content pages + an unconfigured adopted repo → offer the one-click fix
	// (writes .isomorphic.json indexing the whole repo). Any other empty state
	// falls through to the tree: the hidden list is almost never empty (every
	// repo has system files), so there's still something behind the eye toggle.
	if (!paths.length && needsConfig && activeBrainCanManage()) {
		return (
			<div class="mx-auto mt-10 max-w-sm text-center">
				<p class="font-medium text-fg">This brain isn’t configured yet</p>
				<p class="mt-1 text-sm text-muted">
					Its content isn’t under the default layout, so no pages show. Point Isomorphic at the repo
					to index it.
				</p>
				<button
					type="button"
					disabled={configuring}
					onClick={runConfigure}
					class="mt-3 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
				>
					{configuring ? 'Configuring…' : 'Auto-configure'}
				</button>
			</div>
		);
	}

	return (
		<div class="select-none">
			{add?.parent === '' && (
				<AddInput
					kind={add.kind}
					depth={0}
					value={addValue}
					setValue={setAddValue}
					commit={commitAdd}
					cancel={cancelAdd}
					busy={busy}
				/>
			)}
			{!roots.length && !add && <p class="mt-10 text-center text-muted">No pages yet.</p>}
			{roots.map((n) => (
				<TreeItem
					key={n.path}
					node={n}
					depth={0}
					expanded={expanded}
					toggle={toggle}
					actions={actions}
					titleByPath={titleByPath}
				/>
			))}
		</div>
	);
}

export { FileTree, TreeItem, buildTree, treeCtl };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		browse: {
			paths: string[];
			titleByPath?: Record<string, string>;
			hidden?: string[];
			needsConfig?: boolean;
			// Folder to reveal on open (breadcrumb click on a folder with no folder note).
			focus?: string;
		};
	}
}

export default defineView('browse', (v) => (
	<FileTree
		paths={v.paths}
		titleByPath={v.titleByPath}
		hidden={v.hidden}
		needsConfig={v.needsConfig}
		focus={v.focus}
	/>
));
