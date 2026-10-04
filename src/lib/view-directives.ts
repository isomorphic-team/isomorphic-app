// The PURE layer of derived views (FR-1, derived-views PRD): directive parsing,
// page segmentation, and snapshot-region handling. No index, no octokit, no D1 —
// importable by the app bundle (which renders/unwraps but never computes) as well
// as the Worker. The index-coupled resolution/rendering lives in views.ts.
//
// A page declares a computed view as a fenced ```okf-view block; beneath it the
// write path keeps a CACHED STATIC RENDERING between snapshot markers so
// non-executing consumers (github.com, raw OKF) see real content. Executing
// consumers recompute; the snapshot is cosmetic fallback only.

// ---------- folder notes ----------
//
// A folder with one of these as a direct child IS that page (a "folder note"):
// clicking the folder opens it, and `kind: folders` represents the folder by it.
// index.md is preferred (unambiguous, and what "Add folder note" creates);
// README.md is accepted as a fallback so GitHub/Obsidian-convention folders get
// folder notes without a rename. Order matters — earlier names win. This is the
// single source of truth; app/core/util.ts re-exports it so the browser tree and
// the view engine can never disagree on what a folder note is.
export const FOLDER_NOTE_NAMES = ['index.md', 'README.md'];
export const isFolderNoteName = (name: string): boolean => FOLDER_NOTE_NAMES.includes(name);

// ---------- directive spec ----------

export interface ViewSpec {
	// The SOURCE of pages: `backlinks` (pages linking to a target page),
	// `pages` (content pages, optionally scoped by `under` + `filter`), or
	// `folders` (the direct sub-folders under `under`, each represented by its
	// folder note). A directory index (FR-1d) is `pages`/`folders` with `under`.
	// (`kind: count` is accepted as shorthand for backlinks + `as: count`.)
	kind: 'backlinks' | 'pages' | 'folders';
	// backlinks only: target page. Defaults to the page containing the view.
	of?: string;
	// pages/folders: path prefix scope, e.g. "organizations/" (root-relative, or
	// ./-relative to the containing page). Default for `pages` is the whole brain;
	// for `folders` it is the containing page's own directory.
	under?: string;
	// Frontmatter filter on the candidate pages: every key must match one of the
	// listed values (case-insensitive; list-valued frontmatter matches any element).
	filter: Record<string, string[]>;
	// Filter lines whose value starts with an operator (`due: "< today"`). Every
	// condition must hold, alongside `filter`. See matchesCondition.
	conditions: FilterCondition[];
	// The RENDERING: linked list, table, or just the cardinality.
	as: 'list' | 'table' | 'count';
	// table only: columns — 'title' (linked) plus frontmatter keys.
	columns: string[];
	// list only: frontmatter key rendered as a per-item description.
	describe?: string;
	// Group rows into sections (list/table) or per-group tallies (count) by a
	// frontmatter key, e.g. `group-by: sector` for "orgs per sector".
	groupBy?: string;
	// Sort key: 'title' or a frontmatter key (numeric-aware).
	sort: string;
	order: 'asc' | 'desc';
	// count only: text rendered after the number, e.g. "tracked contacts".
	label?: string;
}

// ---------- comparison filters ----------
//
// A filter value that starts with an operator compares instead of matching:
// `<`, `<=`, `>`, `>=` take a number, an ISO date (YYYY-MM-DD), `today`, or a
// day offset from today (`-30d`, `+7d`, UTC). `!=` also takes plain text.
// A page whose field is missing, or holds no value comparable to the operand,
// never matches a condition, `!=` included.

export type FilterOp = '<' | '<=' | '>' | '>=' | '!=';

export interface FilterCondition {
	key: string;
	op: FilterOp;
	// The operand as written (`today`, `-30d`, `2026-01-31`, `5`, `lost`).
	operand: string;
}

const OP_RE = /^(<=|>=|!=|<|>)\s*(.*)$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_RE = /^([+-])(\d{1,5})d$/;

function isRealDate(ymd: string): boolean {
	const m = ymd.match(ISO_DATE_RE);
	if (!m) return false;
	const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
	return d.toISOString().slice(0, 10) === ymd;
}

function isNumeric(s: string): boolean {
	return s.trim() !== '' && Number.isFinite(Number(s));
}

// A field value's date part: `2026-09-01` or the date of `2026-09-01T10:00Z`.
function datePart(value: string): string | undefined {
	const d = value.trim().slice(0, 10);
	const rest = value.trim().slice(10);
	if (rest !== '' && !rest.startsWith('T')) return undefined;
	return isRealDate(d) ? d : undefined;
}

type Operand =
	{ kind: 'date'; date: string } | { kind: 'number'; n: number } | { kind: 'text'; text: string };

// `today` is YYYY-MM-DD (UTC). Returns undefined for an operand an ordering
// operator cannot use.
function resolveOperand(op: FilterOp, raw: string, today: string): Operand | undefined {
	const t = raw.trim();
	if (t === 'today') return { kind: 'date', date: today };
	const off = t.match(OFFSET_RE);
	if (off) {
		const d = new Date(today + 'T00:00:00Z');
		d.setUTCDate(d.getUTCDate() + (off[1] === '-' ? -1 : 1) * Number(off[2]));
		return { kind: 'date', date: d.toISOString().slice(0, 10) };
	}
	if (isRealDate(t)) return { kind: 'date', date: t };
	if (isNumeric(t)) return { kind: 'number', n: Number(t) };
	return op === '!=' && t !== '' ? { kind: 'text', text: t.toLowerCase() } : undefined;
}

// Parse one filter value. Not an operator: undefined (plain equality).
function parseCondition(
	key: string,
	values: string[]
): FilterCondition | { error: string } | undefined {
	const withOp = values.filter((v) => OP_RE.test(v.trim()));
	if (withOp.length === 0) return undefined;
	if (values.length > 1) return { error: `filter "${key}": an operator cannot appear in a list` };
	const [, op, operand] = values[0].trim().match(OP_RE)!;
	// Any valid date stands in for `today` here: only the operand's shape is checked.
	if (!resolveOperand(op as FilterOp, operand, '2000-01-01')) {
		return {
			error: `filter "${key}": "${values[0].trim()}" needs a number, a date (YYYY-MM-DD), today, or an offset like -30d${op === '!=' ? ', or text' : ''}`
		};
	}
	return { key, op: op as FilterOp, operand: operand.trim() };
}

// Whether a page's values for the condition's key satisfy it. An ordering
// operator matches when any comparable value does; `!=` matches when at least
// one value is comparable and none equals the operand.
export function matchesCondition(values: string[], cond: FilterCondition, today: string): boolean {
	const operand = resolveOperand(cond.op, cond.operand, today);
	if (!operand) return false;
	const comparable: number[] = []; // sign of value vs operand: -1, 0, 1
	for (const v of values) {
		if (operand.kind === 'date') {
			const d = datePart(v);
			if (d !== undefined) comparable.push(d < operand.date ? -1 : d > operand.date ? 1 : 0);
		} else if (operand.kind === 'number') {
			if (isNumeric(v)) comparable.push(Math.sign(Number(v) - operand.n));
		} else {
			comparable.push(v.trim().toLowerCase() === operand.text ? 0 : 1);
		}
	}
	if (comparable.length === 0) return false;
	switch (cond.op) {
		case '<':
			return comparable.some((c) => c < 0);
		case '<=':
			return comparable.some((c) => c <= 0);
		case '>':
			return comparable.some((c) => c > 0);
		case '>=':
			return comparable.some((c) => c >= 0);
		case '!=':
			return comparable.every((c) => c !== 0);
	}
}

export interface ParsedView {
	spec?: ViewSpec;
	error?: string; // malformed directive — rendered visibly, never fatal
	yaml: string;
}

// ---------- mini-YAML for the spec body ----------
//
// Same dialect family as parseFrontmatter (scalars, quotes, inline arrays) plus
// inline maps (`filter: { type: Contact }`) and one level of block nesting for
// `filter:`. Deliberately tiny — the spec is a fixed shape, not general YAML.
// Quote an operator value (`due: "< today"`): an unquoted `<` or `>` is read the
// same way, but quoting keeps the line valid YAML for other readers.

function stripQuotes(v: string): string {
	const t = v.trim();
	if (
		t.length >= 2 &&
		((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
	) {
		return t.slice(1, -1).replace(/\\"/g, '"');
	}
	return t;
}

function parseScalarOrList(raw: string): string[] {
	const t = raw.trim();
	if (t.startsWith('[') && t.endsWith(']')) {
		const inner = t.slice(1, -1).trim();
		return inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s));
	}
	return [stripQuotes(t)];
}

// `{ type: Contact, status: [active, new] }` → { type: ["Contact"], ... }
function parseInlineMap(raw: string): Record<string, string[]> | null {
	const t = raw.trim();
	if (!t.startsWith('{') || !t.endsWith('}')) return null;
	const out: Record<string, string[]> = {};
	const inner = t.slice(1, -1).trim();
	if (inner === '') return out;
	// Split on commas not inside brackets (values may be inline arrays).
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of inner) {
		if (ch === '[') depth++;
		if (ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
		} else cur += ch;
	}
	if (cur.trim()) parts.push(cur);
	for (const part of parts) {
		const m = part.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) return null;
		out[m[1]] = parseScalarOrList(m[2]);
	}
	return out;
}

export function parseViewSpec(yaml: string): ParsedView {
	const raw: Record<string, string> = {};
	const filter: Record<string, string[]> = {};
	const lines = yaml.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) return { yaml, error: `unrecognized line: "${line.trim()}"` };
		const [, key, rest] = m;
		if (key === 'filter') {
			if (rest.trim() === '') {
				// Block form: indented `key: value` lines follow.
				while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
					const fm = lines[i + 1].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
					if (!fm) return { yaml, error: `bad filter line: "${lines[i + 1].trim()}"` };
					filter[fm[1]] = parseScalarOrList(fm[2]);
					i++;
				}
			} else {
				const map = parseInlineMap(rest);
				if (!map) return { yaml, error: `bad filter: "${rest.trim()}"` };
				Object.assign(filter, map);
			}
		} else {
			raw[key] = rest.trim();
		}
	}

	const conditions: FilterCondition[] = [];
	for (const [key, values] of Object.entries(filter)) {
		const cond = parseCondition(key, values);
		if (!cond) continue;
		if ('error' in cond) return { yaml, error: cond.error };
		conditions.push(cond);
		delete filter[key];
	}

	let kind = stripQuotes(raw.kind ?? '');
	let as = stripQuotes(raw.as ?? 'list');
	// Phase 1 shorthand: `kind: count` == a backlinks count.
	if (kind === 'count') {
		kind = 'backlinks';
		as = 'count';
	}
	if (kind !== 'backlinks' && kind !== 'pages' && kind !== 'folders') {
		return {
			yaml,
			error: `kind must be "backlinks", "pages", "folders", or "count" (got "${stripQuotes(raw.kind ?? '') || 'nothing'}")`
		};
	}
	if (as !== 'list' && as !== 'table' && as !== 'count') {
		return { yaml, error: `as must be "list", "table", or "count" (got "${as}")` };
	}
	const order = stripQuotes(raw.order ?? 'asc');
	if (order !== 'asc' && order !== 'desc') {
		return { yaml, error: `order must be "asc" or "desc" (got "${order}")` };
	}
	if (raw.of && kind !== 'backlinks') {
		return { yaml, error: `"of" only applies to kind: backlinks` };
	}
	if (raw.under && kind === 'backlinks') {
		return { yaml, error: `"under" applies to kind: pages or folders, not backlinks` };
	}
	const columns = raw.columns ? parseScalarOrList(raw.columns) : ['title'];
	if (columns.length === 0) columns.push('title');
	return {
		yaml,
		spec: {
			kind,
			of: raw.of ? stripQuotes(raw.of) : undefined,
			under: raw.under ? stripQuotes(raw.under) : undefined,
			filter,
			conditions,
			as,
			columns,
			describe: raw.describe ? stripQuotes(raw.describe) : undefined,
			groupBy: raw['group-by'] ? stripQuotes(raw['group-by']) : undefined,
			sort: raw.sort ? stripQuotes(raw.sort) : 'title',
			order,
			label: raw.label ? stripQuotes(raw.label) : undefined
		}
	};
}

// ---------- segmentation (fence + snapshot region) ----------

export const VIEW_FENCE_TAG = 'okf-view';
export const SNAPSHOT_BEGIN =
	'<!-- okf-view:snapshot (generated: do not edit, recomputed on save) -->';
export const SNAPSHOT_END = '<!-- /okf-view:snapshot -->';

export type Segment =
	| { type: 'text'; text: string }
	// A view's fence plus, when present, the body of its trailing snapshot region
	// (marker lines excluded) — retained so presentation code can unwrap it.
	| { type: 'view'; fence: string; view: ParsedView; snapshot?: string };

// Cheap pre-check so pages without views pay nothing.
export function hasViews(content: string): boolean {
	return content.includes('```' + VIEW_FENCE_TAG);
}

// Split a page into text and view segments. A view segment spans the okf-view
// fence plus its trailing snapshot region (markers included), when present. A
// fence inside ANOTHER fenced block is plain text (tracked via generic fence
// state). Tolerant: an unclosed okf-view fence, or a begin marker with no end
// marker, is left as plain text rather than eating the rest of the page.
export function segmentViews(content: string): Segment[] {
	const lines = content.split('\n');
	const segments: Segment[] = [];
	let text: string[] = [];
	let inOtherFence = false;
	const flush = () => {
		if (text.length) segments.push({ type: 'text', text: text.join('\n') });
		text = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isFenceLine = /^```/.test(line.trim());
		if (inOtherFence) {
			text.push(line);
			if (isFenceLine) inOtherFence = false;
			continue;
		}
		if (line.trim() === '```' + VIEW_FENCE_TAG) {
			// Find the closing fence.
			let close = -1;
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim() === '```') {
					close = j;
					break;
				}
			}
			if (close < 0) {
				text.push(line); // unclosed — treat as text
				continue;
			}
			const fence = lines.slice(i, close + 1).join('\n');
			const yaml = lines.slice(i + 1, close).join('\n');
			// Optional snapshot region: blank lines, BEGIN, ..., END.
			let after = close + 1;
			let snapshot: string | undefined;
			let probe = after;
			while (probe < lines.length && lines[probe].trim() === '') probe++;
			if (probe < lines.length && lines[probe].trim() === SNAPSHOT_BEGIN) {
				for (let j = probe + 1; j < lines.length; j++) {
					if (lines[j].trim() === SNAPSHOT_END) {
						snapshot = lines.slice(probe + 1, j).join('\n');
						after = j + 1;
						break;
					}
				}
			}
			flush();
			segments.push({ type: 'view', fence, view: parseViewSpec(yaml), snapshot });
			i = after - 1;
			continue;
		}
		if (isFenceLine) inOtherFence = true;
		text.push(line);
	}
	flush();
	return segments;
}

// The editor path: remove snapshot regions (keep the fences) so generated
// content never round-trips through ProseMirror — it gets recomputed on save.
export function stripSnapshots(content: string): string {
	return segmentViews(content)
		.map((s) => (s.type === 'text' ? s.text : s.fence))
		.join('\n');
}

// The presentation unwrap: show each view's snapshot body and hide its fence,
// WITHOUT touching the index. For content whose snapshots are known-fresh —
// read_page recomputes them at read time — this yields the same bytes as
// renderViews().display, synchronously. The app uses it when rendering raw page
// content it received from read_page (in-app navigation). A view with no
// snapshot keeps its fence visible: the honest fallback when nothing computed.
export function displayFromSnapshots(content: string): string {
	return segmentViews(content)
		.map((s) => (s.type === 'text' ? s.text : (s.snapshot ?? s.fence)))
		.join('\n');
}
