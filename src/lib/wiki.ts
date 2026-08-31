// Wiki-shape helpers — pure functions over brain markdown.
//
// Everything here is runtime-portable (no node:*, no I/O): frontmatter
// parse/serialize, slugs, link extraction, and the changelog editing that keeps
// the brain's log path in sync with page writes. The MCP Worker composes these
// into atomic multi-file commits (see brain-repo.ts); keeping them pure makes
// them unit-testable without GitHub.
//
// Frontmatter is a deliberate YAML *subset*: flat `key: value` scalars and
// flat string lists. That is what the brain schema (AGENTS.md) asks agents to
// write, and a real YAML parser would be a dependency for shapes we don't author.
//
// But we are not the only writer. A brain is an ordinary GitHub repo, and pages
// arrive from external producers — OKF bundles, ETL scripts, humans editing on
// github.com. OKF v0.2's trust family is NESTED (`sources:` as a list of
// resource/title mappings, `generated: {by, at}`), so treating "not in our subset"
// as "not real" meant silently destroying those keys on the next save: the flat
// parser reduced them to '' or to a mangled list item, and serialize wrote that
// back. Nested values are therefore captured VERBATIM as an opaque block and
// re-emitted byte-for-byte. We still don't interpret them — they can't be filtered
// on, indexed, or merged — but we no longer eat them.

import { isFolderNoteName } from './view-directives.ts';

// ---------- page types ----------

export function slugify(text: string, fallback = 'untitled'): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return slug || fallback;
}

export function todayIso(): string {
	return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------- frontmatter ----------

// A nested YAML value we deliberately do NOT model — held as the verbatim lines
// that followed its `key:` so it can be written back unchanged. Opaque by design:
// nothing reads inside it, so nothing can silently reinterpret it.
export interface FrontmatterBlock {
	// The `|` or `>` that followed the key, when there was one.
	readonly indicator?: string;
	// The indented lines beneath the key, exactly as written.
	readonly raw: string[];
}
export type FrontmatterValue = string | string[] | FrontmatterBlock;
export type Frontmatter = Record<string, FrontmatterValue>;

export function isFrontmatterBlock(v: FrontmatterValue | undefined): v is FrontmatterBlock {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray(v.raw);
}

// The flat projection of a value, for the many callers that only handle scalars:
// a scalar returns itself, a list its first element, an opaque block undefined.
export function scalarOf(v: FrontmatterValue | undefined): string | undefined {
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
	return undefined;
}

// The list projection: a list returns itself, a scalar a single-element list, an
// opaque block an empty list.
export function listOf(v: FrontmatterValue | undefined): string[] {
	if (Array.isArray(v)) return v;
	if (typeof v === 'string') return v === '' ? [] : [v];
	return [];
}

const FM_KEY_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
// A list item we CAN model: `- value` with no nested `key:` mapping inside it.
const SIMPLE_ITEM_RE = /^\s+-\s+(?![A-Za-z0-9_-]+:\s)/;

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

// Parse a leading `---` frontmatter block. Returns null frontmatter when the
// document has none. Tolerant: unparseable lines are skipped, not fatal —
// validate() reports on shape, readers shouldn't crash on it.
export function parseFrontmatter(md: string): { frontmatter: Frontmatter | null; body: string } {
	if (!md.startsWith('---\n') && md.trim() !== '---') {
		return { frontmatter: null, body: md };
	}
	const end = md.indexOf('\n---', 3);
	if (end < 0) return { frontmatter: null, body: md };
	const rawBlock = md.slice(4, end);
	// Body starts after the closing fence line (and one following newline).
	const afterFence = md.indexOf('\n', end + 1);
	const body = afterFence < 0 ? '' : md.slice(afterFence + 1).replace(/^\n/, '');

	const fm: Frontmatter = {};
	const lines = rawBlock.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(FM_KEY_RE);
		if (!m) continue;
		const [, key, rest] = m;
		if (rest.trim() === '' || rest.trim() === '|' || rest.trim() === '>') {
			// An indented run follows a bare `key:`. If every line of it is a simple
			// `- scalar` item we model it as a string list; anything else (mappings
			// under the key, `- key: value` items, block scalars) is nesting we don't
			// model, so the whole run is kept verbatim rather than mangled.
			const run: string[] = [];
			while (i + 1 < lines.length && /^\s/.test(lines[i + 1]) && lines[i + 1].trim() !== '') {
				run.push(lines[i + 1]);
				i++;
			}
			if (run.length === 0) {
				fm[key] = '';
			} else if (run.every((l) => SIMPLE_ITEM_RE.test(l))) {
				fm[key] = run.map((l) => stripQuotes(l.replace(/^\s+-\s/, '')));
			} else {
				// Includes the `|`/`>` block-scalar case, whose indicator we must keep.
				const indicator = rest.trim();
				fm[key] = indicator ? { indicator, raw: run } : { raw: run };
			}
		} else {
			// Strip trailing same-line comments only when clearly separated.
			const cleaned = rest.replace(/\s+#\s.*$/, '').trim();
			// Inline arrays (`sources: []`, `tags: [a, b]`) — legacy pages use them.
			if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
				const inner = cleaned.slice(1, -1).trim();
				fm[key] = inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s));
			} else {
				fm[key] = stripQuotes(cleaned);
			}
		}
	}
	return { frontmatter: fm, body };
}

function needsQuoting(v: string): boolean {
	return (
		v === '' ||
		/^[\s'"\-?:[\]{}#&*!|>%@`]/.test(v) ||
		v.includes(': ') ||
		v.endsWith(':') ||
		v.includes(' #') ||
		/\s$/.test(v)
	);
}

function scalar(v: string): string {
	const flat = v.replace(/\r?\n/g, ' ').trim();
	return needsQuoting(flat) ? `"${flat.replace(/"/g, '\\"')}"` : flat;
}

export function serializeFrontmatter(fm: Frontmatter): string {
	const lines: string[] = ['---'];
	for (const [key, value] of Object.entries(fm)) {
		if (isFrontmatterBlock(value)) {
			// Nesting we don't model — replay the original lines byte-for-byte.
			lines.push(value.indicator ? `${key}: ${value.indicator}` : `${key}:`);
			lines.push(...value.raw);
		} else if (Array.isArray(value)) {
			// Empty arrays inline — `key:` with no items would round-trip as ''.
			if (value.length === 0) {
				lines.push(`${key}: []`);
				continue;
			}
			lines.push(`${key}:`);
			for (const item of value) lines.push(`  - ${scalar(item)}`);
		} else {
			lines.push(`${key}: ${scalar(value)}`);
		}
	}
	lines.push('---');
	return lines.join('\n');
}

export function withFrontmatter(fm: Frontmatter, body: string): string {
	return `${serializeFrontmatter(fm)}\n\n${body.replace(/^\n+/, '')}`;
}

// ---------- page title (ONE resolver — see below) ----------
//
// A page can state its name three ways: `title:` frontmatter, a body `# H1`, and
// its filename. Only two were ever consulted, by two separate copies of the same
// fallback (brain-index.ts and librarian.ts), and the H1 — the name a reader
// actually sees — was ignored entirely. So a page could display as one thing,
// be listed as another, and be linkable by a third. Worse, every folder note
// without frontmatter was titled "index", because that is its filename.
//
// This is the single resolver. Order: explicit `title:` wins (an author said so),
// then the body's first H1 (what the page calls itself on screen), then the
// filename — or, for a folder note, the FOLDER's name, since "index" names nothing.
// Wikilinks resolve by title, so widening this also widens what `[[Foo]]` finds.

// Strip inline markup so a heading like `# **[[Acme]]**` yields "Acme".
function plainHeading(text: string): string {
	return text
		.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1') // [[wiki|alias]] → wiki
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](href) → text
		.replace(/[*_`~]/g, '')
		.replace(/\s*#+\s*$/, '') // closing ATX hashes
		.trim();
}

// The first level-1 heading in a body, ignoring fenced code (a `# comment` inside
// a shell block is not a title). Returns '' when there is none.
export function firstHeading(body: string): string {
	const plain = body.replace(/^```[\s\S]*?^```/gm, '');
	for (const line of plain.split('\n')) {
		const m = line.match(/^#\s+(.+?)\s*$/);
		if (m) {
			const t = plainHeading(m[1]);
			if (t) return t;
		}
	}
	return '';
}

export function pageTitle(path: string, content: string): string {
	const { frontmatter, body } = parseFrontmatter(content);
	const declared = frontmatter?.title;
	if (typeof declared === 'string' && declared.trim()) return declared.trim();

	const heading = firstHeading(frontmatter ? body : content);
	if (heading) return heading;

	const name = path.split('/').pop() ?? path;
	// A folder note IS its folder, so its filename ("index") is never its name.
	if (isFolderNoteName(name)) {
		const parent = path.slice(0, path.lastIndexOf('/'));
		const folder = parent.split('/').pop();
		if (folder) return folder.replace(/-/g, ' ');
	}
	return name.replace(/\.md$/, '').replace(/-/g, ' ');
}

// ---------- links ----------

export interface PageLink {
	kind: 'md' | 'wiki';
	// md: the raw href as written; wiki: the page title.
	target: string;
	// The full matched text, for rewrites.
	raw: string;
}

const MD_LINK_RE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const FENCE_RE = /^[ \t]*(```+|~~~+)/;
const INLINE_CODE_RE = /(`+)(?:(?!\1)[\s\S])*?\1/g;

// Blank out fenced blocks and code spans, keeping every other character (and every
// newline) where it was. Link syntax inside code is a code sample — `[[Name]]` on a
// conventions page teaching the syntax is not a link to a page called "Name", and
// reporting it as broken is noise no one can ever clear.
//
// Fences are scanned line by line rather than matched by one regex: an unterminated
// fence has to swallow the rest of the document, and expressing that as a regex
// alternation on `$` silently ends the block at the first line break under /m.
// Blank out fenced and inline code, preserving every character offset, so a
// caller can scan for links in the result and splice back into the original.
// Exported because the renderer needs the same answer: a `[[Name]]` inside a
// fence is a syntax example on a conventions page, not a link.
export function maskCode(md: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, ' ');
	let fence: string | null = null;
	const lines = md.split('\n').map((line) => {
		const m = line.match(FENCE_RE);
		if (fence !== null) {
			// A closing fence is the same character, at least as long as the opener.
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
			return blank(line);
		}
		if (m) {
			fence = m[1];
			return blank(line);
		}
		return line;
	});
	return lines.join('\n').replace(INLINE_CODE_RE, blank);
}

export function extractLinks(body: string): PageLink[] {
	const scannable = maskCode(body);
	const links: PageLink[] = [];
	for (const m of scannable.matchAll(MD_LINK_RE)) {
		const href = m[2];
		if (/^(https?:|mailto:|#)/i.test(href)) continue;
		links.push({ kind: 'md', target: href, raw: m[0] });
	}
	for (const m of scannable.matchAll(WIKI_LINK_RE)) {
		links.push({ kind: 'wiki', target: m[1].trim(), raw: m[0] });
	}
	return links;
}

// ---------- wikilink resolution ----------
//
// A [[wikilink]] is written from memory, so its text is whatever the author calls
// the page: its title, its filename, either one in a different case, hyphens where
// the other has spaces, sometimes a folder path or a #heading. One key covers all
// of those, and BOTH SIDES of every comparison go through it. That symmetry is the
// point: the bug this replaces built its lookup table from raw filenames and then
// queried it with slugified link text, so a page whose filename was not already
// slug-shaped ("2026-06-26 Weekly Sync.md") could never be found by name.

// The comparable form of one link target or page name. Empty when there is nothing
// left to match on (an anchor-only link, punctuation).
export function wikilinkKey(text: string): string {
	return text
		.split('/')
		.map((seg) => slugify(seg, ''))
		.filter(Boolean)
		.join('/');
}

// The name part of a raw wikilink target: no #heading or #^block anchor, no ./
// prefix, no .md extension.
export function wikilinkTargetName(rawTarget: string): string {
	return rawTarget.split('#')[0].trim().replace(/^\.\//, '').replace(/\.md$/i, '').trim();
}

export interface WikilinkIndex {
	byPath: Map<string, string>;
	byName: Map<string, string>;
	byTitle: Map<string, string>;
}

// Build the three lookup lanes, most specific first: path, filename, title. Pages
// are walked in path order and the FIRST claim on a key wins, so two pages sharing
// a name resolve the same way on every read (validate's ambiguousTitleSuggestions
// is what tells the author about the collision).
//
// The path lane holds every multi-segment SUFFIX of a page's path, not just the
// whole thing: a path-form link is written from wherever the author thinks the
// content root is, so [[Meetings/Weekly Sync]] has to reach
// wiki/Meetings/Weekly Sync.md without knowing about the wiki/ prefix.
export function buildWikilinkIndex(pages: { path: string; title: string }[]): WikilinkIndex {
	const byPath = new Map<string, string>();
	const byName = new Map<string, string>();
	const byTitle = new Map<string, string>();
	const claim = (map: Map<string, string>, key: string, path: string) => {
		if (key && !map.has(key)) map.set(key, path);
	};
	for (const p of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
		const noExt = p.path.replace(/\.md$/i, '');
		const segs = noExt.split('/');
		const file = segs[segs.length - 1];
		// A folder note IS its folder: [[Atlas]] and [[Projects/Atlas]] mean this page.
		// Its literal filename ("index") is a key every folder in the brain would
		// claim, so it never becomes one — but its literal path still resolves.
		const isNote = isFolderNoteName(`${file}.md`);
		if (isNote) claim(byPath, wikilinkKey(noExt), p.path);
		const own = isNote ? segs.slice(0, -1) : segs;
		for (let i = 0; i < own.length - 1; i++)
			claim(byPath, wikilinkKey(own.slice(i).join('/')), p.path);
		if (own.length) claim(byName, wikilinkKey(own[own.length - 1]), p.path);
		claim(byTitle, wikilinkKey(p.title), p.path);
	}
	return { byPath, byName, byTitle };
}

// The page a [[wikilink]] points at, or undefined when nothing matches.
export function resolveWikilink(index: WikilinkIndex, rawTarget: string): string | undefined {
	const key = wikilinkKey(wikilinkTargetName(rawTarget));
	if (!key) return undefined; // [[#Section]] — an anchor on this page, not a link out
	return index.byPath.get(key) ?? index.byName.get(key) ?? index.byTitle.get(key);
}

// Resolve a relative href written in `fromPath` to a repo-root path.
// Strips #fragments. A leading "/" means repo root.
export function resolveRelative(fromPath: string, href: string): string {
	const clean = href.split('#')[0].split('?')[0];
	if (clean === '') return fromPath;
	const parts = clean.startsWith('/')
		? clean.slice(1).split('/')
		: [...fromPath.split('/').slice(0, -1), ...clean.split('/')];
	const out: string[] = [];
	for (const part of parts) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return out.join('/');
}

// Relative href from one repo path to another (for writing links).
export function relativeHref(fromPath: string, toPath: string): string {
	const from = fromPath.split('/').slice(0, -1);
	const to = toPath.split('/');
	let common = 0;
	while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
	const ups = from.length - common;
	return [...Array(ups).fill('..'), ...to.slice(common)].join('/');
}

// Rewrite every markdown link in `body` (written in page `fromPath`) that
// resolves to `oldTarget` so it points at `newTarget` instead. Returns the
// new body and how many links changed.
export function rewriteMdLinks(
	body: string,
	fromPath: string,
	oldTarget: string,
	newTarget: string
): { body: string; changed: number } {
	let changed = 0;
	const out = body.replace(MD_LINK_RE, (raw, label: string, href: string) => {
		if (/^(https?:|mailto:|#)/i.test(href)) return raw;
		if (resolveRelative(fromPath, href) !== oldTarget) return raw;
		changed++;
		const fragment = href.includes('#') ? '#' + href.split('#').slice(1).join('#') : '';
		return raw.replace(href, relativeHref(fromPath, newTarget) + fragment);
	});
	return { body: out, changed };
}

// Rewrite a moved page's own outbound relative links so they still resolve
// from its new location (targets are unchanged; only the relative form is).
export function rebaseMdLinks(body: string, oldPath: string, newPath: string): string {
	return body.replace(MD_LINK_RE, (raw, _label: string, href: string) => {
		if (/^(https?:|mailto:|#)/i.test(href)) return raw;
		const target = resolveRelative(oldPath, href);
		const fragment = href.includes('#') ? '#' + href.split('#').slice(1).join('#') : '';
		return raw.replace(href, relativeHref(newPath, target) + fragment);
	});
}

// Repoint every wikilink that referred to `oldTarget` at `newTarget`, whatever
// spelling it was written in. Matching goes through wikilinkKey, so it covers the
// same forms resolution does — a rename that only repointed the exact old title
// would leave the filename-spelled links behind, pointing at nothing.
// #anchors and |aliases are preserved; the replacement is a function so a `$&` in
// the new name stays literal (see docs/references.md).
export function rewriteWikiLinks(
	body: string,
	oldTarget: string,
	newTarget: string
): { body: string; changed: number } {
	const oldKey = wikilinkKey(wikilinkTargetName(oldTarget));
	if (!oldKey) return { body, changed: 0 };
	const replacement = newTarget.trim();
	let changed = 0;
	const out = body.replace(WIKI_LINK_RE, (raw, target: string) => {
		const [name, ...anchor] = target.split('#');
		if (wikilinkKey(wikilinkTargetName(name)) !== oldKey) return raw;
		changed++;
		return raw.replace(target, () => [replacement, ...anchor].join('#'));
	});
	return { body: out, changed };
}

// ---------- wiki/log.md editing ----------

// Prepend a fresh `## YYYY-MM-DD` block above the first existing date heading.
// Doesn't try to merge same-day entries — keeps the logic obvious.
export function insertLogEntry(currentLog: string, dateIso: string, bullet: string): string {
	const block = `## ${dateIso}\n\n- ${bullet}\n\n`;
	const firstHeadingIdx = currentLog.search(/\n## /);
	if (firstHeadingIdx > 0) {
		return currentLog.slice(0, firstHeadingIdx + 1) + block + currentLog.slice(firstHeadingIdx + 1);
	}
	// No prior date headings — insert before the HTML comment placeholder, or
	// just append before any trailing newlines.
	const commentIdx = currentLog.indexOf('<!--');
	if (commentIdx >= 0) {
		return currentLog.slice(0, commentIdx) + block + currentLog.slice(commentIdx);
	}
	return currentLog.replace(/\s*$/, '\n\n') + block;
}

// ---------- base64 (Worker-safe, UTF-8 correct) ----------

// `btoa`/`atob` only handle single-byte strings; markdown contains Unicode.
export function utf8ToBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
	const binary = atob(b64.replace(/\n/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}
