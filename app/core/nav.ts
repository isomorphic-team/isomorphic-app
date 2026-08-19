// WHERE YOU CAN GO — the destinations, their scopes, and which one you are looking at.
//
// Pure and icon-free on purpose: this is the half that DECIDES (which destinations
// exist for a given deployment, and which view counts as standing on one), so it is
// callable from a node test with no DOM. The glyphs and the click handlers live beside
// it in app/components/Destinations.tsx, keyed by the same `DestKey` — a `Record`, so
// adding a destination here and forgetting its icon is a typecheck error rather than a
// blank square in the bar.
//
// It also exists because the list was written down TWICE — once for the breadcrumb's
// pickers and once for the ⋯ menu — and the two had already drifted: the picker offered
// Files and Graph, the menu did not.

/** The three scopes a destination can belong to. See THE SCOPE TEST below. */
export type Scope = 'brain' | 'org' | 'account';

export type DestKey =
	| 'search'
	| 'files'
	| 'graph'
	| 'activity'
	| 'sharing'
	| 'members'
	| 'analytics'
	| 'brains'
	| 'settings';

// THE SCOPE TEST: does switching brains change what this screen shows?
//
// Yes for Search, Files, Graph, Recent changes and Sharing — those are views OF a
// brain, and they are the ones standing in the rail down the left edge.
// No for Manage brains and Your settings: the same list and the same identity whichever
// brain is active, so they are views of your ACCOUNT.
// Members and Analytics answer a third way, which is why there is a third scope: a
// sibling brain in the same org shows the SAME roster and the SAME numbers, and only
// crossing into another org changes them. They are views of the ORG, reached through
// whichever brain is active, not properties of the brain you happen to be in.
export const DEST_META: Record<DestKey, { label: string; scope: Scope }> = {
	// Search leads: it is the way to a page you cannot point at yet, which is the
	// question you arrive with most often. Then Files and Graph, the same brain drawn
	// two ways, and the feed and the audience after them.
	//
	// It is a PLACE like the rest, and it took a detour to get here. Search was briefly
	// a control that swapped the trail for a field — the one item in the rail that
	// opened a widget instead of going somewhere, which is exactly the inconsistency a
	// rail of peers makes obvious. It has a view of its own that holds its own field
	// now, so it behaves like every other destination: press it, arrive, the rail lights.
	search: { label: 'Search', scope: 'brain' },
	files: { label: 'Files', scope: 'brain' },
	graph: { label: 'Graph', scope: 'brain' },
	activity: { label: 'Recent changes', scope: 'brain' },
	sharing: { label: 'Sharing', scope: 'brain' },
	members: { label: 'Members', scope: 'org' },
	analytics: { label: 'Analytics', scope: 'org' },
	brains: { label: 'Manage brains', scope: 'account' },
	settings: { label: 'Your settings', scope: 'account' }
};

/** What the deployment and the caller's roles actually make reachable. */
export type NavCaps = {
	/** Usage recording is opt-in per deployment (USAGE_ANALYTICS), so the tool may not exist. */
	analytics: boolean;
	/** Admin+ of at least one org — brain management is theirs alone. */
	canManageBrains: boolean;
};

// The destinations of one scope, in order, filtered to what a click would actually
// reach. NEVER OFFER A DESTINATION WHOSE CLICK IS REFUSED: a widget cannot list the
// host's tools, so a row for an unregistered `analytics` comes back "unknown tool", and
// Manage brains on a non-admin comes back as a permissions error the user cannot act on.
export function destinationsIn(scope: Scope, caps: NavCaps): DestKey[] {
	return (Object.keys(DEST_META) as DestKey[]).filter((k) => {
		if (DEST_META[k].scope !== scope) return false;
		if (k === 'analytics') return caps.analytics;
		if (k === 'brains') return caps.canManageBrains;
		return true;
	});
}

// Which destination the current view IS, so its control can light up. Flows count as
// their parent destination (Invite is where Members is, Share is where Sharing is):
// the control answers "where am I", and a step pushed off a destination has not left it.
//
// Null for the views that are not destinations at all — a page, an editor, an asset.
// Standing on a page means no destination is current, which is honest: the page came
// from the tree, not from a place in this list.
const VIEW_DEST: Record<string, DestKey> = {
	search: 'search',
	browse: 'files',
	graph: 'graph',
	activity: 'activity',
	'brain-access': 'sharing',
	'share-brain': 'sharing',
	members: 'members',
	'invite-member': 'members',
	analytics: 'analytics',
	brains: 'brains',
	'add-brain': 'brains',
	settings: 'settings',
	'connect-account': 'settings'
};

export function activeDestination(viewKind: string): DestKey | null {
	return VIEW_DEST[viewKind] ?? null;
}
