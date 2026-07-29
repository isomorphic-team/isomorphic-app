// Presentational icon components + the InitialsAvatar.
// (The shared `iconBtn` class string lived here until the UI primitives landed; it is
// now `<Button variant="ghost" size="icon">` in app/ui/Button.tsx.)
// Pure SVG/markup with no dependencies, so any view or the chrome can pull from here.

const ChevronIcon = ({ open }: { open: boolean }) => (
	<svg
		viewBox="0 0 16 16"
		width="12"
		height="12"
		class={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
		aria-hidden="true"
	>
		<path fill="currentColor" d="M6 4l4 4-4 4z" />
	</svg>
);
const FolderIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" class="shrink-0 text-muted" aria-hidden="true">
		<path
			fill="currentColor"
			d="M1.5 3.5A1.5 1.5 0 013 2h3l1.5 1.5H13A1.5 1.5 0 0114.5 5v6A1.5 1.5 0 0113 12.5H3A1.5 1.5 0 011.5 11z"
		/>
	</svg>
);
const FileIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" class="shrink-0 text-muted" aria-hidden="true">
		<path
			fill="currentColor"
			d="M3 1.5A1.5 1.5 0 014.5 0H9l4 4v10.5A1.5 1.5 0 0111.5 16h-7A1.5 1.5 0 013 14.5zM9 1v3.5h3.5z"
		/>
	</svg>
);

const PencilIcon = () => (
	<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
		<path
			fill="currentColor"
			d="M12 1.5l2.5 2.5L5.5 13 2 14l1-3.5zM10.6 2.9l2.5 2.5"
			stroke="currentColor"
			stroke-width="0.5"
		/>
	</svg>
);
const TrashIcon = () => (
	<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
		<path
			fill="currentColor"
			d="M6 1.5h4l.6 1.5H14V4H2V3h3.4zM3 5h10l-.7 9a1 1 0 01-1 .9H4.7a1 1 0 01-1-.9z"
		/>
	</svg>
);

const CloseIcon = () => (
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
		<path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8" />
	</svg>
);

const GithubIcon = () => (
	<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
		<path
			fill="currentColor"
			d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.28.83 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"
		/>
	</svg>
);

const LinkIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			d="M6.5 9.5l3-3M7 5l.8-.8a2.3 2.3 0 0 1 3.3 3.3l-.8.8M9 11l-.8.8a2.3 2.3 0 0 1-3.3-3.3l.8-.8"
		/>
	</svg>
);

const ListIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<path
			fill="currentColor"
			d="M2 3h2v2H2zM6 3.5h8v1H6zM2 7h2v2H2zM6 7.5h8v1H6zM2 11h2v2H2zM6 11.5h8v1H6z"
		/>
	</svg>
);
const SearchIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" />
		<path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M10.5 10.5L14 14" />
	</svg>
);
const HistoryIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
		<path
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M8 4.5V8l2.5 1.5"
		/>
	</svg>
);
const GraphIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.3"
			d="M4 4.5l4-1.5M4.8 5.6l2.6 4.2M11.4 4.8L5.3 10"
		/>
		<circle cx="3.2" cy="4" r="1.8" fill="currentColor" />
		<circle cx="12.4" cy="4" r="1.8" fill="currentColor" />
		<circle cx="4.6" cy="11" r="1.8" fill="currentColor" />
	</svg>
);
const PeopleIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<circle cx="6" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4" />
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			d="M1.8 13c0-2.3 1.9-3.6 4.2-3.6s4.2 1.3 4.2 3.6"
		/>
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			d="M10.6 3.1a2.2 2.2 0 010 4.1M11.6 9.7c1.6.3 2.8 1.4 2.8 3.3"
		/>
	</svg>
);
const HomeIcon = () => (
	<svg viewBox="0 0 16 16" width="13" height="13" class="shrink-0" aria-hidden="true">
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linejoin="round"
			d="M2.5 7.5L8 2.5l5.5 5v5.5a1 1 0 01-1 1h-2.75V10h-3.5v4H3.5a1 1 0 01-1-1z"
		/>
	</svg>
);
const MoreIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<circle cx="3" cy="8" r="1.4" fill="currentColor" />
		<circle cx="8" cy="8" r="1.4" fill="currentColor" />
		<circle cx="13" cy="8" r="1.4" fill="currentColor" />
	</svg>
);
const GearIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
		/>
		<circle cx="6" cy="4.5" r="1.7" fill="var(--c-bg)" stroke="currentColor" stroke-width="1.4" />
		<circle cx="10.5" cy="8" r="1.7" fill="var(--c-bg)" stroke="currentColor" stroke-width="1.4" />
		<circle cx="5" cy="11.5" r="1.7" fill="var(--c-bg)" stroke="currentColor" stroke-width="1.4" />
	</svg>
);

const BrainGlyph = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linejoin="round"
			d="M8 2.2l5.4 3-5.4 3-5.4-3z"
		/>
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linejoin="round"
			d="M2.6 8L8 11l5.4-3"
		/>
	</svg>
);
const ChevronDownIcon = () => (
	<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M4 6.5l4 4 4-4"
		/>
	</svg>
);

// ---- file-tree toolbar icons (Obsidian-style: doc-plus, folder-plus, sort, expand) ----

const NewNoteIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linejoin="round"
			d="M8.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5z"
		/>
		<path stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M8.5 2v4.5H13" />
		<path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 8.5v3M6.5 10h3" />
	</svg>
);
const NewFolderIcon = () => (
	<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linejoin="round"
			d="M1.75 4.25A1 1 0 0 1 2.75 3.5H6l1.4 1.4h5.85a1 1 0 0 1 1 1v6.35a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"
		/>
		<path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M7.5 9.5h3M9 8v3" />
	</svg>
);
// Sort A→Z / Z→A: descending caret flips via the `desc` prop.
const SortIcon = ({ desc = false }: { desc?: boolean }) => (
	<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linecap="round"
			stroke-linejoin="round"
			d={desc ? 'M4 12V4M4 4L2 6M4 4l2 2' : 'M4 4v8M4 12l-2-2M4 12l2-2'}
		/>
		<path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 5h6M8 8h4M8 11h2" />
	</svg>
);
// Expand-all / collapse-all: chevrons point out (expand) or in (collapse).
const ExpandCollapseIcon = ({ expanded = false }: { expanded?: boolean }) => (
	<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			stroke-linejoin="round"
			d={expanded ? 'M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3' : 'M5 3.5l3 3 3-3M5 12.5l3-3 3 3'}
		/>
	</svg>
);
const EyeIcon = ({ off = false }: { off?: boolean }) => (
	<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
		<path
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linejoin="round"
			d="M1.5 8S3.8 3.75 8 3.75 14.5 8 14.5 8 12.2 12.25 8 12.25 1.5 8 1.5 8z"
		/>
		<circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1.3" />
		{off && <path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M3 13L13 3" />}
	</svg>
);

// A small padlock marking a read-only (non-editable) entry — source roots, the
// tool-maintained log, etc., per the brain's .isomorphic.json policy.
const LockIcon = () => (
	<svg viewBox="0 0 16 16" width="11" height="11" class="shrink-0 opacity-70" aria-hidden="true">
		<rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="currentColor" />
		<path
			d="M5 7V5a3 3 0 0 1 6 0v2"
			fill="none"
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linecap="round"
		/>
	</svg>
);

function PlusIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
		>
			<path d="M8 3.5v9M3.5 8h9" />
		</svg>
	);
}

// A small initials avatar in a stable, name-derived tint. Deliberately NOT a
// GitHub avatar image — the iframe CSP blocks external hosts, so remote images
// can't load; initials keep attribution legible without a network fetch.
function InitialsAvatar({ name }: { name: string }) {
	const initial = (name.trim()[0] ?? '?').toUpperCase();
	// Hue from the name so each person gets a consistent color.
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return (
		<span
			class="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold text-white"
			style={`background: hsl(${h} 45% 45%)`}
			aria-hidden="true"
		>
			{initial}
		</span>
	);
}

export {
	ChevronIcon,
	FolderIcon,
	FileIcon,
	PencilIcon,
	TrashIcon,
	CloseIcon,
	GithubIcon,
	LinkIcon,
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
	PlusIcon,
	NewNoteIcon,
	NewFolderIcon,
	SortIcon,
	ExpandCollapseIcon,
	EyeIcon,
	LockIcon,
	InitialsAvatar
};
