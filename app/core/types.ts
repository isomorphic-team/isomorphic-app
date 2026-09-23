// Shared type definitions for the brain viewer/editor app. Types only — no runtime
// code — so every layer can import from here without pulling in behavior.

// The `View` union is not hand-written here: it is DERIVED from the ViewProps
// interface in view-registry.ts, which each routed view file augments via
// `declare module`. Re-exported so existing importers (`import type { View }`) are
// unchanged. (view-registry.ts stays dependency-free, so this re-export is not a cycle.)
export type { View } from './view-registry.ts';

// The tool payload shapes (rows in a roster, a brain in the brains list, a search hit)
// are the wire contract with the Worker and live beside their parsers in
// src/lib/tool-payloads.ts. Re-exported so the app imports one vocabulary.
import type { GraphNode } from '../../src/lib/tool-payloads.ts';
export type {
	Identity,
	Hit,
	BrowseData,
	ActivityEntry,
	GraphNode,
	GraphLink,
	MemberRole,
	Member,
	Invite,
	MemberSelf,
	UsageWindow,
	UsageTotals,
	UsagePoint,
	UsagePerson,
	UsageBrain,
	BrainRow,
	OrgTarget,
	BrainAccessEntry,
	BrainAccessSelf,
	ConnectedAccount
} from '../../src/lib/tool-payloads.ts';

// A backlink surfaced by find_inbound_links (see src/tools/librarian.ts).
export interface Backref {
	path: string;
	title: string;
	mdCount: number;
	wikiCount: number;
}

// A repo the org's installation can see that isn't a brain yet (connect_brain's
// picker, returned when the call omits `repo`).
export interface ConnectableRepo {
	id: string;
	owner: string;
	repo: string;
}

// Brain content-shape policy, delivered by the server in each app-tool's
// structuredContent (see editPolicy in src/tools/apps.ts). The shape is the
// shared PathPolicy from src/lib/brain-policy.ts — the app runs the Worker's own
// path predicates against it. Defaults reproduce the original wiki/ + raw/
// behavior until the first tool result arrives, so a brain that ships no
// .isomorphic.json behaves exactly as before.
export type { PathPolicy as BrainPolicy } from '../../src/lib/brain-policy.ts';

export type DisplayMode = 'inline' | 'fullscreen' | 'pip';

// Promise-based confirmation for destructive actions (unlink an account, disconnect a
// brain). askConfirm(...) shows a modal and resolves true/false; the ConfirmDialog
// component (mounted in Root) renders the pending request from module state.
export interface ConfirmRequest {
	title: string;
	body?: string;
	confirmLabel: string;
	resolve: (ok: boolean) => void;
}

export interface TreeNode {
	name: string;
	path: string;
	dir: boolean;
	children: TreeNode[];
	// A "hidden" entry — anything that isn't a visible content page: system files
	// (.isomorphic.json), `.gitkeep` markers, immutable source, the changelog.
	// Rendered only when "show hidden" is on. Content folders persisted only by a
	// `.gitkeep` still render (the folder itself isn't hidden, its marker is).
	hidden: boolean;
	// An attachment: visible like a page, opens the asset view rather than the
	// editor. Distinct from `hidden` (plumbing) and from a page (markdown).
	asset?: boolean;
}

// A pending inline "new note"/"new folder" input, anchored under `parent` ("" = the
// brain's content root). One at a time.
export interface TreeAdd {
	kind: 'note' | 'folder';
	parent: string;
}

export interface TreeActions {
	showHidden: boolean;
	busy: boolean;
	// The folder the tree was opened AT (breadcrumb click on a note-less folder):
	// pre-expanded, highlighted, and scrolled into view. Carried on `actions` because
	// TreeItem recurses — this is the bag that already rides all the way down.
	focus?: string;
	// The single per-row hover menu (⋯). Only one is open at a time.
	openMenu: string | null;
	setOpenMenu: (path: string | null) => void;
	// Rename (files → new title; folders → new name). `dir` distinguishes them.
	editing: { path: string; dir: boolean } | null;
	editValue: string;
	setEditValue: (v: string) => void;
	startRename: (path: string, name: string, dir: boolean) => void;
	commitRename: () => void;
	cancelRename: () => void;
	// Delete (modal-confirmed; folder deletes remove the whole subtree).
	askDelete: (path: string, dir: boolean, name: string) => void;
	// Inline add (a new note or folder) under a parent folder.
	add: TreeAdd | null;
	addValue: string;
	setAddValue: (v: string) => void;
	startAdd: (kind: 'note' | 'folder', parent: string) => void;
	commitAdd: () => void;
	cancelAdd: () => void;
	// One-click folder note: creates <folder>/index.md pre-seeded with a
	// directory-index view (in the folder's ⋯ menu when it has no note yet).
	addFolderNote: (folder: string) => void;
	// Drag a file or folder onto a folder → move it INTO that folder.
	dragging: { path: string; dir: boolean } | null;
	dropTarget: string | null;
	onDragStart: (path: string, dir: boolean) => void;
	onDragEnd: () => void;
	onDragOverFolder: (path: string) => void;
	onDropFolder: (folder: string) => void;
}

// A live simulation node: the graph node plus its physics state. Positions live
// in "world" space (origin 0,0); the view transform maps world→screen.
export interface SimNode extends GraphNode {
	x: number;
	y: number;
	vx: number;
	vy: number;
	fixed: boolean; // pinned under the cursor while dragging
}

// WYSIWYG markdown editor (ProseMirror + prosemirror-markdown). Edits the page
// BODY only; frontmatter is split off and re-attached server-side on save. The
// editor exposes getMarkdown() through apiRef so save serializes on demand rather
// than on every keystroke.
export interface EditorApi {
	getMarkdown: () => string;
}
