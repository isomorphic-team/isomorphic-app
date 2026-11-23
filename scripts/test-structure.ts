// Golden test for OKF conformance: the structure advisories in src/lib/advisories.ts
// (inlined concepts on folder notes, `type:` consistency, ambiguous titles, wikilink
// portability, note-less folders), the page-title resolver and verbatim preservation
// of nested frontmatter in src/lib/wiki.ts, and folder-move collisions in
// src/tools/librarian.ts. Pure, no D1, no GitHub. Run: pnpm test:structure
//
// The first case is the regression this whole check exists for: a folder note that
// held twelve event franchises as prose sections instead of giving each its own
// page, in a brain whose other folders were already one-file-per-entity.
import { folderMoveCollisions } from '../src/tools/librarian.ts';
import {
	inlinedConceptSuggestions,
	typeFieldSuggestions,
	predictionDueFindings,
	comingDueLines,
	checkDateOf,
	undatedCommitmentFindings,
	dueBlock,
	COMING_DUE_DAYS,
	MAX_COMING_DUE_LINES,
	ambiguousTitleSuggestions,
	wikilinkPortabilityNote,
	folderNoteSuggestions
} from '../src/lib/advisories.ts';
import {
	findingKey,
	filterDismissed,
	importFindings,
	type ReviewLedger
} from '../src/lib/findings.ts';
import {
	parseFrontmatter,
	withFrontmatter,
	isFrontmatterBlock,
	pageTitle
} from '../src/lib/wiki.ts';
import type { PageFields } from '../src/lib/brain-index.ts';

import { checker } from './check.ts';

const { check, done } = checker('structure checks');

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
	check(
		'events: names the count',
		out[0]?.headline.includes('12 sections') === true,
		out[0]?.headline
	);
	check(
		'events: names an example',
		out[0]?.headline.includes('Annual Meeting') === true,
		out[0]?.headline
	);
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
	check(
		'type: soft note does not list pages',
		out[0]?.headline.includes('a.md') === false,
		out[0]?.headline
	);
}

{
	const pages = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }];
	const byPath = new Map([
		['a.md', fields({ type: ['Vendor'] })],
		['b.md', fields({ type: ['Vendor'] })]
	]);
	const out = typeFieldSuggestions(pages, byPath);
	check('type: half-typed brain is flagged', out.length === 1, JSON.stringify(out));
	check('type: names the straggler', out[0]?.headline.includes('c.md') === true, out[0]?.headline);
	check('type: counts correctly', out[0]?.headline.includes('1 of 3') === true, out[0]?.headline);
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
		out[0]?.headline.includes('b.md') === true,
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

{
	// A double-quoted YAML scalar treats `\` as an escape, so any other reader turns
	// `C:\temp` into a tab and a trailing `\` into an unterminated string.
	const fm = {
		title: 'Notes: C:\\temp',
		trail: 'ends with: \\',
		said: 'she said "hi": \\o/',
		tags: ['a: \\b']
	};
	const md = withFrontmatter(fm, 'Body.');
	check('backslash fm: escaped in a quoted scalar', md.includes('title: "Notes: C:\\\\temp"'), md);
	check('backslash fm: trailing backslash escaped', md.includes('trail: "ends with: \\\\"'), md);
	check(
		'backslash fm: quote and backslash both escaped',
		md.includes('said: "she said \\"hi\\": \\\\o/"'),
		md
	);
	check('backslash fm: list item escaped', md.includes('  - "a: \\\\b"'), md);
	const { frontmatter } = parseFrontmatter(md);
	check(
		'backslash fm: round-trips',
		JSON.stringify(frontmatter) === JSON.stringify(fm),
		JSON.stringify(frontmatter)
	);
	// A file written before backslashes were escaped still reads as written.
	const legacy = parseFrontmatter('---\ntitle: "Notes: C:\\temp"\n---\n\nBody.\n');
	check(
		'backslash fm: legacy unescaped value unchanged',
		legacy.frontmatter?.title === 'Notes: C:\\temp',
		String(legacy.frontmatter?.title)
	);
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
	check(
		'titles: match is case-insensitive',
		out[0]?.headline.includes('2 pages') === true,
		out[0]?.headline
	);
	check(
		'titles: names both paths',
		out[0]?.headline.includes('wiki/b/acme.md') === true,
		out[0]?.headline
	);
}

{
	const out = ambiguousTitleSuggestions([
		{ path: 'a.md', title: 'One' },
		{ path: 'b.md', title: 'Two' }
	]);
	check('titles: distinct titles stay quiet', out.length === 0, JSON.stringify(out));
}

// ---------- link syntax: a portability note ----------

{
	const out = wikilinkPortabilityNote([
		{ kind: 'md', cnt: 3 },
		{ kind: 'wiki', cnt: 2 },
		{ kind: 'wiki', cnt: 1 }
	]);
	check('links: wikilinks reported', out.length === 1, JSON.stringify(out));
	check('links: counts are right', out[0]?.headline.includes('3 of 6') === true, out[0]?.headline);
}

{
	check(
		'links: all-markdown brain stays quiet',
		wikilinkPortabilityNote([{ kind: 'md', cnt: 4 }]).length === 0
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

// ---------------------------------------------------------------------------
console.log('\nfolder-note advisory: a note-less folder holding its own overview');
// ---------------------------------------------------------------------------
// Flags only the unambiguous case. "This folder has no note" on its own is not a
// defect, so a folder whose pages are all ordinary concepts says nothing.
{
	const page = (path: string, title?: string) => ({
		path,
		title: title ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
	});
	const one = folderNoteSuggestions([
		page('wiki/vendors/overview.md'),
		page('wiki/vendors/acme.md')
	]);
	check('an overview page beside its siblings is flagged', one.length === 1);
	check(
		'the finding names the page and the move that fixes it',
		one[0]?.headline.includes('wiki/vendors/overview.md') &&
			one[0]?.headline.includes('wiki/vendors/index.md'),
		one[0]?.headline
	);
	check(
		'keyed on the FOLDER, so a renamed candidate keeps the same finding',
		one[0]?.key === findingKey('folder-note', 'wiki/vendors')
	);
	check('advisory weight', one[0]?.weight === 2.5);
	check(
		'a folder that already has index.md is not flagged',
		folderNoteSuggestions([
			page('wiki/vendors/index.md'),
			page('wiki/vendors/overview.md'),
			page('wiki/vendors/acme.md')
		]).length === 0
	);
	check(
		'README.md counts as the folder note too',
		folderNoteSuggestions([
			page('wiki/vendors/README.md'),
			page('wiki/vendors/overview.md'),
			page('wiki/vendors/acme.md')
		]).length === 0
	);
	check(
		'a lone page is not a folder wanting a note',
		folderNoteSuggestions([page('wiki/vendors/overview.md')]).length === 0
	);
	check(
		'repo-root pages have no folder',
		folderNoteSuggestions([page('overview.md'), page('acme.md')]).length === 0
	);
	check(
		'no overview-shaped page: silence, since "no note" is not a defect',
		folderNoteSuggestions([page('wiki/vendors/acme.md'), page('wiki/vendors/globex.md')]).length ===
			0
	);
	check(
		'a filename matching the folder name is an overview',
		folderNoteSuggestions([page('wiki/vendors/vendors.md'), page('wiki/vendors/acme.md')])
			.length === 1
	);
	check(
		'a TITLE matching the folder name is an overview',
		folderNoteSuggestions([page('wiki/vendors/x.md', 'Vendors'), page('wiki/vendors/acme.md')])
			.length === 1
	);
	check(
		'the overview basenames are matched case-insensitively',
		folderNoteSuggestions([page('wiki/Docs/Start-Here.md'), page('wiki/Docs/a.md')]).length === 1
	);
	const two = folderNoteSuggestions([
		page('wiki/z/about.md'),
		page('wiki/z/a.md'),
		page('wiki/a/home.md'),
		page('wiki/a/b.md')
	]);
	check(
		'findings are sorted by key, so validate is stable between reads',
		two.map((f) => f.key).join('|') ===
			`${findingKey('folder-note', 'wiki/a')}|${findingKey('folder-note', 'wiki/z')}`
	);
}

// ---------- prediction due ----------

{
	const TODAY = '2026-11-23';
	const due = (
		rows: Record<string, string[]>,
		path = 'decisions/pricing.md',
		today = TODAY
	): ReturnType<typeof predictionDueFindings> =>
		predictionDueFindings([{ path }], new Map([[path, fields(rows)]]), today);

	const equal = due({ check_at: ['2026-11-23'] });
	check('prediction: due today raises', equal.length === 1, JSON.stringify(equal));
	check(
		'prediction: key carries the path and the date',
		equal[0]?.key === findingKey('prediction-due', 'decisions/pricing.md@2026-11-23'),
		equal[0]?.key
	);
	check('prediction: due yesterday raises', due({ check_at: ['2026-11-22'] }).length === 1);
	check('prediction: due tomorrow does not', due({ check_at: ['2026-11-24'] }).length === 0);
	check(
		'prediction: closed by an outcome',
		due({ check_at: ['2026-11-01'], outcome: ['done'] }).length === 0
	);
	check(
		'prediction: an empty outcome does not close',
		due({ check_at: ['2026-11-01'], outcome: [''] }).length === 1
	);
	check(
		'prediction: a blank outcome does not close',
		due({ check_at: ['2026-11-01'], outcome: ['   '] }).length === 1
	);

	const dt = due({ check_at: ['2026-09-01T10:00Z'] });
	check(
		'prediction: a datetime counts by its date part',
		dt.length === 1 && dt[0]?.key.endsWith('@2026-09-01') === true,
		JSON.stringify(dt)
	);
	for (const bad of ['next week', '2026-13-45', '2026-09-01x', '']) {
		check(
			`prediction: unparseable check_at "${bad}" is ignored`,
			due({ check_at: [bad] }).length === 0
		);
	}
	check('prediction: no check_at raises nothing', due({ type: ['Decision'] }).length === 0);
	check(
		'prediction: expected alone raises nothing',
		due({ expected: ['Churn under 5%'] }).length === 0
	);

	const quoted = due({ check_at: ['2026-11-01'], expected: ['Churn stays under 5%'] })[0];
	check(
		'prediction: headline names the path, the date and the expectation',
		quoted?.headline.includes('decisions/pricing.md') === true &&
			quoted.headline.includes('2026-11-01') &&
			quoted.headline.includes('Churn stays under 5%'),
		quoted?.headline
	);
	check(
		'prediction: no expected, no expectation clause',
		due({ check_at: ['2026-11-01'] })[0]?.headline.includes('Expected') === false
	);
	const long = due({ check_at: ['2026-11-01'], expected: ['x'.repeat(300)] })[0];
	check(
		'prediction: a long expectation is truncated',
		long?.headline.includes('x'.repeat(120) + '...') === true &&
			!long.headline.includes('x'.repeat(121)),
		long?.headline
	);

	const extra = predictionDueFindings(
		[{ path: 'a.md' }],
		new Map([
			['a.md', fields({ check_at: ['2026-11-01'] })],
			['wiki/index.md', fields({ check_at: ['2026-11-01'] })]
		]),
		TODAY
	);
	check(
		'prediction: only the pages passed in are considered',
		extra.length === 1 && extra[0]?.key.includes('a.md') === true
	);

	const redated = due({ check_at: ['2026-11-10'] });
	const oldKey = due({ check_at: ['2026-11-01'] })[0]!.key;
	const ledger: ReviewLedger = {
		version: 1,
		dismissed: [{ key: oldKey, why: 'deferred', at: '2026-11-02' }]
	};
	check(
		'prediction: a dismissal hides that date',
		filterDismissed(due({ check_at: ['2026-11-01'] }), ledger).length === 0
	);
	check(
		'prediction: re-dating changes the key, so the dismissal no longer applies',
		redated[0]!.key !== oldKey && filterDismissed(redated, ledger).length === 1
	);

	const pair = predictionDueFindings(
		[{ path: 'b.md' }, { path: 'a.md' }],
		new Map([
			['a.md', fields({ check_at: ['2026-11-01'] })],
			['b.md', fields({ check_at: ['2026-11-02'] })]
		]),
		TODAY
	);
	check('prediction: two pages, two findings', pair.length === 2);

	// coming due: the week before the check date, an unkeyed section
	const comingList = (rows: Record<string, string[]>, today = TODAY) =>
		comingDueLines(
			[{ path: 'decisions/pricing.md' }],
			new Map([['decisions/pricing.md', fields(rows)]]),
			today
		);
	const coming = (rows: Record<string, string[]>, today = TODAY) =>
		comingList(rows, today).join('\n');
	check(
		'coming due: empty gives an empty list',
		comingList({ check_at: ['2026-12-25'] }).length === 0 && comingList({}).length === 0
	);
	check('coming due: the window is seven days', COMING_DUE_DAYS === 7);
	check(
		'coming due: a check_at of today is prediction-due, not coming due',
		coming({ check_at: ['2026-11-23'] }) === '' && due({ check_at: ['2026-11-23'] }).length === 1
	);
	check('coming due: tomorrow is in', coming({ check_at: ['2026-11-24'] }).includes('(in 1 day)'));
	const edge = coming({ check_at: ['2026-11-30'] });
	check(
		'coming due: today + 7 is in',
		edge.includes('check due 2026-11-30 (in 7 days)') && edge.includes('decisions/pricing.md'),
		edge
	);
	check('coming due: today + 8 is out', coming({ check_at: ['2026-12-01'] }) === '');
	check(
		'coming due: the window crosses a month end',
		coming({ check_at: ['2026-12-02'] }, '2026-11-28').includes('in 4 days')
	);
	check(
		'coming due: an outcome silences it',
		coming({ check_at: ['2026-11-25'], outcome: ['held'] }) === ''
	);
	check('coming due: unparseable check_at is ignored', coming({ check_at: ['next week'] }) === '');
	check('coming due: nothing prints when nothing is due', coming({ type: ['Decision'] }) === '');
	const quotedSoon = coming({ check_at: ['2026-11-25'], expected: ['Churn under 5%'] });
	check(
		'coming due: a line quotes the expectation and ends with the next step',
		quotedSoon.includes('Expected: Churn under 5%') &&
			quotedSoon.includes('Record it with write_page fields {outcome: ...}.'),
		quotedSoon
	);
	check('coming due: no finding key is printed', !/prediction-/.test(quotedSoon));
	for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-30', '2026-12-05']) {
		const rows = { check_at: [d] };
		check(
			`coming due: ${d} is never both coming due and prediction-due`,
			(coming(rows) !== '' ? 1 : 0) + due(rows).length <= 1
		);
	}
	const many = Array.from({ length: MAX_COMING_DUE_LINES + 5 }, (_, i) => `p${i}.md`);
	const manyLines = comingDueLines(
		many.map((path) => ({ path })),
		new Map(many.map((path) => [path, fields({ check_at: ['2026-11-25'] })])),
		TODAY
	);
	check(
		'coming due: the line cap holds and the rest is counted',
		manyLines.filter((l) => l.startsWith('- ')).length === MAX_COMING_DUE_LINES &&
			manyLines.at(-1) === '...and 5 more.',
		manyLines.join('\n')
	);
	const ordered = comingDueLines(
		[{ path: 'b.md' }, { path: 'a.md' }],
		new Map([
			['a.md', fields({ check_at: ['2026-11-26'] })],
			['b.md', fields({ check_at: ['2026-11-25'] })]
		]),
		TODAY
	);
	check('coming due: earliest first', ordered[0]!.includes('b.md') && ordered[1]!.includes('a.md'));

	// the follow-up date keys: due stands in when there is no check_at
	{
		const alias = (rows: Record<string, string[]>) => due(rows)[0];
		const viaDue = alias({ due: ['2026-11-10'], expected: ['Draft sent'] });
		check(
			'follow-up: a dated due raises with the usual key',
			viaDue?.key === findingKey('prediction-due', 'decisions/pricing.md@2026-11-10'),
			viaDue?.key
		);
		check(
			'follow-up: the headline and hint are pinned and do not say prediction',
			viaDue?.headline ===
				'- decisions/pricing.md: due 2026-11-10 (from `due`), nothing recorded. Expected: Draft sent. If done, record what happened with write_page fields {outcome: ...}; if it moved, set a new date with write_page fields {due: ...}; or dismiss with resolve and a reason.',
			viaDue?.headline
		);
		check(
			'follow-up: a check_at page keeps its wording',
			!due({ check_at: ['2026-11-10'] })[0]!.headline.includes('date from') &&
				due({ check_at: ['2026-11-10'] })[0]!.headline.includes('Record it with write_page')
		);
		check(
			'follow-up: check_at wins over due',
			due({ check_at: ['2026-12-25'], due: ['2026-11-10'] }).length === 0 &&
				alias({ check_at: ['2026-11-10'], due: ['2026-11-01'] })?.key.endsWith('@2026-11-10') ===
					true
		);
		check(
			'follow-up: a condition is ignored, a later date in the list is not',
			due({ due: ['when the audit lands'] }).length === 0 &&
				due({ due: ['after launch', '2026-11-10'] }).length === 1
		);
		check(
			'follow-up: an unparseable check_at is not replaced by due',
			due({ check_at: ['next week'], due: ['2026-11-10'] }).length === 0
		);
		check('follow-up: a future due does not raise', due({ due: ['2026-12-25'] }).length === 0);
		check(
			'follow-up: an outcome closes it',
			due({ due: ['2026-11-10'], outcome: ['sent'] }).length === 0
		);
		for (const closed of [
			'done',
			'closed',
			'complete',
			'completed',
			'resolved',
			'decided',
			'cancelled',
			'canceled',
			'dropped',
			'superseded',
			'archived',
			'deprecated'
		])
			check(
				`follow-up: status "${closed}" skips the alias path`,
				due({ due: ['2026-11-10'], status: [closed] }).length === 0
			);
		for (const [k, v] of [
			['status', 'Done'],
			['status', ' superseded '],
			['state', 'closed'],
			['state', 'ARCHIVED']
		] as const)
			check(
				`follow-up: ${k} "${v.trim()}" skips the alias path`,
				due({ due: ['2026-11-10'], [k]: [v] }).length === 0
			);
		check(
			'follow-up: a deprecated page with a past due is not raised',
			due({ due: ['2026-11-10'], status: ['deprecated'] }).length === 0 &&
				due({ due: ['2026-11-10'], state: ['Deprecated'] }).length === 0 &&
				due({ due: ['2026-11-10'], status: ['stable'] }).length === 1
		);
		check(
			'follow-up: an open status does not skip',
			due({ due: ['2026-11-10'], status: ['in progress'] }).length === 1
		);
		check(
			'follow-up: a closed status does not close a page with check_at',
			due({ check_at: ['2026-11-10'], status: ['done'] }).length === 1
		);
		check(
			'follow-up: source_key and source_keys skip the alias path',
			due({ due: ['2026-11-10'], source_key: ['crm-1'] }).length === 0 &&
				due({ due: ['2026-11-10'], source_keys: ['crm-1'] }).length === 0 &&
				due({ check_at: ['2026-11-10'], source_key: ['crm-1'] }).length === 1
		);
		check(
			'follow-up: coming due includes the alias, naming the key',
			coming({ due: ['2026-11-25'], expected: ['Draft sent'] }) ===
				'- decisions/pricing.md: due 2026-11-25 (from `due`, in 2 days). Expected: Draft sent. If done, record what happened with write_page fields {outcome: ...}; if it moved, set a new date with write_page fields {due: ...}.' &&
				coming({ due: ['2026-11-25'], status: ['done'] }) === ''
		);
		check(
			'follow-up: checkDateOf reports the key and handles a missing page',
			checkDateOf((k) => ({ due: ['2026-11-10T09:00Z'] })[k])?.key === 'due' &&
				checkDateOf(() => undefined) === undefined
		);
	}

	// the block validate opens with
	{
		const nothing = dueBlock([], 0);
		check(
			'due block: nothing due prints one line naming the keys read and the gap',
			nothing ===
				'\n\nNothing due or coming due from `check_at` or `due`; dates kept in other fields are not listed.',
			nothing
		);
		const coming1 = dueBlock(['- a.md: due 2026-11-25 (from `due`, in 2 days).'], 0);
		check(
			'due block: coming lines sit under the header',
			coming1.startsWith(
				'\n\nDue and coming due (read from `check_at` or `due`; dates kept in other fields are not listed):\n- a.md'
			),
			coming1
		);
		const overdueOnly = dueBlock([], 2);
		check(
			'due block: overdue alone still prints the header and the count',
			overdueOnly.includes('Due and coming due') &&
				overdueOnly.endsWith('\n2 overdue (prediction-due findings).') &&
				!/below|listed/.test(overdueOnly.split('\n').at(-1)!),
			overdueOnly
		);
	}

	// undated-commitment: an open decision with nothing to check it by
	{
		const undated = (rows: Record<string, string[]>, path = 'decisions/pricing.md') =>
			undatedCommitmentFindings([{ path }], new Map([[path, fields(rows)]]));
		const open = { type: ['Decision'], state: ['proposed'] };
		const base = undated(open);
		check(
			'undated: an open decision with no date raises, keyed on the path alone',
			base.length === 1 &&
				base[0]!.key === findingKey('undated-commitment', 'decisions/pricing.md'),
			JSON.stringify(base)
		);
		check(
			'undated: the headline is pinned',
			base[0]?.headline ===
				'- decisions/pricing.md: open (state proposed), no check date. Give it a check date (write_page fields {check_at: YYYY-MM-DD}), record what was decided ({outcome: ...}), or close it in the field the page uses for its state; or dismiss with resolve and a reason.',
			base[0]?.headline
		);
		check(
			'undated: raised is shown as found; updated is not, and a non-date raised is omitted',
			undated({ ...open, updated: ['2026-06-10'], raised: ['2026-03-01'] })[0]?.headline.includes(
				'no check date; raised 2026-03-01. Give it'
			) === true &&
				!undated({ ...open, updated: ['2026-06-10'] })[0]!.headline.includes('updated') &&
				!base[0]!.headline.includes('raised') &&
				!undated({ ...open, raised: ['sometime'] })[0]!.headline.includes('raised')
		);
		check(
			'undated: the headline names the key the page uses',
			undated({ type: ['Commitment'], status: ['open'] })[0]?.headline.includes('(status open)') ===
				true &&
				undated({ type: ['Commitment'], state: ['open'] })[0]?.headline.includes('(state open)') ===
					true
		);
		check(
			'undated: type matching is the commitment pattern, first type only',
			undated({ ...open, type: ['Adopted Decision Record'] }).length === 1 &&
				undated({ ...open, type: ['Note'] }).length === 0 &&
				undated({ ...open, type: ['Note', 'Decision'] }).length === 0
		);
		check(
			'undated: no state or status raises nothing',
			undated({ type: ['Decision'] }).length === 0 &&
				undated({ type: ['Decision'], status: [' '] }).length === 0 &&
				undated({ type: ['Decision'], state: [''] }).length === 0
		);
		check(
			'undated: the page statuses draft and stable say nothing about the commitment',
			undated({ type: ['Decision'], status: ['draft'] }).length === 0 &&
				undated({ type: ['Decision'], status: ['stable'] }).length === 0 &&
				undated({ type: ['Decision'], status: ['Stable'] }).length === 0
		);
		check(
			'undated: a status that is not a page status raises, and so does any state',
			undated({ type: ['Decision'], status: ['open'] }).length === 1 &&
				undated({ type: ['Decision'], status: ['stable'], state: ['open'] }).length === 1 &&
				undated({
					type: ['Decision'],
					status: ['draft'],
					state: ['proposed']
				})[0]?.headline.includes('(state proposed)') === true
		);
		check(
			'undated: a state of draft or stable is still a state, so it raises',
			undated({ type: ['Decision'], state: ['draft'] }).length === 1 &&
				undated({ type: ['Decision'], state: ['stable'] }).length === 1
		);
		for (const closed of [
			'done',
			'Closed',
			'complete',
			'completed',
			'resolved',
			'decided',
			'cancelled',
			'canceled',
			'dropped',
			'superseded',
			'archived',
			'deprecated'
		])
			check(
				`undated: status "${closed}" raises nothing`,
				undated({ type: ['Decision'], status: [closed] }).length === 0 &&
					undated({ type: ['Decision'], state: [closed] }).length === 0
			);
		check(
			'undated: a closed state beats an open status',
			undated({ type: ['Decision'], status: ['open'], state: ['decided'] }).length === 0
		);
		check(
			'undated: check_at or due (even past) raises nothing',
			undated({ ...open, check_at: ['2026-12-01'] }).length === 0 &&
				undated({ ...open, due: ['2026-01-01'] }).length === 0
		);
		check(
			'undated: a due that is not a date does not count as a date',
			undated({ ...open, due: ['when the audit lands'] }).length === 1
		);
		check(
			'undated: an outcome raises nothing',
			undated({ ...open, outcome: ['held'] }).length === 0
		);
		check('undated: an empty outcome does not', undated({ ...open, outcome: [''] }).length === 1);
		check(
			'undated: a non-empty revisit raises nothing',
			undated({ ...open, revisit: ['after launch'] }).length === 0
		);
		check(
			'undated: source_key and source_keys raise nothing',
			undated({ ...open, source_key: ['crm-1'] }).length === 0 &&
				undated({ ...open, source_keys: ['crm-1'] }).length === 0
		);
		check(
			'undated: editing the page keeps the key',
			undated({ ...open, state: ['in progress'], updated: ['2026-07-01'] })[0]?.key === base[0]!.key
		);
		check(
			'undated: it ranks below prediction-due',
			base[0]!.weight < due({ check_at: ['2026-11-01'] })[0]!.weight
		);
		check(
			'undated: only the pages passed in are considered',
			undatedCommitmentFindings([], new Map([['a.md', fields(open)]])).length === 0
		);
	}

	const typed = typeFieldSuggestions(
		[{ path: 'a.md' }, { path: 'b.md' }],
		new Map([['a.md', fields({ type: ['X'] })]])
	);
	const imp = importFindings('src', [{ key: 'k', kind: 'needs-decision', reason: 'r' }]);
	const w = equal[0]!.weight;
	check(
		'prediction: weight sits between structure advisories and import findings',
		w === 3 && typed[0]!.weight < w && w < imp[0]!.weight
	);
}

done();
