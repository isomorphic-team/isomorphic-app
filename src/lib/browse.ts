// What browse_brain says about a brain, and how much of the brain it carries.
//
// browse_brain exists to OPEN THE VIEWER. It used to return every page path twice
// over — once as text, once in structuredContent alongside a title per page — and on
// a 556-page brain that came to 83,708 characters, which the host refused as a tool
// result and spilled to a file. The full list is not what the call is for: the widget
// can fetch it itself with list_pages (a widget-initiated call the model never pays
// for), and the model gets more out of a shape summary than out of 556 paths.
//
// So the text block is always a summary, and the tree rides along only while it is
// small enough to be cheap. Both halves are pure and live here so `pnpm test:policy`
// can pin the budget and the fallback the app depends on.

export interface BrowseTree {
	paths: string[];
	pages: { path: string; title: string }[];
	assets: string[];
	hidden: string[];
}

// How many characters of tree we are willing to spend on a tool result. Measured on
// the serialized payload rather than a page count, because a page contributes its
// path AND its title and both vary by an order of magnitude between brains. At this
// size the whole result stays a few thousand tokens; above it the widget fetches the
// tree itself.
export const MAX_INLINE_TREE_CHARS = 16_000;

// How many folder tallies the summary names before it stops counting.
const MAX_SUMMARY_GROUPS = 12;

export function treeFitsInline(tree: BrowseTree): boolean {
	return JSON.stringify(tree).length <= MAX_INLINE_TREE_CHARS;
}

// The directory every path shares, so the tallies below are folders a human named
// rather than the one root they all sit under ("wiki (556)" answers nothing).
function commonDir(paths: string[]): string {
	if (paths.length === 0) return '';
	let prefix = paths[0].split('/').slice(0, -1);
	for (const p of paths.slice(1)) {
		const segs = p.split('/').slice(0, -1);
		let i = 0;
		while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
		prefix = prefix.slice(0, i);
		if (prefix.length === 0) break;
	}
	return prefix.length ? prefix.join('/') + '/' : '';
}

// Page counts by the first folder below the shared root — the brain's shape in one
// line. Pages sitting directly in that root are counted together at the end, since
// "the root" is a real place a page can be but not a folder anyone can open.
function folderTallies(paths: string[]): { label: string; count: number }[] {
	const root = commonDir(paths);
	const counts = new Map<string, number>();
	let loose = 0;
	for (const p of paths) {
		const rest = p.slice(root.length);
		const slash = rest.indexOf('/');
		if (slash === -1) loose++;
		else {
			const folder = rest.slice(0, slash);
			counts.set(folder, (counts.get(folder) ?? 0) + 1);
		}
	}
	const rows = [...counts]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	if (loose > 0) rows.push({ label: '(top level)', count: loose });
	return rows;
}

// The text block: what the brain holds, in the shape of its folders, plus where to go
// for the detail. Named tools rather than prose, because this is the block the model
// reads and its next move is a call.
export function browseSummary(brainLabel: string, tree: BrowseTree): string {
	if (tree.paths.length === 0) return `${brainLabel} has no pages yet.`;
	const rows = folderTallies(tree.paths);
	const shown = rows.slice(0, MAX_SUMMARY_GROUPS);
	const rest = rows.length - shown.length;
	const counts = shown.map((r) => `${r.label} (${r.count})`).join(', ');
	const attachments = tree.assets.length ? `, ${tree.assets.length} attachment(s)` : '';
	return [
		`Opened ${brainLabel} in the viewer: ${tree.paths.length} page(s)${attachments}.`,
		`Folders: ${counts}${rest > 0 ? `, +${rest} more` : ''}.`,
		'Use list_pages (optionally with a prefix) for the full list, search_pages to find a page, or read_page to read one.'
	].join('\n');
}
