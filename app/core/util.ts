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
