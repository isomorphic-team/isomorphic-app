// Librarian tool suite — the write/maintenance surface of the brain MCP server.
//
// Two rules govern everything here:
//
// 1. THE UNIT OF WORK IS A BUNDLE. A page write is the page + a changelog entry,
//    landed as ONE atomic commit via commitOrPR(). The log can never drift from
//    content because no tool can forget it. (Link repointing on move/rename adds
//    the affected pages to the same bundle.)
//
// 2. THE USER NEVER SEES GIT. Tool responses speak in saves, pages, and links —
//    never SHAs, branches, or commits. Commit messages are auto-generated and
//    intent-rich, but they're backend bookkeeping.
//
// Write policy comes entirely from the brain's role map (.isomorphic.json, via
// brain-config.ts): folders are arbitrary and free-form, "source" paths are
// immutable, the "log" path is tool-maintained. There are NO fixed entity types
// and NO auto-generated index — those were removed 2026-07. Frontmatter is
// optional; when present it's preserved and merged.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import type { Octokit } from 'octokit';
import {
	type Frontmatter,
	slugify,
	todayIso,
	parseFrontmatter,
	pageTitle,
	withFrontmatter,
	rewriteMdLinks,
	rewriteWikiLinks,
	rebaseMdLinks,
	insertLogEntry,
	wikilinkKey,
	wikilinkTargetName
} from '../lib/wiki.ts';
import {
	type RepoRef,
	type Head,
	type TreeEntry,
	type PageContent,
	type WriteOutcome,
	type CommitAuthor,
	type BrainStore,
	MAX_SCAN_PAGES
} from '../lib/brain-repo.ts';
import {
	type BrainConfig,
	isAssetPath,
	isContentPath,
	isHiddenName,
	isSourcePath,
	isToolMaintained,
	logPathOf
} from '../lib/brain-config.ts';
import {
	type PageFields,
	type BrokenLink,
	ensureFresh,
	inboundFileRefs,
	loadResolvedGraph,
	backlinksTo,
	searchIndex,
	loadAllFields,
	loadPageContents
} from '../lib/brain-index.ts';
import { tryRenderViews, type ViewDeps } from '../lib/views.ts';
import { isToolPagePath, parseToolDef } from '../lib/custom-tools.ts';
import { isFolderNoteName } from '../lib/view-directives.ts';
import { applyPageEdits } from '../lib/page-patch.ts';
import { parseLedger } from '../lib/brain-import.ts';
import type { TenantOpts, Role } from '../lib/orgs.ts';

// Shared optional `brain` arg — every tool takes it so the model can one-shot a
// different brain than the connection's active one (see tenantContext in worker.ts).
const brainArg = z
	.string()
	.optional()
	.describe('Which brain to target (name/handle). Defaults to the active brain.');

export interface BrainContext {
	// Where this brain's content lives, and the only way the content tools reach it.
	// See src/lib/brain-repo.ts.
	store: BrainStore;
	// The raw GitHub client, for operations that are GitHub as a platform rather than
	// a brain as storage: creating a repository, listing an installation's
	// repositories, checking a repo exists before connecting it. Optional because a
	// non-GitHub backend has no such client; all of those operations belong to the org
	// model, which such a deployment does not register (`hasOrgModel` in worker.ts).
	// Anything a brain's content needs goes on `store`.
	octokit?: Octokit;
	repoArgs: RepoRef;
	// The caller's role ON THIS BRAIN (viewer < editor < admin), resolved by
	// effectiveBrainRole from an explicit share, the brain's org visibility, or the
	// org-admin floor. Read tools ignore it; write/configure/share tools gate on it.
	// The legacy github/static single-tenant paths report 'owner'.
	role: Role;
	// The caller's role in this brain's ORG (viewer < editor < admin < owner).
	// Separate from `role` on purpose: org membership governs managing people and
	// adding/removing brains, brain access governs the content. The
	// member-management tools authorize roster changes on THIS one: gating them on
	// `role` would let someone who was merely shared a brain as admin edit the org
	// roster. Legacy single-tenant paths report 'owner'.
	orgRole: Role;
	// The resolved org's id + the acting user's id, present only on the product-native
	// (authjs) path. The member-management tools need these to scope roster queries and
	// enforce self-guards; they're undefined on the legacy single-tenant paths, which
	// have no org table row (those tools error with a clear "org accounts only" message).
	orgId?: string;
	actorUserId?: string;
	// The brain's content-shape config — which paths are editable content,
	// immutable source, or the tool-maintained changelog. Read from .isomorphic.json
	// (or defaults). Every write-policy decision below reads from it.
	config: BrainConfig;
	// The acting human, for commit attribution. Undefined on the static legacy
	// path (no signed-in user) — writes stay App-authored there.
	author?: CommitAuthor;
	// Platform D1 + this brain's index key ("owner/repo"), for the content index
	// that backs the read tools (src/lib/brain-index.ts).
	db: D1Database;
	brainId: string;
	// Which brain this call resolved to (id + display label), so app tools can echo the
	// active brain to the nav switcher.
	activeBrain: { id: string; label: string };
}

// Filename stem, which is one of the names a [[Wiki Link]] can call a page by.
function slugOf(path: string): string {
	return path.split('/').pop()!.replace(/\.md$/, '');
}

// Normalize a folder path for the folder tools: strip surrounding slashes so
// prefix checks (`${folder}/`) are unambiguous. "" means "unspecified".
function normFolderPath(p: string): string {
	return p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

export function ok(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

export function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

// Shape a write response to match how the change actually landed:
//   - direct commit               → the normal "done" message
//   - PR, auto-merged immediately → "done" (it's already live on the branch)
//   - PR, auto-merge armed        → "proposed", will merge itself once checks pass
//   - PR, no auto-merge           → "proposed", needs a human to merge
export function landed(outcome: WriteOutcome, done: string, proposed: string) {
	if (!outcome.prUrl) return ok(done);
	if (outcome.merged) return ok(`${done} (via PR ${outcome.prUrl})`);
	const tail = outcome.autoMergeEnabled
		? `It will merge automatically once checks pass: ${outcome.prUrl}`
		: `Review and merge it here: ${outcome.prUrl}`;
	return ok(`${proposed} ${tail}`);
}

function truncationNote(truncated: boolean): string {
	return truncated
		? `\n\nNote: this brain has more than ${MAX_SCAN_PAGES} pages; only the first ${MAX_SCAN_PAGES} were scanned.`
		: '';
}

// Does this path touch the tools/ area (a file or a folder under tools/)? Files use
// the precise isToolPagePath; folder paths (no .md) match any `tools` segment.
function touchesToolsArea(path: string): boolean {
	return path.endsWith('.md') ? isToolPagePath(path) : path.split('/').includes('tools');
}

// A write that adds, renames, or removes a tool page (under tools/) changes the set
// of registered custom tools. The stateless MCP transport can't push
// tools/list_changed, so the host only sees the new roster after it re-lists — nudge
// the user to reconnect. (Editing an existing tool's BODY takes effect on the next
// call with no reconnect; only add/rename/remove alters the list, i.e.
// write_page-create / move_page / delete_page.) No-op unless a tool path is involved.
function toolRosterNote(...paths: string[]): string {
	return paths.some(touchesToolsArea)
		? '\n\nHeads up: this changes your custom tools. Reconnect the Isomorphic connector in Claude (Settings → Connectors) so the new tool list is picked up.'
		: '';
}

// Fetch only the pages that link to any of `targetPaths`, for repointing links when
// those pages move or are renamed. Discovers the linkers via the content index
// (backlinksTo), then reads just those pages' content at `head` (consistent with the
// commit base). Bounded by inbound-link count rather than brain size, and uncapped:
// the index sees every page, so a linker beyond the old MAX_SCAN_PAGES ceiling no longer
// gets silently missed (which a whole-brain scan capped at MAX_SCAN_PAGES would).
// `exclude` drops linkers that are themselves in the moved set (they're handled as
// moved pages, not outside linkers).
async function fetchInboundLinkersForPaths(
	ctx: BrainContext,
	head: Head,
	targetPaths: string[],
	exclude: Set<string>
): Promise<{ pages: PageContent[]; truncated: boolean }> {
	const { store, repoArgs, config, db, brainId } = ctx;
	const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
	const resolved = await loadResolvedGraph(db, brainId, config);
	const linkerPaths = new Set<string>();
	for (const t of targetPaths) {
		for (const r of backlinksTo(resolved, t)) {
			if (!exclude.has(r.path)) linkerPaths.add(r.path);
		}
	}
	if (linkerPaths.size === 0) return { pages: [], truncated };
	const entries = (await store.listTree(repoArgs, head)).filter((e) => linkerPaths.has(e.path));
	const { pages } = await store.fetchPages(repoArgs, entries);
	return { pages, truncated };
}

// Single-target convenience wrapper (move_page / edit_page retitle).
async function fetchInboundLinkers(
	ctx: BrainContext,
	head: Head,
	targetPath: string
): Promise<{ pages: PageContent[]; truncated: boolean }> {
	return fetchInboundLinkersForPaths(ctx, head, [targetPath], new Set([targetPath]));
}

// Folder-note advisory for validate. A folder's overview page has to be named index.md
// (FOLDER_NOTE_NAMES) for the app to treat it AS the folder: click-to-open, the row
// collapsed as a redundant sibling, `kind: folders` linking through it. Agents and humans
// reach for "overview.md" or "<folder>.md" instead, which leaves the folder note-less and
// the page a loose sibling. Pure over the index's page list; flags only the unambiguous
// cases (a note-less folder holding a page that is plainly its overview, by filename or by
// title matching the folder name), so "folder has no note at all" stays unreported noise.
const OVERVIEW_BASENAMES = new Set(['overview', 'about', 'home', 'summary', 'start-here']);

export function folderNoteSuggestions(pages: { path: string; title: string }[]): string[] {
	const byFolder = new Map<string, { path: string; title: string }[]>();
	for (const p of pages) {
		const cut = p.path.lastIndexOf('/');
		if (cut < 0) continue; // a repo-root page has no folder to be the note for
		const folder = p.path.slice(0, cut);
		const siblings = byFolder.get(folder);
		if (siblings) siblings.push(p);
		else byFolder.set(folder, [p]);
	}
	const out: string[] = [];
	for (const [folder, siblings] of byFolder) {
		if (siblings.length < 2) continue; // a lone page isn't a folder wanting a note
		const nameOf = (p: { path: string }) => p.path.slice(folder.length + 1);
		if (siblings.some((p) => isFolderNoteName(nameOf(p)))) continue;
		const folderSlug = slugify(folder.slice(folder.lastIndexOf('/') + 1));
		const candidate = siblings.find((p) => {
			const base = nameOf(p).replace(/\.md$/, '');
			return (
				OVERVIEW_BASENAMES.has(base.toLowerCase()) ||
				slugify(base) === folderSlug ||
				slugify(p.title ?? '') === folderSlug
			);
		});
		if (!candidate) continue;
		out.push(
			`- ${candidate.path} looks like the overview for "${folder}/". Move_page it to ${folder}/index.md so it becomes the folder note.`
		);
	}
	return out.sort();
}

// ---------- OKF structure advisories (validate) ----------
//
// Google's Open Knowledge Format (OKF v0.2, GoogleCloudPlatform/knowledge-catalog)
// is the interchange shape these brains aim at. Two of its rules bear on structure:
// every CONCEPT is its own markdown file carrying a `type:` in frontmatter (the
// spec's one required field), and `index.md` is a RESERVED name for a directory
// listing — never a concept document. Both are soft in the spec (consumers "SHOULD
// treat all other constraints as soft guidance"), so these are advisories, never
// failures, and they never block a save.
//
// The failure mode they exist to catch is not ignorance of the rules, it is
// INCONSISTENCY: a brain that correctly gives every system, vendor, and person its
// own file, and then writes twelve events as bullet sections inside one index.md.
// Concepts inlined that way have no path, so nothing can link to them, no `type`
// can classify them, and no view or index query can see them at all.

// Headings that are page STRUCTURE rather than concepts. A folder note legitimately
// carries these with prose underneath, so they never count toward the tally.
const STRUCTURAL_HEADINGS = new Set([
	'overview',
	'background',
	'context',
	'summary',
	'purpose',
	'scope',
	'notes',
	'about',
	'how it works',
	'how to use',
	'usage',
	'getting started',
	'start here',
	'contents',
	'approach',
	'process',
	'risks',
	'open questions',
	'next steps',
	'status',
	'glossary',
	'faq',
	'references',
	'see also',
	'changelog',
	'history',
	'contributing'
]);

// A folder note needs this many prose-only sections before we say anything — two or
// three narrative sections is just a well-written overview, not an inlined roster.
const MIN_INLINED_SECTIONS = 4;
const MIN_SECTION_PROSE = 60; // chars of text before a section is "substantive"

// Concepts are named things, so their headings are short noun phrases. A heading
// that asks a question or opens with a verb is narrative prose ("Why this matters",
// "How we decided"), and a long one is a sentence — neither is an inlined entity.
const NARRATIVE_HEADING_RE = /^(why|how|what|when|where|who|should|can|do|does|is|are|if)\b/i;
const MAX_CONCEPT_HEADING_WORDS = 6;

// The headings in ONE folder note that look like concepts with no file: enough prose
// to be a page, no link out to one, and no existing page already carrying the name.
// Pure over the note's own text.
function inlinedSections(content: string, known: Set<string>): string[] {
	const { body } = parseFrontmatter(content);
	// Drop fenced blocks (okf-view directives, their snapshots, code) first — a
	// rendered view's headings are generated, not authored, and aren't inlining.
	const plain = body.replace(/^```[\s\S]*?^```/gm, '');
	const sections: { level: number; heading: string; text: string[] }[] = [];
	for (const line of plain.split('\n')) {
		const m = line.match(/^(#{2,4})\s+(.+?)\s*$/);
		if (m) sections.push({ level: m[1].length, heading: m[2], text: [] });
		else if (sections.length) sections[sections.length - 1].text.push(line);
	}
	// Only siblings at a single heading level count; a mixed outline is prose.
	const byLevel = new Map<number, string[]>();
	for (const s of sections) {
		const heading = s.heading.replace(/[*_`]/g, '').trim();
		if (STRUCTURAL_HEADINGS.has(heading.toLowerCase())) continue;
		if (heading.endsWith('?') || NARRATIVE_HEADING_RE.test(heading)) continue;
		if (heading.split(/\s+/).length > MAX_CONCEPT_HEADING_WORDS) continue;
		if (known.has(wikilinkKey(heading))) continue; // a page by this name already exists
		const text = s.text.join('\n');
		if (/\]\(|\[\[/.test(text)) continue; // links out — a listing entry, working as intended
		if (text.replace(/\s+/g, ' ').trim().length < MIN_SECTION_PROSE) continue;
		byLevel.set(s.level, [...(byLevel.get(s.level) ?? []), heading]);
	}
	let best: string[] = [];
	for (const headings of byLevel.values()) if (headings.length > best.length) best = headings;
	return best;
}

export function inlinedConceptSuggestions(
	notes: { path: string; content: string }[],
	pages: { path: string; title: string }[]
): string[] {
	// Every name the brain already has a page for, so a section that merely restates
	// an existing page isn't mistaken for a homeless concept. Both sides go through
	// wikilinkKey for the reason resolution does: a filename kept raw here never
	// matches a heading, so every Title Case page read as homeless.
	const known = new Set<string>();
	for (const p of pages) {
		known.add(wikilinkKey(slugOf(p.path)));
		if (p.title) known.add(wikilinkKey(p.title));
	}
	const out: string[] = [];
	for (const note of notes) {
		const suspects = inlinedSections(note.content, known);
		if (suspects.length < MIN_INLINED_SECTIONS) continue;
		const shown = suspects.slice(0, 3).join('", "');
		const more = suspects.length > 3 ? ', …' : '';
		out.push(
			`- ${note.path} holds ${suspects.length} sections that read like pages of their own ("${shown}"${more}). A folder note is a LISTING, not a container: if other pages should be able to link to these, give each its own file and leave a link (or an okf-view) here.`
		);
	}
	return out.sort();
}

// Pages with no `type:`. Reported only as an INCONSISTENCY (some pages typed, others
// not) or as a single soft note when the brain has never adopted the convention —
// listing every page of an untyped brain would be pure noise.
export function typeFieldSuggestions(
	conceptPages: { path: string }[],
	fieldsByPath: Map<string, PageFields>
): string[] {
	if (conceptPages.length === 0) return [];
	const missing = conceptPages.filter((p) => {
		const v = fieldsByPath.get(p.path)?.get('type');
		return !v || !v.some((s) => s.trim() !== '');
	});
	if (missing.length === 0) return [];
	if (missing.length === conceptPages.length) {
		return [
			'- No page declares a `type:`. That is OKF\'s one required field — a free-form string ("Vendor", "Event Series", "Meeting Note"), NOT a fixed taxonomy. It makes the brain readable by any OKF consumer, and asking "what type is this?" is the question that catches a concept being written as a section inside another page instead of getting its own file.'
		];
	}
	const shown = missing.slice(0, 8).map((p) => `  - ${p.path}`);
	const more = missing.length > 8 ? `\n  …and ${missing.length - 8} more.` : '';
	return [
		`- ${missing.length} of ${conceptPages.length} pages have no \`type:\` while the rest do, so the brain is half-typed:\n${shown.join('\n')}${more}`
	];
}

// Pages a `[[wikilink]]` cannot tell apart. Resolution matches on path, then
// filename, then title (buildWikilinkIndex), and each lane keeps the first claim,
// so two pages sharing a title — or sharing a filename in different folders — mean
// every `[[That Name]]` lands on one of them and the rest are unreachable by name.
// Pure over the index's page list.
export function ambiguousTitleSuggestions(pages: { path: string; title: string }[]): string[] {
	const group = (of: (p: { path: string; title: string }) => string) => {
		const by = new Map<string, { label: string; paths: string[] }>();
		for (const p of pages) {
			const label = of(p);
			const key = wikilinkKey(label);
			if (!key) continue;
			const entry = by.get(key) ?? { label, paths: [] };
			entry.paths.push(p.path);
			by.set(key, entry);
		}
		return [...by.entries()].filter(([, e]) => e.paths.length > 1);
	};
	const nameOf = (p: { path: string }) => {
		const file = p.path.slice(p.path.lastIndexOf('/') + 1);
		if (!isFolderNoteName(file)) return file.replace(/\.md$/, '');
		const folder = p.path.slice(0, p.path.lastIndexOf('/'));
		return folder.slice(folder.lastIndexOf('/') + 1);
	};
	const seen = new Set<string>();
	const clashes: { label: string; paths: string[] }[] = [];
	for (const [key, entry] of [...group((p) => p.title), ...group(nameOf)].sort(([a], [b]) =>
		a.localeCompare(b)
	)) {
		if (seen.has(key)) continue;
		seen.add(key);
		clashes.push(entry);
	}
	return clashes
		.slice(0, 5)
		.map(
			({ label, paths }) =>
				`- ${paths.length} pages answer to the name "${label}", so a [[${label}]] wikilink can only reach one of them: ${paths.sort().join(', ')}. Give them distinct titles, or link these by path.`
		);
}

// ---------- the broken-link report ----------

// Everything past punctuation and separators, for "did you mean" only. Two pages
// whose loose forms match are NOT the same page — this is a suggestion, never a
// resolution rule.
const looseKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

// How many lines one section of the report may print before it summarizes. A
// report long enough to scroll past is a report nobody reads, which is how the
// genuine problems ended up buried under the noise this exists to prevent.
const MAX_REPORT_LINES = 40;

// Format the broken links for validate, SPLIT BY KIND, because the two mean
// different things to whoever has to fix them: a markdown link names a file that
// is not there (always actionable, and the path says where), while a wikilink is
// a name that matched no page (often a typo or a rename, sometimes a page that was
// never written). Wikilinks are grouped by target so one placeholder repeated
// across thirty pages costs one line, and a near-miss names the page it probably
// meant — which is what makes "reported broken but the page exists" diagnosable in
// one run instead of by hand.
export function brokenLinkReport(
	broken: BrokenLink[],
	pages: { path: string; title: string }[]
): string[] {
	const sections: string[] = [];

	const md = broken
		.filter((b) => b.kind === 'md')
		.sort((a, b) => a.source.localeCompare(b.source) || a.rawTarget.localeCompare(b.rawTarget));
	if (md.length) {
		const lines = md
			.slice(0, MAX_REPORT_LINES)
			.map((b) => `- ${b.source}: "${b.rawTarget}" — no page at ${b.target}.`);
		const more = md.length > MAX_REPORT_LINES ? `\n…and ${md.length - MAX_REPORT_LINES} more.` : '';
		sections.push(
			`${md.length} markdown link(s) point at a file that isn't there:\n${lines.join('\n')}${more}`
		);
	}

	const wiki = broken.filter((b) => b.kind === 'wiki');
	if (wiki.length) {
		const byTarget = new Map<string, { target: string; sources: string[] }>();
		for (const b of wiki) {
			const entry = byTarget.get(b.rawTarget) ?? { target: b.rawTarget, sources: [] };
			if (!entry.sources.includes(b.source)) entry.sources.push(b.source);
			byTarget.set(b.rawTarget, entry);
		}
		const candidates = pages.map((p) => ({
			path: p.path,
			title: p.title,
			loose: looseKey(p.title),
			looseName: looseKey(p.path.slice(p.path.lastIndexOf('/') + 1).replace(/\.md$/, ''))
		}));
		// A page whose name contains the link's, or the other way round — the shape a
		// typo, a truncation, or a since-renamed page leaves behind. Nothing else is
		// close enough to be worth naming.
		const nearMiss = (target: string) => {
			const key = looseKey(wikilinkTargetName(target));
			if (key.length < 4) return undefined;
			return candidates.find(
				(c) =>
					(c.loose.length >= 4 && (c.loose.includes(key) || key.includes(c.loose))) ||
					(c.looseName.length >= 4 && (c.looseName.includes(key) || key.includes(c.looseName)))
			);
		};
		const entries = [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target));
		const lines = entries.slice(0, MAX_REPORT_LINES).map(({ target, sources }) => {
			const where = sources.slice(0, 5).join(', ');
			const rest = sources.length > 5 ? ` and ${sources.length - 5} more page(s)` : '';
			const hit = nearMiss(target);
			const hint = hit ? ` — did you mean [[${hit.title}]] (${hit.path})?` : '';
			return `- [[${target}]] in ${where}${rest}${hint}`;
		});
		const more =
			entries.length > MAX_REPORT_LINES
				? `\n…and ${entries.length - MAX_REPORT_LINES} more target(s).`
				: '';
		sections.push(
			`${wiki.length} wikilink(s) match no page (${entries.length} distinct target(s)):\n${lines.join('\n')}${more}`
		);
	}
	return sections;
}

// How much of the brain's link graph is written in a syntax that only resolves
// HERE. `[[wikilinks]]` are an Isomorphic/Obsidian convenience, not part of OKF —
// an outside reader of the bundle follows plain markdown links and sees a
// wikilink as literal text. Informational, not a defect: a brain may deliberately
// be Obsidian-first. One line, never a list.
export function wikilinkPortabilityNote(edges: { kind: 'md' | 'wiki'; cnt: number }[]): string[] {
	const wiki = edges.filter((e) => e.kind === 'wiki').reduce((n, e) => n + e.cnt, 0);
	if (wiki === 0) return [];
	const total = edges.reduce((n, e) => n + e.cnt, 0);
	return [
		`- ${wiki} of ${total} resolved links are [[wikilinks]]. They resolve here, but they are not Open Knowledge Format links — an outside reader of this brain follows plain markdown links and sees these as literal text.`
	];
}

// Count inbound references to a set of target pages, from the content index (no blob
// fetch, just the per-linker md+wiki tallies backlinksTo already resolves). Used for the
// "still referenced" heads-up on delete_page (page or folder path). Excludes tool-maintained
// pages (e.g. the changelog) and any linker that is itself one of the targets.
// `truncated` reflects an index build that hit MAX_SCAN_PAGES.
async function inboundRefs(
	ctx: BrainContext,
	targets: string[]
): Promise<{ refs: { path: string; count: number }[]; truncated: boolean }> {
	const { store, repoArgs, config, db, brainId } = ctx;
	const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
	const resolved = await loadResolvedGraph(db, brainId, config);
	const targetSet = new Set(targets);
	const counts = new Map<string, number>();
	for (const t of targets) {
		for (const r of backlinksTo(resolved, t)) {
			if (targetSet.has(r.path) || isToolMaintained(r.path, config)) continue;
			counts.set(r.path, (counts.get(r.path) ?? 0) + r.count);
		}
	}
	const refs = [...counts.entries()].map(([path, count]) => ({ path, count }));
	return { refs, truncated };
}

// Merge model-supplied frontmatter (if the content began with a `---` block)
// under our managed keys, returning the body without its old frontmatter.
function splitProvidedContent(content: string): { fm: Frontmatter; body: string } {
	const { frontmatter, body } = parseFrontmatter(content);
	return { fm: frontmatter ?? {}, body: frontmatter ? body : content };
}

// Derived views: regenerate the cached snapshot rendering beneath each okf-view
// fence before the content lands in the file (see src/lib/views.ts). No-op for
// pages without views; falls back to the unrefreshed content on any failure.
async function withFreshSnapshots(ctx: BrainContext, path: string, content: string) {
	const deps: ViewDeps = {
		db: ctx.db,
		store: ctx.store,
		repoArgs: ctx.repoArgs,
		brainId: ctx.brainId,
		config: ctx.config
	};
	const views = await tryRenderViews(content, path, deps);
	return views?.snapshotted ?? content;
}

// write_page's two internal paths. write_page validates the path and decides which to
// run from whether the page already exists; each path builds one atomic commit bundle.

// Create a brand-new page: generate fresh frontmatter (status: draft) and log it. The
// caller guarantees `target` is free, ends in .md, and is inside the editable area.
async function createPageWrite(
	ctx: BrainContext,
	head: Head,
	args: {
		target: string;
		content?: string;
		title?: string;
		type?: string;
		description?: string;
		sources?: string[];
	}
) {
	const { store, repoArgs, config, author } = ctx;
	const { target, content, title, type, description, sources } = args;
	// Fall back through the SAME chain the rest of the system resolves titles by
	// (pageTitle): a `title:` in the caller's own content, then the body's `# H1`,
	// then the filename — or the folder's name for a folder note. Deriving straight
	// from the filename here would have written a title that outranks the heading the
	// author just wrote, permanently, and would have named every folder note "index".
	const finalTitle = title?.trim() || pageTitle(target, content ?? '');
	const provided = splitProvidedContent(content ?? '');
	// `type` is OKF's one required field. Prefer the explicit arg, fall back to a type
	// the caller wrote into the content's own frontmatter, and leave it off entirely
	// when neither is given — we record what the author chose, never invent one.
	const finalType =
		type?.trim() || (typeof provided.fm.type === 'string' ? provided.fm.type.trim() : '');
	const today = todayIso();
	// Keys this call actually sets. `type` leads, as in the OKF spec's own examples.
	const managed: Frontmatter = {
		...(finalType ? { type: finalType } : {}),
		title: finalTitle,
		...(description ? { description } : {}),
		status: 'draft',
		updated: today,
		...(sources?.length ? { sources } : {})
	};
	const fm: Frontmatter = {
		...managed,
		// Everything else the caller supplied is kept — including keys that merely
		// SHARE a managed name while this call sets no value for them. Filtering on the
		// managed NAME list instead dropped a caller's OKF `sources:` block whenever the
		// `sources` argument was absent, which is exactly how provenance went missing.
		...Object.fromEntries(Object.entries(provided.fm).filter(([k]) => !(k in managed)))
	};
	const newContent = await withFreshSnapshots(ctx, target, withFrontmatter(fm, provided.body));
	const writes = [{ path: target, content: newContent }];
	const log = await store.readFile(repoArgs, logPathOf(config));
	if (log) {
		writes.push({
			path: logPathOf(config),
			content: insertLogEntry(log.content, today, `Created "${finalTitle}" (\`${target}\`).`)
		});
	}
	const outcome = await store.commitOrPR(repoArgs, {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod,
		message: `Add ${finalTitle} (${target})\n\nNew draft page${description ? `: ${description}` : ''}. Logged in the same change.`,
		writes,
		head,
		branchPrefix: 'isomorphic/create',
		prTitle: `Add ${finalTitle}`,
		prBody: `Create \`${target}\`${description ? ` — ${description}` : ''}. Proposed via the Isomorphic brain tools.`
	});
	return landed(
		outcome,
		`Created "${finalTitle}" as a draft at ${target}. The change was logged.${toolRosterNote(target)}`,
		`Proposed a new page "${finalTitle}" at ${target}.${toolRosterNote(target)}`
	);
}

// Update an existing page: preserve+merge frontmatter, bump `updated`, repoint inbound
// wikilinks on a retitle, and (for the in-client editor) honor an optional sha guard and
// return a fresh sha. `existing` is the current blob; the caller has checked the sha.
async function updatePageWrite(
	ctx: BrainContext,
	head: Head,
	existing: { content: string; sha: string },
	args: {
		path: string;
		content?: string;
		rawBody?: string;
		changeSummary?: string;
		title?: string;
		type?: string;
		description?: string;
		status?: 'draft' | 'published';
		sha?: string;
	}
) {
	const { store, repoArgs, config, author } = ctx;
	const { path, content, rawBody, changeSummary, title, type, description, status, sha } = args;
	const old = parseFrontmatter(existing.content);
	// Three ways to arrive here, in precedence order: `rawBody` is an
	// already-patched body (append/edits — frontmatter was split off by the
	// caller, so it must NOT be re-parsed); `content` is a caller-supplied
	// replacement that may carry its own frontmatter; omitting both means
	// "metadata only", so keep the existing body verbatim.
	const provided =
		rawBody !== undefined
			? { fm: {} as Frontmatter, body: rawBody }
			: content !== undefined
				? splitProvidedContent(content)
				: { fm: {} as Frontmatter, body: old.body };
	const today = todayIso();

	// Preserve+merge frontmatter when the page has it (or the caller sets a managed
	// field); otherwise save the body as-is. No structure assumptions.
	const oldTitle = typeof old.frontmatter?.title === 'string' ? old.frontmatter.title : null;
	const newTitle = title ?? oldTitle ?? undefined;
	const manageFm =
		old.frontmatter !== null ||
		title !== undefined ||
		type !== undefined ||
		description !== undefined ||
		status !== undefined;

	let newContent: string;
	if (manageFm) {
		const fm: Frontmatter = {
			...(old.frontmatter ?? {}),
			...provided.fm,
			...(newTitle ? { title: newTitle } : {}),
			...(type?.trim() ? { type: type.trim() } : {}),
			...(description ? { description } : {}),
			...(status ? { status } : {}),
			updated: today
		};
		newContent = withFrontmatter(fm, provided.body);
	} else {
		newContent = provided.body;
	}
	newContent = await withFreshSnapshots(ctx, path, newContent);

	const writes = [{ path, content: newContent }];
	const notes: string[] = [];

	// Say what the write did to the body. A patch reports its own summary; a
	// full-content write reports the SIZE of what it replaced, so a clobber of
	// text the caller never read is visible in the transcript instead of silent.
	if (changeSummary) {
		notes.push(changeSummary);
	} else if (content !== undefined && provided.body.trim() !== old.body.trim()) {
		const count = (s: string) => (s.trim() ? s.trim().split('\n').length : 0);
		notes.push(
			`replaced the whole body (was ${count(old.body)} lines, now ${count(provided.body)})`
		);
	}

	// Retitling breaks [[Old Title]] wikilinks — repoint them in the same save. Only the
	// pages that actually link to this one are fetched (via the index), so this is bounded
	// by inbound-link count, not brain size.
	if (title && oldTitle && title !== oldTitle) {
		const { pages, truncated } = await fetchInboundLinkers(ctx, head, path);
		let repointed = 0;
		for (const page of pages) {
			if (page.path === path || isToolMaintained(page.path, config)) continue;
			const rewritten = rewriteWikiLinks(page.content, oldTitle, title);
			if (rewritten.changed > 0) {
				writes.push({ path: page.path, content: rewritten.body });
				repointed += rewritten.changed;
			}
		}
		if (repointed > 0) notes.push(`${repointed} link(s) to the old title repointed`);
		if (truncated) notes.push(`only the first ${MAX_SCAN_PAGES} pages were indexed for links`);
	}

	const log = await store.readFile(repoArgs, logPathOf(config));
	if (log) {
		const label = newTitle ?? path;
		const bullet =
			status && status !== old.frontmatter?.status
				? `Updated "${label}" (\`${path}\`) — status: ${status}.`
				: `Updated "${label}" (\`${path}\`).`;
		writes.push({ path: logPathOf(config), content: insertLogEntry(log.content, today, bullet) });
	}

	const outcome = await store.commitOrPR(repoArgs, {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod,
		message: `Update ${newTitle ?? path} (${path})${title && oldTitle && title !== oldTitle ? `\n\nRetitled from "${oldTitle}"; inbound wikilinks repointed.` : ''}`,
		writes,
		head,
		branchPrefix: 'isomorphic/update',
		prTitle: `Update ${newTitle ?? path}`,
		prBody: `Update \`${path}\`. Proposed via the Isomorphic brain tools.`
	});
	const res = landed(
		outcome,
		`Saved "${newTitle ?? path}". ${notes.length ? notes.join('; ') + '. ' : ''}The change was logged.`,
		`Proposed an update to "${newTitle ?? path}". ${notes.length ? notes.join('; ') + '. ' : ''}`
	);
	// The in-client editor (which passes a sha) wants a fresh sha back so it can keep
	// saving without reopening. Re-read only when the change actually landed on the
	// branch; an unmerged PR leaves the editor's current sha valid.
	if (sha !== undefined) {
		let freshSha = sha;
		if (!(outcome.prUrl && !outcome.merged)) {
			const saved = await store.readFile(repoArgs, path);
			freshSha = saved?.sha ?? '';
		}
		return { ...res, structuredContent: { path, sha: freshSha } };
	}
	return res;
}

// What a folder move would land on top of, split by whether it actually matters.
//
// A folder marker (`.gitkeep`, and any other dot-prefixed scaffolding) exists to
// persist an otherwise-empty directory in git, so the destination's own copy already
// does that job and the source's is redundant. Treating those as collisions made
// MERGING a folder into an existing one impossible in the case where it is most
// wanted: every scaffolded folder has a `.gitkeep`, so the destination always
// already had one, and archiving into an existing archive folder was refused with a
// message naming a file the caller never wrote.
//
// Real content is a different answer: overwriting a page is not this tool's call to
// make. Those are collected in full rather than reported one at a time, so the
// caller learns the shape of the problem in one call instead of clearing it file by
// file.
export function folderMoveCollisions(
	moved: string[],
	existing: Set<string>,
	rename: (path: string) => string
): { blocking: string[]; scaffolding: string[] } {
	const blocking: string[] = [];
	const scaffolding: string[] = [];
	for (const path of moved) {
		if (!existing.has(rename(path))) continue;
		if (isHiddenName(path)) scaffolding.push(path);
		else blocking.push(path);
	}
	return { blocking, scaffolding };
}

// The folder-path form of move_page: move/rename a whole subtree in one atomic commit.
// Two link classes are handled:
//   - Moved pages' OWN outbound links: intra-subtree links are invariant (source and
//     target shift by the same prefix), so only links pointing OUTSIDE the subtree are
//     repointed to a moved sibling first, then the body is rebased for the new location.
//     Titles never change on a move, so [[wikilinks]] still resolve.
//   - OUTSIDE pages linking INTO a moved page: their relative md links are repointed.
async function moveFolderWrite(
	ctx: BrainContext,
	args: { path: string; new_path?: string; new_name?: string },
	// The caller may already have paid for these while deciding this was a folder
	// at all; re-fetching would cost a second round trip for the same answer.
	pre?: { head: Head; tree: TreeEntry[] }
) {
	const { store, repoArgs, config, author } = ctx;
	const { new_path, new_name } = args;
	const folder = normFolderPath(args.path);
	if (!folder) return fail('Give a folder path, e.g. "wiki/Projects".');
	if (!new_path && !new_name?.trim())
		return fail('Give a new_path (move/rename) or a new_title (rename in place).');

	const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
	const newFolder = normFolderPath(
		new_path ?? (parent ? `${parent}/${new_name!.trim()}` : new_name!.trim())
	);
	if (!newFolder) return fail('The new folder path is empty.');
	if (newFolder === folder) return ok(`"${folder}" is already there — nothing to move.`);
	if (newFolder.startsWith(`${folder}/`)) return fail(`Can't move "${folder}" into itself.`);
	if (!isContentPath(`${newFolder}/.gitkeep`, config))
		return fail(`Can't move to "${newFolder}" — it's outside this brain's editable content.`);

	const head = pre?.head ?? (await store.getHead(repoArgs));
	const tree = pre?.tree ?? (await store.listTree(repoArgs, head, { extension: '*' }));
	const moved = tree.filter((e) => e.path.startsWith(`${folder}/`));
	if (moved.length === 0) return fail(`No folder "${folder}" found (it has no files).`);
	for (const e of moved) {
		if (isSourcePath(e.path, config))
			return fail(`"${folder}" contains source material — it can't be moved.`);
		if (isToolMaintained(e.path, config))
			return fail(`"${folder}" contains a tool-maintained file — it can't be moved.`);
	}
	const rename = (p: string) => `${newFolder}${p.slice(folder.length)}`;
	const existing = new Set(tree.map((e) => e.path));
	const { blocking, scaffolding } = folderMoveCollisions(
		moved.map((e) => e.path),
		existing,
		rename
	);
	if (blocking.length) {
		const shown = blocking
			.slice(0, 10)
			.map((p) => `"${rename(p)}"`)
			.join(', ');
		const more = blocking.length > 10 ? `, and ${blocking.length - 10} more` : '';
		return fail(
			`Can't move "${folder}" into "${newFolder}": ${blocking.length} file(s) already exist there (${shown}${more}). Move or rename those first, or pick a destination that doesn't hold them.`
		);
	}
	// The destination keeps its own folder markers; the source's are dropped with the
	// folder rather than written over the top of them.
	const supersededScaffolding = new Set(scaffolding);

	const movedMdEntries = moved.filter((e) => e.path.endsWith('.md'));
	const movedMd = new Set(movedMdEntries.map((e) => e.path));
	// The moved pages' own content, fetched by known path (bounded by folder size)
	// rather than a whole-brain scan, needed to rebase their outbound links.
	const { pages: movedPages } = await store.fetchPages(repoArgs, movedMdEntries);
	const movedContent = new Map(movedPages.map((p) => [p.path, p.content]));
	const today = todayIso();
	const writes: { path: string; content: string }[] = [];
	const deletes: string[] = [];
	let repointedPages = 0;

	// 1. Moved markdown pages — repoint outbound links to moved siblings, then rebase
	//    for the new location, and reattach frontmatter unchanged.
	for (const oldPath of movedMd) {
		const content = movedContent.get(oldPath);
		if (content == null) continue; // unreadable blob, leave it (rare)
		const newPath = rename(oldPath);
		const { frontmatter, body } = parseFrontmatter(content);
		let rebased = body;
		for (const sibling of movedMd) {
			rebased = rewriteMdLinks(rebased, oldPath, sibling, rename(sibling)).body;
		}
		rebased = rebaseMdLinks(rebased, oldPath, newPath);
		writes.push({
			path: newPath,
			content: frontmatter ? withFrontmatter(frontmatter, rebased) : rebased
		});
		deletes.push(oldPath);
	}

	// 2. Non-markdown blobs under the folder (.gitkeep, etc.) — copy across verbatim,
	//    except the scaffolding the destination already carries: writing over that
	//    would replace a file the caller never asked to touch.
	for (const e of moved) {
		if (movedMd.has(e.path)) continue;
		if (supersededScaffolding.has(e.path)) {
			deletes.push(e.path);
			continue;
		}
		const file = await store.readFile(repoArgs, e.path);
		writes.push({ path: rename(e.path), content: file?.content ?? '' });
		deletes.push(e.path);
	}

	// 3. Outside pages linking INTO a moved page — repoint their md links. Discover the
	//    linkers via the content index (bounded by inbound-link count, not brain size,
	//    and uncapped), excluding the moved pages themselves.
	const { pages: linkers, truncated } = await fetchInboundLinkersForPaths(
		ctx,
		head,
		[...movedMd],
		movedMd
	);
	for (const page of linkers) {
		if (isToolMaintained(page.path, config)) continue;
		let content = page.content;
		let changed = 0;
		for (const oldPath of movedMd) {
			const r = rewriteMdLinks(content, page.path, oldPath, rename(oldPath));
			content = r.body;
			changed += r.changed;
		}
		if (changed > 0) {
			writes.push({ path: page.path, content });
			repointedPages++;
		}
	}

	const log = await store.readFile(repoArgs, logPathOf(config));
	if (log) {
		writes.push({
			path: logPathOf(config),
			content: insertLogEntry(log.content, today, `Moved folder \`${folder}\` to \`${newFolder}\`.`)
		});
	}

	const outcome = await store.commitOrPR(repoArgs, {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod,
		message: `Move folder ${folder} -> ${newFolder}\n\nInbound links repointed across ${repointedPages} page(s).`,
		writes,
		deletes,
		head,
		branchPrefix: 'isomorphic/folder-move',
		prTitle: `Move folder ${folder} → ${newFolder}`,
		prBody: `Move folder \`${folder}\` to \`${newFolder}\`; inbound links repointed. Proposed via the Isomorphic brain tools.`
	});
	// Say when this was a MERGE rather than a move into empty space: the destination
	// already existed, and a marker of the source's was dropped instead of copied.
	const mergeNote = supersededScaffolding.size
		? ` Merged into the existing "${newFolder}", which keeps its own ${[...supersededScaffolding]
				.map((p) => p.split('/').pop())
				.join(', ')}.`
		: '';
	return landed(
		outcome,
		`Moved folder "${folder}" to ${newFolder}.${mergeNote} Links in ${repointedPages} page(s) were repointed; the change was logged.${truncationNote(truncated)}${toolRosterNote(folder, newFolder)}`,
		`Proposed moving folder "${folder}" to ${newFolder}.${mergeNote} Links in ${repointedPages} page(s) repointed.${truncationNote(truncated)}${toolRosterNote(folder, newFolder)}`
	);
}

// The non-markdown file form of move_page: move or rename one blob that isn't a page.
//
// This exists because a path like "wiki/Todos/.gitkeep" used to route to the FOLDER
// mover (anything without a .md extension did), which found no files under it and
// answered "no folder found (it has no files)" about a file that plainly existed. So
// a non-page file could block a folder move and could not be addressed to clear it.
//
// No link repointing: markdown links whose target isn't .md are deliberately outside
// the resolved graph (loadResolvedGraph skips them), so there is nothing pointing at
// this file for the index to know about.
async function moveFileWrite(
	ctx: BrainContext,
	head: Head,
	tree: TreeEntry[],
	args: { path: string; new_path?: string; new_name?: string }
) {
	const { store, repoArgs, config, author } = ctx;
	const path = args.path.trim().replace(/^\/+/, '');
	const { new_path, new_name } = args;
	if (!new_path && !new_name?.trim())
		return fail('Give a new_path (move/rename) or a new_title (rename in place).');
	if (isSourcePath(path, config)) return fail(`"${path}" is source material — it can't be moved.`);
	if (isToolMaintained(path, config)) return fail(`"${path}" is maintained automatically.`);
	if (!isContentPath(path, config))
		return fail(`"${path}" is outside this brain's editable content.`);

	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const newPath = (
		new_path ? new_path.trim() : parent ? `${parent}/${new_name!.trim()}` : new_name!.trim()
	).replace(/^\/+/, '');
	if (!newPath) return fail('The new path is empty.');
	if (newPath === path) return ok(`"${path}" is already there — nothing to move.`);
	if (!isContentPath(newPath, config))
		return fail(`Can't move to "${newPath}" — it's outside this brain's editable content.`);
	if (tree.some((e) => e.path === newPath))
		return fail(`Can't move to "${newPath}" — a file already exists there.`);

	const file = await store.readFile(repoArgs, path);
	if (!file) return fail(`"${path}" does not exist.`);
	// Blobs reach us base64-decoded as UTF-8 text, so anything that isn't text has
	// already lost bytes by the time we could write it back. Refuse rather than
	// commit a corrupted copy over the original.
	if (/[\u0000\uFFFD]/.test(file.content))
		return fail(
			`"${path}" isn't a text file, so it can't be moved through these tools without corrupting it. Move it with git, or on github.com.`
		);

	const today = todayIso();
	const writes = [{ path: newPath, content: file.content }];
	const log = await store.readFile(repoArgs, logPathOf(config));
	if (log) {
		writes.push({
			path: logPathOf(config),
			content: insertLogEntry(log.content, today, `Moved \`${path}\` to \`${newPath}\`.`)
		});
	}

	const outcome = await store.commitOrPR(repoArgs, {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod,
		message: `Move ${path} -> ${newPath}`,
		writes,
		deletes: [path],
		head,
		branchPrefix: 'isomorphic/move',
		prTitle: `Move ${path} → ${newPath}`,
		prBody: `Move \`${path}\` to \`${newPath}\`. Proposed via the Isomorphic brain tools.`
	});
	return landed(
		outcome,
		`Moved "${path}" to ${newPath}. It isn't a page, so no links needed repointing; the change was logged.`,
		`Proposed moving "${path}" to ${newPath}.`
	);
}

// The folder-path form of delete_page: delete a whole subtree and everything under it.
// The non-markdown file form of delete_page, and the twin of moveFileWrite: before
// this, a path like "wiki/assets/logo.png" routed to the FOLDER deleter and came
// back as "No folder found" about a file that existed.
//
// Inbound references are checked differently to a page's. A link to a non-page file
// is not an edge in the resolved page graph, so inboundRefs cannot see it, and
// deleting an embedded image would otherwise break every page showing it in silence.
async function deleteFileWrite(ctx: BrainContext, head: Head, args: { path: string }) {
	const { store, repoArgs, config, author, db, brainId } = ctx;
	const path = args.path.trim().replace(/^\/+/, '');
	if (isSourcePath(path, config))
		return fail(`"${path}" is source material — it can't be deleted.`);
	if (isToolMaintained(path, config)) return fail(`"${path}" is maintained automatically.`);
	if (!isContentPath(path, config))
		return fail(`"${path}" is outside this brain's editable content.`);

	const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
	const refs = await inboundFileRefs(db, brainId, path);

	const today = todayIso();
	const writes: { path: string; content: string }[] = [];
	const log = await store.readFile(repoArgs, logPathOf(config));
	if (log) {
		writes.push({
			path: logPathOf(config),
			content: insertLogEntry(log.content, today, `Deleted \`${path}\`.`)
		});
	}

	const outcome = await store.commitOrPR(repoArgs, {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod,
		message: `Delete ${path}\n\nDeletion logged.`,
		writes,
		deletes: [path],
		head,
		branchPrefix: 'isomorphic/delete',
		prTitle: `Delete ${path}`,
		prBody: `Delete \`${path}\`. Proposed via the Isomorphic brain tools.`
	});

	const refNote = refs.length
		? `\n\nHeads up — ${refs.length} page(s) still link to it:\n${refs
				.slice(0, 20)
				.map((p) => `- ${p}`)
				.join('\n')}${refs.length > 20 ? `\n…and ${refs.length - 20} more.` : ''}`
		: '';
	return landed(
		outcome,
		`Deleted "${path}". The deletion was logged.${refNote}${truncationNote(truncated)}`,
		`Proposed deleting "${path}".${refNote}${truncationNote(truncated)}`
	);
}

async function deleteFolderWrite(
	ctx: BrainContext,
	args: { path: string },
	// Already fetched by the router that decided this was a folder (see move's twin).
	pre?: { head: Head; tree: TreeEntry[] }
) {
	const { store, repoArgs, config, author } = ctx;
	const folder = normFolderPath(args.path);
	if (!folder) return fail('Give a folder path, e.g. "wiki/Projects".');

	const head = pre?.head ?? (await store.getHead(repoArgs));
	const tree = pre?.tree ?? (await store.listTree(repoArgs, head, { extension: '*' }));
	const doomed = tree.filter((e) => e.path.startsWith(`${folder}/`));
	if (doomed.length === 0) return fail(`No folder "${folder}" found.`);
	for (const e of doomed) {
		if (isSourcePath(e.path, config))
			return fail(`"${folder}" contains source material — it can't be deleted.`);
		if (isToolMaintained(e.path, config))
			return fail(`"${folder}" contains a tool-maintained file — it can't be deleted.`);
	}
	const doomedMd = new Set(doomed.filter((e) => e.path.endsWith('.md')).map((e) => e.path));

	// References from OUTSIDE the folder into any deleted page, from the content index
	// (md + wikilinks, bounded by inbound-link count rather than brain size).
	const { refs, truncated } = await inboundRefs(ctx, [...doomedMd]);

	const today = todayIso();
	const mdCount = doomedMd.size;
	const label = `${mdCount} page${mdCount === 1 ? '' : 's'}`;
	const writes: { path: string; content: string }[] = [];
	const log = await store.readFile(repoArgs, logPathOf(config));
	if (log) {
		writes.push({
			path: logPathOf(config),
			content: insertLogEntry(log.content, today, `Deleted folder \`${folder}\` (${label}).`)
		});
	}

	const outcome = await store.commitOrPR(repoArgs, {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod,
		message: `Delete folder ${folder} (${label})\n\nDeletion logged.`,
		writes,
		deletes: doomed.map((e) => e.path),
		head,
		branchPrefix: 'isomorphic/folder-delete',
		prTitle: `Delete folder ${folder}`,
		prBody: `Delete folder \`${folder}\` and its ${label}. Proposed via the Isomorphic brain tools.`
	});
	const refNote = refs.length
		? `\n\nHeads up — ${refs.length} page(s) elsewhere still link into it:\n${refs
				.map((r) => `- ${r.path} (${r.count} link(s))`)
				.join('\n')}`
		: '';
	return landed(
		outcome,
		`Deleted folder "${folder}" (${label}). The change was logged.${refNote}${truncationNote(truncated)}${toolRosterNote(folder)}`,
		`Proposed deleting folder "${folder}" (${label}).${refNote}${truncationNote(truncated)}${toolRosterNote(folder)}`
	);
}

export function registerLibrarianTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	// ---------- write_page (create or update) ----------
	server.registerTool(
		'write_page',
		{
			title: 'Write a brain page',
			description:
				'Create a new page, or change an existing one, at a content path you choose (folders are free-form). ONE PAGE = ONE CONCEPT: anything another page should be able to link to — a person, vendor, system, event series, project — gets its own file, never a section inside a bigger page. If you are about to write a heading per item, write a page per item instead. To change PART of a page use `edits` (exact find/replace; each anchor must match exactly once) or `append` (add to the end): both leave the rest of the page untouched, so you do not have to read it first and cannot destroy text you have not seen. `content` REPLACES the entire body, so pass it only for a new page or a deliberate full rewrite, and read the page first (read_page) if you did not just write it. A new page starts as a draft; on an existing page frontmatter is preserved and merged, the "updated" date is bumped, a retitle repoints inbound links, and passing none of content/edits/append changes only metadata (e.g. status: "published" to publish a draft). Every change is logged. Pass mode: "create" to require a new path (fails if it exists) or "update" to require an existing one.',
			inputSchema: {
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Content path, e.g. "wiki/research/model-eval.md". Must end in .md. A folder\'s overview/index page MUST be named "index.md" (e.g. "wiki/vendors/index.md"): that makes it the folder note, which the app opens when the folder is clicked. Naming it anything else ("overview.md", "vendors.md") leaves the folder note-less and the page a loose sibling. An index.md is a LISTING of the folder\'s pages (write it as an okf-view, or as links), never a container holding the folder\'s content inline.'
					),
				content: z
					.string()
					.optional()
					.describe(
						'Markdown body, REPLACING the whole body on an existing page (use edits/append to change only part of it). Frontmatter is generated on create and preserved/merged on update (any you include is merged). Omit on an existing page to change only metadata.'
					),
				append: z
					.string()
					.optional()
					.describe(
						'Markdown to add to the END of an existing page, leaving everything above it untouched. Non-destructive: no need to read the page first. Not combinable with content.'
					),
				edits: z
					.array(
						z.object({
							find: z
								.string()
								.describe(
									'Exact text to replace, copied verbatim from the page (whitespace included). Must occur exactly once, or the call fails and nothing is written; include surrounding lines to disambiguate.'
								),
							replace: z.string().describe('Text to put in its place (empty string deletes it).')
						})
					)
					.optional()
					.describe(
						'Find/replace edits applied in order to an existing page, leaving the rest untouched. Non-destructive: no need to read the whole page first. Not combinable with content.'
					),
				title: z
					.string()
					.optional()
					.describe(
						'Human title. Defaults to the filename on create; retitles on update (inbound links repointed).'
					),
				type: z
					.string()
					.optional()
					.describe(
						'What KIND of thing this page is — a short free-form noun phrase ("Vendor", "Event Series", "Person", "Meeting Note"). This is the one field the Open Knowledge Format requires, and it is not a fixed taxonomy: reuse whatever types the brain already uses (check a sibling page), and coin a new one when nothing fits. Set it on every concept page. If you cannot name a type for something, that is usually a sign it belongs inside another page rather than in its own.'
					),
				description: z.string().optional().describe('One-line summary for the index.'),
				status: z
					.enum(['draft', 'published'])
					.optional()
					.describe('Lifecycle status. New pages default to draft; set "published" to publish.'),
				sources: z
					.array(z.string())
					.optional()
					.describe(
						'What this page was derived from, recorded on create: source/ paths, or URLs. Record them whenever the page restates material from somewhere else — provenance is what lets a reader check a claim later.'
					),
				mode: z
					.enum(['create', 'update', 'upsert'])
					.optional()
					.describe(
						'create = fail if the path exists; update = fail if it does not; upsert (default) = either.'
					),
				sha: z
					.string()
					.optional()
					.describe(
						'Blob sha from edit_page, passed by the in-client editor as a concurrency guard. Omit for conversational edits.'
					)
			}
		},
		async ({
			path,
			content,
			append,
			edits,
			title,
			type,
			description,
			status,
			sources,
			mode,
			sha,
			brain
		}) => {
			const ctx = await getContext({ requires: 'editor', brain });
			const { store, repoArgs, config } = ctx;
			const target = path.trim().replace(/^\/+/, '');
			if (!target.endsWith('.md')) {
				return fail('Pages must end in .md, e.g. "wiki/research/notes.md".');
			}
			// Partial edit vs whole-body replace are different intents; taking both
			// would mean silently dropping one of them.
			const patching = append !== undefined || (edits !== undefined && edits.length > 0);
			if (patching && content !== undefined) {
				return fail(
					'Pass either content (which replaces the whole body) or append/edits (which change part of it), not both.'
				);
			}
			if (isSourcePath(target, config)) return fail(`"${target}" is immutable source material.`);
			if (isToolMaintained(target, config)) return fail(`"${target}" is maintained automatically.`);

			const head = await store.getHead(repoArgs);
			const existing = await store.readFile(repoArgs, target);
			const wantMode = mode ?? 'upsert';

			// New path → create. Guard against an "update"-only intent and confirm editability.
			if (!existing) {
				if (patching) {
					return fail(
						`"${target}" does not exist yet, so there is nothing to ${append !== undefined ? 'append to' : 'edit'}. Create it first by passing content.`
					);
				}
				if (wantMode === 'update') {
					return fail(
						`"${target}" does not exist. Use mode "create" or "upsert" (the default) to create it.`
					);
				}
				if (!isContentPath(target, config)) {
					return fail(`"${target}" is outside this brain's editable content area.`);
				}
				return createPageWrite(ctx, head, {
					target,
					content,
					title,
					type,
					description,
					sources
				});
			}

			// Existing path → update. Guard against a "create"-only intent (clobber guard).
			if (wantMode === 'create') {
				return fail(
					`A page already exists at ${target}. Use mode "update" or "upsert" to change it, or pick a different path.`
				);
			}
			// Concurrency guard for the in-client editor (conversational callers pass no sha).
			if (sha !== undefined && existing.sha !== sha) {
				return fail(
					'This page changed since you opened it (someone else saved first). Reopen the editor to get the latest version (your unsaved text stays in the editor until you leave).'
				);
			}
			if (
				content === undefined &&
				!patching &&
				title === undefined &&
				type === undefined &&
				description === undefined &&
				status === undefined
			) {
				return fail(
					'Nothing to update: pass append / edits (to change part of the page) or content (to replace the body), or a title / type / description / status change.'
				);
			}

			// append/edits run against the AUTHORITATIVE blob we just read, never the
			// index, and against the body alone so an anchor can't match frontmatter.
			let rawBody: string | undefined;
			let changeSummary: string | undefined;
			if (patching) {
				const patched = applyPageEdits(parseFrontmatter(existing.content).body, { append, edits });
				if (!patched.ok) return fail(patched.error);
				rawBody = patched.body;
				changeSummary = patched.summary;
			}
			return updatePageWrite(ctx, head, existing, {
				path: target,
				content,
				rawBody,
				changeSummary,
				title,
				type,
				description,
				status,
				sha
			});
		}
	);

	// ---------- move_page ----------
	server.registerTool(
		'move_page',
		{
			title: 'Move or rename a page or folder',
			description:
				"Move a page (or a whole folder and everything under it) to a different location and/or rename it. Every link pointing at the moved page(s) — from other pages and the index — is repointed in the same save, and the moved content's own links keep working. Nothing dangles. Pass a folder path (no .md extension) to move or rename an entire subtree; moving a folder ONTO an existing one merges them, and is refused only if a page would be overwritten.",
			inputSchema: {
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Current page, folder, or file path, e.g. "wiki/customers/acme.md", "wiki/Projects", or "wiki/Projects/.gitkeep".'
					),
				new_path: z
					.string()
					.optional()
					.describe(
						'Full target path, e.g. "wiki/research/acme.md" (page) or "wiki/Work" (folder). Move to any location and/or rename.'
					),
				new_title: z
					.string()
					.optional()
					.describe(
						'Rename in place (keeps the parent folder). For a page it becomes the new title; for a folder, the new folder name (kept as typed). Ignored if new_path is given.'
					)
			}
		},
		async ({ path, new_path, new_title, brain }) => {
			const ctx = await getContext({ requires: 'editor', brain });
			// A path without a .md extension is a folder OR a non-page file, and the
			// name cannot tell them apart (".gitkeep" is a file, ".obsidian" a folder).
			// Ask the tree instead of guessing, then hand the answer to the mover that
			// fits. Guessing "folder" is what made a dotfile unaddressable: it reported
			// "no folder found (it has no files)" about a file that was right there.
			//
			// This supersedes an attachment-specific branch that routed on isAssetPath:
			// the tree answers the same question for EVERY non-page file, so an
			// attachment needs no case of its own.
			if (!path.trim().replace(/^\/+/, '').endsWith('.md')) {
				const cleaned = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
				const head = await ctx.store.getHead(ctx.repoArgs);
				const tree = await ctx.store.listTree(ctx.repoArgs, head, { extension: '*' });
				if (tree.some((e) => e.path === cleaned))
					return moveFileWrite(ctx, head, tree, { path: cleaned, new_path, new_name: new_title });
				if (tree.some((e) => e.path.startsWith(`${cleaned}/`)))
					return moveFolderWrite(ctx, { path, new_path, new_name: new_title }, { head, tree });
				return fail(`No file or folder "${cleaned}" found.`);
			}
			const { store, repoArgs, config, author } = ctx;
			if (!new_path && !new_title)
				return fail('Give a new_path (move/rename) or a new_title (rename in place).');
			if (isSourcePath(path, config))
				return fail(`"${path}" is source material — it can't be moved.`);
			if (isToolMaintained(path, config)) return fail(`"${path}" is maintained automatically.`);

			const existing = await store.readFile(repoArgs, path);
			if (!existing) return fail(`"${path}" does not exist.`);

			const { frontmatter, body } = parseFrontmatter(existing.content);
			// pageTitle is the single title resolver (frontmatter > H1 > filename); a
			// second copy here would repoint links to a name the rest of the system
			// doesn't call this page.
			const oldTitle = pageTitle(path, existing.content);
			const newPath = new_path
				? new_path.trim().replace(/^\/+/, '')
				: `${path.slice(0, path.lastIndexOf('/'))}/${slugify(new_title!)}.md`;
			if (!newPath.endsWith('.md')) return fail('Target must end in .md.');
			if (!isContentPath(newPath, config))
				return fail(`Can't move to ${newPath} — it's outside this brain's editable content.`);
			const newTitle = new_title ?? oldTitle;
			if (newPath === path) return ok(`"${oldTitle}" is already at ${path} — nothing to move.`);

			const head = await store.getHead(repoArgs);
			const tree = await store.listTree(repoArgs, head);
			if (tree.some((e) => e.path === newPath)) {
				return fail(`Can't move to ${newPath} — a page already exists there.`);
			}

			// Only the pages that link to the moving page are fetched (discovered via the
			// content index), not the whole brain — bounded by inbound-link count.
			const { pages, truncated } = await fetchInboundLinkers(ctx, head, path);
			const today = todayIso();
			const writes: { path: string; content: string }[] = [];
			let repointedPages = 0;

			// Repoint inbound links across the wiki.
			for (const page of pages) {
				if (page.path === path || isToolMaintained(page.path, config)) continue;
				let content = page.content;
				let changed = 0;
				const md = rewriteMdLinks(content, page.path, path, newPath);
				content = md.body;
				changed += md.changed;
				if (newTitle !== oldTitle) {
					const wl = rewriteWikiLinks(content, oldTitle, newTitle);
					content = wl.body;
					changed += wl.changed;
				}
				// A wikilink can also name a page by its FILENAME, so a rename orphans
				// those unless they move with it (the title lane above only catches the
				// ones written as the title).
				if (wikilinkKey(slugOf(newPath)) !== wikilinkKey(slugOf(path))) {
					const wl = rewriteWikiLinks(content, slugOf(path), slugOf(newPath));
					content = wl.body;
					changed += wl.changed;
				}
				if (changed > 0) {
					writes.push({ path: page.path, content });
					repointedPages++;
				}
			}

			// The moved page itself: rebase outbound links, refresh frontmatter.
			const fm: Frontmatter = { ...(frontmatter ?? {}), title: newTitle, updated: today };
			writes.push({
				path: newPath,
				content: withFrontmatter(fm, rebaseMdLinks(body, path, newPath))
			});

			const log = await store.readFile(repoArgs, logPathOf(config));
			if (log) {
				const bullet =
					newTitle !== oldTitle
						? `Moved "${oldTitle}" to \`${newPath}\` (now "${newTitle}").`
						: `Moved "${oldTitle}" to \`${newPath}\`.`;
				writes.push({
					path: logPathOf(config),
					content: insertLogEntry(log.content, today, bullet)
				});
			}

			const outcome = await store.commitOrPR(repoArgs, {
				writeMode: config.writeMode,
				defaultBranch: config.defaultBranch,
				author,
				autoMerge: config.autoMerge,
				mergeMethod: config.mergeMethod,
				message: `Move ${path} -> ${newPath}\n\nInbound links repointed across ${repointedPages} page(s); logged.`,
				writes,
				deletes: [path],
				head,
				branchPrefix: 'isomorphic/move',
				prTitle: `Move ${path} → ${newPath}`,
				prBody: `Move \`${path}\` to \`${newPath}\`; inbound links repointed. Proposed via the Isomorphic brain tools.`
			});
			return landed(
				outcome,
				`Moved "${oldTitle}" to ${newPath}${newTitle !== oldTitle ? ` and renamed it "${newTitle}"` : ''}. Links in ${repointedPages} page(s) were repointed; the change was logged.${truncationNote(truncated)}${toolRosterNote(path, newPath)}`,
				`Proposed moving "${oldTitle}" to ${newPath}${newTitle !== oldTitle ? ` (renamed "${newTitle}")` : ''}; links in ${repointedPages} page(s) repointed.${truncationNote(truncated)}${toolRosterNote(path, newPath)}`
			);
		}
	);

	// ---------- delete_page ----------
	server.registerTool(
		'delete_page',
		{
			title: 'Delete a page or folder',
			description:
				'Remove a page (or a whole folder and everything under it) from the wiki. The deletion is logged. If other pages still link into what you deleted, they are listed so the references can be cleaned up. Pass a folder path (no .md extension) to delete an entire subtree, or the path of a non-page file (an image, a folder marker) to delete just that file.',
			inputSchema: {
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Page, folder, or file path, e.g. "wiki/projects/old.md", "wiki/Projects", or "wiki/assets/logo.png".'
					)
			}
		},
		async ({ path, brain }) => {
			const ctx = await getContext({ requires: 'editor', brain });
			// A path without a .md extension is a folder OR a non-page file; the tree
			// says which, for the same reason it does in move_page. Guessing "folder"
			// answered "No folder found" about files that were plainly there. This
			// supersedes an attachment-specific branch, exactly as in move_page.
			if (!path.trim().replace(/^\/+/, '').endsWith('.md')) {
				const cleaned = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
				const head = await ctx.store.getHead(ctx.repoArgs);
				const tree = await ctx.store.listTree(ctx.repoArgs, head, { extension: '*' });
				if (tree.some((e) => e.path === cleaned))
					return deleteFileWrite(ctx, head, { path: cleaned });
				if (tree.some((e) => e.path.startsWith(`${cleaned}/`)))
					return deleteFolderWrite(ctx, { path }, { head, tree });
				return fail(`No file or folder "${cleaned}" found.`);
			}
			const { store, repoArgs, config, author } = ctx;
			if (isSourcePath(path, config))
				return fail(`"${path}" is source material — it can't be deleted.`);
			if (isToolMaintained(path, config)) return fail(`"${path}" is maintained automatically.`);
			if (!isContentPath(path, config))
				return fail(`"${path}" is outside this brain's editable content.`);

			const existing = await store.readFile(repoArgs, path);
			if (!existing) return fail(`"${path}" does not exist.`);

			const head = await store.getHead(repoArgs);
			const title = pageTitle(path, existing.content);
			const { refs, truncated } = await inboundRefs(ctx, [path]);

			const today = todayIso();
			const writes: { path: string; content: string }[] = [];
			const log = await store.readFile(repoArgs, logPathOf(config));
			if (log) {
				writes.push({
					path: logPathOf(config),
					content: insertLogEntry(log.content, today, `Deleted "${title}" (\`${path}\`).`)
				});
			}

			const outcome = await store.commitOrPR(repoArgs, {
				writeMode: config.writeMode,
				defaultBranch: config.defaultBranch,
				author,
				autoMerge: config.autoMerge,
				mergeMethod: config.mergeMethod,
				message: `Delete ${title} (${path})\n\nDeletion logged.`,
				writes,
				deletes: [path],
				head,
				branchPrefix: 'isomorphic/delete',
				prTitle: `Delete ${title}`,
				prBody: `Delete \`${path}\`. Proposed via the Isomorphic brain tools.`
			});

			const refNote = refs.length
				? `\n\nHeads up — ${refs.length} page(s) still reference it:\n${refs
						.map((r) => `- ${r.path} (${r.count} link(s))`)
						.join('\n')}\nUpdate those pages to remove or repoint the references.`
				: '';
			return landed(
				outcome,
				`Deleted "${title}" (${path}). The change was logged.${refNote}${truncationNote(truncated)}${toolRosterNote(path)}`,
				`Proposed deleting "${title}" (${path}).${refNote}${truncationNote(truncated)}${toolRosterNote(path)}`
			);
		}
	);

	// ---------- find_inbound_links ----------
	server.registerTool(
		'find_inbound_links',
		{
			title: 'Find pages linking to a page',
			annotations: { readOnlyHint: true },
			description:
				'List everything that links to the given page or attachment — via markdown links, image embeds, or [[wikilinks]]. Useful before restructuring, before deleting an image (to see which pages would lose it), or to gauge how connected a page is.',
			inputSchema: {
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Target page or attachment path, e.g. "wiki/customers/acme.md" or "wiki/customers/assets/logo.png".'
					)
			}
		},
		async ({ path, brain }) => {
			const { store, repoArgs, config, db, brainId } = await getContext({ brain });
			// An attachment has to take a different existence check. readFile decodes the
			// blob as UTF-8, and on a PNG that does not fail — it returns mojibake — so
			// the old path would sail past the `!existing` guard and then run pageTitle()
			// over binary garbage, labelling the image with whatever fell out of it.
			// An attachment's title is its filename; there is nothing inside to read.
			let title: string;
			if (isAssetPath(path, config)) {
				const file = await store.readBinary(repoArgs, path);
				if (!file) return fail(`"${path}" does not exist.`);
				title = path.split('/').pop() ?? path;
			} else {
				// readFile confirms the target exists and gives its authoritative current
				// title; the backlinks themselves come from the content index.
				const existing = await store.readFile(repoArgs, path);
				if (!existing) return fail(`"${path}" does not exist.`);
				title = pageTitle(path, existing.content);
			}

			const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
			const resolved = await loadResolvedGraph(db, brainId, config);
			const refs = backlinksTo(resolved, path);

			// Structured payload for the in-client app's "Linked references" panel.
			// backlinksTo already carries each backlink's display title + md/wiki counts.
			const structuredContent = {
				target: { path, title },
				refs,
				truncated
			};

			if (refs.length === 0) {
				return {
					...ok(`No pages link to "${title}" (${path}).${truncationNote(truncated)}`),
					structuredContent
				};
			}
			return {
				...ok(
					`${refs.length} page(s) link to "${title}" (${path}):\n${refs
						.map((r) => {
							const parts = [];
							if (r.mdCount) parts.push(`${r.mdCount} link(s)`);
							if (r.wikiCount) parts.push(`${r.wikiCount} wikilink(s)`);
							return `- ${r.path} — ${parts.join(', ')}`;
						})
						.join('\n')}${truncationNote(truncated)}`
				),
				structuredContent
			};
		}
	);

	// ---------- validate ----------
	server.registerTool(
		'validate',
		{
			title: 'Check the brain for problems',
			annotations: { readOnlyHint: true },
			description:
				'Scan the wiki for broken links — markdown links to missing pages and [[wikilinks]] that match no page — and surface any pending import decisions awaiting a human answer. Also returns advisory Open Knowledge Format structure notes: concepts written as sections inside a folder note instead of getting their own page, pages missing a `type:`, and nested frontmatter the editor would flatten. Taxonomy-agnostic (folders stay free-form) and nothing it reports blocks a save. Run after big changes or restructures.',
			inputSchema: { brain: brainArg }
		},
		async ({ brain }) => {
			const { store, repoArgs, config, db, brainId } = await getContext({ brain });
			const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
			const resolved = await loadResolvedGraph(db, brainId, config);

			// Every link that resolved to no page (see loadResolvedGraph), reported in
			// two sections: files that aren't there, and names that match no page.
			const problemSections = brokenLinkReport(resolved.broken, resolved.pages);
			const problemCount = resolved.broken.length;
			const pageCount = resolved.pages.length;

			// Pending import decisions: the last sync's unanswered questions, persisted
			// per source in its ledger (.isomorphic/imports/<source>.json). Validate is
			// the "anything need attention?" surface — deciding happens via
			// resolve_import; a decision stays listed here until someone answers it.
			const pendingSections: string[] = [];
			try {
				const head = await store.getHead(repoArgs);
				// listTree defaults to .md — ledgers are .json.
				const tree = await store.listTree(repoArgs, head, { extension: '.json' });
				const ledgers = tree.filter((e) => /^\.isomorphic\/imports\/[^/]+\.json$/.test(e.path));
				for (const entry of ledgers) {
					const source = entry.path
						.split('/')
						.pop()!
						.replace(/\.json$/, '');
					const file = await store.readFile(repoArgs, entry.path);
					let ledger;
					try {
						ledger = parseLedger(file?.content ?? null);
					} catch {
						pendingSections.push(
							`Import ledger for "${source}" is corrupt (${entry.path}) — fix it before the next sync.`
						);
						continue;
					}
					if (!ledger.pending.length) continue;
					const lines = ledger.pending.map((q) =>
						q.kind === 'proposed-deletion'
							? `- "${q.key}" (${q.path}): ${q.reason} — delete it, or keep it and suppress the key.`
							: `- "${q.key}": ${q.reason}`
					);
					pendingSections.push(
						`${ledger.pending.length} import decision(s) pending for "${source}" — answer with resolve_import:\n${lines.join('\n')}`
					);
				}
			} catch {
				// Surfacing pending questions is best-effort; link validation stands alone.
			}
			const pendingText = pendingSections.length ? `\n\n${pendingSections.join('\n\n')}` : '';

			// Custom tools: report tool pages (under tools/) that can't register — a
			// malformed ```tool block, an unknown op, a duplicate name — so an author
			// sees why a tool didn't show up in the list. Best-effort; the tool blobs are
			// few (bounded by tools/ page count) and this never blocks link validation.
			const toolNotes: string[] = [];
			try {
				const toolPaths = resolved.pages.filter((p) => isToolPagePath(p.path)).map((p) => p.path);
				const namesSeen = new Map<string, string>();
				for (const tp of toolPaths) {
					const file = await store.readFile(repoArgs, tp);
					if (!file) continue;
					const res = parseToolDef(tp, file.content);
					if (!res.def) {
						toolNotes.push(`- ${tp}: ${res.error}`);
						continue;
					}
					const prev = namesSeen.get(res.def.name);
					if (prev)
						toolNotes.push(`- ${tp}: duplicate tool name "${res.def.name}" (also ${prev}).`);
					else namesSeen.set(res.def.name, tp);
				}
			} catch {
				// Best-effort — malformed-tool reporting never blocks link validation.
			}
			const toolText = toolNotes.length
				? `\n\n${toolNotes.length} custom tool page(s) won't register — fix them, then reconnect:\n${toolNotes.join('\n')}`
				: '';

			// Folders whose overview page isn't named index.md, so the app can't open
			// them from the folder. Advisory, not a problem, and pure over the index's
			// page list (no extra fetch).
			const folderNotes = folderNoteSuggestions(resolved.pages);
			const folderNoteText = folderNotes.length
				? `\n\n${folderNotes.length} folder(s) have an overview page that isn't a folder note, so clicking the folder in the app won't open it:\n${folderNotes.join('\n')}`
				: '';

			// OKF structure advisories: concepts inlined into a folder note instead of
			// getting their own file, and pages missing the `type:` the format requires.
			// Soft and best-effort — a failure here must never take link validation with it.
			let structureText = '';
			try {
				const notePaths = resolved.pages
					.filter((p) => isFolderNoteName(p.path.slice(p.path.lastIndexOf('/') + 1)))
					.map((p) => p.path);
				const noteContents = await loadPageContents(db, brainId, notePaths);
				const fieldsByPath = await loadAllFields(db, brainId);
				const conceptPages = resolved.pages.filter(
					(p) =>
						!isFolderNoteName(p.path.slice(p.path.lastIndexOf('/') + 1)) &&
						!isToolMaintained(p.path, config)
				);
				const structure = [
					...inlinedConceptSuggestions(
						[...noteContents].map(([path, content]) => ({ path, content })),
						resolved.pages
					),
					...typeFieldSuggestions(conceptPages, fieldsByPath),
					...ambiguousTitleSuggestions(resolved.pages),
					...wikilinkPortabilityNote(resolved.edges)
				];
				if (structure.length) {
					structureText = `\n\nStructure notes (Open Knowledge Format — advisory, nothing is broken):\n${structure.join('\n')}`;
				}
			} catch {
				// Advisory only; link validation stands alone.
			}

			const extras = `${truncationNote(truncated)}${pendingText}${toolText}${folderNoteText}${structureText}`;
			if (problemCount === 0) {
				return ok(`Checked ${pageCount} page(s) — no broken links.${extras}`);
			}
			return ok(
				`Checked ${pageCount} page(s) — ${problemCount} broken link(s):\n\n${problemSections.join('\n\n')}${extras}`
			);
		}
	);

	// ---------- search_pages ----------
	server.registerTool(
		'search_pages',
		{
			title: 'Search brain pages',
			annotations: { readOnlyHint: true },
			description:
				'Full-text search across wiki pages (case-insensitive). Returns matching lines with their page and line number.',
			inputSchema: {
				brain: brainArg,
				query: z.string().min(2).describe('Text to search for.'),
				prefix: z
					.string()
					.optional()
					.describe(
						'Restrict to a path prefix, e.g. "internal/frameworks/". Defaults to all content.'
					)
			}
		},
		async ({ query, prefix, brain }) => {
			const { store, repoArgs, config, db, brainId } = await getContext({ brain });
			const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);

			const MAX_HITS = 50;
			// Structured hits ride along for UI consumers (the brain MCP App);
			// the text block stays the source of truth for chat/agent consumers.
			// searchIndex matches lines exactly as the old live scan did, but against
			// the D1 index (no GitHub fetch, unbounded by page count).
			const hits = await searchIndex(db, brainId, query, prefix, MAX_HITS);

			if (hits.length === 0) {
				return {
					...ok(`No matches for "${query}".${truncationNote(truncated)}`),
					structuredContent: { hits: [] }
				};
			}
			const capped = hits.length >= MAX_HITS ? ` (showing first ${MAX_HITS})` : '';
			return {
				...ok(
					`${hits.length} match(es) for "${query}"${capped}:\n${hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')}${truncationNote(truncated)}`
				),
				structuredContent: { hits }
			};
		}
	);
}
