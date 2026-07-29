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
	openBrains,
	openMembers,
	openSettings,
	openAddBrain,
	navigateTo,
	fetchPaths,
	switchBrain
} from '../core/actions.ts';
import { BrainGlyph, ChevronDownIcon, FolderIcon, FileIcon } from '../core/icons.tsx';
import { Menu, MenuRow, MenuSeparator, MenuNote, type MenuTriggerProps } from '../ui/Menu.tsx';

const CrumbSep = () => <span class="mx-1 shrink-0 text-muted opacity-50">/</span>;

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
	const glyph = (
		<span class="shrink-0 text-muted">
			<BrainGlyph />
		</span>
	);
	const name = (close?: () => void) =>
		inert ? (
			<span class="min-w-0 truncate font-medium text-fg" title={label}>
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
				class="min-w-0 truncate rounded font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
			>
				{label}
			</button>
		);
	if (!rows)
		return (
			<span class="flex min-w-0 max-w-[44vw] shrink items-center gap-1.5">
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
				<span class="group flex min-w-0 items-center gap-1.5">
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
						<span class="truncate text-fg">{label}</span>
					) : (
						<button
							type="button"
							onClick={() => {
								close();
								openFolder(path);
							}}
							class="truncate rounded text-muted outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-accent"
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

// A destination that has no path (Search, Members, Recent changes, …) still hangs off
// the brain crumb:
//
//   🧠 Team brain / Members · 4 people
//
// so leaving it is the same one click as anywhere else. `parent` adds one clickable
// crumb between the brain and the destination, for a view that was PUSHED from another
// (🧠 / Brains / Add a brain): a pushed flow needs a way back to the thing that opened
// it, not just a way home, and the crumb is where a user looks for it.
function DestinationCrumb({
	parent,
	children
}: {
	parent?: { label: string; onClick: () => void };
	children: ComponentChildren;
}) {
	return (
		<nav class="flex min-w-0 items-center">
			<BrainCrumb />
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
				<span class="text-muted">Search · “{view.query}”</span>
			</DestinationCrumb>
		);
	if (view.kind === 'activity')
		return (
			<DestinationCrumb>
				<span class="text-muted">Recent changes{view.scopePath ? ` · ${view.scopePath}` : ''}</span>
			</DestinationCrumb>
		);
	// Graph gets NO label: its control in the bar is lit while you're in it, so a
	// "Graph" crumb would say the same thing twice. The page/link tally likewise lives
	// in the canvas's own corner. That leaves just the way back.
	if (view.kind === 'graph') return <BrainCrumb />;
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
	// app/ui/Flow.tsx) and hangs off the screen it was opened from, so the crumb is the
	// way back out as well as the statement of where you are.
	// The parent crumb is conditional: add-brain is reachable three ways (the brains
	// list, the brain picker, the no-brains empty state), so it is shown only when Back
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
	// The file tree IS home — the brain crumb is the current location.
	if (!path) return <BrainCrumb inert />;
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
