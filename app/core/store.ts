// Reactive store + navigation history + brain/policy state. The lowest runtime layer
// (imports only types + the pure path-policy module): the module-level MCP callbacks
// and the Preact views both drive and read this state. Mutable `let`s that other
// modules reassign are exposed with a setter (a `let` live-binding can be READ across
// modules but only WRITTEN in its home).

import type { View, BrainRow, BrainPolicy, BrowseData } from './types.ts';
import {
	DEFAULT_BRAIN_CONFIG,
	PATH_ROLES,
	isContentPath,
	normRoot
} from '../../src/lib/brain-policy.ts';

const history: View[] = [];
// The whole last file-tree payload, not just its paths: the tree, the folder-note
// lookup behind a breadcrumb click, and wikilink resolution all read the same cache,
// so opening the tree a second time costs nothing. Cleared on brain switch/create.
let browseCache: BrowseData | null = null;
function setBrowseCache(v: BrowseData | null): void {
	browseCache = v;
}

// The active brain (id + label), echoed by every app-tool result so the switcher can
// show it. The full list is fetched lazily via list_brains (in actions) the first time
// the switcher needs it — the switcher only appears when there are 2+ brains.
let activeBrain: { id: string; label: string } | null = null;
let brainList: BrainRow[] | null = null;
function setActiveBrain(v: { id: string; label: string } | null): void {
	activeBrain = v;
}
function setBrainList(v: BrainRow[] | null): void {
	brainList = v;
}
function applyBrainContext(sc: Record<string, unknown>): void {
	const ab = sc.activeBrain as { id?: string; label?: string } | undefined;
	if (ab && typeof ab.id === 'string' && typeof ab.label === 'string') {
		activeBrain = { id: ab.id, label: ab.label };
	}
}
// What the SERVER registered, learned from the `brains` payload alongside the list
// itself (ensureBrainList runs on every open). A widget cannot list the host's tools,
// so without this the nav would have to offer every destination and let the unlucky
// ones fail on click. Unknown until the list lands, and a missing flag reads as OFF:
// a destination that quietly does not appear is a far smaller failure than one that
// appears and errors.
let features: { analytics: boolean } = { analytics: false };
function setFeatures(v: Partial<{ analytics: boolean }> | undefined): void {
	if (v && typeof v.analytics === 'boolean') features = { ...features, analytics: v.analytics };
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
let currentView: View = { kind: 'loading', label: 'Connecting…' };
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
const HISTORY_LIMIT = 50;

function show(v: View, { push = true } = {}) {
	if (push && currentView.kind !== 'loading' && currentView.kind !== 'error') {
		history.push(currentView);
		if (history.length > HISTORY_LIMIT) history.shift();
	}
	currentView = v;
	bump();
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
	if (prev) show(prev, { push: false });
	else fallback?.();
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

// (There used to be an `addCtl` handle here, so a list screen could publish its
// inline composer's open() to the header. Add-shaped actions are pushed VIEWS now —
// see app/ui/Flow.tsx — so the header just calls the opener directly and nothing has
// to be registered at mount time. That registration was also a failure mode: a view
// that imported the binding hook and forgot to CALL it typechecked clean and simply
// rendered no button. `noUnusedLocals` now catches that shape, but not needing the
// handle at all is better.)

export {
	history,
	browseCache,
	setBrowseCache,
	activeBrain,
	brainList,
	setActiveBrain,
	setBrainList,
	applyBrainContext,
	features,
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
	isEditablePath
};
