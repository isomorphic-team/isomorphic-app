// The location trail: WHERE YOU ARE, and what else sits at each level of the path that
// got you there.
//
//   🧠 Team brain ⌄ / wiki ⌄ / people ⌄ / Ada Lovelace ⌄
//
// It answers that question ONLY. Where else you could BE — the file tree, the graph, the
// activity feed, the sharing panel, the org and account screens — is the RAIL down the
// left edge (main.tsx). The trail briefly carried those too, as extra rows inside its
// chevrons, and the two questions blurred: standing on the tree it read "Brain / Files ⌄",
// a segment naming a view rather than a place, whose picker offered three more views
// unrelated to the path it was drawn from. A crumb picker lists what could have stood in
// that segment's place, and a view could never have stood in a path segment's place.
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
import { Fragment } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { View, BrowseData, BrainRow } from '../core/types.ts';
import { isFolderNoteName, groupBrainsByOrg } from '../core/util.ts';
import { browseCache, brainList, activeBrain, goBack, backKind } from '../core/store.ts';
import type { Scope } from '../core/nav.ts';
import {
	openBrowse,
	openFolder,
	openBrains,
	openMembers,
	openSettings,
	openAddBrain,
	openBrainAccess,
	navigateTo,
	openAsset,
	fetchPaths,
	ensureBrainList,
	guardNav,
	switchBrain
} from '../core/actions.ts';
import {
	BrainGlyph,
	ChevronDownIcon,
	FolderIcon,
	FileIcon,
	ImageIcon,
	ArrowLeftIcon
} from '../core/icons.tsx';
import { Menu, MenuRow, MenuSeparator, MenuNote, type MenuTriggerProps } from '../ui/Menu.tsx';
import { crumbCurrent, crumbLink, crumbMeta, eyebrow } from '../ui/typography.ts';

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

type CrumbEntry = { name: string; path: string; dir: boolean; asset?: boolean };

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
	// Pages AND attachments. Listing only pages meant an assets/ folder never appeared
	// as a peer of the pages beside it, so the folder you were standing in was missing
	// from its own parent's picker — you could reach an image from the file tree but
	// not by walking the breadcrumb it was displaying.
	const assetSet = new Set(data.assets);
	for (const p of [...data.paths, ...data.assets]) {
		if (!p.startsWith(prefix)) continue;
		const rest = p.slice(prefix.length);
		const cut = rest.indexOf('/');
		if (cut === -1) {
			if (!isFolderNoteName(rest))
				files.push({ name: rest, path: p, dir: false, asset: assetSet.has(p) });
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
						onClick={guardNav(() => {
							close();
							if (e.dir) openFolder(e.path);
							else if (e.asset) openAsset(e.path);
							else navigateTo(e.path);
						})}
					>
						<span class={here ? 'text-accent' : 'text-muted'}>
							{e.dir ? <FolderIcon /> : e.asset ? <ImageIcon /> : <FileIcon />}
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

// The rows of the brain picker. Same shape as SiblingRows, and for the same reason: a
// cold list is FETCHED WHEN THE PICKER OPENS rather than being a precondition for the
// picker existing at all.
//
// This crumb used to render as a plain label with no chevron whenever `brainList` was
// null, on the grounds that UNKNOWN IS NOT ZERO — which is right about the label and
// wrong about the control. The list is only ever fetched by handleToolResult, so a
// widget that came up any other way (the self-boot in connectToHost) or a single failed
// `brains` call left the one control that switches brains permanently absent, with no
// error and no retry. Unknown is still not zero: the ADD row waits for real rows, so
// "you have no brains" is never implied by a list we haven't loaded.
function BrainRows({ close }: { close: () => void }) {
	const [rows, setRows] = useState<BrainRow[] | null>(brainList);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (rows) return;
		let live = true;
		// ensureBrainList swallows its own errors and leaves the list null, so the store
		// is what says whether it worked.
		void ensureBrainList().then(() => {
			if (!live) return;
			if (brainList) setRows(brainList);
			else setFailed(true);
		});
		return () => {
			live = false;
		};
	}, []);
	if (failed) return <MenuNote>Couldn’t load your brains.</MenuNote>;
	if (!rows) return <MenuNote>Loading…</MenuNote>;
	return (
		<>
			{/* Grouped by org, which is what carries the org name now that the label
			    no longer prepends it. The heading appears only when there are two orgs
			    to tell apart; with one, every row is in it and it says nothing. */}
			{groupBrainsByOrg(rows).map((g) => (
				<Fragment key={g.org ?? '·'}>
					{g.org && <div class={`px-3 pb-0.5 pt-1 ${eyebrow}`}>{g.org}</div>}
					{g.rows.map((b) => {
						// Ticked = the brain the CRUMB above this picker names, not the row's
						// own `active` flag. That flag is the connection's pointer as the
						// server saw it when the list was fetched, and a widget opened on an
						// explicitly named brain sat one row away from it: the panel showed
						// one brain and the checkmark another (issue #26).
						const here = b.id === activeBrain?.id;
						return (
							<MenuRow
								key={b.id}
								onClick={guardNav(() => {
									close();
									switchBrain(b.id);
								})}
							>
								<span class={here ? 'text-accent' : 'text-muted'}>
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
								{here && <span class="shrink-0 text-accent">✓</span>}
							</MenuRow>
						);
					})}
				</Fragment>
			))}
			<MenuSeparator />
			<MenuRow
				class="text-muted hover:text-fg"
				onClick={guardNav(() => {
					close();
					openAddBrain();
				})}
			>
				<span class="shrink-0 text-[15px] leading-none">＋</span>
				<span class="min-w-0 flex-1 truncate">Add a brain</span>
			</MenuRow>
		</>
	);
}

// The root crumb: which brain you are in. The label opens its file tree (the way home
// from every view, exactly as ⌂ was); the picker switches brains or adds one.
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
	// `inert` is the FILE TREE, where the brain crumb is not a step on the way to the
	// place you are — it IS the place, the root the tree is rooted at. So it takes the
	// same colour as any other terminus (see crumbCurrent) and drops the link, exactly
	// as the last folder crumb does one level down.
	const name = (close?: () => void) =>
		inert ? (
			<span class={`min-w-0 truncate ${crumbCurrent}`} title={label}>
				{label}
			</span>
		) : (
			<button
				type="button"
				title="Files"
				onClick={guardNav(() => {
					close?.();
					openBrowse();
				})}
				class={`min-w-0 truncate ${crumbLink}`}
			>
				{label}
			</button>
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
			{(close) => <BrainRows close={close} />}
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
							onClick={guardNav(() => {
								close();
								openFolder(path);
							})}
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
				<span class={crumbCurrent}>Manage brains</span>
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
