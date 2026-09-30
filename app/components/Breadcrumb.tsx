// The location trail: WHERE YOU ARE, and nothing else.
//
//   🧠 Team brain / wiki / people / Ada Lovelace
//
// Where else you could BE (the file tree, the graph, the activity feed, the sharing
// panel, the org and account screens) is the RAIL down the left edge (main.tsx). The
// trail names places; it never names a view or offers one.
//
// The brain IS the root of the trail. Its glyph opens the Brains page (which brain) and
// its label opens that brain's file tree (home).
//
// NO CRUMB IS A PICKER. A panel hanging off the top row gets the space beneath it and no
// more, so on a short inline card any list of siblings or brains becomes a scroll box a
// row and a half tall. Siblings are the file tree's job and brains are the Brains page's,
// both of which have room. What is left is an icon, text, and links.
import type { ComponentChildren, VNode } from 'preact';
import type { View } from '../core/types.ts';
import { isFolderNoteName } from '../core/util.ts';
import { brainList, activeBrain, goBack, backKind, canGoBack, stepBack } from '../core/store.ts';
import type { Scope } from '../core/nav.ts';
import {
	openBrowse,
	openFolder,
	openBrains,
	openMembers,
	openSettings,
	openBrainAccess,
	guardNav
} from '../core/actions.ts';
import { BrainGlyph, ArrowLeftIcon, BuildingIcon, PersonIcon, MoreIcon } from '../core/icons.tsx';
import { crumbCurrent, crumbLink, crumbMeta } from '../ui/typography.ts';

// Wide enough that a crumb and the slash after it never read as one unit.
// The rule the trail follows: tight INSIDE a crumb, loose BETWEEN crumbs (here).
const CrumbSep = () => <span class="mx-2 shrink-0 text-muted opacity-50">/</span>;

// The leading slot's geometry, worn by the brain glyph that opens a brain screen's
// trail and, without the margin, by the back button ahead of every trail. Identical
// insets in both, including the padding a glyph has no other use for, because unequal
// ones moved every label in the bar by 2px when the two sat in the same place.
// The back button wears the same box without the margin: it sits outside the trail, and
// the header's own gap spaces it.
const SLOT_BOX =
	'shrink-0 rounded p-0.5 text-muted outline-none transition-colors hover:bg-chip hover:text-fg focus-visible:ring-2 focus-visible:ring-accent';
const LEADING_SLOT = `mr-1.5 ${SLOT_BOX}`;

// ---------- the crumbs ----------

// The root crumb: which brain you are in. Two controls, and they answer the trail's two
// halves separately: the GLYPH changes which brain, the LABEL opens that brain's file
// tree (the way home from every view).
//
// The label NAMES A BRAIN and nothing else, never a view's name. Every payload that
// draws brain content carries `activeBrain` (list_pages included), so the fallback
// means we genuinely do not know yet, and it says so generically.
function BrainCrumb({ inert }: { inert?: boolean }) {
	const label = activeBrain?.label ?? (brainList?.length === 0 ? 'No brain' : 'Brain');
	// THE GLYPH IS THE SWITCHER: the mark that means "brain" carries the action.
	const glyph = (
		<button
			type="button"
			title="Switch brain"
			aria-label="Switch brain"
			onClick={guardNav(openBrains)}
			class={LEADING_SLOT}
		>
			<BrainGlyph />
		</button>
	);
	// `inert` is the FILE TREE, where the brain crumb is not a step on the way to the
	// place you are — it IS the place, the root the tree is rooted at. So it takes the
	// same colour as any other terminus (see crumbCurrent) and drops the link, exactly
	// as the last folder crumb does one level down.
	const name = inert ? (
		<span class={`min-w-0 truncate ${crumbCurrent}`} title={label}>
			{label}
		</span>
	) : (
		<button
			type="button"
			title="Files"
			onClick={guardNav(openBrowse)}
			class={`min-w-0 truncate ${crumbLink}`}
		>
			{label}
		</button>
	);
	// SWITCHING BRAINS IS A PAGE, not a popover: BrainsView lists every brain you can
	// reach with roles and the active one ticked, plus add, disconnect and sharing. A
	// floating panel cannot hold that list on a short card (see NO CRUMB IS A PICKER).
	return (
		// CAPPED, so a long brain name cannot push the rest of the trail across the bar:
		// the crumbs after it move with its length, and a cap bounds how far.
		<span class="flex min-w-0 max-w-[min(44vw,14rem)] shrink items-center">
			{glyph}
			{name}
		</span>
	);
}

// One path segment. `last` is the current location, so its label is inert: a crumb must
// never be a self-link that goes nowhere. A folder crumb opens the tree revealed at
// that folder (openFolder). Siblings are the file tree's job, not a picker's.
function PathCrumb({ seg, path, last }: { seg: string; path: string; last: boolean }) {
	const label = seg.replace(/\.md$/, '');
	return (
		// Only the tail gives ground. A trail that squeezed every segment equally would
		// render a deep path as a row of two-letter stubs; the ancestors stay at full
		// width and the current location is what truncates.
		<span class={`flex items-center ${last ? 'min-w-0 shrink' : 'shrink-0'}`}>
			{last ? (
				<span class={`truncate ${crumbCurrent}`}>{label}</span>
			) : (
				<button
					type="button"
					onClick={guardNav(() => openFolder(path))}
					class={`truncate ${crumbLink}`}
				>
					{label}
				</button>
			)}
		</span>
	);
}

// THE BACK BUTTON, ahead of the whole trail on every screen. A way back is history
// rather than location, so it is an ARROW and not a crumb: anything that looks like a
// crumb has to behave like one (name a place, offer what else is at that level), and a
// back arrow promises neither, so it can honestly go wherever you came from.
//
// It used to exist only on screens outside the brain (Members, Analytics, Manage
// brains, Your settings), which have no parent crumb to name. Inside the brain the
// trail answered "where am I" and nothing answered "where was I", so following a link
// from one page to another left no way back but finding the first page again.
//
// Where it lands, and when there is nowhere, is `stepBack` / `canGoBack` in the store.
// With nowhere it is DISABLED rather than absent, so the trail never shifts sideways
// the moment a first step is taken.
export function BackButton() {
	const enabled = canGoBack();
	return (
		<button
			type="button"
			title="Back"
			aria-label="Back"
			disabled={!enabled}
			onClick={guardNav(stepBack)}
			class={`${SLOT_BOX} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted`}
		>
			<ArrowLeftIcon />
		</button>
	);
}

// THE SCOPE MARK: what an org or account screen puts where a brain screen has its
// glyph. Without one the trail started 25px further left on those screens, so every
// crossing between a brain and Members, Analytics, Brains or Your settings slid the
// title sideways and back. Same box as the glyph (LEADING_SLOT, minus the hover it has
// no action for), so the title starts at one x on every screen, and the mark says which
// scope you are in rather than leaving a gap to say nothing.
//
// Decorative: the crumb after it already names the place, so it is hidden from the
// accessibility tree rather than announced twice.
const SCOPE_ICON: Record<Exclude<Scope, 'brain'>, () => VNode> = {
	org: BuildingIcon,
	account: PersonIcon
};
function ScopeMark({ icon }: { icon: VNode }) {
	return (
		<span data-scope-mark class="mr-1.5 flex shrink-0 p-0.5 text-muted" aria-hidden="true">
			{icon}
		</span>
	);
}

// NO TALLIES. A crumb names a place; it does not report on it (a count of what the view
// below already shows in full). What goes after the · is only ever IDENTITY, such as
// which page's history, because that distinguishes one instance of a view from another.
//
// A destination that has no path (Search, Recent changes, Graph, …) still hangs off the
// brain crumb:
//
//   🧠 Team brain / Recent changes
//
// so leaving it is the same one click as anywhere else. `parent` adds one clickable
// crumb between the brain and the destination, for a view that was PUSHED from another
// (← Manage brains / Add a brain): a pushed flow needs a way back to the thing that
// opened it, not just a way home, and the crumb is where a user looks for it.
function DestinationCrumb({
	parent,
	root = 'brain',
	mark,
	children
}: {
	parent?: { key: string; label: string; onClick: () => void };
	/** The scope mark's icon, when the scope's own would say less (see ScopeMark). */
	mark?: VNode;
	/**
	 * See THE SCOPE TEST in app/core/nav.ts. Only `brain` screens sit INSIDE the brain
	 * and get the brain crumb; `org` and `account` ones sit beside it, so their trail is
	 * just the destination, after the back button every screen has.
	 */
	root?: Scope;
	children: ComponentChildren;
}) {
	return (
		<nav class="flex min-w-0 items-center">
			{root === 'brain' ? (
				<>
					<BrainCrumb />
					<CrumbSep />
				</>
			) : (
				<ScopeMark icon={mark ?? SCOPE_ICON[root]()} />
			)}
			{parent && (
				<>
					<button
						type="button"
						onClick={guardNav(parent.onClick)}
						class={`shrink-0 truncate ${crumbLink}`}
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

// The trail MIRRORS THE FILE TREE: the brain crumb is the tree's root and every folder
// the tree shows is a crumb, content roots included. A folder crumb opens the tree
// REVEALED at that folder (expanded + highlighted), whether or not the folder has a
// note. A folder-note page collapses into its folder crumb (wiki/index.md shows as
// "🧠 / wiki") so the trailing crumb is never a self-link.
export function Breadcrumb({ view }: { view: View }) {
	if (view.kind === 'search')
		return (
			<DestinationCrumb>
				{/* No query after the ·. The search PAGE carries its own field, showing the
				    query in the thing you typed it into, so a copy up here would be the trail
				    reporting a value the screen below is already displaying — the same rule
				    that keeps tallies out of it. */}
				<span class={crumbCurrent}>Search</span>
			</DestinationCrumb>
		);
	if (view.kind === 'review')
		return (
			<DestinationCrumb>
				<span class={crumbCurrent}>Review</span>
			</DestinationCrumb>
		);
	if (view.kind === 'activity')
		return (
			<DestinationCrumb>
				<span class={crumbCurrent}>Recent changes</span>
				{view.scopePath && <span class={crumbMeta}> · {view.scopePath}</span>}
			</DestinationCrumb>
		);
	// Labelled like every other destination, so the trail never trails off. The
	// page/link tally lives in the canvas's own corner.
	if (view.kind === 'graph')
		return (
			<DestinationCrumb>
				<span class={crumbCurrent}>Graph</span>
			</DestinationCrumb>
		);
	// More is the one screen that belongs to no single scope: it is the index of both the
	// org and the account destinations. Any non-brain root leaves it the back button
	// alone, which is what it needs — it sits BESIDE the brain like everything it lists,
	// and a brain crumb would claim the organization is inside the brain.
	if (view.kind === 'more')
		return (
			<DestinationCrumb root="account" mark={<MoreIcon />}>
				<span class={crumbCurrent}>More</span>
			</DestinationCrumb>
		);
	// ORG root, not brain: every brain in the org shows the same roster, so a brain
	// crumb would read as "these people belong to this brain".
	if (view.kind === 'members')
		return (
			<DestinationCrumb root="org">
				<span class={crumbCurrent}>Members</span>
			</DestinationCrumb>
		);
	// Org root for the same reason as Members: the numbers describe the organization,
	// so switching to a sibling brain shows the identical page.
	//
	// No window suffix here. The trail says WHERE YOU ARE, and the time range is not
	// a place: it is the view's own control, in the header's right-hand slot.
	if (view.kind === 'analytics')
		return (
			<DestinationCrumb root="org">
				<span class={crumbCurrent}>Analytics</span>
			</DestinationCrumb>
		);
	if (view.kind === 'brains')
		return (
			<DestinationCrumb root="account" mark={<BrainGlyph />}>
				<span class={crumbCurrent}>Brains</span>
			</DestinationCrumb>
		);
	if (view.kind === 'settings')
		return (
			<DestinationCrumb root="account">
				<span class={crumbCurrent}>Your settings</span>
			</DestinationCrumb>
		);
	// The flows. Each is a pushed view (the card is already a bounded box, so a flow
	// that needs room takes the whole card rather than floating a dialog inside it —
	// app/ui/Flow.tsx) and hangs off the screen it was opened from, so the crumb is the
	// way back out as well as the statement of where you are.
	// The parent crumb is conditional: add-brain is reachable three ways (the brains
	// list, the brain picker, the no-brains empty state), so it is shown only when Back
	// actually goes to the brains list. A crumb must never name a destination its own
	// click would not reach.
	if (view.kind === 'add-brain')
		return (
			<DestinationCrumb
				root="account"
				mark={<BrainGlyph />}
				parent={
					backKind() === 'brains'
						? { key: 'brains', label: 'Brains', onClick: () => goBack(openBrains) }
						: undefined
				}
			>
				<span class={crumbCurrent}>{view.first ? 'Create your first brain' : 'Add a brain'}</span>
			</DestinationCrumb>
		);
	if (view.kind === 'invite-member')
		return (
			<DestinationCrumb
				root="org"
				parent={{ key: 'members', label: 'Members', onClick: () => goBack(openMembers) }}
			>
				<span class={crumbCurrent}>Invite</span>
			</DestinationCrumb>
		);
	// Sharing passes THE SCOPE TEST: who can reach a brain is a fact about that brain,
	// and switching brains shows a different answer. So it is a view OF the brain and a
	// peer of Files, Graph and Recent changes, pickable from any of them.
	//
	// The crumb names the brain the RESULT carries (`activeBrain` on brain_access's
	// payload, adopted by pickShownBrain), so the Share control in the brains list opens
	// a panel for one brain under that brain's crumb without moving the active pointer.
	if (view.kind === 'brain-access')
		return (
			<DestinationCrumb>
				<span class={crumbCurrent}>Sharing</span>
			</DestinationCrumb>
		);
	if (view.kind === 'share-brain')
		return (
			<DestinationCrumb
				parent={{
					key: 'sharing',
					label: 'Sharing',
					onClick: () => goBack(() => openBrainAccess(view.brainId))
				}}
			>
				<span class={crumbCurrent}>Share</span>
			</DestinationCrumb>
		);
	if (view.kind === 'connect-account')
		return (
			<DestinationCrumb
				root="account"
				parent={{ key: 'settings', label: 'Your settings', onClick: () => goBack(openSettings) }}
			>
				<span class={crumbCurrent}>Connect an account</span>
			</DestinationCrumb>
		);
	const path = 'path' in view ? (view as { path: string }).path : null;
	// THE TREE IS THE BRAIN'S ROOT, so the trail is complete at the brain crumb: no tail,
	// no separator, just the brain, styled as the terminus it is.
	//
	// WHY FILES ALONE HAS NO TAIL, next to 🧠 Personal / Graph. The tail names the place,
	// and the tree's place is the root — which the brain crumb already names, the way
	// "My Drive" names Drive's. A "Files" tail would name that root a second time, and
	// would then have to survive one folder click: either it vanishes (🧠 Personal / wiki,
	// a segment that disappears as you go deeper) or it stays (🧠 Personal / Files / wiki,
	// a view's name wedged into a path). Graph, Search, Recent changes and Sharing have no
	// root to inherit, so they say their own name.
	//
	// Which SECTION is open is the rail's answer, not the trail's — the same split as an
	// editor's activity bar naming EXPLORER while its breadcrumb names only the path.
	if (!path)
		return (
			<nav class="flex min-w-0 items-center">
				<BrainCrumb inert />
			</nav>
		);
	let segs = path.split('/').filter(Boolean);
	// A folder note collapses into its folder crumb (never a self-link tail).
	if (isFolderNoteName(segs[segs.length - 1])) segs = segs.slice(0, -1);
	return (
		<nav class="flex min-w-0 items-center">
			<BrainCrumb />
			{segs.map((seg, i) => (
				<span key={segs.slice(0, i + 1).join('/')} class="flex min-w-0 items-center">
					<CrumbSep />
					<PathCrumb seg={seg} path={segs.slice(0, i + 1).join('/')} last={i === segs.length - 1} />
				</span>
			))}
		</nav>
	);
}
