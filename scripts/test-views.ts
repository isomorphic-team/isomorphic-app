// Golden test for the derived-views engine (src/lib/views.ts and the pure layer
// it re-exports from src/lib/view-directives.ts). No D1, no GitHub: the
// ViewContext is a fixed graph and field map over a small in-memory brain.
//
//   pnpm test:views
//
// 1. Directive parsing (`parseViewSpec`): every kind (`backlinks`, `pages`,
//    `folders`, `count`), inline and block filters, and the per-kind refusals.
// 2. Rendering (`renderViews`): counts, tables, grouping, `describe`, filters,
//    the empty placeholder, a visible error for a malformed directive, and the
//    links each row carries.
// 3. Snapshots: upsert and its idempotency, `displayFromSnapshots`,
//    `stripSnapshots` for the editor, and segmentation edge cases (nested and
//    unclosed fences, an unmatched begin marker).
// 4. `columns:` bare (`a, b`) and bracketed (`[a, b]`) forms.
// 5. Comparison filters: each operator over numbers, dates, `today` and day
//    offsets with a pinned clock, missing and non-comparable fields, `!=` on
//    text, equality unchanged alongside, and malformed operator values.
import {
	parseViewSpec,
	segmentViews,
	stripSnapshots,
	displayFromSnapshots,
	renderViews,
	hasViews,
	matchesCondition,
	SNAPSHOT_BEGIN,
	SNAPSHOT_END,
	type ViewContext
} from '../src/lib/views.ts';
import type { PageFields } from '../src/lib/brain-index.ts';

import { checker } from './check.ts';

const { check, done } = checker('view checks');

// ---------- fixture brain ----------
// org page + three people; two link to the org (one via wikilink), one links elsewhere.
const fields = new Map<string, PageFields>([
	[
		'people/ada-lovelace.md',
		new Map([
			['type', ['Contact']],
			['roles', ['CEO', 'Founder']],
			['email', ['ada@example.com']]
		])
	],
	[
		'people/grace-hopper.md',
		new Map([
			['type', ['Reporter']],
			['email', ['grace@example.com']],
			['rank', ['2']]
		])
	],
	['people/unlinked.md', new Map([['type', ['Contact']]])]
]);

const ctx: ViewContext = {
	resolved: {
		pages: [
			{ path: 'organizations/acme.md', title: 'Acme Health' },
			{ path: 'people/ada-lovelace.md', title: 'Ada Lovelace' },
			{ path: 'people/grace-hopper.md', title: 'Grace Hopper' },
			{ path: 'people/unlinked.md', title: 'Unlinked Person' }
		],
		edges: [
			{ source: 'people/ada-lovelace.md', target: 'organizations/acme.md', kind: 'md', cnt: 1 },
			{ source: 'people/grace-hopper.md', target: 'organizations/acme.md', kind: 'wiki', cnt: 2 }
		],
		fileEdges: [],
		broken: []
	},
	fieldsFor: async (paths) => new Map([...fields].filter(([p]) => paths.includes(p)))
};

async function main() {
	// ---------- spec parsing ----------
	console.log('spec parsing:');
	const s1 = parseViewSpec(
		'kind: backlinks\nfilter: { type: Contact }\nas: table\ncolumns: [title, roles, email]'
	);
	check(
		'inline filter + columns',
		!!s1.spec && s1.spec.as === 'table' && s1.spec.columns.join() === 'title,roles,email'
	);
	check('inline filter values', s1.spec?.filter.type?.join() === 'Contact');

	const s2 = parseViewSpec(
		'kind: backlinks\nfilter:\n  type: [Contact, Reporter]\n  status: active'
	);
	check(
		'block filter with list',
		s2.spec?.filter.type?.join() === 'Contact,Reporter' &&
			s2.spec?.filter.status?.join() === 'active'
	);

	const s3 = parseViewSpec('kind: count\nlabel: tracked contacts');
	check(
		'kind: count is shorthand for backlinks + as: count',
		s3.spec?.kind === 'backlinks' && s3.spec.as === 'count' && s3.spec.label === 'tracked contacts'
	);

	const s4 = parseViewSpec('kind: nonsense');
	check('bad kind is an error, not a throw', !!s4.error);

	const s5 = parseViewSpec('kind: pages\nunder: people/\ngroup-by: type\ndescribe: email');
	check(
		'pages spec with under/group-by/describe',
		s5.spec?.kind === 'pages' &&
			s5.spec.under === 'people/' &&
			s5.spec.groupBy === 'type' &&
			s5.spec.describe === 'email'
	);
	check('"of" rejected on kind: pages', !!parseViewSpec('kind: pages\nof: x.md').error);
	check('"under" rejected on kind: backlinks', !!parseViewSpec('kind: backlinks\nunder: p/').error);

	// ---------- rendering ----------
	console.log('rendering:');
	const orgPage = [
		'---',
		'title: Acme Health',
		'---',
		'# Acme Health',
		'',
		'```okf-view',
		'kind: count',
		'label: tracked contacts',
		'```',
		'',
		'Prose in between.',
		'',
		'```okf-view',
		'kind: backlinks',
		'as: table',
		'columns: [title, email]',
		'```',
		''
	].join('\n');

	check('hasViews', hasViews(orgPage) && !hasViews('# no views here'));

	const r1 = await renderViews(orgPage, 'organizations/acme.md', ctx);
	check('two views found', r1.count === 2);
	check('count renders bold with label', r1.display.includes('**2** tracked contacts'));
	check('display has no fence', !r1.display.includes('```okf-view'));
	check('display keeps surrounding prose', r1.display.includes('Prose in between.'));
	check(
		'table rows link relatively, sorted by title',
		r1.display.indexOf('[Ada Lovelace](../people/ada-lovelace.md)') <
			r1.display.indexOf('[Grace Hopper](../people/grace-hopper.md)') &&
			r1.display.includes('| Title | email |')
	);
	check('unlinked page not included', !r1.display.includes('Unlinked'));

	// filtered view: only Contacts
	const filtered = await renderViews(
		'```okf-view\nkind: backlinks\nfilter: { type: Contact }\n```',
		'organizations/acme.md',
		ctx
	);
	check(
		'filter excludes non-matching linker',
		filtered.display.includes('Ada') && !filtered.display.includes('Grace')
	);

	// count with filter
	const fcount = await renderViews(
		'```okf-view\nkind: count\nfilter: { type: Contact }\nlabel: tracked contacts\n```',
		'organizations/acme.md',
		ctx
	);
	check('filtered count', fcount.display.includes('**1** tracked contacts'));

	// empty result
	const empty = await renderViews(
		'```okf-view\nkind: backlinks\nfilter: { type: Missing }\n```',
		'organizations/acme.md',
		ctx
	);
	check('empty renders placeholder', empty.display.includes('*No matching pages.*'));

	// malformed directive renders an error note, never throws
	const bad = await renderViews('```okf-view\nkind: what\n```', 'organizations/acme.md', ctx);
	check('malformed renders visible error', bad.display.includes('could not be computed'));

	// ---------- Phase 2: kind: pages (FR-1b) + directory index (FR-1d) ----------
	console.log('pages views:');
	const allContacts = await renderViews(
		'```okf-view\nkind: pages\nfilter: { type: Contact }\n```',
		'organizations/acme.md',
		ctx
	);
	check(
		'pages + filter finds matching pages brain-wide (link or not)',
		allContacts.display.includes('Ada Lovelace') &&
			allContacts.display.includes('Unlinked Person') &&
			!allContacts.display.includes('Grace')
	);

	const dirIndex = await renderViews(
		'```okf-view\nkind: pages\nunder: people/\n```',
		'wiki-index.md',
		ctx
	);
	check(
		'under scopes to the path prefix',
		dirIndex.display.includes('Ada Lovelace') &&
			dirIndex.display.includes('Grace Hopper') &&
			!dirIndex.display.includes('Acme Health')
	);

	const selfExcluded = await renderViews(
		'```okf-view\nkind: pages\n```',
		'organizations/acme.md',
		ctx
	);
	check('containing page excludes itself', !selfExcluded.display.includes('[Acme Health]'));

	const grouped = await renderViews(
		'```okf-view\nkind: pages\nunder: people/\ngroup-by: type\n```',
		'wiki-index.md',
		ctx
	);
	check(
		'group-by renders sections, alphabetical',
		grouped.display.indexOf('### Contact') >= 0 &&
			grouped.display.indexOf('### Contact') < grouped.display.indexOf('### Reporter')
	);

	const groupedAll = await renderViews(
		'```okf-view\nkind: pages\ngroup-by: type\n```',
		'x.md',
		ctx
	);
	check(
		'missing group key lands in "(none)", sorted last',
		groupedAll.display.indexOf('### (none)') > groupedAll.display.indexOf('### Reporter') &&
			groupedAll.display.includes('Acme Health')
	);

	const groupCount = await renderViews(
		'```okf-view\nkind: pages\nunder: people/\nas: count\ngroup-by: type\n```',
		'wiki-index.md',
		ctx
	);
	check(
		'grouped count tallies per group',
		groupCount.display.includes('- Contact: **2**') &&
			groupCount.display.includes('- Reporter: **1**')
	);

	const described = await renderViews(
		'```okf-view\nkind: pages\nunder: people/\nfilter: { type: Contact }\ndescribe: email\n```',
		'wiki-index.md',
		ctx
	);
	check(
		'describe appends the frontmatter value',
		described.display.includes('- [Ada Lovelace](people/ada-lovelace.md) - ada@example.com')
	);

	// ---------- kind: folders (directory index by sub-folder) ----------
	console.log('folders views:');
	const foldersCtx: ViewContext = {
		resolved: {
			pages: [
				{ path: 'Projects/index.md', title: 'Projects' },
				{ path: 'Projects/alpha/index.md', title: 'Project Alpha' },
				{ path: 'Projects/alpha/tasks/todo.md', title: 'Todo' },
				{ path: 'Projects/beta/README.md', title: 'Project Beta' },
				{ path: 'Projects/gamma/notes.md', title: 'Gamma Notes' }, // sub-folder, no note
				{ path: 'Projects/roadmap.md', title: 'Roadmap' } // direct file, not a folder
			],
			edges: [],
			fileEdges: [],
			broken: []
		},
		fieldsFor: async (paths) =>
			new Map<string, PageFields>(
				[
					['Projects/alpha/index.md', new Map([['status', ['active']]])],
					['Projects/beta/README.md', new Map([['status', ['paused']]])]
				].filter(([p]) => (paths as string[]).includes(p as string)) as [string, PageFields][]
			)
	};

	const folders = await renderViews(
		'```okf-view\nkind: folders\n```',
		'Projects/index.md',
		foldersCtx
	);
	check(
		'folders links each sub-folder via its folder note (index.md > README.md)',
		folders.display.includes('[Project Alpha](alpha/index.md)') &&
			folders.display.includes('[Project Beta](beta/README.md)')
	);
	check(
		'note-less sub-folder appears unlinked, deslugged from its name',
		folders.display.includes('- gamma') && !folders.display.includes('[gamma]')
	);
	check(
		'direct files and the containing page are not folders',
		!folders.display.includes('Roadmap') && !folders.display.includes('[Projects]')
	);
	check(
		'deeper pages collapse to their top sub-folder (no dup)',
		!folders.display.includes('tasks')
	);

	// `under` scopes folders, and the whole row machinery (filter/describe) applies
	// to the folder notes' frontmatter.
	const foldersElsewhere = await renderViews(
		'```okf-view\nkind: folders\nunder: Projects/\ndescribe: status\n```',
		'home.md',
		foldersCtx
	);
	check(
		'under scopes folders + describe reads the note frontmatter',
		foldersElsewhere.display.includes('[Project Alpha](Projects/alpha/index.md) - active') &&
			foldersElsewhere.display.includes('[Project Beta](Projects/beta/README.md) - paused')
	);

	const foldersFiltered = await renderViews(
		'```okf-view\nkind: folders\nunder: Projects/\nfilter: { status: active }\n```',
		'home.md',
		foldersCtx
	);
	check(
		'filter on folder-note frontmatter selects folders',
		foldersFiltered.display.includes('Project Alpha') &&
			!foldersFiltered.display.includes('Project Beta') &&
			!foldersFiltered.display.includes('gamma') // note-less folder has no fields → filtered out
	);

	const foldersCount = await renderViews(
		'```okf-view\nkind: folders\nunder: Projects/\nas: count\nlabel: projects\n```',
		'home.md',
		foldersCtx
	);
	check(
		'folders as: count tallies the sub-folders',
		foldersCount.display.includes('**3** projects')
	);

	check('"of" rejected on kind: folders', !!parseViewSpec('kind: folders\nof: x.md').error);
	check(
		'kind: folders parses with under',
		parseViewSpec('kind: folders\nunder: Projects/').spec?.kind === 'folders'
	);

	// ---------- snapshots ----------
	console.log('snapshots:');
	check(
		'snapshot has fence + markers',
		r1.snapshotted.includes('```okf-view') &&
			r1.snapshotted.includes(SNAPSHOT_BEGIN) &&
			r1.snapshotted.includes(SNAPSHOT_END)
	);

	// Re-rendering the snapshotted content replaces the stale snapshot, not stacks it.
	const r2 = await renderViews(r1.snapshotted, 'organizations/acme.md', ctx);
	check(
		'snapshot upsert is idempotent',
		r2.snapshotted === r1.snapshotted,
		'second pass changed bytes'
	);
	check('display from snapshotted content matches', r2.display === r1.display);

	// Presentation unwrap: fresh-snapshotted content displays identically to the
	// live rendering, with no recompute (what PageView does for read_page content).
	check(
		'displayFromSnapshots unwraps to display form',
		displayFromSnapshots(r1.snapshotted) === r1.display
	);
	check(
		'displayFromSnapshots keeps fence when no snapshot',
		displayFromSnapshots(orgPage).includes('```okf-view')
	);

	// Editor strip: removes snapshots, keeps fences and prose.
	const stripped = stripSnapshots(r1.snapshotted);
	check(
		'strip removes markers',
		!stripped.includes(SNAPSHOT_BEGIN) && !stripped.includes(SNAPSHOT_END)
	);
	check(
		'strip keeps fences + prose',
		stripped.includes('```okf-view') && stripped.includes('Prose in between.')
	);
	check('strip of unsnapshotted content is unchanged', stripSnapshots(orgPage) === orgPage);

	// ---------- segmentation edge cases ----------
	console.log('segmentation:');
	const nested = '```js\nconst s = "```okf-view";\n```\ntext';
	check(
		'fence inside another fence is text',
		segmentViews(nested).every((s) => s.type === 'text')
	);

	const unclosed = '```okf-view\nkind: backlinks';
	check(
		'unclosed fence is text',
		segmentViews(unclosed).every((s) => s.type === 'text')
	);

	const orphanBegin = `\`\`\`okf-view\nkind: count\n\`\`\`\n\n${SNAPSHOT_BEGIN}\nno end marker follows`;
	const segs = segmentViews(orphanBegin);
	check(
		'begin marker without end is left as text',
		segs.some((s) => s.type === 'view') &&
			segs.some((s) => s.type === 'text' && s.text.includes('no end marker'))
	);

	// Link destinations with spaces/parens must be <>-wrapped (CommonMark ends a
	// bare destination at the first space) — common in Obsidian-style vaults.
	const spacedCtx: ViewContext = {
		resolved: {
			pages: [
				{ path: 'Projects/index.md', title: 'Projects' },
				{ path: 'Projects/Acme Care Platform/index.md', title: 'Acme Care Platform' },
				{ path: 'Projects/plain.md', title: 'Plain' }
			],
			edges: [],
			fileEdges: [],
			broken: []
		},
		fieldsFor: async () => new Map()
	};
	const spaced = await renderViews(
		'```okf-view\nkind: pages\nunder: Projects/\n```',
		'Projects/index.md',
		spacedCtx
	);
	check(
		'path with spaces is angle-wrapped',
		spaced.display.includes('[Acme Care Platform](<Acme Care Platform/index.md>)')
	);
	check(
		'slug path stays bare (no needless wrapping)',
		spaced.display.includes('[Plain](plain.md)')
	);

	// ---------- columns ----------
	console.log('columns:');
	const bare = parseViewSpec('kind: pages\nas: table\ncolumns: title, roles, email').spec;
	check(
		'bare comma-separated columns split',
		bare?.columns.join('|') === 'title|roles|email',
		bare?.columns.join('|')
	);
	const bracketed = parseViewSpec('kind: pages\nas: table\ncolumns: [title, roles, email]').spec;
	check('bracketed columns unchanged', bracketed?.columns.join('|') === 'title|roles|email');
	const single = parseViewSpec('kind: pages\nas: table\ncolumns: email').spec;
	check('single bare column', single?.columns.join('|') === 'email');
	const bareTable = await renderViews(
		'```okf-view\nkind: pages\nunder: people/\nfilter: { type: Contact }\nas: table\ncolumns: title, email\n```',
		'organizations/acme.md',
		ctx
	);
	check(
		'bare columns render as separate table columns',
		bareTable.display.includes('| Title | email |') && bareTable.display.includes('ada@example.com')
	);
	check(
		'bare filter value with a comma stays one value',
		parseViewSpec('kind: pages\nfilter:\n  name: Acme, Inc').spec?.filter.name?.join('|') ===
			'Acme, Inc'
	);

	// ---------- comparison filters ----------
	console.log('comparison filters:');
	const TODAY = '2026-06-15';
	const deals = new Map<string, PageFields>([
		[
			'deals/acme.md',
			new Map([
				['type', ['Deal']],
				['stage', ['proposal']],
				['due', ['2026-06-10']],
				['value', ['50000']]
			])
		],
		[
			'deals/northwind.md',
			new Map([
				['type', ['Deal']],
				['stage', ['lost']],
				['due', ['2026-06-15']],
				['value', ['9000']]
			])
		],
		[
			'deals/globex.md',
			new Map([
				['type', ['Deal']],
				['stage', ['won']],
				['due', ['2026-07-01T09:30:00Z']],
				['value', ['120000']]
			])
		],
		[
			'deals/initech.md',
			new Map([
				['type', ['Deal']],
				['stage', ['prospect']],
				['due', ['next week']],
				['value', ['tbd']]
			])
		],
		['deals/umbrella.md', new Map([['type', ['Deal']]])]
	]);
	const dealCtx: ViewContext = {
		resolved: {
			pages: [
				{ path: 'deals/index.md', title: 'Deals' },
				{ path: 'deals/acme.md', title: 'Acme' },
				{ path: 'deals/northwind.md', title: 'Northwind' },
				{ path: 'deals/globex.md', title: 'Globex' },
				{ path: 'deals/initech.md', title: 'Initech' },
				{ path: 'deals/umbrella.md', title: 'Umbrella' }
			],
			edges: [],
			fileEdges: [],
			broken: []
		},
		fieldsFor: async (paths) => new Map([...deals].filter(([p]) => paths.includes(p))),
		today: TODAY
	};
	const names = ['Acme', 'Northwind', 'Globex', 'Initech', 'Umbrella'];
	const listed = async (filterLines: string): Promise<string[]> => {
		const r = await renderViews(
			'```okf-view\nkind: pages\nunder: deals/\nfilter:\n' + filterLines + '\n```',
			'deals/index.md',
			dealCtx
		);
		return names.filter((n) => r.display.includes(`[${n}]`));
	};
	const expect = async (label: string, filterLines: string, want: string[]) => {
		const got = await listed(filterLines);
		check(`${label} -> ${want.join(', ') || 'none'}`, got.join() === want.join(), got.join());
	};

	await expect('< today', '  due: "< today"', ['Acme']);
	await expect('<= today', '  due: "<= today"', ['Acme', 'Northwind']);
	await expect('> today (timestamp compares by its date)', '  due: "> today"', ['Globex']);
	await expect('>= today', '  due: ">= today"', ['Northwind', 'Globex']);
	await expect('< -3d (offset from today)', '  due: "< -3d"', ['Acme']);
	await expect('>= +16d', '  due: ">= +16d"', ['Globex']);
	await expect('> +17d', '  due: "> +17d"', []);
	await expect('explicit ISO date', '  due: "< 2026-06-12"', ['Acme']);
	await expect('number compares numerically, not as text', '  value: "> 10000"', [
		'Acme',
		'Globex'
	]);
	await expect('<= number', '  value: "<= 9000"', ['Northwind']);
	await expect('!= text excludes the value and missing fields', '  stage: "!= lost"', [
		'Acme',
		'Globex',
		'Initech'
	]);
	await expect('!= is case-insensitive', '  stage: "!= LOST"', ['Acme', 'Globex', 'Initech']);
	await expect('!= date skips non-dates', '  due: "!= today"', ['Acme', 'Globex']);
	await expect('unquoted operator reads the same', '  due: < today', ['Acme']);
	await expect('equality and condition on separate keys', '  type: Deal\n  value: ">= 50000"', [
		'Acme',
		'Globex'
	]);
	await expect('equality alongside a condition', '  stage: [proposal, won]\n  due: "> today"', [
		'Globex'
	]);
	await expect('equality unchanged', '  stage: [proposal, lost]', ['Acme', 'Northwind']);
	const inline = await renderViews(
		'```okf-view\nkind: pages\nunder: deals/\nfilter: { value: "< 10000", type: Deal }\n```',
		'deals/index.md',
		dealCtx
	);
	check(
		'inline-map condition',
		inline.display.includes('[Northwind]') && !inline.display.includes('[Acme]')
	);

	const cond = parseViewSpec('kind: pages\nfilter:\n  due: "< -30d"\n  type: Deal').spec;
	check(
		'operator value parses into a condition, not an equality filter',
		cond?.conditions.length === 1 &&
			cond.conditions[0].op === '<' &&
			cond.conditions[0].operand === '-30d' &&
			cond.filter.due === undefined &&
			cond.filter.type?.join() === 'Deal'
	);
	check(
		'missing field never matches',
		!matchesCondition([], { key: 'due', op: '!=', operand: 'x' }, TODAY)
	);
	check(
		'non-comparable value never matches',
		!matchesCondition(['soon'], { key: 'due', op: '<', operand: 'today' }, TODAY)
	);
	check(
		'list field matches when any value does',
		matchesCondition(['2020-01-01', 'n/a'], { key: 'due', op: '<', operand: 'today' }, TODAY)
	);
	check(
		'impossible calendar date is not a date',
		!matchesCondition(['2026-02-30'], { key: 'due', op: '<', operand: 'today' }, TODAY)
	);
	check(
		'offsets cross month boundaries',
		matchesCondition(['2026-05-31'], { key: 'due', op: '<=', operand: '-15d' }, TODAY)
	);

	for (const [label, line] of [
		['ordering op on text', 'due: "< soon"'],
		['empty operand', 'due: "<"'],
		['operator inside a list', 'due: ["< today", "> -5d"]'],
		['malformed offset', 'due: "< -30days"'],
		['impossible date operand', 'due: "< 2026-13-01"']
	] as const) {
		check(
			`malformed: ${label} is an error`,
			!!parseViewSpec(`kind: pages\nfilter:\n  ${line}`).error
		);
	}
	const badOp = await renderViews(
		'```okf-view\nkind: pages\nfilter:\n  due: "< soon"\n```',
		'deals/index.md',
		dealCtx
	);
	check(
		'malformed operator renders the visible note',
		badOp.display.includes('could not be computed')
	);

	done();
}

main();
