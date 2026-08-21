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
// `blurb` is one line saying what the destination is FOR. Required on all nine even
// though only the More page renders it today: an optional field is one a new
// destination quietly omits, and the row it lands in is then a bare word with a gap
// under it where its neighbours have a sentence.
export const DEST_META: Record<DestKey, { label: string; scope: Scope; blurb: string }> = {
	// DECLARATION ORDER IS RAIL ORDER — destinationsIn filters these keys in place, so
	// moving an entry here moves the icon.
	//
	// Files leads: the tree is the brain itself and the thing the app opens into, so the
	// rail's first mark is where you already are. Graph next, the same brain drawn the
	// other way. Then Search, which is the way to a page you cannot point at. Then the
	// feed and the audience.
	//
	// Search is a PLACE like the rest, and it took a detour to get here. It was briefly a
	// control that swapped the trail for a field — the one item in the rail that opened a
	// widget instead of going somewhere, which is exactly the inconsistency a rail of
	// peers makes obvious. It has a view of its own holding its own field now, so it
	// behaves like every other destination: press it, arrive, the rail lights.
	files: { label: 'Files', scope: 'brain', blurb: 'The whole brain as a tree' },
	graph: { label: 'Graph', scope: 'brain', blurb: 'How the pages link to each other' },
	search: { label: 'Search', scope: 'brain', blurb: 'Find a page by its text' },
	activity: {
		label: 'Recent changes',
		scope: 'brain',
		blurb: 'What changed, and who changed it'
	},
	sharing: { label: 'Sharing', scope: 'brain', blurb: 'Who can open this brain' },
	members: { label: 'Members', scope: 'org', blurb: 'Who is in your organization' },
	analytics: {
		label: 'Analytics',
		scope: 'org',
		blurb: 'How much your organization uses its brains'
	},
	brains: {
		label: 'Brains',
		scope: 'account',
		blurb: 'Create, connect, or disconnect a brain'
	},
	settings: {
		label: 'Your settings',
		scope: 'account',
		blurb: 'Your identity and connected accounts'
	}
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

// IS THE RAIL'S ⋯ THE PLACE YOU ARE? True on the More page itself and on everything
// More leads to, so the rail keeps answering "where am I" once you are two steps in.
// Without the second half, opening Members from More lights nothing and the rail reads
// as though you had left it.
//
// Defined by SCOPE rather than by a list, so a destination added to org or account is
// covered the day it exists — those are exactly the ones the rail does not show itself.
export function isMorePlace(viewKind: string): boolean {
	if (viewKind === 'more') return true;
	const d = activeDestination(viewKind);
	return !!d && DEST_META[d].scope !== 'brain';
}
