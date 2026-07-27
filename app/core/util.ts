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
