// Golden test for link resolution — how a [[wikilink]] finds its page, and what
// validate says about the ones that find nothing. Pure: D1 is shimmed over
// node:sqlite, GitHub is a stub, no network.
//
//   pnpm test:links
//
// Why this file exists (issue #12): the lookup table was keyed by a page's RAW
// filename and queried with the SLUGIFIED link text, so a page whose filename was
// not already slug-shaped could only ever be found through the title lane. On a
// brain of dated meeting notes and Title Case filenames that meant ~100 links
// reported broken whose targets `list_pages` and `read_page` returned happily.
// Every case below is a form a human writes by hand and expects to work.

import { DatabaseSync } from 'node:sqlite';
import {
	ensureFresh,
	loadResolvedGraph,
	type BrokenLink,
	type ResolvedGraph
} from '../src/lib/brain-index.ts';
import { githubStore } from '../src/lib/brain-repo.ts';
import { applyMigrations } from '../src/local/d1-sqlite.ts';
import { DEFAULT_BRAIN_CONFIG, type BrainConfig } from '../src/lib/brain-policy.ts';
import { extractLinks, rewriteWikiLinks, wikilinkKey } from '../src/lib/wiki.ts';
import { classifyMdLink } from '../src/lib/links.ts';
import { brokenLinkReport } from '../src/tools/librarian.ts';

import { checker } from './check.ts';

const { check, done } = checker('link checks');

// ---- D1 over node:sqlite (real migrations) + a GitHub stub behind githubStore ----

let sqlite = new DatabaseSync(':memory:');
applyMigrations(sqlite);

function shimStatement(sql: string, params: unknown[] = []): any {
	return {
		bind: (...p: unknown[]) => shimStatement(sql, p),
		first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
		all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
		run: async () => {
			// `meta.changes` is load-bearing: d1WriteLedger.claim decides it won a claim
			// with `(res.meta?.changes ?? 0) > 0`, and writeThroughIndex reads it the
			// same way. A shim without it reports every write as a no-op.
			const r = sqlite.prepare(sql).run(...(params as []));
			return { success: true, meta: { changes: Number(r.changes ?? 0) } };
		}
	};
}
const db = {
	prepare: (sql: string) => shimStatement(sql),
	batch: async (stmts: { run: () => Promise<unknown> }[]) => {
		for (const s of stmts) await s.run();
		return [];
	}
} as never;

interface FakePage {
	path: string;
	sha: string;
	content: string;
}
let currentPages: FakePage[] = [];
let currentHead = 'commit-0';

const octokit = {
	graphql: async (_query: string, variables: Record<string, string>) => {
		const byOid = new Map(currentPages.map((p) => [p.sha, p]));
		const repository: Record<string, { text: string; isTruncated: boolean } | null> = {};
		for (const [k, v] of Object.entries(variables)) {
			if (!k.startsWith('o')) continue;
			const p = byOid.get(v);
			repository[`b${k.slice(1)}`] = p ? { text: p.content, isTruncated: false } : null;
		}
		return { repository };
	},
	rest: {
		repos: {
			get: async () => ({
				data: { default_branch: 'main', allow_squash_merge: true, allow_merge_commit: true }
			}),
			getBranch: async () => ({ data: { protected: false } }),
			getContent: async () => {
				throw Object.assign(new Error('Not Found'), { status: 404 });
			}
		},
		git: {
			getRef: async () => ({ data: { object: { sha: currentHead } } }),
			getCommit: async () => ({ data: { tree: { sha: `tree-${currentHead}` } } }),
			getTree: async () => ({
				data: { tree: currentPages.map((p) => ({ type: 'blob', path: p.path, sha: p.sha })) }
			}),
			getBlob: async () => {
				throw new Error('getBlob should not be needed (no oversized blobs in this fixture)');
			}
		}
	}
} as never;

const store = githubStore(octokit);
const repo = { owner: 'example-org', repo: 'brain' };
const brainId = 'example-org/brain';
const config: BrainConfig = { ...DEFAULT_BRAIN_CONFIG };

async function indexAndResolve(pages: FakePage[]): Promise<ResolvedGraph> {
	sqlite = new DatabaseSync(':memory:');
	applyMigrations(sqlite);
	currentPages = pages;
	currentHead = `commit-${pages.length}`;
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
	resolves('single-word filename resolves', 'wiki/Projects/Atlas/Architecture.md');
	check(
		'a filename that differs from the page title resolves',
		!brokenTargets.has('Architecture'),
		[...brokenTargets].join(' | ')
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

done();
