// Golden test for OKF conformance: the structure advisories in src/tools/librarian.ts
// (inlined-concept detection on folder notes, the `type:` consistency check) and
// verbatim preservation of OKF's nested frontmatter in src/lib/wiki.ts.
// Pure — no D1, no GitHub. Run: pnpm test:structure
//
// The first case is the regression this whole check exists for: a folder note that
// held twelve event franchises as prose sections instead of giving each its own
// page, in a brain whose other folders were already one-file-per-entity.
import {
	folderMoveCollisions,
	inlinedConceptSuggestions,
	typeFieldSuggestions,
	ambiguousTitleSuggestions,
	wikilinkPortabilityNote
} from '../src/tools/librarian.ts';
import {
	parseFrontmatter,
	withFrontmatter,
	isFrontmatterBlock,
	pageTitle
} from '../src/lib/wiki.ts';
import { backlinksTo } from '../src/lib/brain-index.ts';
import type { PageFields } from '../src/lib/brain-index.ts';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

const fields = (rows: Record<string, string[]>): PageFields => new Map(Object.entries(rows));

// ---------- inlined concepts ----------

const EVENTS = [
	'Annual Meeting',
	'Payer Issues Roundtable',
	'Health IT Forum',
	'Spine Summit',
	'CEO Roundtable',
	'Revenue Cycle Forum',
	'Digital Health Summit',
	'Oncology Forum',
	'Nursing Leadership Summit',
	'Pediatric Forum',
	'Rural Health Roundtable',
	'Behavioral Health Forum'
];

{
	const body = EVENTS.map(
		(e) =>
			`## ${e}\n\nA recurring franchise held each year for hospital executives, with roughly two thousand attendees and a dedicated sponsorship tier structure.\n`
	).join('\n');
	const note = { path: 'wiki/events/index.md', content: `---\ntitle: Events\n---\n\n${body}` };
	const out = inlinedConceptSuggestions(
		[note],
		[{ path: 'wiki/events/index.md', title: 'Events' }]
	);
	check('events: 12 inlined franchises are flagged', out.length === 1, JSON.stringify(out));
	check('events: names the count', out[0]?.includes('12 sections') === true, out[0]);
	check('events: names an example', out[0]?.includes('Annual Meeting') === true, out[0]);
}

{
	// The same folder done correctly: a listing whose entries link out to real pages.
	const body = EVENTS.map(
		(e) =>
			`## ${e}\n\n* [${e}](./${e.toLowerCase().replace(/\s+/g, '-')}.md) - a recurring franchise for hospital executives held annually.\n`
	).join('\n');
	const out = inlinedConceptSuggestions(
		[{ path: 'wiki/events/index.md', content: body }],
		[{ path: 'wiki/events/index.md', title: 'Events' }]
	);
	check('listing: sections that link out are not flagged', out.length === 0, JSON.stringify(out));
}

{
	// A narrative folder note: structural headings, each with real prose.
	const body = ['Overview', 'Background', 'Approach', 'Risks', 'Next steps']
		.map(
			(h) =>
				`## ${h}\n\nSeveral paragraphs of ordinary explanatory prose that carries well past the substantive-section threshold used by the heuristic.\n`
		)
		.join('\n');
	const out = inlinedConceptSuggestions(
		[{ path: 'wiki/projects/index.md', content: body }],
		[{ path: 'wiki/projects/index.md', title: 'Projects' }]
	);
	check('narrative: structural headings are not flagged', out.length === 0, JSON.stringify(out));
}

{
	// Question-shaped and sentence-length headings are prose, not entities.
	const body = [
		'Why this matters',
		'How we decided on the vendor',
		'What happens when a contract lapses',
		'Should we renew the enterprise agreement'
	]
		.map(
			(h) =>
				`## ${h}\n\nSeveral paragraphs of ordinary explanatory prose that carries well past the substantive-section threshold used by the heuristic.\n`
		)
		.join('\n');
	const out = inlinedConceptSuggestions(
		[{ path: 'wiki/notes/index.md', content: body }],
		[{ path: 'wiki/notes/index.md', title: 'Notes' }]
	);
	check('narrative: question/verb headings are not flagged', out.length === 0, JSON.stringify(out));
}

{
	// Three concept sections is under the threshold — a short overview, not a roster.
	const body = EVENTS.slice(0, 3)
		.map(
			(e) =>
				`## ${e}\n\nA recurring franchise held each year for hospital executives, with a dedicated sponsorship tier structure.\n`
		)
		.join('\n');
	const out = inlinedConceptSuggestions(
		[{ path: 'wiki/events/index.md', content: body }],
		[{ path: 'wiki/events/index.md', title: 'Events' }]
	);
	check('threshold: 3 sections stay quiet', out.length === 0, JSON.stringify(out));
}

{
	// Sections naming pages that already exist are a listing missing its links —
	// a lesser problem, and deliberately not this check's business.
	const body = EVENTS.map(
		(e) =>
			`## ${e}\n\nA recurring franchise held each year for hospital executives, with a dedicated sponsorship tier structure.\n`
	).join('\n');
	const pages = [
		{ path: 'wiki/events/index.md', title: 'Events' },
		...EVENTS.map((e) => ({
			path: `wiki/events/${e.toLowerCase().replace(/\s+/g, '-')}.md`,
			title: e
		}))
	];
	const out = inlinedConceptSuggestions([{ path: 'wiki/events/index.md', content: body }], pages);
	check(
		'existing pages: sections with a real page are not flagged',
		out.length === 0,
		JSON.stringify(out)
	);
}

{
	// The same listing, but the pages are found by FILENAME rather than title (their
	// titles come from an H1 that says something longer). Both sides of this lookup
	// go through wikilinkKey, so a Title Case filename matches — keeping the raw
	// filename here reported every one of these pages as homeless.
	const body = EVENTS.map(
		(e) =>
			`## ${e}\n\nA recurring franchise held each year for hospital executives, with a dedicated sponsorship tier structure.\n`
	).join('\n');
	const pages = [
		{ path: 'wiki/events/index.md', title: 'Events' },
		...EVENTS.map((e) => ({ path: `wiki/events/${e}.md`, title: `${e} (annual series)` }))
	];
	const out = inlinedConceptSuggestions([{ path: 'wiki/events/index.md', content: body }], pages);
	check(
		'existing pages: matched by filename, not only by title',
		out.length === 0,
		JSON.stringify(out)
	);
}

{
	// A rendered okf-view's own headings are generated, not authored.
	const view = EVENTS.map(
		(e) => `## ${e}\n\nGenerated tally line for this group of pages here.\n`
	).join('\n');
	const body = `# Events\n\n\`\`\`okf-view\nkind: pages\nunder: events/\ngroup-by: type\n\`\`\`\n\n<!-- okf-view:snapshot -->\n${view}\n<!-- /okf-view:snapshot -->\n`;
	const out = inlinedConceptSuggestions(
		[{ path: 'wiki/events/index.md', content: body }],
		[{ path: 'wiki/events/index.md', title: 'Events' }]
	);
	check('views: fenced directive content is ignored', out.length === 0, JSON.stringify(out));
}

// ---------- type: consistency ----------

{
	check('type: empty brain says nothing', typeFieldSuggestions([], new Map()).length === 0);
}

{
	const pages = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }];
	const out = typeFieldSuggestions(pages, new Map());
	check('type: wholly untyped brain gets one soft note', out.length === 1, JSON.stringify(out));
	check('type: soft note does not list pages', out[0]?.includes('a.md') === false, out[0]);
}

{
	const pages = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }];
	const byPath = new Map([
		['a.md', fields({ type: ['Vendor'] })],
		['b.md', fields({ type: ['Vendor'] })]
	]);
	const out = typeFieldSuggestions(pages, byPath);
	check('type: half-typed brain is flagged', out.length === 1, JSON.stringify(out));
	check('type: names the straggler', out[0]?.includes('c.md') === true, out[0]);
	check('type: counts correctly', out[0]?.includes('1 of 3') === true, out[0]);
}

{
	const pages = [{ path: 'a.md' }, { path: 'b.md' }];
	const byPath = new Map([
		['a.md', fields({ type: ['Vendor'] })],
		['b.md', fields({ type: ['Person'] })]
	]);
	check('type: fully typed brain says nothing', typeFieldSuggestions(pages, byPath).length === 0);
}

{
	const pages = [{ path: 'a.md' }, { path: 'b.md' }];
	const byPath = new Map([
		['a.md', fields({ type: ['Vendor'] })],
		['b.md', fields({ type: ['   '] })]
	]);
	const out = typeFieldSuggestions(pages, byPath);
	check(
		'type: blank type counts as missing',
		out[0]?.includes('b.md') === true,
		JSON.stringify(out)
	);
}

// ---------- nested frontmatter (OKF v0.2 trust family) ----------
//
// These shapes are NOT in our flat subset, and the write path used to destroy them:
// `generated: {by, at}` parsed to '' and `sources: [{resource, title}]` lost every
// sub-key but the first. They are now held verbatim and replayed byte-for-byte.

const OKF_FM = `---
type: Event Series
title: Annual Meeting
sources:
  - resource: /source/faq.md
    title: Event Info FAQ
  - resource: /source/playbook.md
    title: Playbook
generated:
  by: claude
  at: 2026-07-24T10:00:00Z
verified:
  - by: alex
    at: 2026-07-24
tags:
  - events
  - flagship
status: stable
---

Body text.
`;

{
	const { frontmatter, body } = parseFrontmatter(OKF_FM);
	check('okf fm: parses', !!frontmatter);
	check('okf fm: flat scalar still flat', frontmatter?.type === 'Event Series');
	check(
		'okf fm: flat list still a list',
		Array.isArray(frontmatter?.tags) && (frontmatter.tags as string[]).length === 2
	);
	check('okf fm: nested map is opaque', isFrontmatterBlock(frontmatter?.generated));
	check('okf fm: list of mappings is opaque', isFrontmatterBlock(frontmatter?.sources));
	check('okf fm: nested list of mappings is opaque', isFrontmatterBlock(frontmatter?.verified));
	check('okf fm: body survives', body.trim() === 'Body text.');

	// The whole point: a save must not change bytes it does not mean to change.
	const round = withFrontmatter(frontmatter!, body);
	const head = (s: string) => s.slice(0, s.indexOf('\n---', 3) + 4);
	check('okf fm: round-trips byte-identically', head(OKF_FM) === head(round), head(round));
}

{
	// Regression: the flat cases the brain actually authors must be untouched.
	const flat = `---\ntitle: Acme\nsources:\n  - source/faq.md\n  - source/pricing.md\nempty:\ninline: [a, b]\n---\n\nBody.\n`;
	const { frontmatter } = parseFrontmatter(flat);
	check(
		'flat fm: simple list still parses as strings',
		Array.isArray(frontmatter?.sources) &&
			(frontmatter.sources as string[])[1] === 'source/pricing.md'
	);
	check('flat fm: bare key is empty string', frontmatter?.empty === '');
	check(
		'flat fm: inline array still parses',
		Array.isArray(frontmatter?.inline) && (frontmatter.inline as string[]).length === 2
	);
}

{
	// A `|` block scalar keeps its indicator, so the value is not silently reflowed.
	const blockScalar = `---\ntitle: Acme\nnote: |\n  line one\n  line two\n---\n\nBody.\n`;
	const { frontmatter, body } = parseFrontmatter(blockScalar);
	check('block scalar: opaque', isFrontmatterBlock(frontmatter?.note));
	const round = withFrontmatter(frontmatter!, body);
	check('block scalar: indicator preserved', round.includes('note: |'), round);
	check('block scalar: lines preserved', round.includes('  line two'), round);
}

// ---------- page title: ONE resolver, H1 included ----------
//
// Redundancy #1: a page states its name three ways (frontmatter, body H1, filename)
// and only two were consulted, by two duplicate implementations. The H1 — the name
// the reader actually sees — was ignored, and every folder note without frontmatter
// was titled "index".

{
	const fm = `---\ntitle: Acme Corp\n---\n\n# Something Else\n\nBody.\n`;
	check('title: explicit frontmatter wins over H1', pageTitle('wiki/acme.md', fm) === 'Acme Corp');
}

{
	const h1 = `---\nstatus: draft\n---\n\n# Acme Corporation\n\nBody.\n`;
	check(
		'title: H1 used when frontmatter has no title',
		pageTitle('wiki/acme.md', h1) === 'Acme Corporation'
	);
}

{
	const bare = `# Acme Corporation\n\nBody.\n`;
	check(
		'title: H1 used when there is no frontmatter at all',
		pageTitle('wiki/acme.md', bare) === 'Acme Corporation'
	);
}

{
	const fenced = '```sh\n# not a title\n```\n\n# Real Title\n\nBody.\n';
	check(
		'title: H1 inside a code fence is ignored',
		pageTitle('wiki/x.md', fenced) === 'Real Title'
	);
}

{
	check(
		'title: heading markup is stripped',
		pageTitle('wiki/x.md', '# **[[Acme Corp]]**\n') === 'Acme Corp'
	);
	check(
		'title: heading link text is kept',
		pageTitle('wiki/x.md', '# [Acme](https://acme.test)\n') === 'Acme'
	);
}

{
	check('title: ## is not an H1', pageTitle('wiki/my-page.md', '## Sub\n\nBody.\n') === 'my page');
}

{
	// The bug this fixes: every note-less folder note was called "index".
	check(
		'title: folder note falls back to the FOLDER name',
		pageTitle('wiki/vendors/index.md', 'Body with no heading.\n') === 'vendors'
	);
	check(
		'title: README folder note too',
		pageTitle('wiki/key-vendors/README.md', 'Body.\n') === 'key vendors'
	);
	check(
		'title: folder note still prefers its H1',
		pageTitle('wiki/vendors/index.md', '# Our Vendors\n') === 'Our Vendors'
	);
}

{
	check(
		'title: ordinary page falls back to deslugged filename',
		pageTitle('wiki/model-eval.md', 'Body.\n') === 'model eval'
	);
}

// ---------- ambiguous titles (what makes a wikilink land on the wrong page) ----------

{
	const out = ambiguousTitleSuggestions([
		{ path: 'wiki/a/acme.md', title: 'Acme' },
		{ path: 'wiki/b/acme.md', title: 'acme' },
		{ path: 'wiki/other.md', title: 'Other' }
	]);
	check('titles: duplicate title flagged', out.length === 1, JSON.stringify(out));
	check('titles: match is case-insensitive', out[0]?.includes('2 pages') === true, out[0]);
	check('titles: names both paths', out[0]?.includes('wiki/b/acme.md') === true, out[0]);
}

{
	const out = ambiguousTitleSuggestions([
		{ path: 'a.md', title: 'One' },
		{ path: 'b.md', title: 'Two' }
	]);
	check('titles: distinct titles stay quiet', out.length === 0, JSON.stringify(out));
}

// ---------- link syntax: one count, and a portability note ----------

{
	const out = wikilinkPortabilityNote([
		{ kind: 'md', cnt: 3 },
		{ kind: 'wiki', cnt: 2 },
		{ kind: 'wiki', cnt: 1 }
	]);
	check('links: wikilinks reported', out.length === 1, JSON.stringify(out));
	check('links: counts are right', out[0]?.includes('3 of 6') === true, out[0]);
}

{
	check(
		'links: all-markdown brain stays quiet',
		wikilinkPortabilityNote([{ kind: 'md', cnt: 4 }]).length === 0
	);
}

{
	// backlinksTo now carries a single `count`, so no caller has to sum the two kinds.
	const graph = {
		pages: [
			{ path: 'a.md', title: 'A' },
			{ path: 'b.md', title: 'B' }
		],
		edges: [
			{ source: 'a.md', target: 'b.md', kind: 'md' as const, cnt: 2 },
			{ source: 'a.md', target: 'b.md', kind: 'wiki' as const, cnt: 3 }
		],
		broken: []
	};
	const refs = backlinksTo(graph, 'b.md');
	check('backlinks: single source aggregated', refs.length === 1, JSON.stringify(refs));
	check('backlinks: count totals both syntaxes', refs[0]?.count === 5, JSON.stringify(refs[0]));
	check(
		'backlinks: split still available',
		refs[0]?.mdCount === 2 && refs[0]?.wikiCount === 3,
		JSON.stringify(refs[0])
	);
}

// ---------- folder-move collisions ----------

{
	const rename = (p: string) => `Archive/Todos${p.slice('Todos'.length)}`;
	const existing = new Set([
		'Archive/Todos/.gitkeep',
		'Archive/Todos/old-task.md',
		'Todos/.gitkeep',
		'Todos/task-one.md'
	]);
	const moved = ['Todos/.gitkeep', 'Todos/task-one.md'];
	const only = folderMoveCollisions(moved, existing, rename);
	check(
		'collisions: a folder marker alone does not block a merge',
		only.blocking.length === 0 && only.scaffolding.length === 1,
		JSON.stringify(only)
	);

	const clash = folderMoveCollisions(
		['Todos/.gitkeep', 'Todos/old-task.md', 'Todos/other.md'],
		existing,
		rename
	);
	check(
		'collisions: a real page still blocks',
		clash.blocking.length === 1 && clash.blocking[0] === 'Todos/old-task.md',
		JSON.stringify(clash)
	);

	const many = folderMoveCollisions(
		['Todos/a.md', 'Todos/b.md'],
		new Set(['Archive/Todos/a.md', 'Archive/Todos/b.md']),
		rename
	);
	check(
		'collisions: every blocker is collected, not just the first',
		many.blocking.length === 2,
		JSON.stringify(many)
	);

	const clean = folderMoveCollisions(['Todos/a.md'], new Set(['Archive/Todos/b.md']), rename);
	check(
		'collisions: nothing in the way means nothing reported',
		clean.blocking.length === 0 && clean.scaffolding.length === 0
	);
}

console.log(failures === 0 ? '\nAll structure checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
