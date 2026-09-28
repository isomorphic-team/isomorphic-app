// Reactive store + navigation history + brain/policy state. The lowest runtime layer
// (imports only types + the pure path-policy module): the module-level MCP callbacks
// and the Preact views both drive and read this state. Mutable `let`s that other
// modules reassign are exposed with a setter (a `let` live-binding can be READ across
// modules but only WRITTEN in its home).

import type { View, BrainRow, BrainPolicy, BrowseData, OrgTarget } from './types.ts';
import {
	DEFAULT_BRAIN_CONFIG,
	PATH_ROLES,
	isContentPath,
	normRoot
} from '../../src/lib/brain-policy.ts';
import { isWebHost, webPathFor, WEB_TOOL_ROUTING, type WebTarget } from './host-web.ts';
import { pageTitle } from '../../src/lib/wiki.ts';

type WebExtras = Omit<WebTarget, 'brain' | 'path'>;

// The URL token for a tool, from the one table. Throwing rather than defaulting: a
// view mapped to a tool with no `view` route is a programming error here, and a
// silent fallback would give two destinations the same URL.
function webToken(tool: string): string {
	const route = WEB_TOOL_ROUTING[tool];
	if (route?.kind !== 'view') throw new Error(`${tool} has no web view route`);
	return route.token;
}

// NOTE: this shadows the global `history`. Anything wanting the browser's own
// history stack (see syncAddressBar) must say `globalThis.history`.
const history: View[] = [];
// The whole last file-tree payload, not just its paths: the tree, the folder-note
// lookup behind a breadcrumb click, and wikilink resolution all read the same cache,
// so opening the tree a second time costs nothing. Cleared on brain switch/create.
let browseCache: BrowseData | null = null;
function setBrowseCache(v: BrowseData | null): void {
	browseCache = v;
}

// The brain the widget is showing (id + label), echoed by every app-tool result so the
// trail can name it. The full list is fetched once per open via `brains`
// (ensureBrainList in actions); it backs the trail's label when no brain is known, the
// manage/share gates, search's widen-to-all offer, and the first-brain create state.
let activeBrain: { id: string; label: string } | null = null;
let brainList: BrainRow[] | null = null;
// The orgs the caller can add a brain to, as the SERVER reports them. Derived from
// the brains list this could never include an org holding no brains yet, which is
// exactly the org someone is trying to put a first repo into.
let orgList: OrgTarget[] | null = null;
// THE one place the widget changes which brain it is showing, and therefore the one
// place everything scoped to a brain gets dropped: the cached file tree (which also
// backs folder-note lookup and wikilink resolution) and the path policy. A brain can be
// entered from any result, including a view_page / browse_brain the MODEL aimed at
// another brain with `brain:`, so the drop cannot live in switchBrain alone.
function setActiveBrain(v: { id: string; label: string } | null): void {
	if (v && activeBrain && activeBrain.id !== v.id) {
		browseCache = null;
		resetPolicy();
	}
	activeBrain = v;
}

// Which brain a `brains`-shaped payload (brains / switch_brain / create_brain /
// connect_brain) leaves the widget showing.
//
// Its `active` field is the USER's default (the active-brain pointer), which is a
// different question from "which brain is this widget showing". A widget opened by
// view_page or browse_brain with an explicit `brain:` is showing THAT brain, and the
// pointer does not move for a view (only switch_brain, create_brain and
// disconnect_brain write it), so the brain list the app fetches on every open
// (ensureBrainList) can name a different brain. Adopting it would retarget the crumb,
// the tree, and every subsequent widget call away from the brain the model opened
// (issue #26).
//
// So the pointer wins only when it is an answer to this question: the widget has no
// brain of its own yet (the self-boot, where nothing else has said), or the call was a
// deliberate change of brain — which switch_brain and create_brain declare with
// `switched`, and connect_brain does not, since adopting a repo moves nobody into it.
function pickShownBrain(
	rows: BrainRow[],
	payloadActive: string | undefined,
	deliberate: boolean
): { id: string; label: string } | null {
	const wanted = deliberate ? [payloadActive] : [activeBrain?.id, payloadActive];
	for (const id of wanted) {
		const row = id ? rows.find((b) => b.id === id) : undefined;
		if (row) return { id: row.id, label: row.label };
	}
	return null;
}
function setBrainList(v: BrainRow[] | null): void {
	brainList = v;
}
function setOrgList(v: OrgTarget[] | null): void {
	orgList = v;
}
// The brain a result says it is about. Every payload that draws brain content carries
// it, including the ones the MODEL aimed at another brain with `brain:` — which is why
// this goes through setActiveBrain rather than assigning: arriving in a brain is
// arriving in a brain, however the widget got there.
function applyBrainContext(sc: Record<string, unknown>): void {
	const ab = sc.activeBrain as { id?: string; label?: string } | undefined;
	if (ab && typeof ab.id === 'string' && typeof ab.label === 'string') {
		setActiveBrain({ id: ab.id, label: ab.label });
	}
}
// What the SERVER registered, learned from the `brains` payload alongside the list
// itself (ensureBrainList runs on every open). A widget cannot list the host's tools,
// so without this the nav would have to offer every destination and let the unlucky
// ones fail on click. Unknown until the list lands, and a missing flag reads as OFF:
// a destination that quietly does not appear is a far smaller failure than one that
// appears and errors.
let features: { analytics: boolean; people: boolean; webBase?: string } = {
	analytics: false,
	people: false
};
function setFeatures(
	v: Partial<{ analytics: boolean; people: boolean; webBase: string }> | undefined
): void {
	if (!v) return;
	if (typeof v.analytics === 'boolean') features = { ...features, analytics: v.analytics };
	if (typeof v.people === 'boolean') features = { ...features, people: v.people };
	if (typeof v.webBase === 'string' && v.webBase) features = { ...features, webBase: v.webBase };
}

// Whether the caller is admin+ in the active brain's org (can auto-configure it).
function activeBrainCanManage(): boolean {
	return !!brainList?.find((b) => b.id === activeBrain?.id)?.canManage;
}

// The brain the widget is currently SHOWING (activeBrain tracks it via
// applyBrainContext on every result). Every widget-initiated tool call passes this
// explicitly so its actions hit the displayed brain, not the connection's ambient
// active brain — otherwise a page opened via a one-shot `brain:` view would be
// browsed/edited against a different brain (the file tree would miss it, the Edit
// button would misfire). Omitted until the first result names a brain, so the server
// falls back to the active brain for the very first call.
function brainArgs(): { brain?: string } {
	return activeBrain?.id ? { brain: activeBrain.id } : {};
}

// Whether the open editor has unsaved changes. It lives HERE rather than on the
// editor's own control handle because the thing that needs to read it is the app's
// navigation (`confirmLeaveEdit` in actions.ts), which sits below the view layer and
// cannot import from it.
//
// This is what lets the chrome stay live while you edit: navigation asks before it
// abandons typed text, rather than the bar hiding its controls.
let editDirty = false;
function setEditDirty(v: boolean): void {
	editDirty = v;
}

let brainPolicy: BrainPolicy = { paths: { ...DEFAULT_BRAIN_CONFIG.paths } };

// A policy belongs to ONE brain, so switching brains must drop it — otherwise the
// new brain's tree renders under the old brain's roles until a result carrying a
// fresh policy lands. (The wiki/ default is a guess too, but it is at least the
// documented default rather than another brain's answer.)
function resetPolicy(): void {
	brainPolicy = { paths: { ...DEFAULT_BRAIN_CONFIG.paths } };
}

function applyPolicy(sc: Record<string, unknown>): void {
	const c = sc.config as { paths?: unknown } | undefined;
	if (!c?.paths || typeof c.paths !== 'object' || Array.isArray(c.paths)) return;
	const paths: BrainPolicy['paths'] = {};
	for (const [k, v] of Object.entries(c.paths as Record<string, unknown>)) {
		if (typeof v === 'string' && (PATH_ROLES as readonly string[]).includes(v))
			paths[k] = v as (typeof PATH_ROLES)[number];
	}
	brainPolicy = { paths };
}

// Tiny external store so the module-level MCP callbacks (ontoolresult, navigation)
// can drive the UI regardless of Preact's mount timing. `connect()` runs at module
// scope (deferring it into an effect stalls the postMessage handshake), so views may
// change before or after mount — useSyncExternalStore handles both.
const listeners = new Set<() => void>();
let version = 0;
let currentView: View = { kind: 'loading', label: 'Connecting…', task: 'connect' };
function subscribeStore(cb: () => void) {
	listeners.add(cb);
	return () => listeners.delete(cb);
}
// A monotonic version is the useSyncExternalStore snapshot; components read
// currentView / displayMode from module state. Any change calls bump() to re-render.
function bump() {
	version++;
	listeners.forEach((l) => l());
}

// Transient views are never recorded: you can't go "back to Loading…", and an error
// view's own Retry is its way out. Everything else is a real place the user was.
//
// THE EDITOR IS NOT A PLACE either, for Back's purposes. Its unsaved text is in no
// view object, so returning to a recorded editor reopens it on whatever was saved when
// you left, which is the editor discarding its own premise (the same reason it has no
// URL). And leaving it by Save or Cancel REPLACES it with the page (`push: false`),
// which left the page as it stood BEFORE the edit on top of the stack: one press of
// Back from a page you had just saved showed you the same page, stale. So the pre-edit
// copy is dropped when the editor hands over to the page it was editing, and Back from
// there goes wherever you were before you opened the page.
const HISTORY_LIMIT = 50;
const UNRECORDED: ReadonlySet<View['kind']> = new Set<View['kind']>(['loading', 'error', 'edit']);

// Pure, and exported so `pnpm test:policy` can pin it: this is what decides where the
// back button lands, and `show` is too entangled with the DOM to call from a test.
function recordStep(stack: View[], from: View, to: View, push: boolean): void {
	if (push && !UNRECORDED.has(from.kind)) {
		stack.push(from);
		if (stack.length > HISTORY_LIMIT) stack.shift();
	}
	if (from.kind === 'edit' && to.kind === 'page') {
		const top = stack.at(-1);
		if (top?.kind === 'page' && top.path === to.path) stack.pop();
	}
}

function show(v: View, { push = true } = {}) {
	recordStep(history, currentView, v, push);
	display(v, push);
}

// Put a view on screen without touching the stack: `goBack` has already popped the
// entry it is restoring, so running `recordStep` again could drop a second one.
function display(v: View, push: boolean) {
	currentView = v;
	syncAddressBar(v, push);
	bump();
}

// Keep the browser's address bar naming what is on screen (web host only).
//
// In a tab the URL is not decoration: it is what you copy to send someone the page
// you are reading, and what Back returns you to. Nothing wrote it before, so the app
// parsed `/b/...` once at boot and then navigated underneath it — every page you
// reached by clicking still advertised the one you first opened, and Back left the
// app entirely. `webPathFor` existed for this and had no caller outside its own
// round-trip test, which is why a green `pnpm test:web` never noticed.
//
// Only the views the URL grammar can NAME are synced, and `webTargetFor` is the whole
// list. Everything else leaves the bar on the last thing it named rather than
// inventing a URL that cannot be read back, which is the inverse property the module
// exists to hold. The editor is the pointed omission: its unsaved text is not in the
// URL, so a link to it would open on saved content and discard its own premise.
//
// In the MCP App this is dead: `isWebHost()` is false, there is no address bar, and
// the host owns navigation.
// The tokens come from WEB_TOOL_ROUTING rather than being spelled again here, so a
// destination cannot be addressable in one direction only.
function webTargetFor(v: View): { path: string; extras: WebExtras } | null {
	const at = (view: string, arg?: string): { path: string; extras: WebExtras } => ({
		path: '',
		extras: { view, ...(arg ? { arg } : {}) }
	});
	switch (v.kind) {
		case 'page':
			return { path: v.path, extras: {} };
		// The tree's own argument is the folder a breadcrumb click reveals, so a link
		// to a revealed folder reopens it there rather than at the root.
		case 'browse':
			return { path: '', extras: v.focus ? { arg: v.focus } : {} };
		// The query is the whole state worth carrying: the hits are derived from it,
		// and re-running the search is what the recipient of the link wants anyway.
		case 'search':
			return at(webToken('search_pages'), v.query);
		case 'graph':
			return at(webToken('view_graph'), v.focus);
		case 'activity':
			return at(webToken('view_activity'), v.scopePath);
		case 'brain-access':
			return at(webToken('brain_access'));
		case 'members':
			return at(webToken('members'));
		// The window is the one thing a reader chose, so a link to "the last 90 days"
		// reopens on 90 rather than silently on the default.
		case 'analytics':
			return at(webToken('analytics'), String(v.window.days));
		default:
			return null;
	}
}

// What the tab is called, for the same reason the address bar is written: a tab strip
// and a history menu are read by their titles, and "Brain" twelve times over is no
// help. Names the destination and the brain, so two brains' index pages are told
// apart. Only for the views that have a URL, like the bar itself.
function webTitleFor(v: View): string | null {
	switch (v.kind) {
		// The ONE title resolver (frontmatter, then the H1, then the filename or the
		// folder for a folder note), so the tab says what the header says.
		case 'page':
			return pageTitle(v.path, v.markdown);
		case 'browse':
			return v.focus ? v.focus.split('/').pop() || 'Files' : 'Files';
		case 'search':
			return v.query ? `Search: ${v.query}` : 'Search';
		case 'graph':
			return 'Graph';
		case 'activity':
			return 'Recent changes';
		case 'brain-access':
			return 'Sharing';
		case 'members':
			return 'Members';
		case 'analytics':
			return 'Analytics';
		default:
			return null;
	}
}

// The web app's URL for what the widget is showing, for the "Open in browser"
// control in the MCP App: the same page, same brain, in a full window. Null when
// there is nothing to offer: on the web host itself (already there), on a
// deployment with no web app (`features.webBase` never arrived), before a brain is
// known, or on a view the URL grammar cannot name (the editor, deliberately).
function webLinkFor(v: View): string | null {
	if (isWebHost() || !features.webBase || !activeBrain) return null;
	const target = webTargetFor(v);
	if (!target) return null;
	return `${features.webBase}${webPathFor(activeBrain.id, target.path, target.extras)}`;
}

function syncAddressBar(v: View, push: boolean): void {
	if (!isWebHost()) return;
	const target = webTargetFor(v);
	if (!target) return;
	// The brain on screen. On the web it is set from the URL before anything is
	// shown (main.tsx), so the only way to have none is a bare `/b` with no brain
	// list yet, where there is nothing to write.
	const brain = activeBrain?.id;
	if (!brain) return;
	const url = webPathFor(brain, target.path, target.extras);
	const title = webTitleFor(v);
	if (title) document.title = `${title} · ${activeBrain?.label ?? brain}`;
	// Compared against path AND query, since two destinations now differ only in the
	// query string.
	if (url === `${location.pathname}${location.search}`) return;
	// `push: false` means the view is being RESTORED — goBack, a refresh in place, or
	// the popstate handler reacting to a move the browser already made. Pushing there
	// would leave an entry pointing at where the user just was, so Back would have to
	// be pressed twice to go anywhere.
	//
	// Each entry records how many app entries sit beneath it, so the back button can
	// tell a Back that stays in the app from one that would leave it (the browser only
	// reports its whole stack's length, which counts the pages before ours). A replace
	// keeps the depth of the entry it replaces.
	if (push) globalThis.history.pushState({ isoDepth: webDepth() + 1 }, '', url);
	else globalThis.history.replaceState(globalThis.history.state, '', url);
}

function webDepth(): number {
	const depth = (globalThis.history.state as { isoDepth?: unknown } | null)?.isoDepth;
	return typeof depth === 'number' ? depth : 0;
}

// Return to whatever pushed the current view.
//
// `show()` has recorded every push since the app started, but until now NOTHING read
// the stack — so a pushed flow had no way home except an unrelated destination (the
// create-a-brain form's Cancel called openBrowse() and landed you on the file tree
// rather than the brains list you came from). The breadcrumb answers "where am I"; this
// answers "undo the step that got me here", which is what a flow needs to be
// cancelable.
//
// `fallback` runs when the stack is empty (a flow entered directly from a tool
// result). It's a callback rather than a default destination because this module is
// the lowest runtime layer and must not import actions.
function goBack(fallback?: () => void): void {
	const prev = history.pop();
	if (prev) display(prev, false);
	else fallback?.();
}

// The header's back button. Two hosts, two stacks:
//
//   - In the MCP App the widget's own stack is the only history there is.
//   - In a browser tab the BROWSER's stack is the truth, and the button is its Back.
//     Popping our stack there would `replaceState` over the current entry, leaving
//     the browser's stack pointing at pages the app had already left, so its Forward
//     would stop working. `history.back()` fires the popstate handler that the
//     browser's own button does, so the two cannot disagree.
//
// Nothing to go back to disables the button rather than hiding it, so the trail
// never shifts sideways when it appears. On the web that includes a tab that
// arrived from another site: Back would leave the app, which is the browser's
// button's job and not ours. A load in flight disables it too, since the result
// would land after the pop and overwrite where Back took you.
//
// The EDITOR is the one web screen that uses our stack: it has no URL of its own, so
// the browser's entry is still the page's, and its Back would skip past the page to
// whatever came before it. Back from the editor lands on the page in both hosts.
function browserOwnsBack(): boolean {
	return isWebHost() && currentView.kind !== 'edit';
}

function canGoBack(): boolean {
	if (currentView.kind === 'loading') return false;
	return browserOwnsBack() ? webDepth() > 0 : history.length > 0;
}

function stepBack(): void {
	if (!canGoBack()) return;
	if (browserOwnsBack()) globalThis.history.back();
	else goBack();
}

// Where Back would actually land, for chrome that NAMES the destination. A crumb
// reading "Brains" on a screen whose Back goes somewhere else is worse than no crumb,
// and a flow reachable from several places (add-brain) can't know statically.
function backKind(): View['kind'] | null {
	return history.at(-1)?.kind ?? null;
}

// Editable = the Worker's own isContentPath verdict against the delivered policy —
// the SAME function, bundled from src/lib/brain-policy.ts, so the app's locks can
// never disagree with what a write tool would actually accept.
function isEditablePath(path: string): boolean {
	return isContentPath(path, brainPolicy);
}

export {
	history,
	editDirty,
	setEditDirty,
	browseCache,
	setBrowseCache,
	activeBrain,
	brainList,
	orgList,
	setActiveBrain,
	pickShownBrain,
	setBrainList,
	setOrgList,
	applyBrainContext,
	features,
	webLinkFor,
	setFeatures,
	activeBrainCanManage,
	brainArgs,
	brainPolicy,
	normRoot,
	applyPolicy,
	resetPolicy,
	listeners,
	version,
	currentView,
	subscribeStore,
	bump,
	show,
	goBack,
	backKind,
	canGoBack,
	stepBack,
	recordStep,
	HISTORY_LIMIT,
	isEditablePath
};
