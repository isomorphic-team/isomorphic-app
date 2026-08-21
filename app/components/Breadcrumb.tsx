// The location trail: WHERE YOU ARE, and nothing else.
//
//   🧠 Team brain / wiki / people / Ada Lovelace
//
// Where else you could BE — the file tree, the graph, the activity feed, the sharing
// panel, the org and account screens — is the RAIL down the left edge (main.tsx). The
// trail briefly carried those too, as extra rows inside its chevrons, and the two
// questions blurred: standing on the tree it read "Brain / Files ⌄", a segment naming a
// view rather than a place, whose picker offered three more views unrelated to the path
// it was drawn from.
//
// TWO CONTROLS BECAME ONE. The bar used to open with a brain switcher AND a ⌂ home
// crumb, which were the same destination twice: the switcher's own "select the active
// brain" row re-opened its file tree, and ⌂ opened the file tree. Two controls, one
// place. The brain IS the root of the trail, so it is now the root crumb, and its label
// goes home exactly as ⌂ did.
//
// NO CRUMB IS A PICKER ANY MORE.
//
// Every segment used to carry one (the VS Code breadcrumb behaviour): label = go there,
// chevron = the siblings that could have stood in this segment's place. It was a real
// shortcut and it lost to the ceiling every popover in this bar loses to — a panel
// hanging off the top row gets the space beneath it and no more, so on a short inline
// card a folder of any size became a scroll box a row and a half tall. Two answers, both
// arrived at the same way as the rail's ⋯ before them:
//
//   * SIBLINGS moved to the file tree, which is the first item in the rail, shows the
//     same list with no height limit, and shows the structure around it as well.
//   * BRAINS moved to the Brains page, which already existed as the switcher's
//     "bi-modal counterpart" and carries add / share / disconnect besides. The BRAIN
//     GLYPH goes there — the icon that already meant "brain", carrying the action
//     rather than a chevron beside it announcing one.
//
// What is left is an icon, text, and links. The trail states a location and hands off
// every list to a screen with room for it.
import type { ComponentChildren } from 'preact';
import type { View } from '../core/types.ts';
import { isFolderNoteName } from '../core/util.ts';
import { brainList, activeBrain, goBack, backKind } from '../core/store.ts';
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
import { BrainGlyph, ArrowLeftIcon } from '../core/icons.tsx';
import { crumbCurrent, crumbLink, crumbMeta } from '../ui/typography.ts';

// Wider than the 4px it was, so a crumb and the slash after it never read as one unit.
// The rule the trail follows: tight INSIDE a crumb, loose BETWEEN crumbs (here).
const CrumbSep = () => <span class="mx-2 shrink-0 text-muted opacity-50">/</span>;

// The leading slot's geometry, worn by BOTH controls that can open the trail: the brain
// glyph on a brain screen, the back arrow everywhere else. Identical insets in both,
// including the padding a glyph has no other use for, because unequal ones moved every
// label in the bar by 2px when you crossed between an account screen and a brain one.
const LEADING_SLOT =
	'mr-1.5 shrink-0 rounded p-0.5 text-muted outline-none transition-colors hover:bg-chip hover:text-fg focus-visible:ring-2 focus-visible:ring-accent';

// ---------- the crumbs ----------

// The root crumb: which brain you are in. Two controls, and they answer the trail's two
// halves separately — the GLYPH changes which brain, the LABEL opens that brain's file
// tree (the way home from every view, exactly as ⌂ was).
//
// The label NAMES A BRAIN and nothing else. It used to fall back to "Files" — the old
// ⌂ home button's word, kept when the brain crumb absorbed it — so a brain we could not
// name rendered the trail as "Files / Files": the root crumb answering with the name of
// a VIEW, which is the one thing the two halves of this bar exist to keep apart. Every
// payload that draws brain content now carries `activeBrain` (list_pages included), so
// this fallback means we genuinely do not know yet, and it says so generically rather
// than borrowing a destination's name.
function BrainCrumb({ inert }: { inert?: boolean }) {
	const label = activeBrain?.label ?? (brainList?.length === 0 ? 'No brain' : 'Brain');
	// THE GLYPH IS THE SWITCHER. It was decoration with a chevron beside it doing this
	// job, which put two marks on one crumb to say one thing; the icon was already the
	// mark that means "brain", so it carries the action instead of announcing it twice.
	//
	// It also makes the leading slot honest: every trail opens with a control now, the
	// brain on a brain screen and the back arrow on the ones beside it (LEADING_SLOT).
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
	// SWITCHING BRAINS IS A PAGE, not a popover.
	//
	// It was a picker listing every brain grouped by org, each row two lines (name, then
	// role and setup state). That list is ~300px, and a panel hanging off the top bar can
	// only have the room beneath it: on a 170px inline card it is clamped to ~130px, so a
	// person with four brains scrolled a box that showed one and a half of them. The
	// clamp is not the bug — without it the panel spills past the card and makes the card
	// itself scroll (ui/Menu.tsx). There is no height at which a floating panel holds this
	// list, for the same reason the rail's ⋯ could not hold its menu.
	//
	// BrainsView is already the page version and calls itself so in its own header: every
	// brain you can reach, roles, the active one ticked, click to switch. It also carries
	// what the picker never had room for — add, disconnect, per-brain sharing. So this is
	// deleting a cramped duplicate rather than building a replacement.
	return (
		<span class="flex min-w-0 max-w-[44vw] shrink items-center">
			{glyph}
			{name}
		</span>
	);
}

// One path segment. `last` is the current location, so its label is inert: a crumb must
// never be a self-link that goes nowhere.
//
// NO PICKER. Each of these carried one listing the segment's siblings, which was a real
// shortcut and lost to the same ceiling everything else in this bar lost to: a panel
// hanging off the top row gets the space beneath it and no more, so a folder of any size
// became a scroll box a row and a half tall. A trail is also the wrong host for it — the
// bar tells you where you are, and browsing what is next to you is the file tree's whole
// job. Files is the first item in the rail now, shows the same siblings with no height
// limit, and shows the structure around them as well. This costs one press on a move
// that used to take none.
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

// A screen outside the brain gets a way back rather than a parent crumb, because it has
// no parent to name: Members, Analytics, Manage brains and Your settings sit BESIDE the
// brain, not inside it (THE SCOPE TEST, app/core/nav.ts). A way back is history rather
// than location, so it is an ARROW and not a crumb. Anything that looks like a crumb has
// to behave like one — name a place, offer what else is at that level — and a back arrow
// promises neither, so it can honestly go wherever you came from.
function BackCrumb() {
	// Nothing behind you and no brain to fall back into — the very first run, sitting on
	// "Create your first brain". A back arrow there would land on the tree, fail for want
	// of a brain, and bounce you to this same screen.
	if (!backKind() && !activeBrain) return null;
	return (
		<button
			type="button"
			title="Back"
			aria-label="Back"
			onClick={guardNav(() => goBack(() => openBrowse()))}
			class={LEADING_SLOT}
		>
			<ArrowLeftIcon />
		</button>
	);
}

// NO TALLIES. A crumb names a place; it does not report on it. "Members · 4 people ·
// 1 invited" and "Manage brains · 3" were counts of what the view below was already
// showing in full, which is the screen telling you something it is simultaneously
// showing you. What stays after the · is only ever IDENTITY — which search, which
// page's history — because that distinguishes one instance of a view from another.
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
//
// NO PICKER ON A DESTINATION CRUMB. These segments used to carry one — the chevron on
// "Files" offered Graph, Recent changes and Sharing — and it was the wrong control in
// the wrong place. A crumb's chevron answers "what else could this segment have been",
// which for a path segment is its siblings on disk and for a view is nothing at all: a
// view has no siblings, it has peers, and peers belong in the bar's own cluster where
// one press reaches them from anywhere. The trail is location; the cluster is
// destinations. Path crumbs keep their pickers, which is the question they can actually
// answer.
function DestinationCrumb({
	parent,
	root = 'brain',
	children
}: {
	parent?: { key: string; label: string; onClick: () => void };
	/**
	 * See THE SCOPE TEST in app/core/nav.ts. Only `brain` screens sit INSIDE the brain
	 * and get the brain crumb; `org` and `account` ones sit beside it and get a back
	 * arrow instead.
	 */
	root?: Scope;
	children: ComponentChildren;
}) {
	return (
		<nav class="flex min-w-0 items-center">
			{root !== 'brain' ? (
				<BackCrumb />
			) : (
				<>
					<BrainCrumb />
					<CrumbSep />
				</>
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
// the tree shows is a crumb, content roots included. Folder segments open the folder's
// note (<folder>/index.md) when it has one, else the tree REVEALED at that folder
// (expanded + highlighted) — a note-less folder still lands you where you clicked. A
// folder-note page collapses into its folder crumb (wiki/index.md shows as "🧠 / wiki")
// so the trailing crumb is never a self-link.
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
	if (view.kind === 'activity')
		return (
			<DestinationCrumb>
				<span class={crumbCurrent}>Recent changes</span>
				{view.scopePath && <span class={crumbMeta}> · {view.scopePath}</span>}
			</DestinationCrumb>
		);
	// Graph used to render as a bare brain crumb with nothing after it, on the grounds
	// that its control sat lit in the bar right beside the trail and would have said the
	// same thing twice. That control now lives at the far right, and a labelled crumb is
	// what makes graph a PLACE like the others — one with siblings you can pick from —
	// rather than the one view whose trail trails off. The page/link tally still lives in
	// the canvas's own corner.
	if (view.kind === 'graph')
		return (
			<DestinationCrumb>
				<span class={crumbCurrent}>Graph</span>
			</DestinationCrumb>
		);
	// ORG root, not brain: the roster belongs to the organization the active brain sits
	// in, and every brain in that org shows the same one. Under a brain crumb it read as
	// "these people belong to this brain", which is the containment main already removed
	// from Manage brains and Your settings for exactly the same reason.
	// More is the one screen that belongs to no single scope: it is the index of both the
	// org and the account destinations. Any non-brain root gives it the back arrow, which
	// is what it needs — it sits BESIDE the brain like everything it lists, and a brain
	// crumb would claim the organization is inside the brain.
	if (view.kind === 'more')
		return (
			<DestinationCrumb root="account">
				<span class={crumbCurrent}>More</span>
			</DestinationCrumb>
		);
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
	// a place: it is the view's own control, which lives in the header's right-hand
	// slot and shows its own state. A "· 30d" crumb was both the wrong half of the
	// bar and a second, non-clickable copy of a control that was already there.
	if (view.kind === 'analytics')
		return (
			<DestinationCrumb root="org">
				<span class={crumbCurrent}>Analytics</span>
			</DestinationCrumb>
		);
	if (view.kind === 'brains')
		return (
			<DestinationCrumb root="account">
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
	// That only holds because opening it MAKES ITS BRAIN ACTIVE (brain_access is
	// registered sticky in worker.ts, like the other in-client view tools). Without
	// that, the Share control in the brains list could open a panel for one brain under
	// a crumb naming another.
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
