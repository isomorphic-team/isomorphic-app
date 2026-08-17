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
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSyncExternalStore } from 'preact/compat';
import type { View } from './core/types.ts';
import type { ViewAction } from './core/view-registry.ts';
import { subscribeStore, version, currentView, show, brainList, features } from './core/store.ts';
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
	ensureBrainList,
	openBrowse,
	openGraph,
	openActivity,
	openMembers,
	openAnalytics,
	openBrainAccess,
	openBrains,
	openSettings,
	runSearch
} from './core/actions.ts';
import { toast, Toast, ConfirmDialog } from './core/toast.tsx';
import {
	SearchIcon,
	HistoryIcon,
	GraphIcon,
	PeopleIcon,
	ChartIcon,
	ShareIcon,
	MoreIcon,
	GearIcon,
	BrainGlyph
} from './core/icons.tsx';
import { Button, Menu, MenuRow, MenuSeparator } from './ui/index.ts';
import { Breadcrumb } from './components/Breadcrumb.tsx';
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
// down to the trail + Search/Graph + Edit. New destinations (Org settings, etc.)
// become rows here — the bar never grows. Contents are contextual: while editing,
// only Display (switching views mid-edit would abandon it); otherwise the full nav +
// settings. Hidden entirely if it would be empty.
function OverflowMenu({ editing }: { editing: boolean }) {
	const modes = availableModeList();
	const hasDisplay = modes.length >= 2;
	// While editing there's nothing but Display — if the host offers one mode, drop the
	// whole menu rather than show an empty ⋯.
	if (editing && !hasDisplay) return null;
	return (
		<Menu
			label="More"
			align="end"
			trigger={({ props }) => (
				<Button variant="ghost" size="icon" title="More" aria-label="More" {...props}>
					<MoreIcon />
				</Button>
			)}
		>
			{(close) => {
				const go = (fn: () => void) => () => {
					close();
					fn();
				};
				return (
					<>
						{/* GROUPED BY SCOPE, the same three groups the breadcrumb uses. Recent
						    changes and Sharing are views of THIS BRAIN and change when you switch
						    brains. Members is a view of the ORGANIZATION: every brain in one org
						    shows the same roster, so it moved out of "This brain", where it was the
						    one row that failed the test the group is named for. Manage brains and
						    Your settings are views of YOUR ACCOUNT and change with neither.
						    Ungrouped, this read as one flat list of unrelated places, which is what
						    made Members look like a property of whichever brain you were in.
						    Graph is not here: it has its own lit control in the bar, and a row would
						    be a second way to say the same thing. */}
						{!editing && (
							<>
								<div class={`px-3 pb-0.5 pt-1 ${eyebrow}`}>This brain</div>
								<MenuRow onClick={go(() => openActivity())}>
									<span class="w-4 text-muted">
										<HistoryIcon />
									</span>
									<span class="flex-1">Recent changes</span>
								</MenuRow>
								{/* Ungated: brain_access is read-only and open to anyone who can reach
								    the brain, so unlike Manage brains below there is no role to check.
								    Members is the org's people, this is who reaches THIS brain. */}
								<MenuRow onClick={go(() => openBrainAccess())}>
									<span class="w-4 text-muted">
										<ShareIcon />
									</span>
									<span class="flex-1">Sharing</span>
								</MenuRow>
								<MenuSeparator />
								<div class={`px-3 pb-0.5 pt-1 ${eyebrow}`}>Organization</div>
								<MenuRow onClick={go(openMembers)}>
									<span class="w-4 text-muted">
										<PeopleIcon />
									</span>
									<span class="flex-1">Members</span>
								</MenuRow>
								{/* Shown only where the server registered it: usage recording is
								    opt-in per deployment (USAGE_ANALYTICS), and this menu must not
								    offer a row whose click comes back "unknown tool". */}
								{features.analytics && (
									<MenuRow onClick={go(() => openAnalytics())}>
										<span class="w-4 text-muted">
											<ChartIcon />
										</span>
										<span class="flex-1">Analytics</span>
									</MenuRow>
								)}
								<MenuSeparator />
								<div class={`px-3 pb-0.5 pt-1 ${eyebrow}`}>Your account</div>
								{/* Brain management (add/remove) — the brain crumb's picker is
								    switch-only. Shown when the user is admin of at least one org. */}
								{brainList?.some((b) => b.canManage) && (
									<MenuRow onClick={go(openBrains)}>
										<span class="w-4 text-muted">
											<BrainGlyph />
										</span>
										<span class="flex-1">Manage brains</span>
									</MenuRow>
								)}
								<MenuRow onClick={go(openSettings)}>
									<span class="w-4 text-muted">
										<GearIcon />
									</span>
									<span class="flex-1">Your settings</span>
								</MenuRow>
							</>
						)}
						{hasDisplay && (
							<>
								{!editing && <MenuSeparator />}
								<div class={`px-3 pb-0.5 pt-1 ${eyebrow}`}>Display</div>
								{modes.map((m) => (
									<MenuRow
										key={m}
										onClick={go(() => setDisplayMode(m))}
										class={m === displayMode ? 'text-accent' : 'text-fg'}
									>
										<span class="w-4 text-center">{MODE_ICON[m]}</span>
										<span class="flex-1">{MODE_LABEL[m]}</span>
										{m === displayMode && <span>✓</span>}
									</MenuRow>
								))}
							</>
						)}
					</>
				);
			}}
		</Menu>
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
			// An icon action MAY also carry a label, and then wears both: the page's
			// refresh control reports the render's age beside its glyph, which is a
			// property of the action rather than a second control, and splitting them
			// into two header slots would read as two things to press. `xs` rather than
			// the default size so a labelled icon button stays the same height as the
			// bare glyphs beside it. `aria-label` stays the title either way, since the
			// visible text is a value ("4m") and not the name of what the button does.
			<Button
				variant="ghost"
				size={action.label ? 'xs' : 'icon'}
				title={action.title}
				aria-label={action.title}
				disabled={action.disabled}
				onClick={action.onClick}
				aria-pressed={action.active === undefined ? undefined : action.active}
				class={action.active ? 'text-accent' : undefined}
			>
				{action.icon}
				{action.label && <span class="tabular-nums">{action.label}</span>}
			</Button>
		);
	// A LABELLED action lights up exactly like an icon one. This branch used to drop
	// `active` on the floor, so a labelled toggle group (the analytics window: 7d /
	// 30d / 90d) rendered as three identical buttons with no way to tell which one you
	// were looking at. Same accent the icon branch uses, plus aria-pressed, since three
	// buttons where one is selected is a toggle group and not three separate commands.
	return (
		<Button
			variant={action.primary ? 'subtle' : 'ghost'}
			size="sm"
			title={action.title}
			disabled={action.disabled}
			onClick={action.onClick}
			aria-pressed={action.active === undefined ? undefined : action.active}
			class={action.active ? 'text-accent' : undefined}
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
				{/* The trail owns the left edge, whole. It starts at the BRAIN — which is
				    what killed the separate top-left switcher: that control and the ⌂ crumb
				    beside it were the same destination twice (see components/Breadcrumb).
				    Nothing may sit between the brain and the rest of the path, or the trail
				    stops reading as one. */}
				<Breadcrumb view={view} />
				<span class="ml-auto flex shrink-0 items-center gap-0.5">
					{/* Search and Graph moved here when the brain became the head of the trail:
					    the left edge is now the trail and nothing else. The rule the bar follows
					    is LEFT = where you are, RIGHT = what you can do about it — and both of
					    these act on the brain you are already in (search it, re-draw it as a
					    graph) rather than naming a place. Graph stays lit while you're in it.
					    Both are hidden while editing — leaving mid-edit would abandon it, the
					    same reason the ⋯ menu drops its nav rows.

					    This button SURVIVED the crumb picker gaining a Graph row, because on a
					    page it is not the same action: it passes the page's path, and view_graph
					    with a path returns the subgraph around it. "This page's neighbours" is
					    not something a list of destinations can express — and a page's trail ends
					    in a path crumb, so it has no destination picker to express it in. The
					    title says which of the two you are getting; a control whose meaning
					    changes with context has to say so. */}
					{!editing && (
						<>
							<SearchBox />
							<Button
								variant="ghost"
								size="icon"
								title={view.kind === 'page' ? 'Show this page in the graph' : 'Graph view'}
								aria-label={view.kind === 'page' ? 'Show this page in the graph' : 'Graph view'}
								onClick={() => openGraph(view.kind === 'page' ? view.path : undefined)}
								class={view.kind === 'graph' ? 'text-accent' : undefined}
							>
								<GraphIcon />
							</Button>
						</>
					)}
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
			{/* `data-view` names the view currently rendered. It rides on the <main> that
			    was already here rather than a wrapper, so it adds no element and cannot
			    change layout, and it sits at the ONE render site rather than in each view
			    file, so a view added later carries it for free. `pnpm test:ui` selects on
			    it: [data-view="page"], [data-view="browse"], and so on. */}
			<main
				data-view={view.kind}
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
				// SELF-BOOT: no tool result arrived, so open the tree ourselves — and fetch
				// the nav's own data too, which handleToolResult would otherwise have been
				// the only thing to ask for. Without this the app came up with no brain
				// list: no brain picker, and the Analytics row silently absent because
				// `features` rides on that same payload. Safe to fire only here, where by
				// definition no result is coming to name a brain first.
				if (currentView.kind === 'loading') {
					void ensureBrainList();
					openBrowse();
				}
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
