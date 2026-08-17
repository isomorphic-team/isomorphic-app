// Small pure helpers shared by more than one view.

// Folder-note names live in the view engine's pure layer (single source of truth,
// so the browser tree and `kind: folders` can never disagree); re-exported here
// for the app's tree/breadcrumb code.
export { FOLDER_NOTE_NAMES, isFolderNoteName } from '../../src/lib/view-directives.ts';

// Compact relative time ("3d ago", "2h ago"), falling back to the date for
// anything older than ~a month. Keeps the feed scannable without a date library.
export function relativeTime(iso: string): string {
	if (!iso) return '';
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso.slice(0, 10);
	const secs = Math.max(0, (Date.now() - then) / 1000);
	if (secs < 60) return 'just now';
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	if (days < 30) return `${days}d ago`;
	return iso.slice(0, 10);
}

// How old a render is, in the compact form the refresh control wears as its label
// ("4m", "2h", "3d"). `now` is passed in rather than read off the clock so the rule
// can be pinned by a pure test.
//
// Null means "new enough that saying so would be noise", and that is the point of
// the threshold: a control that announces an age on a render one second old trains
// the reader to ignore it, and this label only earns its space in the header when
// the answer is not obvious. Null is also what an unknown fetch time reports, since
// a render whose age we cannot vouch for must not claim one — including the case
// where a clock moved backwards under us.
const AGE_VISIBLE_AFTER_MS = 60_000;

export function renderAge(fetchedAt: number | undefined, now: number): string | null {
	if (!fetchedAt) return null;
	const ms = now - fetchedAt;
	if (ms < AGE_VISIBLE_AFTER_MS) return null;
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
}

// What a completed refresh is allowed to claim, decided on blob shas alone.
//
// Comparing the MARKDOWN instead would be wrong here even though it looks equivalent:
// view_page serves a page with its okf-view fences replaced by live results, while
// read_page serves the same page with the cached snapshot beneath the fence, so the
// two spellings of an unchanged page differ by construction and every refresh of a
// page holding a view would announce a change that never happened.
//
// 'unknown' is the honest answer when either side has no sha (an older Worker, a
// backend that does not report one). The page is still swapped for the fresh copy;
// what is withheld is the claim about whether anything moved.
export function refreshOutcome(
	before: string | undefined,
	after: string | undefined
): 'updated' | 'current' | 'unknown' {
	if (!before || !after) return 'unknown';
	return before === after ? 'current' : 'updated';
}

// A host that refuses a tool call substitutes its own text for the result, so what
// reaches the widget is several paragraphs of instructions addressed to the MODEL
// ("you *may* attempt to accomplish this action using other tools…"). Rendering that
// verbatim tells the reader nothing they can act on and reads as an Isomorphic
// failure, when the call never left the client.
//
// The patterns are the host's own wording, deliberately narrow: a server-side
// authorization error ("requires editor") is a real answer from the brain and must
// keep its own text.
const HOST_DENIALS = [
	/permission for this action was denied/i,
	/requested permissions? to use/i,
	/doesn.?t want to proceed with this tool use/i
];

export function isHostDenial(detail: string | undefined): boolean {
	return !!detail && HOST_DENIALS.some((re) => re.test(detail));
}

// Brains grouped by the org that owns them, in the order the server sent (oldest
// first), for the two surfaces that list brains: the crumb's brain picker and Manage
// brains. The org heading is what lets brainLabel drop the "Org — " prefix it used to
// put on every row of a multi-brain org; it says the org once instead of once per row,
// and it survives the brains being renamed.
//
// `org` is null when there is only ONE org to show, whatever its brain count: a heading
// naming the only org there is disambiguates nothing, and the rule the nav follows is
// that a control earns its space by offering a choice.
export function groupBrainsByOrg<T extends { orgId?: string; orgLabel?: string }>(
	rows: T[]
): { org: string | null; rows: T[] }[] {
	const groups: { org: string | null; rows: T[] }[] = [];
	const byOrg = new Map<string, T[]>();
	for (const b of rows) {
		const key = b.orgId ?? b.orgLabel ?? '';
		let bucket = byOrg.get(key);
		if (!bucket) {
			bucket = [];
			byOrg.set(key, bucket);
			groups.push({ org: b.orgLabel ?? null, rows: bucket });
		}
		bucket.push(b);
	}
	return groups.length > 1 ? groups : [{ org: null, rows }];
}
