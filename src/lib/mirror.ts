// The mirror copier: turning a connection's pages into a read-only record each party
// keeps when the relationship ends. Design: docs/design/brain-seams.md §7.
//
// WHY THIS IS PAGED. commitFiles builds ONE createTree with every blob inline, so a
// large brain is a single multi-megabyte request that fails. §4's rule against unbounded
// work in one request applies here more than anywhere: the failure is not "slow", it is
// "this copy can never complete". So the walk is budgeted and cursored, exactly like the
// index rebuild, and each pass leaves a valid repository holding a subset rather than a
// broken one.
//
// WHY TEXT IS A NARROW ALLOWLIST AND EVERYTHING ELSE IS COPIED AS BYTES. Reading bytes
// is lossless for anything; reading text is lossless only for valid UTF-8, and the cost
// of guessing wrong is a file that arrives corrupted with nothing anywhere to say so. So
// the default is bytes, and only the extensions the platform itself writes take the
// cheap batched path, which is still almost every file in almost every brain.
//
// It would be neater to infer this from what fetchPages returns, and that was the first
// thing tried here. It does not work across backends: GitHub's GraphQL yields null for a
// blob that is not valid UTF-8, so the skipped entries identify themselves, while the
// filesystem backend reads the same blob as UTF-8 with replacement characters and hands
// back mangled text that looks like a perfectly successful read. A rule that is exact on
// one backend and silently corrupting on the other is worse than a plain one that
// behaves identically on both. `pnpm test:e2e-mirror` is what caught it.

import type { BrainStore, FileWrite, RepoRef, TreeEntry } from './brain-repo.ts';

export interface MirrorEnd {
	store: BrainStore;
	repo: RepoRef;
}

export interface MirrorPassResult {
	// Where to resume, or null when the copy is complete. Persisted on the party row.
	cursor: string | null;
	copied: number;
	// How many of this pass's files had to be read one at a time because they were not
	// text. Reported so a caller can see the cost rather than infer it.
	binaries: number;
	done: boolean;
}

// Files per pass. Text is cheap (batched, 100 to a request) and bytes are not (one
// request each), so a binary spends several units of the same budget. Both numbers are
// deliberately conservative: too small costs an extra round of passes, too large costs
// the whole copy.
export const MIRROR_PAGE_BUDGET = 200;
const BINARY_COST = 10;

// The extensions the platform writes itself, and the only ones read as text. Everything
// else, including files a brain merely happens to contain, is copied as bytes.
const TEXT_EXTENSIONS = ['.md', '.json'];

export function isTextPath(path: string): boolean {
	return TEXT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

// One pass of the copy. Idempotent for a given cursor: re-running it rewrites the same
// files with the same content, which is what makes a resumed copy safe after a failure
// whose outcome is unknown.
export async function copyMirrorPass(
	src: MirrorEnd,
	dst: MirrorEnd,
	opts: { branch: string; cursor: string | null; budget?: number; label: string }
): Promise<MirrorPassResult> {
	const budget = opts.budget ?? MIRROR_PAGE_BUDGET;
	const head = await src.store.getHead(src.repo, opts.branch);
	// Everything, not just pages: a mirror that holds the prose and drops the images is
	// not the record it claims to be.
	const all = await src.store.listTree(src.repo, head, { extension: '*' });
	// Path order, so the cursor is a position in a stable sequence rather than in
	// whatever order the platform happened to return.
	all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const remaining = opts.cursor ? all.filter((e) => e.path > opts.cursor!) : all;
	if (remaining.length === 0) return { cursor: null, copied: 0, binaries: 0, done: true };

	// Fill one pass by COST, not by count, so a window full of images cannot turn into
	// one request per file with no ceiling. Always take at least one entry, or a single
	// file more expensive than the whole budget would stall the copy forever.
	const batch: TreeEntry[] = [];
	let spent = 0;
	for (const entry of remaining) {
		const cost = isTextPath(entry.path) ? 1 : BINARY_COST;
		if (batch.length > 0 && spent + cost > budget) break;
		batch.push(entry);
		spent += cost;
	}

	const textEntries = batch.filter((e) => isTextPath(e.path));
	const byPath = new Map<string, string>();
	if (textEntries.length > 0) {
		const { pages } = await src.store.fetchPages(src.repo, textEntries);
		for (const p of pages) byPath.set(p.path, p.content);
	}

	const writes: FileWrite[] = [];
	let binaries = 0;
	for (const entry of batch) {
		if (isTextPath(entry.path)) {
			const text = byPath.get(entry.path);
			// A text file the batched read did not return is skipped rather than guessed
			// at. It will not be retried, which is the honest trade: one unreadable page
			// must not hold the whole record hostage.
			if (text !== undefined) writes.push({ path: entry.path, content: text });
			continue;
		}
		const bin = await src.store.readBinary(src.repo, entry.path);
		if (!bin) continue; // vanished between listing and reading; nothing to copy
		writes.push({ path: entry.path, content: bin.contentBase64, encoding: 'base64' });
		binaries += 1;
	}

	// The cursor advances past the whole WINDOW, not past the last file written. They
	// differ whenever something was skipped, and advancing only to the last write would
	// re-examine the skipped entries on every pass: a copy that never converges.
	const window = batch[batch.length - 1].path;
	const done = window === remaining[remaining.length - 1].path;

	if (writes.length > 0) {
		await dst.store.commitFiles(dst.repo, {
			message: `Copy ${opts.label} (${writes.length} file(s))`,
			writes
		});
	}
	return { cursor: done ? null : window, copied: writes.length, binaries, done };
}

// The note left at the root of a mirror. A repository full of someone else's pages with
// no explanation is worse than useless a year later, and this is the one file the copy
// adds rather than reproduces.
export function mirrorReadme(input: {
	connectionName: string;
	parties: string[];
	endedAt: string;
}): string {
	return [
		`# ${input.connectionName} (archive)`,
		'',
		`This is a read-only copy of a shared working space between ${input.parties.join(' and ')}.`,
		'',
		`The connection ended on ${input.endedAt}. Nothing here can be edited: it is kept as a record`,
		'of what the two sides had written together, not as a place to carry on working.',
		'',
		'Pages that linked to each other still do. Links that pointed outside this space will not',
		'resolve, because what they pointed at was never part of it.',
		''
	].join('\n');
}
