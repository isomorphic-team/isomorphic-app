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
import { useSyncExternalStore } from 'preact/compat';
import type { View } from './core/types.ts';
import type { ViewAction } from './core/view-registry.ts';
import { subscribeStore, version, currentView, show } from './core/store.ts';
import { activeDestination, isMorePlace } from './core/nav.ts';
import { destinations } from './components/Destinations.tsx';
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
	openMore,
	guardNav
} from './core/actions.ts';
import { toast, Toast, ConfirmDialog } from './core/toast.tsx';
import { MoreIcon } from './core/icons.tsx';
import { Button, Menu, MenuRow } from './ui/index.ts';
import { Breadcrumb } from './components/Breadcrumb.tsx';
// The Body dispatch table is codegenned from app/views/*.tsx (see scripts/gen-app.ts).
import { renderView, viewActions } from './views/registry.generated.ts';
// Chrome still binds the editor's save/cancel + toolbar directly.
import { EditorToolbar, editCtl } from './views/EditView.tsx';

// ---------- host wiring ----------

app.onhostcontextchanged = applyHostContext;
app.onerror = (e) => toast(String(e), true);
app.ontoolresult = handleToolResult;

// A RESULT IS COMING. The host announces the tool call that opened this widget when the
// call STARTS and delivers its result when the tool FINISHES, so silence at the
// self-boot deadline below means "the tool is still running", not "nothing is coming" —
// and view_page on a large brain (a cold Worker, an index catch-up) is routinely slower
// than the deadline. Self-booting into the file tree there is what made the app flash
// the right page and then replace it with the tree: the tree fetch went out FIRST and
// answered LAST, so it landed on top of the page that had arrived meanwhile.
//
// These are one-shot events, so the handlers are registered here at module scope, before
// connect() — the host may send them the moment the handshake completes.
let resultPending = false;
function noteResultComing() {
	resultPending = true;
}
app.ontoolinput = noteResultComing;
app.ontoolinputpartial = noteResultComing;
// Cancelled means the result is NOT coming after all, so stop holding the screen for it.
app.ontoolcancelled = () => {
	resultPending = false;
};

// ---------- chrome ----------

// WHICH WINDOW THIS IS, at the right end of the top bar.
//
// It used to be the third group inside the rail's ⋯ menu, filed beside Members and Your
// settings, which put a WINDOW CONTROL among PLACES and is most of why that menu read as
// a junk drawer. It is not a destination: it changes how the app is presented, not what
// you are looking at, and it is the one thing here that must stay reachable without
// navigating — going fullscreen to read something has to leave you on the thing you were
// reading.
//
// Right end of the bar rather than in the rail. The rail is destinations only, and the
// bottom of the rail (the other candidate) collides with the destination group on a
// short card, which is why that column is top-anchored. The honest wrinkle: this end of
// the bar is otherwise the current VIEW's actions, and display mode belongs to the app.
// The gap before it is what separates the two.
function DisplayMenu() {
	const modes = availableModeList();
	// One mode is not a choice. A host that offers no alternative gets no control.
	if (modes.length < 2) return null;
	return (
		<Menu
			label="Display"
			align="end"
			class="ml-1 border-l border-border pl-1.5"
			trigger={({ props }) => (
				<Button
					variant="ghost"
					size="icon"
					title={`Display: ${MODE_LABEL[displayMode]}`}
					aria-label={`Display: ${MODE_LABEL[displayMode]}`}
					{...props}
				>
					{MODE_ICON[displayMode]}
				</Button>
			)}
		>
			{(close) =>
				modes.map((m) => (
					<MenuRow
						key={m}
						onClick={() => {
							close();
							setDisplayMode(m);
						}}
						class={m === displayMode ? 'text-accent' : 'text-fg'}
					>
						<span class="w-4 text-center">{MODE_ICON[m]}</span>
						<span class="flex-1">{MODE_LABEL[m]}</span>
						{m === displayMode && <span>✓</span>}
					</MenuRow>
				))
			}
		</Menu>
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

// THE RAIL — where else you can go. The app's three questions, one zone each:
//
//   ▤   🧠 Team brain / wiki / people / Ada Lovelace       🔍   ⟳ 4m   Edit
//   ⁙   ───────────────────────────────────────────────────────────────────
//   ⏱   # Ada Lovelace
//   ⇗
//   ⋯
//
// Left rail = WHERE ELSE YOU COULD BE. Top left = WHERE YOU ARE. Top right = WHAT YOU
// CAN DO HERE. Nothing answers two of those, which is the failure every previous
// arrangement of this bar had in some form: destinations pushed into the breadcrumb's
// chevrons (a trail claiming to know about views), then destinations and page actions
// sharing one run of buttons at the right end (Edit beside Graph, indistinguishable).
//
// A rail is also where "you are here" reads best. Lit-among-four in a horizontal run of
// nine controls is a weak signal; a vertical stack of four with one in accent is not.
//
// It costs ~40px of width, which is free in fullscreen and real in an inline chat card.
// The trade is deliberate: the trail truncates and the content column is centred with
// margin to spare, so the rail eats margin rather than text almost everywhere.
//
// `aria-current` rather than `aria-pressed`: these are navigation, and a nav control is
// current or it is not — it is never a toggle that happens to be down.
// One slot in the rail. The active marker is an EDGE, not a fill: a filled square in a
// 40px column is a heavy mark to carry permanently, and the edge is what every
// rail-shaped nav uses, so it reads as "current" without being read as "selected item
// in a list".
function RailItem({ current, children }: { current: boolean; children: ComponentChildren }) {
	return (
		<div class="relative flex w-full justify-center">
			{current && (
				<span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-accent" />
			)}
			{children}
		</div>
	);
}

function Rail({ view }: { view: View }) {
	const here = activeDestination(view.kind);
	return (
		// Stretches to the full height of the content so its edge runs the whole card,
		// while the icons inside stick to the top — a bottom-anchored group would collide
		// with the top one in a short inline card, where the whole app may be 200px tall.
		<aside class="w-10 shrink-0 border-r border-border" aria-label="Places">
			{/* z-30 IS THE CHROME LAYER, and it has to be stated rather than left to auto.
			    `position: sticky` creates a stacking context, so the z-20 that ui/Menu.tsx
			    puts on an open panel is scoped to THIS nav and cannot lift the panel over
			    anything in <main>, a later sibling: the overflow menu rendered underneath
			    the analytics chart's bars. Content-layer overlays run up to z-20 (the
			    analytics tooltip at 10, ProseMirror's column-resize handle at 20), so chrome
			    sits above them at 30. Header carries the same value for the same reason. */}
			<nav class="sticky top-0 z-30 flex flex-col items-center gap-0.5 py-1.5">
				{/* THE RAIL DOES NOT GO AWAY WHILE YOU EDIT. Every destination does abandon an
				    in-progress edit, which is why this row used to empty itself out — but
				    hiding the controls cost the user their navigation and protected nothing,
				    since the trail beside them stayed linked and kept its brain switcher. So
				    the rail stays whole and `guardNav` asks before discarding (actions.ts). */}
				{destinations('brain').map((d) => {
					// GRAPH IS THE ONE CONTEXTUAL CONTROL. From a page it passes that page's
					// path, and view_graph with a path returns the subgraph around it, so the
					// button means "this page's neighbours" there and "the whole brain"
					// everywhere else. A control whose meaning changes with context has to
					// say so, which is what the title does.
					const onPage = d.key === 'graph' && view.kind === 'page';
					const title = onPage ? 'Show this page in the graph' : d.label;
					const current = d.key === here;
					return (
						<RailItem key={d.key} current={current}>
							<Button
								variant="ghost"
								size="icon"
								title={title}
								aria-label={title}
								aria-current={current ? 'page' : undefined}
								onClick={guardNav(onPage ? () => openGraph(view.path) : d.open)}
								class={current ? 'text-accent' : undefined}
							>
								{d.icon}
							</Button>
						</RailItem>
					);
				})}
				<span class="my-0.5 h-px w-4 bg-border" />
				{/* ⋯ IS A DESTINATION LIKE THE REST OF THE RAIL, not a menu. It opens the More
				    page, which carries the org and account scopes: one press further in than
				    the brain's own views because they are rarer, and separate because sitting
				    open in the rail beside them would read as "these belong to this brain",
				    the containment claim the scope split exists to prevent.
				    It lights while you are on More AND while you are on anything More led you
				    to, so the rail keeps answering "where am I" two steps in (isMorePlace). */}
				{(() => {
					const current = isMorePlace(view.kind);
					return (
						<RailItem current={current}>
							<Button
								variant="ghost"
								size="icon"
								title="More"
								aria-label="More"
								aria-current={current ? 'page' : undefined}
								onClick={guardNav(openMore)}
								class={current ? 'text-accent' : undefined}
							>
								<MoreIcon />
							</Button>
						</RailItem>
					);
				})()}
			</nav>
		</aside>
	);
}

// ONE ROW: where you are, and what you can do to it. Where else you could be is the
// rail (above), which is what lets this row stay one row.
//
// A SECOND ROW IS A MODE, NOT A FIXTURE. It appears when you enter the editor, carrying
// the formatting toolbar, and that is the whole of its job — the appearing is the
// signal. A permanent second row holding two icons was the version before this, and it
// read as leftover space rather than a zone, because a row that is always there cannot
// tell you anything by being there.
function Header({ view }: { view: View }) {
	const editing = view.kind === 'edit';
	// The toolbar waits for the editor to actually be bound, so the row drops in WITH
	// the buttons already in it — no blank-toolbar frame, and no opacity fade, which was
	// the visible flash.
	const toolbar = editing && editCtl.view ? editCtl.view : null;
	return (
		<header class="sticky top-0 z-30 bg-bg/90 backdrop-blur">
			{/* Fixed row height (not padding-driven) so toggling the search icon ↔ input —
			    which have slightly different intrinsic heights — can't nudge the header up/down. */}
			<div class="flex h-9 items-center gap-1.5 px-2.5 text-sm">
				{/* The trail owns the left edge, whole. It starts at the BRAIN — which is what
				    killed the separate top-left switcher: that control and the ⌂ crumb beside
				    it were the same destination twice (see components/Breadcrumb). Nothing may
				    sit between the brain and the rest of the path, or the trail stops reading
				    as one. */}
				<Breadcrumb view={view} />
				<span class="ml-auto flex shrink-0 items-center gap-0.5">
					{/* "What you can do HERE" — supplied by the current view, not switched on
					    here. Five views used to have an empty slot and had to put their primary
					    action in the body instead; declaring actions per view is what closed
					    that. They have this end of the bar to themselves now that the
					    destinations have a rail. */}
					{viewActions(view).map((a) => (
						<HeaderAction key={a.key} action={a} />
					))}
					{/* Then the window itself, after a rule. Not one of the view's actions, and
					    the separator is what says so. */}
					<DisplayMenu />
				</span>
			</div>
			{/* The formatting toolbar slides in / out as you enter / leave edit — grid-rows
			    0fr↔1fr animates to the exact content height. `data-row` rides on the
			    collapsing element rather than the content inside it, so a collapsed row
			    measures zero and a test can assert its absence the way a user sees it. */}
			<div
				data-row="actions"
				class={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
					toolbar ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
				}`}
			>
				<div class="min-h-0 overflow-hidden">
					<div class="flex items-center border-b border-border px-2 pb-1.5 pt-0.5">
						<EditorToolbar view={toolbar} />
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
		// A ROW at the top level now: the rail, then everything else in a column beside
		// it. The rail is a sibling of the header rather than something inside it, because
		// it spans the whole card — the header scrolls its content under a sticky bar, and
		// the rail is not part of that.
		// THE RAIL IS THE HEIGHT FLOOR: the window is never shorter than the list of
		// places you can go. That already fell out of flex sizing, since the aside's nav
		// has intrinsic height and nothing caps it, and it is stated here so it survives
		// a later `overflow-hidden` on main or an absolutely positioned rail. A stale
		// value is harmless in one direction only: too low and flex still gives the rail
		// what it needs, too high and short views grow dead space. Inline only, because
		// min-h-screen already clears it and two min-h utilities on one element would
		// resolve by stylesheet order rather than by the order they are written here.
		<div
			class={`flex bg-bg text-fg ${
				inline
					? 'min-h-[168px] max-h-[560px] overflow-y-auto rounded-xl border border-border'
					: 'min-h-screen'
			}`}
		>
			<Rail view={view} />
			{/* min-w-0 so the trail's truncation still works: without it the flex child
			    takes its content's intrinsic width and a long path pushes the card wider
			    than the chat column instead of ellipsing. */}
			<div class="flex min-w-0 flex-1 flex-col">
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
			</div>
			<Toast />
			<ConfirmDialog />
		</div>
	);
}

// ---------- connect ----------

// How long the app waits for an opening tool result before drawing something itself.
// The short one is the ordinary case (no call announced); the long one bounds the wait
// when the host HAS announced a call, so a tool that never returns still ends with a
// usable app rather than a permanent spinner.
const SELF_BOOT_MS = 1200;
const SELF_BOOT_MAX_MS = 30_000;

function connectToHost() {
	show({ kind: 'loading', label: 'Connecting…', task: 'connect' }, { push: false });
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
			// SELF-BOOT: no tool result arrived, so open the tree ourselves — and fetch the
			// nav's own data too, which handleToolResult would otherwise have been the only
			// thing to ask for. Without this the app came up with no brain list: no brain
			// picker, and the Analytics row silently absent because `features` rides on that
			// same payload.
			//
			// Two deadlines, because "nothing yet" means two different things. If the host
			// never announced a call, none is coming (a widget reopened from history, a host
			// that does not replay) and the tree is the right thing to draw. If it DID
			// announce one, the result is what belongs on screen and the app waits for it —
			// but not forever: a hung tool must still leave something usable behind.
			let waited = 0;
			const selfBoot = () => {
				if (currentView.kind !== 'loading') return; // a result landed, or we moved on
				waited += SELF_BOOT_MS;
				if (resultPending && waited < SELF_BOOT_MAX_MS) {
					setTimeout(selfBoot, SELF_BOOT_MS);
					return;
				}
				void ensureBrainList();
				openBrowse();
			};
			setTimeout(selfBoot, SELF_BOOT_MS);
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
