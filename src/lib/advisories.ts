// The advisories `validate` reports: the pure functions that PRODUCE findings.
//
// findings.ts owns the Finding type, the dismissal ledger and the rendering; these
// are what generate them. They were in src/tools/librarian.ts, which meant the tool
// layer held ~370 lines that touch no context, no store and no network, and that
// pnpm test:structure and pnpm test:links already import directly.
//
// Every function here is pure: page lists, link lists and frontmatter in, findings
// out. That is what makes them testable without a brain, and it is the property to
// preserve — anything needing a BrainContext belongs back in the tool.

import type { BrokenLink, PageFields } from './brain-index.ts';
import { type Finding, findingKey } from './findings.ts';
import type { ProbeResult } from './probe.ts';
import { isFolderNoteName } from './view-directives.ts';
import { parseFrontmatter, slugOf, slugify, wikilinkKey, wikilinkTargetName } from './wiki.ts';

// Folder-note advisory for validate. A folder's overview page has to be named index.md
// (FOLDER_NOTE_NAMES) for the app to treat it AS the folder: click-to-open, the row
// collapsed as a redundant sibling, `kind: folders` linking through it. Agents and humans
// reach for "overview.md" or "<folder>.md" instead, which leaves the folder note-less and
// the page a loose sibling. Pure over the index's page list; flags only the unambiguous
// cases (a note-less folder holding a page that is plainly its overview, by filename or by
// title matching the folder name), so "folder has no note at all" stays unreported noise.
const OVERVIEW_BASENAMES = new Set(['overview', 'about', 'home', 'summary', 'start-here']);

export function folderNoteSuggestions(pages: { path: string; title: string }[]): Finding[] {
	const byFolder = new Map<string, { path: string; title: string }[]>();
	for (const p of pages) {
		const cut = p.path.lastIndexOf('/');
		if (cut < 0) continue; // a repo-root page has no folder to be the note for
		const folder = p.path.slice(0, cut);
		const siblings = byFolder.get(folder);
		if (siblings) siblings.push(p);
		else byFolder.set(folder, [p]);
	}
	const out: Finding[] = [];
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
		// Keyed on the FOLDER, not the candidate page: the finding is "this folder's
		// overview is not its note", and it stays that finding if the page is renamed.
		out.push({
			key: findingKey('folder-note', folder),
			weight: 2.5,
			headline: `- ${candidate.path} looks like the overview for "${folder}/". Move_page it to ${folder}/index.md so it becomes the folder note.`
		});
	}
	return out.sort((a, b) => a.key.localeCompare(b.key));
}

// One line describing where the expected page landed. Kept beside the tool rather
// than in the pure scorer because it is presentation: the scorer decides the verdict,
// this decides how to say it.
export function describeProbe(p: ProbeResult): string {
	switch (p.verdict) {
		case 'owned':
			return `"${p.expect}" ranked FIRST of ${p.matched.length} matching page(s).`;
		case 'outranked':
		case 'buried':
			return `"${p.expect}" ranked ${p.position} of ${p.matched.length}, behind ${p.outrankedBy.slice(0, 3).join(', ')}. If it should own this question, sharpen its title and description, then search again.`;
		case 'elsewhere':
			return `"${p.expect}" did NOT match. ${p.matched.length} other page(s) answered, starting with ${p.matched.slice(0, 3).join(', ')} — either they own this question or the expected page is missing the words people search with.`;
		case 'inconclusive':
			return `"${p.expect}" did not appear, but the hit budget ran out, so it may simply not have been reached.`;
		default:
			return `Nothing in this brain matched, so "${p.expect}" is not findable by this question.`;
	}
}

// How many findings `validate` prints before it stops and says how many are left.
// Bounded because validate is read inside a conversation where every line costs
// context: a hundred advisories is not more useful than ten plus a count, and the
// count is what stops a truncated list reading as the whole list.
export const MAX_FINDINGS_SHOWN = 12;

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
): Finding[] {
	// Every name the brain already has a page for, so a section that merely restates
	// an existing page isn't mistaken for a homeless concept. Both sides go through
	// wikilinkKey for the reason resolution does: a filename kept raw here never
	// matches a heading, so every Title Case page read as homeless.
	const known = new Set<string>();
	for (const p of pages) {
		known.add(wikilinkKey(slugOf(p.path)));
		if (p.title) known.add(wikilinkKey(p.title));
	}
	const out: Finding[] = [];
	for (const note of notes) {
		const suspects = inlinedSections(note.content, known);
		if (suspects.length < MIN_INLINED_SECTIONS) continue;
		const shown = suspects.slice(0, 3).join('", "');
		const more = suspects.length > 3 ? ', …' : '';
		out.push({
			key: findingKey('inlined', note.path),
			weight: 3,
			headline: `- ${note.path} holds ${suspects.length} sections that read like pages of their own ("${shown}"${more}). A folder note is a LISTING, not a container: if other pages should be able to link to these, give each its own file and leave a link (or an okf-view) here.`
		});
	}
	return out.sort((a, b) => a.key.localeCompare(b.key));
}

// Pages with no `type:`. Reported only as an INCONSISTENCY (some pages typed, others
// not) or as a single soft note when the brain has never adopted the convention —
// listing every page of an untyped brain would be pure noise.
export function typeFieldSuggestions(
	conceptPages: { path: string }[],
	fieldsByPath: Map<string, PageFields>
): Finding[] {
	if (conceptPages.length === 0) return [];
	const missing = conceptPages.filter((p) => {
		const v = fieldsByPath.get(p.path)?.get('type');
		return !v || !v.some((s) => s.trim() !== '');
	});
	if (missing.length === 0) return [];
	// Two keys, not one: "nothing is typed" and "half of it is typed" are different
	// situations, and a brain that adopts `type:` partway has changed its mind since
	// dismissing the first. Silencing the adoption note should not also silence the
	// inconsistency note it turns into.
	if (missing.length === conceptPages.length) {
		return [
			{
				key: findingKey('untyped', 'none'),
				weight: 1.5,
				headline:
					'- No page declares a `type:`. That is OKF\'s one required field — a free-form string ("Vendor", "Event Series", "Meeting Note"), NOT a fixed taxonomy. It makes the brain readable by any OKF consumer, and asking "what type is this?" is the question that catches a concept being written as a section inside another page instead of getting its own file.'
			}
		];
	}
	const shown = missing.slice(0, 8).map((p) => `  - ${p.path}`);
	const more = missing.length > 8 ? `\n  …and ${missing.length - 8} more.` : '';
	return [
		{
			key: findingKey('untyped', 'partial'),
			weight: 1.5,
			headline: `- ${missing.length} of ${conceptPages.length} pages have no \`type:\` while the rest do, so the brain is half-typed:\n${shown.join('\n')}${more}`
		}
	];
}

// Pages a `[[wikilink]]` cannot tell apart. Resolution matches on path, then
// filename, then title (buildWikilinkIndex), and each lane keeps the first claim,
// so two pages sharing a title — or sharing a filename in different folders — mean
// every `[[That Name]]` lands on one of them and the rest are unreachable by name.
// Pure over the index's page list.
export function ambiguousTitleSuggestions(pages: { path: string; title: string }[]): Finding[] {
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
	return clashes.slice(0, 5).map(({ label, paths }) => ({
		// The clashing PAGES are the identity. The label is what they happen to share
		// today, and renaming one of them resolves the finding rather than renaming it.
		key: findingKey('ambiguous', paths),
		weight: 2,
		headline: `- ${paths.length} pages answer to the name "${label}", so a [[${label}]] wikilink can only reach one of them: ${paths.sort().join(', ')}. Give them distinct titles, or link these by path.`
	}));
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
export function wikilinkPortabilityNote(edges: { kind: 'md' | 'wiki'; cnt: number }[]): Finding[] {
	const wiki = edges.filter((e) => e.kind === 'wiki').reduce((n, e) => n + e.cnt, 0);
	if (wiki === 0) return [];
	const total = edges.reduce((n, e) => n + e.cnt, 0);
	// One brain-wide note, so the identity is the brain. This is the advisory that most
	// wanted a dismissal: a deliberately Obsidian-first brain has already decided, and
	// before findings had keys it was told again on every single run.
	return [
		{
			key: findingKey('wikilink-portability', 'brain'),
			weight: 0.5,
			headline: `- ${wiki} of ${total} resolved links are [[wikilinks]]. They resolve here, but they are not Open Knowledge Format links — an outside reader of this brain follows plain markdown links and sees these as literal text.`
		}
	];
}
