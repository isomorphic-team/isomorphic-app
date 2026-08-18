// Partial page updates for write_page: `append` and `edits` change part of the
// BODY, `fields` changes part of the FRONTMATTER.
//
// Why this exists: write_page's `content` argument replaces the whole body, so
// changing one line of a page you haven't read means destroying the rest of it.
// That forced a read-the-whole-page-then-rewrite-it cycle for every small edit,
// and an agent that can't read first is one clobber away from data loss. These
// arguments change part of a page without needing the rest of it in context.
//
// Pure: no octokit, no D1, no index. Golden test: pnpm test:patch.
//
// Two rules make the body edits safe to call blind:
//   1. A `find` string must match EXACTLY ONCE. Zero matches or several is an
//      error, never a guess. Ambiguity fails loudly instead of editing the wrong
//      paragraph.
//   2. Matches inside an okf-view SNAPSHOT REGION don't count. That text is
//      generated (recomputed from the index on every save), so an edit anchored
//      there would be silently reverted on the very same write. Anchoring on a
//      snapshot is a mistake worth naming, so it gets its own error message.

import { isFrontmatterBlock, type Frontmatter, type FrontmatterValue } from './wiki.ts';
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

// ---------- frontmatter fields (`fields`) ----------
//
// The body's twin: set or remove individual frontmatter keys without rewriting
// the page. Semantics are JSON Merge Patch (RFC 7386): a key present in the patch
// is set, an explicit null removes it, an absent key is left alone.
//
// Three rules, each forced by something elsewhere in the codebase:
//
//   1. Key names must match what parseFrontmatter can read back. Its FM_KEY_RE
//      accepts [A-Za-z0-9_-] only, and it SKIPS lines it cannot match, so a key
//      with a space or a dot would be written successfully and then disappear on
//      the next read. A writer must not be able to produce files our own reader
//      loses.
//   2. Keys write_page manages itself are refused, with a pointer to the argument
//      that owns them. `title` is the reason this is a rule rather than a
//      preference: retitling repoints every inbound wikilink in the same save, so
//      a title set through here would break links silently. `updated` is stamped
//      on every write.
//   3. A key currently holding nested YAML is refused, for set AND for remove.
//      Those runs are held verbatim as FrontmatterBlock and replayed byte for
//      byte (OKF `sources:`/`generated:` provenance). Flattening one destroys
//      structure the caller has not read, and not having to read first is the
//      whole point of this argument. Same invariant `edits` enforces: you cannot
//      destroy what you have not seen.

export const MANAGED_FIELD_KEYS = ['title', 'type', 'description', 'status', 'updated'] as const;
export const OKF_PAGE_STATUSES = ['draft', 'stable', 'deprecated'] as const;
export type OkfPageStatus = (typeof OKF_PAGE_STATUSES)[number];

const FIELD_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Exported so the app's properties panel refuses exactly what the tool refuses.
// Two copies of this rule would let the UI offer a key the write then rejects.
export function isUsableFieldKey(key: string): boolean {
	return FIELD_KEY_RE.test(key) && !(MANAGED_FIELD_KEYS as readonly string[]).includes(key);
}

// The argument to reach for instead, per managed key. `updated` has none: it is
// stamped by the writer on every save and is not the caller's to set.
const MANAGED_FIELD_ADVICE: Record<string, string> = {
	title: 'Use the "title" argument (it also repoints inbound links).',
	type: 'Use the "type" argument.',
	description: 'Use the "description" argument.',
	status: 'Use the "status" argument.',
	updated: 'It is stamped automatically on every save.'
};

export type FieldValue = string | number | boolean | Array<string | number> | null;
export type FieldPatch = Record<string, FieldValue>;

export type FieldPatchResult =
	| { ok: true; frontmatter: Frontmatter; summary: string; changed: number }
	| { ok: false; error: string };

function normalize(value: Exclude<FieldValue, null>): FrontmatterValue {
	return Array.isArray(value) ? value.map((v) => String(v)) : String(value);
}

// Compared post-normalization so `2` and `"2"` are the same value, which is what
// they become in the file. Lets a caller re-run a patch without touching pages
// that already say what it asks for.
function sameValue(a: FrontmatterValue | undefined, b: FrontmatterValue): boolean {
	if (a === undefined) return false;
	if (isFrontmatterBlock(a)) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Context-free checks on a patch: key names and managed keys. Separate from
 * applyFieldPatch so a batch caller can reject a bad patch before fetching any
 * page, rather than discovering it on page 1 of 200.
 *
 * Returns an error string, or null when the patch is well-formed.
 */
export function validateFieldPatch(patch: FieldPatch): string | null {
	const keys = Object.keys(patch);
	if (keys.length === 0) {
		return 'Nothing to set: "fields" is empty. Pass at least one key, or null to remove one.';
	}
	for (const key of keys) {
		if (!FIELD_KEY_RE.test(key)) {
			return `"${key}" is not a usable frontmatter key: use letters, digits, underscores and dashes only (e.g. "due_date"). Other characters are dropped when the page is read back.`;
		}
		if ((MANAGED_FIELD_KEYS as readonly string[]).includes(key)) {
			return `"${key}" is managed by write_page and cannot be set through "fields". ${MANAGED_FIELD_ADVICE[key]}`;
		}
		const value = patch[key];
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			return `The value for "${key}" must be text, a number, true/false, a list of those, or null to remove it.`;
		}
	}
	return null;
}

/**
 * Apply a field patch to a page's parsed frontmatter. `changed` is the number of
 * keys whose value actually moved, so a caller can skip writing a page that
 * already says what the patch asks for.
 */
export function applyFieldPatch(fm: Frontmatter, patch: FieldPatch): FieldPatchResult {
	const invalid = validateFieldPatch(patch);
	if (invalid) return { ok: false, error: invalid };

	const next: Frontmatter = { ...fm };
	const set: string[] = [];
	const removed: string[] = [];

	for (const [key, value] of Object.entries(patch)) {
		if (isFrontmatterBlock(fm[key])) {
			return {
				ok: false,
				error: `"${key}" holds nested YAML on this page, which this tool keeps exactly as written rather than rewriting. Read the page and use "content" if you really mean to replace it.`
			};
		}
		if (value === null) {
			if (key in next) {
				delete next[key];
				removed.push(key);
			}
			continue;
		}
		const normalized = normalize(value);
		if (sameValue(fm[key], normalized)) continue;
		next[key] = normalized;
		set.push(key);
	}

	const notes: string[] = [];
	if (set.length) notes.push(`set ${set.join(', ')}`);
	if (removed.length) notes.push(`removed ${removed.join(', ')}`);
	return {
		ok: true,
		frontmatter: next,
		changed: set.length + removed.length,
		summary: notes.length ? notes.join('; ') : 'no field changes (already up to date)'
	};
}
