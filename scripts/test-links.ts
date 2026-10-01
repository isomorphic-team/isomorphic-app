// Golden test for the link graph: how a [[wikilink]] finds its page, what validate
// says about the ones that find nothing, what a markdown link means
// (classifyMdLink), attachments as file edges, and backlinksTo. Pure: D1 is shimmed
// over node:sqlite, GitHub is scripts/fake-github.ts, no network.
//
//   pnpm test:links
//
// Why this file exists (issue #12): the lookup table was keyed by a page's RAW
// filename and queried with the SLUGIFIED link text, so a page whose filename was
// not already slug-shaped could only ever be found through the title lane. On a
// brain of dated meeting notes and Title Case filenames that meant ~100 links
// reported broken whose targets `list_pages` and `read_page` returned happily.
// Every case below is a form a human writes by hand and expects to work.

import {
	backlinksTo,
	ensureFresh,
	loadResolvedGraph,
	type BrokenLink,
	type ResolvedGraph
} from '../src/lib/brain-index.ts';
import { githubStore } from '../src/lib/brain-repo.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { DEFAULT_BRAIN_CONFIG, type BrainConfig } from '../src/lib/brain-policy.ts';
import { extractLinks, rewriteWikiLinks, wikilinkKey } from '../src/lib/wiki.ts';
import { classifyMdLink } from '../src/lib/links.ts';
import { brokenLinkReport } from '../src/lib/advisories.ts';

import { checker } from './check.ts';
import { fakeGithub, type FakePage } from './fake-github.ts';

const { check, done } = checker('link checks');

// ---- D1 over node:sqlite (real migrations) + a fake GitHub behind githubStore ----

let { db } = localD1();
const gh = fakeGithub();
const store = githubStore(gh.octokit);
const repo = { owner: 'example-org', repo: 'brain' };
const brainId = 'example-org/brain';
const config: BrainConfig = { ...DEFAULT_BRAIN_CONFIG };

async function indexAndResolve(pages: FakePage[]): Promise<ResolvedGraph> {
	({ db } = localD1());
	gh.pages = pages;
	gh.head = `commit-${pages.length}`;
	await ensureFresh(db, store, repo, brainId, config);
	return loadResolvedGraph(db, brainId, config);
}

const page = (path: string, content: string): FakePage => ({
	path,
	sha: `sha-${path}`,
	content
});

// A brain shaped like the one in the report: dated notes, Title Case filenames,
// a project folder with a folder note and leaf pages.
const BRAIN: FakePage[] = [
	page(
		'wiki/Meetings/2026-06-26 Weekly Sync.md',
		['---', 'type: Meeting', '---', '', 'Notes from the sync.', '', '## Decisions', ''].join('\n')
	),
	page(
		'wiki/Meetings/2026-07-03 Weekly Sync.md',
		[
			'---',
			'type: Meeting',
			'---',
			'',
			'Follow-up to [[2026-06-26 Weekly Sync]] — same folder, same shape.',
			''
		].join('\n')
	),
	page('wiki/People/Jane Doe.md', ['---', 'type: Person', '---', '', '# Jane Doe', ''].join('\n')),
	page(
		'wiki/Projects/Atlas/index.md',
		['---', 'type: Project', '---', '', 'Atlas is a project.', ''].join('\n')
	),
	page(
		'wiki/Projects/Atlas/Architecture.md',
		['---', 'type: Note', '---', '', '# Atlas Architecture', '', 'How Atlas is built.', ''].join(
			'\n'
		)
	),
	page(
		'wiki/Todos/2026-Q3.md',
		['---', 'type: Todo', 'status: draft', '---', '', '- [ ] something', ''].join('\n')
	),
	page(
		'wiki/index.md',
		[
			'Everything links from here:',
			'',
			'- [[2026-06-26 Weekly Sync]] — a dated note by filename',
			'- [[Jane Doe]] — by title',
			'- [[jane doe]] — by title, wrong case',
			'- [[Atlas]] — a folder note by its folder name',
			'- [[Architecture]] — a leaf page by filename, titled differently',
			'- [[2026-Q3]] — a dated todo',
			'- [[Meetings/2026-06-26 Weekly Sync]] — path form',
			'- [[2026-06-26 Weekly Sync#Decisions]] — with a heading anchor',
			'- [[Jane Doe|Jane]] — with an alias',
			'- [[Atlas Architecture]] — by its H1 title',
			'- [[Nowhere At All]] — genuinely missing',
			''
		].join('\n')
	),
	// The permanent-noise case: a conventions page whose [[…]] are illustrative
	// syntax, not links. In code they are code, and nothing should report them.
	page(
		'wiki/Conventions.md',
		[
			'Link to a person with `[[Name]]`, and to a project with `[[Project]]`.',
			'',
			'```markdown',
			'# Daily note',
			'',
			'See [[daily note]] and [[wiki-links]].',
			'[a broken md link](./nowhere-in-a-fence.md)',
			'```',
			'',
			'Real link: [[Jane Doe]].',
			''
		].join('\n')
	)
];

console.log('\nLink resolution — how a [[wikilink]] finds its page\n');

// ---------------------------------------------------------------- resolution
{
	const graph = await indexAndResolve(BRAIN);
	const from = 'wiki/index.md';
	const brokenFrom = (source: string) => graph.broken.filter((b) => b.source === source);
	const brokenTargets = new Set(graph.broken.map((b) => b.rawTarget));

	const resolves = (label: string, path: string) =>
		check(
			label,
			graph.edges.some((e) => e.source === from && e.target === path),
			`edges from index.md: ${graph.edges
				.filter((e) => e.source === from)
				.map((e) => e.target)
				.join(', ')}`
		);

	// The reported bug: filenames that are not already slug-shaped.
	resolves('dated filename with spaces resolves', 'wiki/Meetings/2026-06-26 Weekly Sync.md');
	resolves('dated filename in another folder resolves', 'wiki/Todos/2026-Q3.md');
	resolves(
		'a single-word filename that differs from the page title resolves',
		'wiki/Projects/Atlas/Architecture.md'
	);
	// The forms that already worked — regression guards.
	resolves('title match still resolves', 'wiki/People/Jane Doe.md');
	resolves('folder note by folder name still resolves', 'wiki/Projects/Atlas/index.md');

	check('wrong case resolves', !brokenTargets.has('jane doe'), [...brokenTargets].join(' | '));
	check(
		'path form resolves',
		!brokenTargets.has('Meetings/2026-06-26 Weekly Sync'),
		[...brokenTargets].join(' | ')
	);
	check(
		'heading anchor is ignored when resolving',
		!brokenTargets.has('2026-06-26 Weekly Sync#Decisions'),
		[...brokenTargets].join(' | ')
	);
	check(
		'H1-derived title resolves',
		!brokenTargets.has('Atlas Architecture'),
		[...brokenTargets].join(' | ')
	);
	check(
		'same-folder link resolves',
		brokenFrom('wiki/Meetings/2026-07-03 Weekly Sync.md').length === 0,
		JSON.stringify(brokenFrom('wiki/Meetings/2026-07-03 Weekly Sync.md'))
	);

	// A missing page is still reported — the fix must not resolve everything.
	check(
		'a genuinely missing target is still broken',
		brokenTargets.has('Nowhere At All'),
		[...brokenTargets].join(' | ')
	);

	// Illustrative syntax inside code is not a link.
	check(
		'wikilinks inside inline code are not links',
		!brokenTargets.has('Name') && !brokenTargets.has('Project'),
		[...brokenTargets].join(' | ')
	);
	check(
		'wikilinks inside a fenced block are not links',
		!brokenTargets.has('daily note') && !brokenTargets.has('wiki-links'),
		[...brokenTargets].join(' | ')
	);
	check(
		'md links inside a fenced block are not links',
		!graph.broken.some((b) => b.rawTarget.includes('nowhere-in-a-fence')),
		JSON.stringify(graph.broken)
	);
	check(
		'a real link on a page that also shows syntax still counts',
		graph.edges.some(
			(e) => e.source === 'wiki/Conventions.md' && e.target === 'wiki/People/Jane Doe.md'
		),
		JSON.stringify(graph.edges.filter((e) => e.source === 'wiki/Conventions.md'))
	);
}

// ---------------------------------------------------------------- keys
{
	check(
		'key: spaces and hyphens are the same key',
		wikilinkKey('2026-06-26 Weekly Sync') === wikilinkKey('2026 06 26 weekly sync')
	);
	check('key: case-insensitive', wikilinkKey('Jane Doe') === wikilinkKey('jane doe'));
	check(
		'key: path segments survive',
		wikilinkKey('Meetings/Weekly Sync') === 'meetings/weekly-sync'
	);
	check('key: empty stays empty', wikilinkKey('   ') === '');
}

// ---------------------------------------------------------------- extraction
{
	const links = extractLinks(
		['A [[Real Page]] and `[[Not A Page]]`.', '', '~~~', '[[Also Not]]', '~~~', ''].join('\n')
	);
	check(
		'extractLinks skips code',
		links.length === 1 && links[0].target === 'Real Page',
		JSON.stringify(links)
	);
	const nested = extractLinks('```\n`[[A]]`\n```\ntail [[B]]');
	check(
		'extractLinks: fence wins over inline code',
		nested.length === 1 && nested[0].target === 'B',
		JSON.stringify(nested)
	);
}

// ---------------------------------------------------------------- rewriting
{
	const body = 'See [[Weekly Sync]], [[weekly-sync|the sync]] and [[Weekly Sync#Notes]].';
	const out = rewriteWikiLinks(body, 'Weekly Sync', 'Sync Notes');
	check('rewrite: all spellings repointed', out.changed === 3, JSON.stringify(out));
	check('rewrite: alias preserved', out.body.includes('[[Sync Notes|the sync]]'), out.body);
	check('rewrite: anchor preserved', out.body.includes('[[Sync Notes#Notes]]'), out.body);
	const dollar = rewriteWikiLinks('[[A]]', 'A', 'B $& C');
	check('rewrite: $& in the new title is literal', dollar.body === '[[B $& C]]', dollar.body);
	const untouched = rewriteWikiLinks('[[Other]]', 'A', 'B');
	check(
		'rewrite: unrelated links untouched',
		untouched.changed === 0 && untouched.body === '[[Other]]'
	);
}

// ---------------------------------------------------------------- the report
{
	const pages = [
		{ path: 'wiki/People/Jane Doe.md', title: 'Jane Doe' },
		{ path: 'wiki/Meetings/2026-06-26 Weekly Sync.md', title: '2026 06 26 Weekly Sync' }
	];
	const broken: BrokenLink[] = [
		{ source: 'wiki/a.md', rawTarget: '../gone.md', kind: 'md', target: 'wiki/gone.md' },
		{ source: 'wiki/a.md', rawTarget: 'Jane Doe Jr', kind: 'wiki' },
		{ source: 'wiki/b.md', rawTarget: 'Project', kind: 'wiki' },
		{ source: 'wiki/c.md', rawTarget: 'Project', kind: 'wiki' }
	];
	const report = brokenLinkReport(broken, pages).join('\n');
	check(
		'report: markdown links get their own section',
		/markdown link\(s\) point at a file that isn't there/.test(report),
		report
	);
	check(
		'report: wikilinks get their own section',
		/wikilink\(s\) match no page/.test(report),
		report
	);
	check(
		'report: a repeated wikilink is one line naming both pages',
		/\[\[Project\]\][^\n]*wiki\/b\.md[^\n]*wiki\/c\.md/.test(report),
		report
	);
	check(
		'report: a near miss suggests the page it probably meant',
		/Jane Doe Jr[^\n]*Jane Doe/.test(report),
		report
	);
	check('report: nothing broken produces nothing', brokenLinkReport([], pages).length === 0);
}

// ---- what a MARKDOWN link means, as a pure rule ----
//
// classifyMdLink is the single authority: the content index calls it per stored
// link and the dev harness calls it while scanning fixtures, so a disagreement
// here is a preview that manufactures bugs prod does not have. It was only ever
// covered THROUGH loadResolvedGraph, which cannot reach the cases D1 never stores
// (an external href, an unresolvable target) — so the rule gets its own checks.
{
	console.log('\nmarkdown link classification');
	const cfg = DEFAULT_BRAIN_CONFIG;
	const src = 'wiki/vendors/acme.md';
	const known = (p: string) => p === 'wiki/index.md';
	const kindOf = (href: string) => classifyMdLink(src, href, cfg, known).kind;

	check('a link to a known page is an edge', kindOf('../index.md') === 'page');
	check('a link to a missing page is broken', kindOf('./nope.md') === 'broken');
	check('an image is a file reference', kindOf('./assets/logo.png') === 'file');
	// The widening: the app cannot preview a .csv, but the brain can still lose it.
	check('so is a non-media content file', kindOf('./data/pricing.csv') === 'file');
	check('source material is ignored, never broken', kindOf('../../raw/notes.md') === 'ignore');

	// Extraction already drops http/mailto/#, so these only arrive via a caller that
	// does its own scanning — which is exactly what the harness is. tel: and data:
	// are NOT filtered upstream, so this is the only thing standing between a
	// `data:` URI and resolveRelative.
	for (const href of ['https://example.com/a.md', 'mailto:a@example.com', '#section']) {
		check(`external href is ignored: ${href}`, kindOf(href) === 'ignore');
	}
	check('a tel: link is ignored', kindOf('tel:+15550100') === 'ignore');
	check('a data: URI is ignored', kindOf('data:text/plain;base64,AAAA') === 'ignore');

	// A hidden file is not content anyone links to on purpose, and treating
	// `.gitkeep` as a reference would make every scaffolded folder look load-bearing.
	check('a dotfile is not a file reference', kindOf('./.gitkeep') === 'ignore');
}

// ---- attachments in the link graph ----
//
// An image or other non-page file a page links to is a FILE edge: kept out of the
// page edge list, never reported broken, and found by backlinksTo, which is the call
// move_page and delete_page make before repointing or removing it.
//
// The .png is never added to the tree: the index has no inventory of assets, so the
// file edge comes from the link alone.
{
	console.log('\nattachments in the link graph');
	const g = await indexAndResolve([
		page(
			'wiki/vendors/acme.md',
			[
				'# Acme',
				'',
				'![The logo](./assets/logo.png)',
				'A [real page](../index.md) and a [missing one](./nope.md).',
				'A [source doc](../../raw/notes.txt) too.',
				'And a [spreadsheet](./data/pricing.csv) the app cannot render.'
			].join('\n')
		),
		page('wiki/index.md', '# Index\n\nAlso shows ![it](./vendors/assets/logo.png).')
	]);

	const asset = 'wiki/vendors/assets/logo.png';
	check(
		'image link is recorded as an asset edge',
		g.fileEdges.some((e) => e.source === 'wiki/vendors/acme.md' && e.target === asset),
		JSON.stringify(g.fileEdges)
	);
	check(
		'a second page referencing it is recorded too',
		g.fileEdges.filter((e) => e.target === asset).length === 2,
		JSON.stringify(g.fileEdges)
	);
	// The graph view builds nodes from `pages` and degree from `edges`; an asset in
	// that list would be a link to a node the renderer has no data for.
	check(
		'asset edges stay OUT of the page edge list',
		!g.edges.some((e) => e.target === asset),
		JSON.stringify(g.edges)
	);
	check(
		'page-to-page links still resolve',
		g.edges.some((e) => e.source === 'wiki/vendors/acme.md' && e.target === 'wiki/index.md')
	);
	// The index has no inventory of assets, so it cannot tell a typo from a file it
	// has not indexed.
	check(
		'a missing attachment is never reported broken',
		!g.broken.some((b) => b.target?.endsWith('.png')),
		JSON.stringify(g.broken)
	);
	check(
		'but a missing PAGE still is',
		g.broken.some((b) => b.target === 'wiki/vendors/nope.md'),
		JSON.stringify(g.broken)
	);
	// Source material is not indexed, so a link into raw/ is neither broken nor a file
	// edge.
	check(
		'a link into source material is neither broken nor a file edge',
		!g.broken.some((b) => b.target?.startsWith('raw/')) &&
			!g.fileEdges.some((e) => e.target.startsWith('raw/')),
		JSON.stringify({ broken: g.broken, fileEdges: g.fileEdges })
	);
	// A non-page file the app cannot render is still a file the brain can lose, so
	// deleting a linked .csv warns exactly as deleting a .png does.
	const csv = 'wiki/vendors/data/pricing.csv';
	check(
		'a link to a non-media content file is a file edge too',
		g.fileEdges.some((e) => e.target === csv),
		JSON.stringify(g.fileEdges)
	);
	check(
		'and backlinksTo finds it',
		backlinksTo(g, csv).some((r) => r.path === 'wiki/vendors/acme.md'),
		JSON.stringify(backlinksTo(g, csv))
	);
	check(
		'while staying out of the page edge list',
		!g.edges.some((e) => e.target === csv),
		JSON.stringify(g.edges)
	);

	const refs = backlinksTo(g, asset);
	check(
		'backlinksTo finds both referrers of an attachment',
		refs.length === 2,
		JSON.stringify(refs)
	);
	check(
		'and counts them, so "still referenced" can say how many',
		refs.every((r) => r.count === 1),
		JSON.stringify(refs)
	);
	const pageRefs = backlinksTo(g, 'wiki/index.md');
	check(
		'page backlinks still work and do not pick up assets',
		pageRefs.length === 1 && pageRefs[0].path === 'wiki/vendors/acme.md',
		JSON.stringify(pageRefs)
	);
}

// ---- backlinksTo aggregation ----
//
// One `count` per referring page, totalled across both link syntaxes.
{
	console.log('\nbacklinksTo aggregation');
	const graph: ResolvedGraph = {
		pages: [
			{ path: 'a.md', title: 'A' },
			{ path: 'b.md', title: 'B' }
		],
		edges: [
			{ source: 'a.md', target: 'b.md', kind: 'md', cnt: 2 },
			{ source: 'a.md', target: 'b.md', kind: 'wiki', cnt: 3 }
		],
		fileEdges: [],
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

done();
