// Non-destructive body edits for write_page: `append` and `edits` (find/replace).
//
// Why this exists: write_page's `content` argument replaces the whole body, so
// changing one line of a page you haven't read means destroying the rest of it.
// That forced a read-the-whole-page-then-rewrite-it cycle for every small edit,
// and an agent that can't read first is one clobber away from data loss. These
// two arguments change part of a page without needing the rest of it in context.
//
// Pure: no octokit, no D1, no index. Golden test: pnpm test:patch.
//
// Two rules make this safe to call blind:
//   1. A `find` string must match EXACTLY ONCE. Zero matches or several is an
//      error, never a guess. Ambiguity fails loudly instead of editing the wrong
//      paragraph.
//   2. Matches inside an okf-view SNAPSHOT REGION don't count. That text is
//      generated (recomputed from the index on every save), so an edit anchored
//      there would be silently reverted on the very same write. Anchoring on a
//      snapshot is a mistake worth naming, so it gets its own error message.

import { SNAPSHOT_BEGIN, SNAPSHOT_END } from './view-directives.ts';

export interface PageEdit {
	find: string;
	replace: string;
}

export type PatchResult =
	| { ok: true; body: string; summary: string }
	| { ok: false; error: string };

// Character ranges covered by okf-view snapshot regions (markers included).
// Line-based, mirroring segmentContent's own marker scan in view-directives.ts.
function snapshotRanges(body: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const lines = body.split('\n');
	let offset = 0;
	let start: number | null = null;
	for (const line of lines) {
		const end = offset + line.length;
		if (start === null) {
			if (line.trim() === SNAPSHOT_BEGIN) start = offset;
		} else if (line.trim() === SNAPSHOT_END) {
			ranges.push([start, end]);
			start = null;
		}
		offset = end + 1; // the '\n' we split on
	}
	// An unterminated BEGIN marker (hand-mangled page): treat the rest as generated.
	if (start !== null) ranges.push([start, body.length]);
	return ranges;
}

function allIndexesOf(haystack: string, needle: string): number[] {
	const out: number[] = [];
	for (
		let i = haystack.indexOf(needle);
		i !== -1;
		i = haystack.indexOf(needle, i + needle.length)
	) {
		out.push(i);
	}
	return out;
}

// A short, quotable label for an error message: the find string's first line,
// truncated, so the model can see WHICH anchor missed without echoing a page.
function excerpt(s: string, max = 60): string {
	const line = s.split('\n')[0].trim();
	const shortened = line.length > max ? `${line.slice(0, max)}…` : line;
	return s.includes('\n') ? `${shortened} …` : shortened;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

// Apply `edits` in order, then `append`, to a page BODY (frontmatter already
// stripped by the caller). Each edit sees the result of the previous one, so a
// caller can make several related changes in a single save.
export function applyPageEdits(
	body: string,
	opts: { append?: string; edits?: PageEdit[] }
): PatchResult {
	let next = body;
	const notes: string[] = [];

	const edits = opts.edits ?? [];
	for (const [i, edit] of edits.entries()) {
		const label = edits.length > 1 ? `edit ${i + 1} ("${excerpt(edit.find)}")` : 'that text';
		if (edit.find === '') {
			return {
				ok: false,
				error: `The "find" text of ${label} is empty; give the text to replace.`
			};
		}
		const hits = allIndexesOf(next, edit.find);
		if (hits.length === 0) {
			return {
				ok: false,
				error: `Couldn't find "${excerpt(edit.find)}" on the page, so nothing was changed. Read the page and copy the exact text (whitespace included) you want replaced.`
			};
		}
		const generated = snapshotRanges(next);
		const inSnapshot = (at: number) =>
			generated.some(([from, to]) => at < to && at + edit.find.length > from);
		const live = hits.filter((at) => !inSnapshot(at));
		if (live.length === 0) {
			return {
				ok: false,
				error: `"${excerpt(edit.find)}" only appears inside a generated okf-view snapshot, which is recomputed on every save, so editing it would have no effect. Edit the okf-view directive itself, or anchor on text outside the snapshot markers.`
			};
		}
		if (live.length > 1) {
			return {
				ok: false,
				error: `"${excerpt(edit.find)}" appears ${plural(live.length, 'time')} on the page, so ${label === 'that text' ? 'the edit' : label} is ambiguous and nothing was changed. Include more of the surrounding text to make it match exactly once.`
			};
		}
		const at = live[0];
		next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
	}
	if (edits.length) notes.push(`${plural(edits.length, 'replacement')} made`);

	if (opts.append !== undefined) {
		const addition = opts.append.replace(/\s+$/, '');
		if (addition.trim() === '') {
			return { ok: false, error: 'Nothing to append: "append" is empty.' };
		}
		// One blank line between the old body and the addition, and exactly one
		// trailing newline, so appending repeatedly can't stack blank lines.
		const base = next.replace(/\s+$/, '');
		next = base === '' ? `${addition}\n` : `${base}\n\n${addition}\n`;
		notes.push(`${plural(addition.split('\n').length, 'line')} appended`);
	}

	if (notes.length === 0) {
		return {
			ok: false,
			error: 'Nothing to change: pass "append" or at least one entry in "edits".'
		};
	}
	return { ok: true, body: next, summary: notes.join(', ') };
}
