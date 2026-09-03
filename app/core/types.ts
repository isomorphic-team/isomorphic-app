// Shared type definitions for the brain viewer/editor app. Types only — no runtime
// code — so every layer can import from here without pulling in behavior.

// The `View` union is no longer hand-written here: it is DERIVED from the ViewProps
// interface in view-registry.ts, which each routed view file augments via
// `declare module`. Re-exported so existing importers (`import type { View }`) are
// unchanged. (view-registry.ts stays dependency-free, so this re-export is not a cycle.)
export type { View } from './view-registry.ts';

// The signed-in user, as reported by the whoami tool. All optional — static-bearer
// mode has no identity, and org role/name resolve only on the product-native path.
export interface Identity {
	email?: string;
	login?: string;
	role?: string;
	org?: string;
	activeBrainLabel?: string;
}

export interface Hit {
	path: string;
	line: number;
	text: string;
	// Set when the search spanned brains (scope: 'all'). Not decoration: opening a hit
	// from another brain has to switch first, because navigateTo resolves its path
	// against the ACTIVE brain and would otherwise look it up in the wrong one.
	brain?: string;
	brainLabel?: string;
}

// The file-tree payload (one list_pages call). Cached in the store so reopening the
// tree — or the folder-note lookup behind a breadcrumb folder click — is a lookup
// rather than a round-trip. Invalidated whenever the brain changes.
export interface BrowseData {
	paths: string[];
	titleByPath: Record<string, string>;
	// Attachments (images, PDFs). Listed apart from `hidden` because they are
	// content someone deliberately added, not repo plumbing — see listNonPagePaths.
	assets: string[];
	hidden: string[];
	needsConfig: boolean;
}

// One change in the activity/audit feed (see view_activity in src/tools/apps.ts).
export interface ActivityEntry {
	sha: string;
	shortSha: string;
	message: string;
	path?: string;
	authorName: string;
	authorLogin?: string;
	date: string;
	url: string;
}

// A backlink surfaced by find_inbound_links (see src/tools/librarian.ts).
export interface Backref {
	path: string;
	title: string;
	mdCount: number;
	wikiCount: number;
}

// Graph view payload (see view_graph in src/tools/apps.ts). Nodes are pages;
// links are page↔page references, deduped undirected.
export interface GraphNode {
	id: string;
	title: string;
	group: string;
	degree: number;
}
export interface GraphLink {
	source: string;
	target: string;
}

// Org roster payload (see src/tools/members.ts). Roles are the DB tokens; the UI
// renders them via roleLabel. `me` carries the caller's identity + role so the view
// can gate admin controls and forbid self-edits without another round-trip.
export type MemberRole = 'viewer' | 'editor' | 'admin' | 'owner';
export interface Member {
	user_id: string;
	email: string;
	name: string | null;
	github_login: string | null;
	role: MemberRole;
	added_at: string;
}
export interface Invite {
	invite_id: string;
	email: string;
	role: MemberRole;
	invited_at: string;
	expires_at: string;
}
export interface MemberSelf {
	user_id: string;
	role: MemberRole;
}

// ---------- usage analytics (the org Analytics tab) ----------
// Mirrors the payload of the `analytics` tool; the shapes are produced by
// summarize() in src/lib/usage.ts, which is where their meaning is documented.

export interface UsageWindow {
	from: string;
	to: string;
	days: number;
}
export interface UsageTotals {
	activeUsers: number;
	members: number;
	reads: number;
	writes: number;
	admin: number;
	calls: number;
	errors: number;
}
export interface UsagePoint {
	day: string;
	reads: number;
	writes: number;
}
export interface UsagePerson {
	user_id: string;
	name: string | null;
	email: string | null;
	role: string | null;
	reads: number;
	writes: number;
	admin: number;
	lastActive: string | null;
	/** Activity from someone no longer on the roster. */
	former: boolean;
}
export interface UsageBrain {
	brain_id: string;
	label: string;
	reads: number;
	writes: number;
	people: number;
	lastActive: string | null;
}

// A brain the user can reach (see src/tools/brains.ts). Drives the nav switcher.
export interface BrainRow {
	id: string;
	label: string;
	role: string;
	active: boolean;
	canManage?: boolean; // caller is admin+ in this brain's ORG (can disconnect it)
	canShare?: boolean; // caller is admin+ ON THIS BRAIN (can change who reaches it)
	visibility?: string; // 'org' | 'private': drives the Private badge
	orgId?: string; // so the UI can target adds per-org, independent of the active brain
	orgLabel?: string;
	needsConfig?: boolean; // adopted repo with no content under its roots — offer "Set up"
	configPrUrl?: string; // a configure PR is pending (protected repo) — show "Review PR"
	// Readable, never writable, by anyone including the org's admins. The role the row
	// carries is already capped to viewer; this is the flag the cap came from.
	readOnly?: boolean;
}

// An org the caller can add a brain to. Identified by its own id rather than by a
// brain inside it: the org waiting for its FIRST repo holds no brain to name it with.
export interface OrgTarget {
	orgId: string;
	orgLabel: string;
}

// A repo the org's installation can see that isn't a brain yet (connect_brain's
// picker, returned when the call omits `repo`).
export interface ConnectableRepo {
	id: string;
	owner: string;
	repo: string;
}

// Per-brain access payload (see src/tools/brain-access.ts). The brain-scope
// sibling of the org roster above: `role` here is the caller's role ON THIS BRAIN,
// and `via` says how they got it: an explicit share, the brain being visible to
// the whole org, or the org-admin floor. The UI uses `via` to label the row and to
// hide a Remove button that would do nothing (you cannot un-share someone who
// reaches the brain because it is org-visible).
export interface BrainAccessEntry {
	user_id: string;
	email: string;
	name: string | null;
	role: MemberRole;
	via: 'grant' | 'org' | 'org-admin';
	granted_at?: string;
}
// The caller, in both scopes at once: the panel gates sharing controls on the
// BRAIN role and shows org context from the org role.
export interface BrainAccessSelf {
	user_id: string;
	role: MemberRole;
	orgRole: MemberRole;
}

// One entry in the "Connected accounts" roster (see src/tools/connected-accounts.ts):
// either a linked email identity or a linked GitHub account.
export interface ConnectedAccount {
	kind: 'email' | 'github';
	is_self: boolean;
	user_id?: string;
	email?: string;
	name?: string | null;
	github_user_id?: number;
	github_login?: string | null;
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
