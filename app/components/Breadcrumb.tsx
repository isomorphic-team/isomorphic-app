// The location trail — and, since the brain is the root of it, the app's only
// "where am I / where else could I be" control.
//
//   🧠 Team brain ⌄ / wiki ⌄ / people ⌄ / Ada Lovelace ⌄
//
// TWO CONTROLS BECAME ONE. The bar used to open with a brain switcher AND a ⌂ home
// crumb, which were the same destination twice: the switcher's own "select the active
// brain" row re-opened its file tree, and ⌂ opened the file tree. Two controls, one
// place. The brain IS the root of the trail, so it is now the root crumb: its label
// goes home exactly as ⌂ did, and its picker lists the other brains — because at the
// root of a trail, "what else is at this level" means another brain.
//
// EVERY CRUMB IS A PICKER (the VS Code breadcrumb behaviour). Label = go there,
// chevron = the other things that live at this level. SIBLINGS, not children: the
// question a crumb answers is "what else could this segment have been", so `people`
// offers the other folders and pages under `wiki/`, and the trailing page offers the
// rest of its own folder. That last one is the payoff — moving between sibling pages
// used to mean a round trip through the file tree.
//
// Two sources: the trail comes from the path alone, the pickers from the cached file
// tree (`browseCache` — one list_pages call for the whole brain). A cold cache fetches
// when a picker is OPENED rather than up front, so the bar never waits on data that a
// given visit may not need.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { View, BrowseData } from '../core/types.ts';
import { isFolderNoteName } from '../core/util.ts';
import { browseCache, brainList, activeBrain, goBack, backKind } from '../core/store.ts';
import {
	openBrowse,
	openFolder,
	openActivity,
	openGraph,
	openBrains,
	openMembers,
	openSettings,
	openAddBrain,
	navigateTo,
	fetchPaths,
	switchBrain
} from '../core/actions.ts';
import {
	BrainGlyph,
	ChevronDownIcon,
	FolderIcon,
	FileIcon,
	ArrowLeftIcon,
	ListIcon,
	HistoryIcon,
	GraphIcon,
	PeopleIcon,
	GearIcon
} from '../core/icons.tsx';
import { Menu, MenuRow, MenuSeparator, MenuNote, type MenuTriggerProps } from '../ui/Menu.tsx';
import { crumbCurrent, crumbLink, crumbInert, crumbMeta } from '../ui/typography.ts';

// Wider than the 4px it was, because a crumb is no longer just a word: it is a label
// and its picker, and those have to read as ONE unit. At the old spacing the chevron
// sat as far from its own label as from the next slash, so the eye grouped it with the
// separator. The rule the trail follows now: tight INSIDE a crumb (the chevron's
// ml-0.5), loose BETWEEN crumbs (here).
const CrumbSep = () => <span class="mx-2 shrink-0 text-muted opacity-50">/</span>;

// The picker's affordance. Always rendered, but held at 40% until the crumb is hovered
// or its menu is open: a chevron per segment is a lot of furniture for a 36px bar, and
// this keeps the trail reading as text while staying visibly clickable.
function CrumbChevron({
	props,
	open,
	title
}: {
	props: MenuTriggerProps;
	open: boolean;
	title: string;
}) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			{...props}
			class={`ml-0.5 shrink-0 rounded p-0.5 text-muted outline-none transition-opacity hover:bg-chip hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent ${
				open ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'
			}`}
		>
			<ChevronDownIcon />
		</button>
	);
}

// ---------- sibling data ----------

type CrumbEntry = { name: string; path: string; dir: boolean };

// What lives directly under `parent` ('' = the brain root): sub-folders, then pages,
// alphabetical — the file tree's own order, so a picker and the tree can never
// disagree about what a folder contains.
//
// Folder notes are left out: <folder>/index.md IS the folder, so listing it beside its
// own folder is the redundant sibling the tree already hides. Hidden files never
// appear, since `paths` is the visible content set and the hidden list is kept apart.
function entriesUnder(parent: string, data: BrowseData): CrumbEntry[] {
	const prefix = parent ? `${parent}/` : '';
	const folders = new Set<string>();
	const files: CrumbEntry[] = [];
	for (const p of data.paths) {
		if (!p.startsWith(prefix)) continue;
		const rest = p.slice(prefix.length);
		const cut = rest.indexOf('/');
		if (cut === -1) {
			if (!isFolderNoteName(rest)) files.push({ name: rest, path: p, dir: false });
		} else {
			folders.add(rest.slice(0, cut));
		}
	}
	const byName = (a: CrumbEntry, b: CrumbEntry) => a.name.localeCompare(b.name);
	return [
		...[...folders].map((n) => ({ name: n, path: prefix + n, dir: true })).sort(byName),
		...files.sort(byName)
	];
}

function entryLabel(e: CrumbEntry, data: BrowseData): string {
	return e.dir ? e.name : (data.titleByPath[e.path] ?? e.name.replace(/\.md$/, ''));
}

// The rows of one crumb's picker. Reads the memoized tree; only a cold cache costs a
// round trip, and a failed one says so rather than rendering an empty menu that reads
// as "this folder has nothing in it".
function SiblingRows({
	parent,
	current,
	close
}: {
	parent: string;
	/** Full path of the crumb this picker hangs off — marked in the list. */
	current: string;
	close: () => void;
}) {
	const [data, setData] = useState<BrowseData | null>(browseCache);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (data) return;
		let live = true;
		void fetchPaths().then(
			(d) => {
				if (live) setData(d);
			},
			() => {
				if (live) setFailed(true);
			}
		);
		return () => {
			live = false;
		};
	}, []);
	if (failed) return <MenuNote>Couldn’t load this folder.</MenuNote>;
	if (!data) return <MenuNote>Loading…</MenuNote>;
	const entries = entriesUnder(parent, data);
	if (!entries.length) return <MenuNote>Nothing else here.</MenuNote>;
	return (
		<>
			{entries.map((e) => {
				const here = e.path === current;
				const label = entryLabel(e, data);
				return (
					<MenuRow
						key={e.path}
						onClick={() => {
							close();
							if (e.dir) openFolder(e.path);
							else navigateTo(e.path);
						}}
					>
						<span class={here ? 'text-accent' : 'text-muted'}>
							{e.dir ? <FolderIcon /> : <FileIcon />}
						</span>
						<span class={`min-w-0 flex-1 truncate ${here ? 'text-accent' : ''}`} title={label}>
							{label}
						</span>
						{here && <span class="shrink-0 text-accent">✓</span>}
					</MenuRow>
				);
			})}
		</>
	);
}

// ---------- the crumbs ----------

// The root crumb: which brain you are in. The label opens its file tree (the way home
// from every view, exactly as ⌂ was); the picker switches brains or adds one.
//
// Three states, and the middle one matters: `brainList === null` is UNKNOWN, not zero,
// so it renders a plain label with no picker rather than implying you have no brains
// (see ensureBrainList in core/actions).
function BrainCrumb({ inert }: { inert?: boolean }) {
	const rows = brainList;
	const label = activeBrain?.label ?? (rows && rows.length === 0 ? 'No brain' : 'Files');
	// The glyph carries its own trailing space rather than the row carrying a `gap`:
	// a gap would apply to the CHEVRON too, on top of the ml-0.5 every crumb's chevron
	// already has, and the brain crumb would sit its picker 4× further from its label
	// than the path crumbs do.
	//
	// THE LEADING SLOT IS SHARED with BackCrumb's arrow — one or the other opens the
	// trail depending on scope. Its geometry (15px icon, p-0.5 inset, mr-1.5) is
	// therefore identical in both, including the padding this span has no other use for:
	// the arrow needs it as a hover target, and unequal insets moved every label in the
	// bar by 2px when you crossed between an account screen and a brain one.
	const glyph = (
		<span class="mr-1.5 shrink-0 p-0.5 text-muted">
			<BrainGlyph />
		</span>
	);
	const name = (close?: () => void) =>
		inert ? (
			<span class={`min-w-0 truncate ${crumbInert}`} title={label}>
				{label}
			</span>
		) : (
			<button
				type="button"
				title="Files"
				onClick={() => {
					close?.();
					openBrowse();
				}}
				class={`min-w-0 truncate ${crumbLink}`}
			>
				{label}
			</button>
		);
	if (!rows)
		return (
			<span class="flex min-w-0 max-w-[44vw] shrink items-center">
				{glyph}
				{name()}
			</span>
		);
	return (
		<Menu
			label="Brains"
			class="min-w-0 max-w-[44vw] shrink"
			panelClass="min-w-[210px]"
			trigger={({ props, open, close }) => (
				<span class="group flex min-w-0 items-center">
					{glyph}
					{name(close)}
					<CrumbChevron props={props} open={open} title="Switch brain" />
				</span>
			)}
		>
			{(close) => (
				<>
					{rows.map((b) => (
						<MenuRow
							key={b.id}
							onClick={() => {
								close();
								switchBrain(b.id);
							}}
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
						</MenuRow>
					))}
					<MenuSeparator />
					<MenuRow
						class="text-muted hover:text-fg"
						onClick={() => {
							close();
							openAddBrain();
						}}
					>
						<span class="shrink-0 text-[15px] leading-none">＋</span>
						<span class="min-w-0 flex-1 truncate">Add a brain</span>
					</MenuRow>
				</>
			)}
		</Menu>
	);
}

// One path segment. `last` is the current location, so its label is inert (a crumb
// must never be a self-link that goes nowhere) — but its picker is the useful one,
// since the siblings of where you are is exactly what you want next.
function PathCrumb({
	seg,
	path,
	parent,
	last
}: {
	seg: string;
	path: string;
	parent: string;
	last: boolean;
}) {
	const label = seg.replace(/\.md$/, '');
	return (
		<Menu
			label={parent ? `Alongside ${label} in ${parent}` : `Alongside ${label}`}
			// Only the tail gives ground. A trail that squeezed every segment equally
			// would render a deep path as a row of two-letter stubs; the ancestors stay
			// at full width and the current location is what truncates.
			class={last ? 'min-w-0 shrink' : 'shrink-0'}
			trigger={({ props, open, close }) => (
				<span class="group flex min-w-0 items-center">
					{last ? (
						<span class={`truncate ${crumbCurrent}`}>{label}</span>
					) : (
						<button
							type="button"
							onClick={() => {
								close();
								openFolder(path);
							}}
							class={`truncate ${crumbLink}`}
						>
							{label}
						</button>
					)}
					<CrumbChevron
						props={props}
						open={open}
						title={`What else is in ${parent || 'this brain'}`}
					/>
				</span>
			)}
		>
			{(close) => <SiblingRows parent={parent} current={path} close={close} />}
		</Menu>
	);
}

// The destinations, in TWO SCOPES, because they are not one level. Recent changes,
// Graph and Members are views of a brain; Manage brains and Your settings are views of
// your account. A single flat list let a crumb offer Graph as a sibling of Your
// settings, which is not what "what else is at this level" means — those are two
// distinct operations and the trail should not pretend one leads to the other.
//
// Which list a crumb offers follows from its own root (see THE SCOPE TEST): a crumb
// under the brain offers brain destinations, an account crumb offers account ones. So
// from Manage brains you reach Your settings and no further, which is exactly as far
// as that level goes.
//
// This deliberately overlaps the ⋯ menu, which carries the same two groups. They answer
// different questions (⋯ is what you can DO, the trail is where you can BE) and the
// overlap is the point: from a page the trail's tail is a page, so ⋯ stays the only
// way in.
type Destination = { key: string; label: string; icon: ComponentChildren; open: () => void };

function brainDestinations(): Destination[] {
	return [
		// Files leads, and belongs here even though the brain crumb's own label already
		// opens it. The brain crumb is doing two jobs — it is the ROOT of the trail and it
		// is the file-tree VIEW — and only the first of those is visible from a picker. A
		// list that offers Graph and Members while silently omitting the tree is claiming
		// to be the views of this brain and isn't one of them.
		// Order is deliberate: Files and Graph are the SAME brain drawn two ways, so they
		// sit together at the top, and the feed and the roster follow.
		{ key: 'files', label: 'Files', icon: <ListIcon />, open: () => openBrowse() },
		{ key: 'graph', label: 'Graph', icon: <GraphIcon />, open: () => openGraph() },
		{ key: 'activity', label: 'Recent changes', icon: <HistoryIcon />, open: () => openActivity() },
		{ key: 'members', label: 'Members', icon: <PeopleIcon />, open: openMembers }
	];
}

function accountDestinations(): Destination[] {
	return [
		// Same gate as the ⋯ menu's row: brain management is for admins of at least one
		// org. A picker must never offer a destination its click would be refused.
		...(brainList?.some((b) => b.canManage)
			? [{ key: 'brains', label: 'Manage brains', icon: <BrainGlyph />, open: openBrains }]
			: []),
		{ key: 'settings', label: 'Your settings', icon: <GearIcon />, open: openSettings }
	];
}

// A destination crumb: its label, plus the picker of its siblings. `current` marks the
// row you are on — and an unrecognised key (Search, which is a query rather than a
// standing place) simply marks nothing, which is honest: the list still answers where
// else you could go.
function DestinationPicker({
	scope,
	current,
	last,
	children
}: {
	scope: 'brain' | 'account';
	current: string;
	last?: boolean;
	children: ComponentChildren;
}) {
	const rows = scope === 'account' ? accountDestinations() : brainDestinations();
	// NO PICKER WITHOUT A CHOICE. A chevron that opens onto the screen you are already
	// looking at is furniture that promises somewhere to go and delivers nowhere — which
	// is what an account crumb offers a user who administers no org, since Manage brains
	// is then gated away and Your settings is all that is left.
	if (!rows.some((d) => d.key !== current))
		return <span class={last ? 'min-w-0 truncate' : 'shrink-0'}>{children}</span>;
	return (
		<Menu
			label={scope === 'account' ? 'Your account' : 'Places in this brain'}
			class={last ? 'min-w-0 shrink' : 'shrink-0'}
			trigger={({ props, open }) => (
				<span class="group flex min-w-0 items-center">
					{children}
					<CrumbChevron
						props={props}
						open={open}
						title={scope === 'account' ? 'Your account' : 'What else is in this brain'}
					/>
				</span>
			)}
		>
			{(close) =>
				rows.map((d) => {
					const here = d.key === current;
					return (
						<MenuRow
							key={d.key}
							onClick={() => {
								close();
								d.open();
							}}
						>
							<span class={`w-4 ${here ? 'text-accent' : 'text-muted'}`}>{d.icon}</span>
							<span class={`min-w-0 flex-1 truncate ${here ? 'text-accent' : ''}`}>{d.label}</span>
							{here && <span class="shrink-0 text-accent">✓</span>}
						</MenuRow>
					);
				})
			}
		</Menu>
	);
}

// THE SCOPE TEST: does switching brains change what this screen shows?
//
// Yes for Members (a different org, a different roster), Recent changes, Graph and
// Search — those are views OF a brain and belong under the brain crumb. No for Manage
// brains and Your settings: the same list, the same identity, whichever brain happens
// to be active. Hanging those off a brain crumb claimed a containment that is not
// there, and read as "these people belong to this brain".
//
// So they get no parent crumb, because they have no parent to name — they sit beside
// the brain, not inside it. What they get instead is a way back, and that is history
// rather than location, so it is an ARROW and not a crumb. Anything that looks like a
// crumb has to behave like one (name a place, offer its siblings); a back arrow
// promises neither, and so can honestly go wherever you came from.
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
			onClick={() => goBack(() => openBrowse())}
			class="mr-1.5 shrink-0 rounded p-0.5 text-muted outline-none transition-colors hover:bg-chip hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
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
// A destination that has no path (Search, Members, Recent changes, …) still hangs off
// the brain crumb:
//
//   🧠 Team brain / Members ⌄
//
// so leaving it is the same one click as anywhere else. `parent` adds one clickable
// crumb between the brain and the destination, for a view that was PUSHED from another
// (🧠 / Manage brains / Add a brain): a pushed flow needs a way back to the thing that
// opened it, not just a way home, and the crumb is where a user looks for it.
//
// `current` is omitted for a step INSIDE a flow (Invite, Connect an account). That is
// not an exception to "every crumb is a picker" but the rule applying: a flow step has
// no siblings to offer, and its parent crumb — which does — carries the picker.
function DestinationCrumb({
	parent,
	current,
	root = 'brain',
	rootInert,
	children
}: {
	parent?: { key: string; label: string; onClick: () => void };
	current?: string;
	/** See THE SCOPE TEST above. `account` screens sit beside the brain, not inside it. */
	root?: 'brain' | 'account';
	/**
	 * Kill the brain crumb's link. Only Files needs it: the brain crumb's label opens
	 * the file tree, so on the file tree it would be a crumb that navigates to the view
	 * you are already reading.
	 */
	rootInert?: boolean;
	children: ComponentChildren;
}) {
	return (
		<nav class="flex min-w-0 items-center">
			{root === 'account' ? (
				<BackCrumb />
			) : (
				<>
					<BrainCrumb inert={rootInert} />
					<CrumbSep />
				</>
			)}
			{parent && (
				<>
					<DestinationPicker scope={root} current={parent.key}>
						<button type="button" onClick={parent.onClick} class={`truncate ${crumbLink}`}>
							{parent.label}
						</button>
					</DestinationPicker>
					<CrumbSep />
				</>
			)}
			{current === undefined ? (
				<span class="min-w-0 truncate">{children}</span>
			) : (
				<DestinationPicker scope={root} current={current} last>
					<span class="min-w-0 truncate">{children}</span>
				</DestinationPicker>
			)}
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
			<DestinationCrumb current="search">
				<span class={crumbCurrent}>Search</span>
				<span class={crumbMeta}> · “{view.query}”</span>
			</DestinationCrumb>
		);
	if (view.kind === 'activity')
		return (
			<DestinationCrumb current="activity">
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
			<DestinationCrumb current="graph">
				<span class={crumbCurrent}>Graph</span>
			</DestinationCrumb>
		);
	if (view.kind === 'members')
		return (
			<DestinationCrumb current="members">
				<span class={crumbCurrent}>Members</span>
			</DestinationCrumb>
		);
	if (view.kind === 'brains')
		return (
			<DestinationCrumb current="brains" root="account">
				<span class={crumbCurrent}>Manage brains</span>
			</DestinationCrumb>
		);
	if (view.kind === 'settings')
		return (
			<DestinationCrumb current="settings" root="account">
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
						? { key: 'brains', label: 'Manage brains', onClick: () => goBack(openBrains) }
						: undefined
				}
			>
				<span class={crumbCurrent}>{view.first ? 'Create your first brain' : 'Add a brain'}</span>
			</DestinationCrumb>
		);
	if (view.kind === 'invite-member')
		return (
			<DestinationCrumb
				parent={{ key: 'members', label: 'Members', onClick: () => goBack(openMembers) }}
			>
				<span class={crumbCurrent}>Invite</span>
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
	// The file tree is a VIEW of the brain, so it says so — and being named is what lets
	// it be selected. It used to render as the bare brain crumb on the reasoning that the
	// tree IS home, which left the one screen you are on most often as the only one whose
	// trail never said where you were, and the only brain-scope screen with no way to
	// reach its siblings. The brain crumb goes inert here rather than the tail: it is the
	// brain crumb's label that opens the tree, so it is the one that would be the
	// self-link.
	if (!path)
		return (
			<DestinationCrumb current="files" rootInert>
				<span class={crumbCurrent}>Files</span>
			</DestinationCrumb>
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
					<PathCrumb
						seg={seg}
						path={segs.slice(0, i + 1).join('/')}
						parent={segs.slice(0, i).join('/')}
						last={i === segs.length - 1}
					/>
				</span>
			))}
		</nav>
	);
}
