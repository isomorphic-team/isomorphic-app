// EVERYWHERE ELSE YOU CAN GO: the destinations that are not this brain, as a page.
//
// This is the rail's ⋯, and it used to be a popover carrying three groups (Organization,
// Your account, Display). Two things were wrong with that, and only one of them was the
// popover. The menu answered two different questions at once — four PLACES and one
// WINDOW CONTROL — so it had no identity and read as a junk drawer. And the rail is
// top-anchored, so its ⋯ sits ~145px down whatever the card's height is: on a 170px
// inline card there were 32px beneath it, and every treatment that hangs off that button
// (popover, flyout rail, labelled expanding rail) is bounded by the same 32px. Growing
// the window does not help, because the trigger moves down with it.
//
// A page is the one shape that escapes: it owns the content area and scrolls natively,
// identically at every card size, with no clamping, flipping, or measuring. It also has
// room for a line under each row, which a menu never did — "Analytics" alone is a guess,
// "How much your organization uses its brains" is not.
//
// Display mode went to the right end of the top bar instead of onto this page. It is a
// property of the window rather than a place, and putting it here would mean leaving the
// page you are reading in order to go fullscreen, then arriving HERE rather than back at
// your content.
import { destinations } from '../components/Destinations.tsx';
import type { Scope } from '../core/nav.ts';
import { defineView } from '../core/view-registry.ts';
import { List, ListRow } from '../ui/index.ts';
import { eyebrow } from '../ui/typography.ts';

// The two scopes this page carries. The brain's own views are NOT here: Search, Files,
// Graph, Recent changes and Sharing are the five icons standing in the rail, and a row
// each would be a second way to say the same thing.
const GROUPS: { scope: Exclude<Scope, 'brain'>; heading: string }[] = [
	{ scope: 'org', heading: 'Organization' },
	{ scope: 'account', heading: 'Your account' }
];

function MoreView() {
	// Read live rather than at module scope: `features` lands with the brain list and
	// `canManage` changes with the active brain, so a group can be empty on one brain
	// and full on the next. An empty one is dropped whole, heading included, since a
	// heading over nothing is a promise of rows that were gated away.
	const groups = GROUPS.map((g) => ({ ...g, rows: destinations(g.scope) })).filter(
		(g) => g.rows.length > 0
	);
	if (!groups.length)
		return (
			<div class="mt-6 text-center text-sm text-muted">
				Nothing here yet. Your organization and account screens appear once this deployment has
				them.
			</div>
		);
	return (
		<div class="flex flex-col gap-5">
			{groups.map((g) => (
				<div key={g.scope}>
					<div class={`mb-1 ${eyebrow}`}>{g.heading}</div>
					<List>
						{g.rows.map((d) => (
							<ListRow key={d.key} class="p-0">
								<button
									type="button"
									onClick={d.open}
									class="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-chip focus-visible:ring-2 focus-visible:ring-accent"
								>
									<span class="shrink-0 text-muted">{d.icon}</span>
									<span class="min-w-0 flex-1">
										<span class="block truncate text-fg">{d.label}</span>
										<span class="block truncate text-xs text-muted">{d.blurb}</span>
									</span>
								</button>
							</ListRow>
						))}
					</List>
				</div>
			))}
		</div>
	);
}

export { MoreView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		// No payload. Everything this page renders comes from the store (which
		// destinations exist for this deployment and this caller), so opening it is a
		// pure client-side move with no tool call and nothing to wait for.
		more: Record<never, never>;
	}
}

export default defineView('more', () => <MoreView />);
