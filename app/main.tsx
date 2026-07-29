// Brain viewer/editor — the MCP App that runs inside the host's sandboxed iframe.
// Rebuilt on Preact + Tailwind (Phase D foundation). Framework-agnostic MCP
// plumbing stays module-level; Preact renders the views. Data flows over standard
// MCP exactly as before: the host feeds the opening tool result via ontoolresult,
// and in-app navigation calls back through app.callServerTool.
//
// This entry file holds the app chrome (header, brain switcher, overflow menu, the
// Body view switch) + the connect/render bootstrap. Everything else lives in layered
// modules: app/core/* (types < store < toast < host < actions < icons/util) and one
// file per view under app/views/*. Adding a view = one file there + one Body case here.

import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useSyncExternalStore } from 'preact/compat';
import type { View } from './core/types.ts';
import type { ViewAction } from './core/view-registry.ts';
import { isFolderNoteName } from './core/util.ts';
import {
	subscribeStore,
	version,
	currentView,
	show,
	goBack,
	backKind,
	brainList,
	activeBrain
} from './core/store.ts';
import {
	app,
	applyHostContext,
	displayMode,
	setDisplayMode,
	MODE_ICON,
	MODE_LABEL,
	availableModeList
} from './core/host.ts';
import {
	handleToolResult,
	openBrowse,
	openFolder,
	openGraph,
	openActivity,
	openMembers,
	openBrains,
	openSettings,
	openAddBrain,
	switchBrain,
	runSearch
} from './core/actions.ts';
import { toast, Toast, ConfirmDialog } from './core/toast.tsx';
import {
	ListIcon,
	SearchIcon,
	HistoryIcon,
	GraphIcon,
	PeopleIcon,
	HomeIcon,
	MoreIcon,
	GearIcon,
	BrainGlyph,
	ChevronDownIcon,
	PlusIcon
} from './core/icons.tsx';
import { Button } from './ui/index.ts';
// The Body dispatch table is codegenned from app/views/*.tsx (see scripts/gen-app.ts).
import { renderView, viewActions } from './views/registry.generated.ts';
// Chrome still binds the editor's save/cancel + toolbar directly.
import { EditorToolbar, editCtl } from './views/EditView.tsx';
import { eyebrow } from './ui/typography.ts';

// ---------- host wiring ----------

app.onhostcontextchanged = applyHostContext;
app.onerror = (e) => toast(String(e), true);
app.ontoolresult = handleToolResult;

// ---------- chrome ----------

// The single overflow menu (⋯) that holds everything secondary, so the top bar stays
// down to its brain-action icons (Files, Search, Graph) + Edit. New destinations
// (Org settings, etc.) become rows here — the bar never grows. Contents are
// contextual: while editing, only Display (switching views mid-edit would abandon it);
// otherwise the full nav + settings. Hidden entirely if it would be empty.
function OverflowMenu({ editing }: { editing: boolean }) {
	const modes = availableModeList();
	const hasDisplay = modes.length >= 2;
	const [open, setOpen] = useState(false);
	// Cap the dropdown to the space between its button and the bottom of the visible
	// viewport (the inline card is the iframe, so window.innerHeight IS the card's
	// visible height). Without this, a short card clips the lower menu items, since the
	// card's overflow-y-auto contains the absolutely-positioned menu. Clamped → the menu
	// scrolls internally and always fits.
	const [maxH, setMaxH] = useState<number | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
		document.addEventListener('mousedown', onDoc);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);
	useLayoutEffect(() => {
		if (!open) {
			setMaxH(null);
			return;
		}
		const measure = () => {
			// ref wraps the button (the menu is absolute → doesn't affect this rect), so
			// its bottom is the menu's top edge. Leave an 8px breathing gap to the card edge.
			const b = ref.current?.getBoundingClientRect().bottom ?? 0;
			setMaxH(Math.max(96, window.innerHeight - b - 8));
		};
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	}, [open]);
	// While editing there's nothing but Display — if the host offers one mode, drop the
	// whole menu rather than show an empty ⋯.
	if (editing && !hasDisplay) return null;
	const close = () => setOpen(false);
	const go = (fn: () => void) => () => {
		close();
		fn();
	};
	return (
		<div ref={ref} class="relative">
			<Button
				variant="ghost"
				size="icon"
				title="More"
				aria-label="More"
				onClick={() => setOpen((o) => !o)}
			>
				<MoreIcon />
			</Button>
			{open && (
				<div
					style={maxH ? { maxHeight: `${maxH}px` } : undefined}
					class="absolute top-full right-0 z-20 mt-1 min-w-[168px] overflow-y-auto overscroll-contain rounded-md border border-border bg-bg py-1 shadow-lg"
				>
					{!editing && (
						<>
							<Button
								variant="row"
								class="gap-2.5 rounded-none px-3 py-1.5 text-sm"
								onClick={go(() => openActivity())}
							>
								<span class="w-4 text-muted">
									<HistoryIcon />
								</span>
								<span class="flex-1">Recent changes</span>
							</Button>
							<Button
								variant="row"
								class="gap-2.5 rounded-none px-3 py-1.5 text-sm"
								onClick={go(openMembers)}
							>
								<span class="w-4 text-muted">
									<PeopleIcon />
								</span>
								<span class="flex-1">Members</span>
							</Button>
							{/* Brain management (add/remove) lives here — the switcher top-left is
							    switch-only. Shown when the user is admin of at least one brain's org. */}
							{brainList?.some((b) => b.canManage) && (
								<Button
									variant="row"
									class="gap-2.5 rounded-none px-3 py-1.5 text-sm"
									onClick={go(openBrains)}
								>
									<span class="w-4 text-muted">
										<BrainGlyph />
									</span>
									<span class="flex-1">Manage brains</span>
								</Button>
							)}
						</>
					)}
					{hasDisplay && (
						<>
							{!editing && <div class="my-1 border-t border-border" />}
							<div class={`px-3 pb-0.5 pt-1 ${eyebrow}`}>Display</div>
							{modes.map((m) => (
								<Button
									variant="row"
									onClick={go(() => setDisplayMode(m))}
									class={`gap-2.5 rounded-none px-3 py-1.5 text-sm ${
										m === displayMode ? 'text-accent' : 'text-fg'
									}`}
								>
									<span class="w-4 text-center">{MODE_ICON[m]}</span>
									<span class="flex-1">{MODE_LABEL[m]}</span>
									{m === displayMode && <span>✓</span>}
								</Button>
							))}
						</>
					)}
					{!editing && (
						<>
							<div class="my-1 border-t border-border" />
							<Button
								variant="row"
								class="gap-2.5 rounded-none px-3 py-1.5 text-sm"
								onClick={go(openSettings)}
							>
								<span class="w-4 text-muted">
									<GearIcon />
								</span>
								<span class="flex-1">Your settings</span>
							</Button>
						</>
					)}
				</div>
			)}
		</div>
	);
}

function SearchBox() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (open) ref.current?.focus();
	}, [open]);
	if (!open)
		return (
			<Button
				variant="ghost"
				size="icon"
				title="Search"
				aria-label="Search"
				onClick={() => setOpen(true)}
			>
				<SearchIcon />
			</Button>
		);
	return (
		<input
			ref={ref}
			type="search"
			placeholder="Search…"
			onKeyDown={(e) => {
				if (e.key === 'Enter') runSearch((e.target as HTMLInputElement).value);
				if (e.key === 'Escape') setOpen(false);
			}}
			onBlur={(e) => !(e.target as HTMLInputElement).value && setOpen(false)}
			class="w-44 rounded-md bg-chip px-2 py-1 text-sm text-fg outline-none"
		/>
	);
}

// The ⌂ crumb. Home is the file tree, and it is the way back from EVERY view, so
// this renders on path views and destination views alike. `inert` is the browse
// view itself (we're already home — nothing to click).
function HomeCrumb({ inert, active }: { inert?: boolean; active?: boolean }) {
	const cls = `flex shrink-0 items-center ${active ? 'text-fg' : 'text-muted hover:text-fg'}`;
	if (inert)
		return (
			<span class={cls} title="Home" aria-label="Home">
				<HomeIcon />
			</span>
		);
	return (
		<button type="button" title="Home" aria-label="Home" onClick={() => openBrowse()} class={cls}>
			<HomeIcon />
		</button>
	);
}

const CrumbSep = () => <span class="mx-1 shrink-0 text-muted opacity-50">/</span>;

// A destination that has no path (Search, Members, Recent changes, …) still hangs off
// home:
//
//   ⌂ / Members · 4 people
//
// so leaving it is the same one click as anywhere else — otherwise these views are
// dead ends, since the top-left control is the brain switcher, not a way back. Views
// with a lit control of their own in the bar (graph) skip the label and render the bare
// HomeCrumb instead; the control already says where you are.
// `parent` adds one clickable crumb between home and the destination, for a view
// that was PUSHED from another (⌂ / Brains / Add a brain). A pushed flow needs a way
// back to the thing that opened it, not just a way home, and the crumb is where a
// user looks for it — so the flow's own body carries Back/Cancel for the step and
// this carries the way out.
function DestinationCrumb({
	parent,
	children
}: {
	parent?: { label: string; onClick: () => void };
	children: ComponentChildren;
}) {
	return (
		<nav class="flex min-w-0 items-center">
			<HomeCrumb />
			<CrumbSep />
			{parent && (
				<>
					<button
						type="button"
						onClick={parent.onClick}
						class="shrink-0 text-muted hover:text-fg hover:underline"
					>
						{parent.label}
					</button>
					<CrumbSep />
				</>
			)}
			<span class="min-w-0 truncate">{children}</span>
		</nav>
	);
}

// Location as clickable breadcrumbs, always anchored at a HOME crumb:
//
//   ⌂ / wiki / people / Ada Lovelace
//
// The breadcrumb MIRRORS THE FILE TREE: ⌂ is the tree's root (a neutral icon —
// brains differ in structure, so no folder name plays "root"), and every folder
// the tree shows is a crumb, content roots included. Clicking ⌂ opens the
// top-level tree — the always-available way back up, even when the top-left
// control is the brain switcher; on the browse view it renders as the current
// location. Folder segments open the folder's note (<folder>/index.md) when it
// has one, else the tree REVEALED at that folder (expanded + highlighted) — a
// note-less folder still lands you where you clicked. A folder-note page collapses into its folder crumb
// (wiki/index.md shows as "⌂ / wiki") so the trailing crumb is never a
// self-link that goes nowhere; the current location is inert.
function Breadcrumb({ view }: { view: View }) {
	if (view.kind === 'search')
		return (
			<DestinationCrumb>
				<span class="text-muted">Search · “{view.query}”</span>
			</DestinationCrumb>
		);
	if (view.kind === 'activity')
		return (
			<DestinationCrumb>
				<span class="text-muted">Recent changes{view.scopePath ? ` · ${view.scopePath}` : ''}</span>
			</DestinationCrumb>
		);
	// Graph gets NO label: its control in the bar to the left is lit while you're in it,
	// so a "Graph" crumb would say the same thing twice. The page/link tally likewise
	// lives in the canvas's own corner. That leaves just the way back.
	if (view.kind === 'graph') return <HomeCrumb />;
	if (view.kind === 'members')
		return (
			<DestinationCrumb>
				<span class="text-fg">Members</span>
				<span class="text-muted">
					{' · '}
					{view.members.length} {view.members.length === 1 ? 'person' : 'people'}
					{view.invites.length ? ` · ${view.invites.length} invited` : ''}
				</span>
			</DestinationCrumb>
		);
	if (view.kind === 'brains')
		return (
			<DestinationCrumb>
				<span class="text-fg">Brains</span>
				<span class="text-muted"> · {view.brains.length}</span>
			</DestinationCrumb>
		);
	if (view.kind === 'settings')
		return (
			<DestinationCrumb>
				<span class="text-fg">Your settings</span>
			</DestinationCrumb>
		);
	// The flows. Each is a pushed view (the card is already a bounded box, so a flow
	// that needs room takes the whole card rather than floating a dialog inside it —
	// app/ui/Flow.tsx) and hangs off the screen it was opened from, so the crumb is
	// the way back out as well as the statement of where you are.
	// The parent crumb is conditional: add-brain is reachable three ways (the brains
	// list, the switcher, the no-brains empty state), so it is shown only when Back
	// actually goes to the brains list. A crumb must never name a destination its own
	// click would not reach.
	if (view.kind === 'add-brain')
		return (
			<DestinationCrumb
				parent={
					backKind() === 'brains'
						? { label: 'Brains', onClick: () => goBack(openBrains) }
						: undefined
				}
			>
				<span class="text-fg">{view.first ? 'Create your first brain' : 'Add a brain'}</span>
			</DestinationCrumb>
		);
	if (view.kind === 'invite-member')
		return (
			<DestinationCrumb parent={{ label: 'Members', onClick: () => goBack(openMembers) }}>
				<span class="text-fg">Invite</span>
			</DestinationCrumb>
		);
	if (view.kind === 'connect-account')
		return (
			<DestinationCrumb parent={{ label: 'Your settings', onClick: () => goBack(openSettings) }}>
				<span class="text-fg">Connect an account</span>
			</DestinationCrumb>
		);
	const path = 'path' in view ? (view as { path: string }).path : null;
	// The file tree IS home — render the home crumb as the current location.
	if (!path) return <HomeCrumb inert active />;
	let segs = path.split('/').filter(Boolean);
	// A folder note collapses into its folder crumb (never a self-link tail).
	const isNote = isFolderNoteName(segs[segs.length - 1]);
	if (isNote) segs = segs.slice(0, -1);
	return (
		<nav class="flex min-w-0 items-center">
			<HomeCrumb active={segs.length === 0} />
			{segs.map((seg, i) => {
				const last = i === segs.length - 1;
				return (
					<span key={i} class="flex min-w-0 items-center">
						<CrumbSep />
						{last ? (
							<span class="truncate text-fg">{seg.replace(/\.md$/, '')}</span>
						) : (
							<button
								type="button"
								onClick={() => openFolder(segs.slice(0, i + 1).join('/'))}
								class="shrink-0 text-muted hover:text-fg hover:underline"
							>
								{seg}
							</button>
						)}
					</span>
				);
			})}
		</nav>
	);
}

// The brain switcher — the top-left control when the user can reach 2+ brains. Shows
// the active brain; the dropdown lists all reachable brains (active marked). Selecting
// the active brain re-opens its files; selecting another switches + opens its files.
function BrainSwitcher() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
		document.addEventListener('mousedown', onDoc);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);
	const rows = brainList ?? [];
	return (
		<div ref={ref} class="relative shrink-0">
			<button
				type="button"
				title="Switch brain"
				onClick={() => setOpen((o) => !o)}
				class="flex max-w-[44vw] items-center gap-1.5 rounded px-1.5 py-1 text-fg transition-colors hover:bg-chip"
			>
				<span class="text-muted">
					<BrainGlyph />
				</span>
				<span class="truncate font-medium">{activeBrain?.label ?? 'Brain'}</span>
				<span class="text-muted">
					<ChevronDownIcon />
				</span>
			</button>
			{open && (
				<div class="absolute left-0 top-full z-20 mt-1 max-h-[min(60vh,320px)] min-w-[210px] max-w-[80vw] overflow-y-auto overscroll-contain rounded-md border border-border bg-bg py-1 shadow-lg">
					{rows.map((b) => (
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								switchBrain(b.id);
							}}
							class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-chip"
						>
							<span class={b.active ? 'text-accent' : 'text-muted'}>
								<BrainGlyph />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-fg" title={b.label}>
									{b.label}
								</span>
								<span class="block text-xs text-muted">
									{b.role}
									{b.configPrUrl ? ' · setup pending' : b.needsConfig ? ' · not configured' : ''}
								</span>
							</span>
							{b.active && <span class="shrink-0 text-accent">✓</span>}
						</button>
					))}
					<div class="my-1 border-t border-border" />
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							openAddBrain();
						}}
						class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-muted hover:bg-chip hover:text-fg"
					>
						<span class="shrink-0 text-[15px] leading-none">＋</span>
						<span class="min-w-0 flex-1 truncate">Add a brain</span>
					</button>
				</div>
			)}
		</div>
	);
}

// One entry in the header's action slot. Views declare these (see ViewAction in
// core/view-registry.ts); the header no longer knows which view it is rendering for.
//
// Icon-only vs text is the view's call, and the two are not interchangeable: a bare
// glyph works for the tree's frequent, conventional actions and does not work for
// "invite a person to your organization". Icon actions therefore REQUIRE a title,
// which doubles as the accessible name.
function HeaderAction({ action }: { action: ViewAction }) {
	if (action.icon)
		return (
			<Button
				variant="ghost"
				size="icon"
				title={action.title}
				aria-label={action.title}
				disabled={action.disabled}
				onClick={action.onClick}
				class={action.active ? 'text-accent' : undefined}
			>
				{action.icon}
			</Button>
		);
	return (
		<Button
			variant={action.primary ? 'subtle' : 'ghost'}
			size="sm"
			title={action.title}
			disabled={action.disabled}
			onClick={action.onClick}
		>
			{action.label}
		</Button>
	);
}

function Header({ view }: { view: View }) {
	const editing = view.kind === 'edit';
	// In edit mode the navbar hosts the formatting toolbar (a second flush row) and a
	// subtle Save/Cancel — so editing feels integrated with the top chrome, not boxed.
	return (
		<header class="sticky top-0 z-10 bg-bg/90 backdrop-blur">
			{/* Fixed row height (not padding-driven) so toggling the search icon ↔ input —
			    which have slightly different intrinsic heights — can't nudge the header up/down. */}
			<div class="flex h-9 items-center gap-1.5 px-2.5 text-sm">
				{/* Top-left is brain-aware: with ≥1 brain it's the brain switcher (which lists
				    brains, opens the active brain's files, and offers "Add a brain"); with zero
				    brains it's an Add-a-brain button; before the list loads it's plain Files.
				    That branch also requires that no brain is currently open: offering
				    "create your first brain" to someone reading a page in one is always wrong, so
				    a brain on screen outranks an empty list however the list got that way. */}
				{brainList && brainList.length === 0 && !activeBrain ? (
					<Button
						variant="ghost"
						size="icon"
						title="Add a brain"
						aria-label="Add a brain"
						onClick={() => openAddBrain()}
					>
						<PlusIcon />
					</Button>
				) : brainList && brainList.length >= 1 ? (
					<BrainSwitcher />
				) : (
					<Button
						variant="ghost"
						size="icon"
						title="Files"
						aria-label="Files"
						onClick={() => openBrowse()}
					>
						<ListIcon />
					</Button>
				)}
				{/* Search and Graph sit with the brain switcher — all three are "get somewhere" —
				    not stranded among the secondary actions on the right. The rule the bar follows:
				    LEFT = where you are and where you can go (switcher, search, graph, breadcrumb),
				    RIGHT = what you can do here (tree tools, Edit, ⋯). Graph is lit while you're in
				    it, so its control sits beside the crumb it produces instead of at the opposite end
				    of the bar. Hidden while editing — leaving mid-edit would abandon it, the same
				    reason the ⋯ menu drops its nav rows. */}
				<span class="shrink-0">
					<SearchBox />
				</span>
				{!editing && (
					<button
						type="button"
						title="Graph view"
						onClick={() => openGraph(view.kind === 'page' ? view.path : undefined)}
						class={`shrink-0 rounded p-1 transition-colors hover:bg-chip ${
							view.kind === 'graph' ? 'text-accent' : 'text-muted hover:text-fg'
						}`}
					>
						<GraphIcon />
					</button>
				)}
				<Breadcrumb view={view} />
				<span class="ml-auto flex shrink-0 items-center gap-0.5">
					{/* "What you can do HERE" — supplied by the current view, not switched on
					    here. Five views used to have an empty slot and had to put their primary
					    action in the body instead; declaring actions per view is what closed that. */}
					{viewActions(view).map((a) => (
						<HeaderAction key={a.key} action={a} />
					))}
					<OverflowMenu editing={editing} />
				</span>
			</div>
			{/* The formatting toolbar slides in / out as you enter / leave edit (grid-rows
			    0fr↔1fr animates to the exact content height). Gated on the editor actually
			    being bound (editCtl.view) so it drops in WITH the buttons already there —
			    no blank-toolbar frame — and no opacity fade, which was the visible flash. */}
			<div
				class={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
					editing && editCtl.view ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
				}`}
			>
				<div class="min-h-0 overflow-hidden">
					<div class="flex items-center border-b border-border px-2 pb-1.5 pt-0.5">
						<EditorToolbar view={editCtl.view} />
					</div>
				</div>
			</div>
		</header>
	);
}

function Body({ view }: { view: View }) {
	return renderView(view);
}

function Root() {
	useSyncExternalStore(subscribeStore, () => version);
	const view = currentView;
	// Fullscreen gives the app the whole conversation area — use the extra room.
	const wide = displayMode === 'fullscreen';
	const inline = displayMode === 'inline';
	// INLINE = a bounded card in the chat column:
	//  - sizes to content up to a CAP (max-h), then scrolls WITHIN itself, so a long
	//    page/tree never pushes the conversation down. autoResize reports the capped
	//    height, so the host frames it tightly.
	//  - a border makes the card's edge visible in the chat, since the host doesn't
	//    always draw one. The scroll container is this root, so the sticky Header
	//    stays pinned while the body scrolls under it.
	// Fullscreen/pip own their own window → fill it (min-h-screen), no cap, no border.
	return (
		<div
			class={`flex flex-col bg-bg text-fg ${
				inline ? 'max-h-[560px] overflow-y-auto rounded-xl border border-border' : 'min-h-screen'
			}`}
		>
			<Header view={view} />
			{/* One padding source for every view (page / browse / search / edit / activity
			    / graph / members) so they read identically. Kept tight — the app usually
			    renders inline in the chat column, where big margins waste width. */}
			<main
				class={`mx-auto w-full flex-1 px-3.5 pt-3 pb-5 ${wide ? 'max-w-[1100px]' : 'max-w-[860px]'}`}
			>
				<Body view={view} />
			</main>
			<Toast />
			<ConfirmDialog />
		</div>
	);
}

// ---------- connect ----------

function connectToHost() {
	show({ kind: 'loading', label: 'Connecting…' }, { push: false });
	const timeout = setTimeout(() => {
		if (currentView.kind === 'loading') {
			show(
				{
					kind: 'error',
					headline: "Couldn't connect to the host.",
					detail:
						"The app never completed its handshake with the chat client. This usually means the host doesn't fully support MCP Apps yet.",
					retry: connectToHost
				},
				{ push: false }
			);
		}
	}, 5000);
	app
		.connect()
		.then(() => {
			clearTimeout(timeout);
			const ctx = app.getHostContext();
			if (ctx) applyHostContext(ctx); // may auto-request fullscreen (see applyHostContext)
			setTimeout(() => {
				if (currentView.kind === 'loading') openBrowse();
			}, 1200);
		})
		.catch((e) => {
			clearTimeout(timeout);
			show(
				{
					kind: 'error',
					headline: "Couldn't connect to the host.",
					detail: String(e),
					retry: connectToHost
				},
				{ push: false }
			);
		});
}

render(<Root />, document.getElementById('root')!);
connectToHost();
