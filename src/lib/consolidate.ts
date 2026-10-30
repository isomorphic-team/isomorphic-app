// The consolidation loop's detector: where a brain's CHEAP surface (titles, folder
// placement, folder notes, link structure) disagrees with what a full read would
// tell you. Pure over index-derived material — no D1, no GitHub — so the rule can be
// pinned by `pnpm test:consolidate`.
//
// These are reported by `validate` alongside its other advisories, and dismissed
// through `resolve` like any other finding. They are judgment calls, which is exactly
// why they need a dismissal: an advisory nobody can silence decays into noise. What
// stays outside that system is the one class with a single right answer — a broken
// link is a defect, carries no key, and cannot be dismissed.
//
// Everything below is computed, never generated. Deciding whether a tension is real,
// and what the right shape is, costs model tokens in the caller's session.
import { isFolderNoteName, FOLDER_NOTE_NAMES } from './view-directives.ts';
import { parseFrontmatter } from './wiki.ts';
import { findingKey, type Finding } from './findings.ts';

export type TensionKind =
	| 'island'
	| 'orphan'
	| 'note-less-folder'
	| 'hollow-folder-note'
	| 'folder-note-convention'
	| 'folder-echo-page'
	| 'near-duplicate'
	| 'same-identifier';

export interface Tension {
	// Stable across runs and across content edits, so a dismissal sticks. Derived
	// from kind + the paths involved, never from the wording of the headline.
	key: string;
	kind: TensionKind;
	paths: string[];
	headline: string;
	evidence: string[];
	move: string;
	weight: number;
}

// A folder earns a folder note once it holds this many pages: below it, "no note" is
// a shape, not a gap. `folderNoteSuggestions` stays silent on note-less folders at any
// size (it speaks only when an overview-shaped page already exists); this is the
// counterpart that is allowed to be a judgment call, because it can be dismissed.
const MIN_FOLDER_PAGES_FOR_NOTE = 3;

// Jaccard over word bigrams. Two pages telling the same story land well above this;
// two pages in the same domain sharing vocabulary land below it. Pinned in both
// directions by the golden test.
const DUP_THRESHOLD = 0.2;

// Near-duplicate detection is the only check that needs page BODIES. Above this many
// pages the pass is skipped rather than run slowly, and the report says so instead of
// quietly covering less than it claims.
export const MAX_DUP_PAGES = 2000;

// A bigram on this share of a folder's pages is a template, not what a page says. Well
// under half, because a folder often mixes stubs built from a template with full pages.
const TEMPLATE_SHARE = 0.25;

// However small the folder, a bigram needs this many holders to be a template, so a few
// pages telling one story never have it removed.
const MIN_TEMPLATE_HOLDERS = 4;

// A templated page with this little left says too little to compare: a shared phrase
// or two would read as a high overlap.
const MIN_SHINGLES_AFTER_TEMPLATE = 10;

// Pairs are blocked on shared bigrams held by at most this many pages. A bigram held
// by more is common vocabulary, and pairing its holders is the all-pairs pass again.
const MAX_BLOCKING_PAGES = 20;

const STOPWORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'but',
	'if',
	'of',
	'to',
	'in',
	'on',
	'for',
	'with',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'it',
	'its',
	'this',
	'that',
	'these',
	'those',
	'as',
	'at',
	'by',
	'from',
	'we',
	'our',
	'you',
	'your',
	'they',
	'their',
	'not',
	'no',
	'so',
	'can',
	'will',
	'has',
	'have',
	'had',
	'do',
	'does',
	'what'
]);

function folderOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

function baseOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/\.md$/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

const tensionKey = (kind: TensionKind, paths: string[]) => findingKey(kind, paths);

/**
 * Tensions as `validate` reports them: the headline, its evidence and the suggested
 * move folded into one block, carrying the key `resolve` dismisses it by.
 */
export function tensionFindings(tensions: Tension[]): Finding[] {
	return tensions.map((t) => ({
		key: t.key,
		weight: t.weight,
		headline: [`- ${t.headline}`, ...t.evidence.map((e) => `    ${e}`), `  → ${t.move}`].join('\n')
	}));
}

// ---------- near-duplicate ----------

function shingles(content: string): Set<string> {
	const { body } = parseFrontmatter(content);
	const words = body
		.replace(/^```[\s\S]*?^```/gm, ' ')
		.replace(/`[^`]*`/g, ' ')
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w));
	const out = new Set<string>();
	for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const s of small) if (large.has(s)) shared++;
	return shared / (a.size + b.size - shared);
}

// Each page's shingles with its folder's template removed. Pages left with too little
// to compare are dropped.
function withoutTemplates(sets: Map<string, Set<string>>): Map<string, Set<string>> {
	const byFolder = new Map<string, string[]>();
	for (const path of sets.keys()) {
		const f = folderOf(path);
		byFolder.set(f, [...(byFolder.get(f) ?? []), path]);
	}
	const out = new Map(sets);
	for (const paths of byFolder.values()) {
		const held = new Map<string, number>();
		for (const p of paths) for (const s of sets.get(p)!) held.set(s, (held.get(s) ?? 0) + 1);
		const holders = Math.max(MIN_TEMPLATE_HOLDERS, Math.ceil(paths.length * TEMPLATE_SHARE));
		const template = new Set([...held].filter(([, n]) => n >= holders).map(([s]) => s));
		if (!template.size) continue;
		for (const p of paths) {
			const kept = new Set([...sets.get(p)!].filter((s) => !template.has(s)));
			if (kept.size === sets.get(p)!.size) continue;
			if (kept.size < MIN_SHINGLES_AFTER_TEMPLATE) out.delete(p);
			else out.set(p, kept);
		}
	}
	return out;
}

// Path pairs (first path sorts lower) sharing at least one rare bigram.
function candidatePairs(sets: Map<string, Set<string>>): [string, string][] {
	const holders = new Map<string, string[]>();
	for (const [path, set] of sets) {
		for (const s of set) {
			const list = holders.get(s);
			if (list) list.push(path);
			else holders.set(s, [path]);
		}
	}
	const seen = new Map<string, [string, string]>();
	for (const list of holders.values()) {
		if (list.length < 2 || list.length > MAX_BLOCKING_PAGES) continue;
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const [a, b] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]];
				const id = `${a}\0${b}`;
				if (!seen.has(id)) seen.set(id, [a, b]);
			}
		}
	}
	return [...seen.values()];
}

// ---------- same-identifier ----------

function normalizeIdentifier(field: string, value: string): string {
	const v = value.trim();
	return field === 'email' ? v.toLowerCase() : v;
}

export interface TensionInput {
	pages: { path: string; title: string }[];
	edges: { source: string; target: string }[];
	// Page bodies, for near-duplicate detection only. Omit to skip that check.
	contents?: Map<string, string>;
	// Paths the tools own (log.md and friends) — never a consolidation candidate.
	toolMaintained?: (path: string) => boolean;
	// Indexed frontmatter per path, for same-identifier. Omit to skip that check.
	fields?: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
	// The frontmatter keys that identify an entity (BrainConfig.identityFields).
	identityFields?: readonly string[];
	// Whether a path is under the brain's content roots.
	isContent?: (path: string) => boolean;
}

export function computeTensions(input: TensionInput): Tension[] {
	const { pages, edges } = input;
	const owned = input.toolMaintained ?? (() => false);
	const content = pages.filter((p) => !owned(p.path));
	const out: Tension[] = [];

	const inbound = new Map<string, number>();
	const outbound = new Map<string, number>();
	for (const e of edges) {
		if (e.source === e.target) continue;
		outbound.set(e.source, (outbound.get(e.source) ?? 0) + 1);
		inbound.set(e.target, (inbound.get(e.target) ?? 0) + 1);
	}

	// ---- islands and orphans ----
	// A folder note is reachable by navigation (clicking its folder), so a note with
	// no inbound link is not stranded the way a concept page is.
	for (const p of content) {
		if (isFolderNoteName(baseOf(p.path))) continue;
		const inn = inbound.get(p.path) ?? 0;
		const outn = outbound.get(p.path) ?? 0;
		if (inn === 0 && outn === 0) {
			out.push({
				key: tensionKey('island', [p.path]),
				kind: 'island',
				paths: [p.path],
				headline: `"${p.title}" is an island: nothing links to it and it links to nothing.`,
				evidence: [p.path, '0 inbound links, 0 outbound links'],
				move: 'Read it. Either link it into the folder note and out to what it depends on, or archive it (status: archived via write_page fields) if it is spent.',
				weight: 3
			});
		} else if (inn === 0) {
			out.push({
				key: tensionKey('orphan', [p.path]),
				kind: 'orphan',
				paths: [p.path],
				headline: `Nothing links to "${p.title}".`,
				evidence: [p.path, `0 inbound, ${outn} outbound`],
				move: 'Add a link from the folder note or from the page whose question it answers, so it is reachable by more than search.',
				weight: 1
			});
		}
	}

	// ---- folder notes ----
	const byFolder = new Map<string, { path: string; title: string }[]>();
	for (const p of content) {
		const f = folderOf(p.path);
		byFolder.set(f, [...(byFolder.get(f) ?? []), p]);
	}

	const noteNamesUsed = new Map<string, string[]>();
	for (const p of content) {
		const b = baseOf(p.path);
		if (isFolderNoteName(b)) noteNamesUsed.set(b, [...(noteNamesUsed.get(b) ?? []), p.path]);
	}
	if (noteNamesUsed.size > 1) {
		const paths = [...noteNamesUsed.values()].flat();
		const counts = [...noteNamesUsed.entries()]
			.map(([name, ps]) => `${name} x${ps.length}`)
			.join(', ');
		// FOLDER_NOTE_NAMES is priority-ordered; the head is what "Add folder note"
		// writes, so it is the form a mixed brain should converge on.
		const preferred = FOLDER_NOTE_NAMES[0];
		const minority = [...noteNamesUsed.entries()]
			.filter(([name]) => name !== preferred)
			.flatMap(([, ps]) => ps);
		out.push({
			key: tensionKey('folder-note-convention', paths),
			kind: 'folder-note-convention',
			paths: minority,
			headline: `This brain uses both folder-note names (${counts}).`,
			evidence: minority.map((p) => `${p} is not ${preferred}`),
			move: `Both resolve, so nothing is broken. Converge on ${preferred} (what the app writes) with move_page, or decide the split is deliberate and dismiss this.`,
			weight: 2
		});
	}

	for (const [folder, ps] of byFolder) {
		if (!folder) continue;
		if (ps.length < MIN_FOLDER_PAGES_FOR_NOTE) continue;
		if (ps.some((p) => isFolderNoteName(baseOf(p.path)))) continue;
		out.push({
			key: tensionKey('note-less-folder', [folder]),
			kind: 'note-less-folder',
			paths: [folder],
			headline: `${folder}/ holds ${ps.length} pages and has no folder note.`,
			evidence: ps.slice(0, 5).map((p) => p.path),
			move: `Write ${folder}/index.md: what this folder is for, and an okf-view (kind: pages, under: ${folder}/) so the listing maintains itself.`,
			weight: 2 + Math.min(ps.length / 10, 2)
		});
	}

	// A folder note is a LISTING. One that links to none of its siblings does not
	// list them: nothing traverses it, backlinks stay empty, and `kind: folders`
	// renders it as a dead end. The common cause is a note that names its pages in
	// prose, a table, a fenced block, or inline backticks — all of which maskCode and
	// the link extractor correctly refuse to read as links.
	for (const [folder, ps] of byFolder) {
		if (!folder) continue;
		const note = ps.find((p) => isFolderNoteName(baseOf(p.path)));
		if (!note) continue;
		const siblings = ps.filter((p) => p.path !== note.path);
		if (siblings.length < 2) continue;
		const siblingPaths = new Set(siblings.map((p) => p.path));
		const linked = new Set(
			edges.filter((e) => e.source === note.path && siblingPaths.has(e.target)).map((e) => e.target)
		);
		if (linked.size > 0) continue;
		out.push({
			key: tensionKey('hollow-folder-note', [note.path]),
			kind: 'hollow-folder-note',
			paths: [note.path],
			headline: `${note.path} lists none of the ${siblings.length} pages in its folder.`,
			evidence: [
				`${siblings.length} sibling pages, 0 linked from the note`,
				...siblings.slice(0, 4).map((p) => p.path)
			],
			move: `Link the siblings from the note, or replace the hand-written listing with an okf-view (kind: pages, under: ${folder}/), which stays correct as pages are added. Names in prose, tables, fenced blocks, or backticks are not links and nothing can follow them.`,
			weight: 2.5
		});
	}

	// A page named after its own folder is the folder note under another name: the
	// app cannot open it by clicking the folder, and `kind: folders` renders the
	// folder unlinked.
	for (const p of content) {
		const b = baseOf(p.path);
		if (isFolderNoteName(b)) continue;
		const folder = folderOf(p.path);
		if (!folder) continue;
		if (slug(b) !== slug(baseOf(folder))) continue;
		out.push({
			key: tensionKey('folder-echo-page', [p.path]),
			kind: 'folder-echo-page',
			paths: [p.path],
			headline: `${p.path} is named after its own folder but is not the folder note.`,
			evidence: [`folder: ${folder}/`, `page: ${b}`],
			move: `move_page it to ${folder}/${FOLDER_NOTE_NAMES[0]} so clicking the folder opens it. Inbound links are repointed for you.`,
			weight: 2
		});
	}

	// ---- near-duplicate ----
	if (input.contents && content.length <= MAX_DUP_PAGES) {
		const all = new Map<string, Set<string>>();
		for (const p of content) {
			const c = input.contents.get(p.path);
			if (c) all.set(p.path, shingles(c));
		}
		const sets = withoutTemplates(all);
		const titles = new Map(content.map((p) => [p.path, p.title]));
		for (const [a, b] of candidatePairs(sets)) {
			const score = jaccard(sets.get(a)!, sets.get(b)!);
			if (score < DUP_THRESHOLD) continue;
			out.push({
				key: tensionKey('near-duplicate', [a, b]),
				kind: 'near-duplicate',
				paths: [a, b],
				headline: `"${titles.get(a)}" and "${titles.get(b)}" say ${Math.round(score * 100)}% of the same thing.`,
				evidence: [a, b, `bigram overlap ${score.toFixed(2)}`],
				move: 'Read both. If one concept: merge into the better page and move_page the other onto it so inbound links follow. If two: sharpen the titles and descriptions until the difference is visible without reading.',
				weight: 2 + score * 4
			});
		}
	}

	// ---- same-identifier ----
	if (input.fields) {
		const inContent = input.isContent ?? (() => true);
		const holders = new Map<string, { label: string; paths: Set<string> }>();
		for (const p of content) {
			if (isFolderNoteName(baseOf(p.path)) || !inContent(p.path)) continue;
			const fields = input.fields.get(p.path);
			if (!fields) continue;
			for (const field of input.identityFields ?? []) {
				for (const raw of fields.get(field) ?? []) {
					const value = normalizeIdentifier(field, raw);
					if (!value) continue;
					const id = `${field}\0${value}`;
					const entry = holders.get(id) ?? { label: `${field}: ${value}`, paths: new Set() };
					entry.paths.add(p.path);
					holders.set(id, entry);
				}
			}
		}
		// One tension per group of pages, however many identifiers that group shares.
		const groups = new Map<string, { paths: string[]; labels: string[] }>();
		for (const { label, paths } of holders.values()) {
			if (paths.size < 2) continue;
			const sorted = [...paths].sort();
			const id = sorted.join('\0');
			const group = groups.get(id) ?? { paths: sorted, labels: [] };
			group.labels.push(label);
			groups.set(id, group);
		}
		for (const { paths, labels } of groups.values()) {
			out.push({
				key: tensionKey('same-identifier', paths),
				kind: 'same-identifier',
				paths,
				headline: `${paths.length} pages carry the same identifier, so they may describe one entity.`,
				evidence: [...labels, ...paths],
				move: 'Read them. If one entity: merge into the fuller page and move_page the others onto it so inbound links follow. If the identifier is genuinely shared, dismiss this.',
				weight: 4.5
			});
		}
	}

	return out.sort((x, y) => y.weight - x.weight || x.key.localeCompare(y.key));
}
