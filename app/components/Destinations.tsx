// The renderable half of app/core/nav.ts: a glyph and a click for every destination.
//
// Split from the list itself so the decisions (which destinations a deployment has,
// which one you are standing on) stay testable without a DOM. Both records are keyed
// by `DestKey`, so a destination added there and forgotten here fails typecheck.
import type { VNode } from 'preact';
import {
	BrainGlyph,
	ChartIcon,
	GearIcon,
	GraphIcon,
	HistoryIcon,
	ListIcon,
	PeopleIcon,
	SearchIcon,
	ShareIcon
} from '../core/icons.tsx';
import {
	openActivity,
	openAnalytics,
	openBrainAccess,
	openBrains,
	openBrowse,
	openGraph,
	openMembers,
	openSearch,
	openSettings
} from '../core/actions.ts';
import { brainList, features } from '../core/store.ts';
import { DEST_META, destinationsIn, type DestKey, type Scope } from '../core/nav.ts';

const DEST_ICON: Record<DestKey, VNode> = {
	search: <SearchIcon />,
	files: <ListIcon />,
	graph: <GraphIcon />,
	activity: <HistoryIcon />,
	sharing: <ShareIcon />,
	members: <PeopleIcon />,
	analytics: <ChartIcon />,
	brains: <BrainGlyph />,
	settings: <GearIcon />
};

const DEST_OPEN: Record<DestKey, () => void> = {
	search: () => openSearch(),
	files: () => openBrowse(),
	graph: () => openGraph(),
	activity: () => openActivity(),
	sharing: () => openBrainAccess(),
	members: () => openMembers(),
	analytics: () => openAnalytics(),
	brains: () => openBrains(),
	settings: () => openSettings()
};

export type Destination = { key: DestKey; label: string; icon: VNode; open: () => void };

// One scope's destinations, resolved against the live store. Read on every header
// render rather than memoized: `features` lands with the brain list, and `canManage`
// changes with the active brain.
export function destinations(scope: Scope): Destination[] {
	const caps = {
		analytics: features.analytics,
		canManageBrains: !!brainList?.some((b) => b.canManage)
	};
	return destinationsIn(scope, caps).map((key) => ({
		key,
		label: DEST_META[key].label,
		icon: DEST_ICON[key],
		open: DEST_OPEN[key]
	}));
}
