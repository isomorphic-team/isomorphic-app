// Golden test for the tool-payload parsers (src/lib/tool-payloads.ts): what the widget
// does with each tool's structuredContent, pure, no host and no client.
//
// Three things are pinned here and nowhere else:
//
//   1. An `isError` result is REFUSED, never parsed. A failed call is a result carrying
//      isError, not a rejection, and its empty payload parses as a successful empty
//      answer. `fetchPaths` had no check and cached a failed list_pages as an empty
//      tree, which made the "no brain yet" state unreachable from the tree and let the
//      background revalidate silently blank a tree the user was reading.
//   2. Which `view` token opens which screen, including the two that share one
//      (`settings` and `connected_accounts`) and the fallback (anything else is a page).
//   3. What a missing field becomes. Absent and empty are different answers for the
//      org list, a missing sha is '' for the editor and absent for the viewer, and a
//      guest's org role is null rather than 'viewer'.
//
//   pnpm test:payloads

import {
	firstText,
	structuredOf,
	payloadOf,
	isNoBrain,
	pagesToTitleMap,
	parseTree,
	parseListPages,
	answersFor,
	parsePage,
	parseEdit,
	parseReadPage,
	parseAsset,
	parseSearchHits,
	parseActivity,
	parseGraph,
	parseMembers,
	parseBrainAccess,
	parseAnalytics,
	parseAccounts,
	parseIdentity,
	parseOrgs,
	parseBrains,
	derivedOrgTargets,
	parseToolView,
	type ToolResultLike,
	type BrainRow
} from '../src/lib/tool-payloads.ts';

import { checker } from './check.ts';

const { check, done } = checker('payload checks');

const ok = (structuredContent: unknown, text = ''): ToolResultLike => ({
	content: text ? [{ type: 'text', text }] : [],
	structuredContent
});
const failed = (text: string): ToolResultLike => ({
	isError: true,
	content: [{ type: 'text', text }]
});
const throws = (fn: () => unknown): string | null => {
	try {
		fn();
		return null;
	} catch (e) {
		return String((e as Error).message);
	}
};

// ---------------------------------------------------------------------------
console.log('\nThe envelope');
// ---------------------------------------------------------------------------
check(
	'firstText: the first text block',
	firstText({
		content: [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }]
	}) === 'a'
);
check(
	'firstText: no text block is the empty string',
	firstText({ content: [{ type: 'image' }] }) === ''
);
check('firstText: no content at all is the empty string', firstText({}) === '');
check('structuredOf: the object as sent', structuredOf(ok({ view: 'graph' })).view === 'graph');
check(
	'structuredOf: missing is an empty payload',
	Object.keys(structuredOf(ok(undefined))).length === 0
);
check(
	'structuredOf: an array is not a payload',
	Object.keys(structuredOf(ok([1, 2]))).length === 0
);
check('structuredOf: a string is not a payload', Object.keys(structuredOf(ok('x'))).length === 0);
check(
	'structuredOf never throws on an error result',
	Object.keys(structuredOf(failed('boom'))).length === 0
);
check(
	'payloadOf refuses an error result with its text',
	throws(() => payloadOf(failed('You do not have access to that brain.'))) ===
		'You do not have access to that brain.'
);
check('payloadOf: a success is its payload', payloadOf(ok({ a: 1 })).a === 1);

check(
	'isNoBrain: the NoBrainError message',
	isNoBrain("You don't have a brain yet. Create one with create_brain.")
);
check('isNoBrain: a curly apostrophe', isNoBrain('You don’t have a brain yet'));
check('isNoBrain: no apostrophe', isNoBrain('you dont have a brain yet'));
check('isNoBrain: an unrelated error naming a brain', !isNoBrain('That brain is read-only.'));

// ---------------------------------------------------------------------------
console.log('\nThe tree');
// ---------------------------------------------------------------------------
const PAGES = [
	{ path: 'wiki/a.md', title: 'A' },
	{ path: 'wiki/b.md', title: 'B' },
	{ path: 'wiki/c.md' }, // no title: listed, untitled
	'not a page',
	null
];
check(
	'pagesToTitleMap: titled pages only',
	JSON.stringify(pagesToTitleMap(PAGES)) === '{"wiki/a.md":"A","wiki/b.md":"B"}'
);
check(
	'pagesToTitleMap: a missing field is empty',
	Object.keys(pagesToTitleMap(undefined)).length === 0
);

const fromPages = parseTree({
	pages: PAGES,
	assets: ['img.png'],
	hidden: ['.isomorphic.json'],
	needsConfig: 1
});
check(
	'parseTree derives paths from pages, in order, skipping malformed entries',
	JSON.stringify(fromPages?.paths) === '["wiki/a.md","wiki/b.md","wiki/c.md"]'
);
check(
	'parseTree: assets and hidden ride along',
	fromPages?.assets[0] === 'img.png' && fromPages?.hidden[0] === '.isomorphic.json'
);
check('parseTree: needsConfig is coerced', fromPages?.needsConfig === true);
check(
	'parseTree: an explicit paths list wins over pages',
	JSON.stringify(parseTree({ paths: ['x.md'], pages: PAGES })?.paths) === '["x.md"]'
);
check(
	'parseTree: neither paths nor pages is NO tree (browse_brain over budget)',
	parseTree({ view: 'browse' }) === null
);
check(
	'parseTree: an empty pages list is an EMPTY tree, not no tree',
	parseTree({ pages: [] })?.paths.length === 0
);
check(
	'parseTree: assets and hidden default to empty lists',
	JSON.stringify(parseTree({ paths: [] })) ===
		'{"paths":[],"titleByPath":{},"assets":[],"hidden":[],"needsConfig":false}'
);

check(
	'parseListPages REFUSES an error result rather than answering "empty brain"',
	throws(() => parseListPages(failed("You don't have a brain yet."))) ===
		"You don't have a brain yet.",
	'this is the fetchPaths defect: a failed list_pages was cached as an empty tree'
);
check(
	'parseListPages refuses a success with no page list',
	throws(() => parseListPages(ok({ config: {} }))) === 'list_pages: no page list in the result'
);
check(
	'parseListPages: the tree',
	parseListPages(ok({ pages: PAGES }, 'wiki/a.md\nwiki/b.md')).paths.length === 3
);
check(
	'parseListPages: "No markdown pages found." is an empty tree',
	parseListPages(ok({ pages: [] }, 'No markdown pages found.')).paths.length === 0
);

check(
	'answersFor: a widget with no brain yet accepts any answer',
	answersFor({ activeBrain: { id: 'o/x' } }, undefined)
);
check('answersFor: an answer naming no brain is accepted', answersFor({}, 'o/x'));
check('answersFor: the same brain', answersFor({ activeBrain: { id: 'o/x' } }, 'o/x'));
check('answersFor: a DIFFERENT brain is stale', !answersFor({ activeBrain: { id: 'o/y' } }, 'o/x'));

// ---------------------------------------------------------------------------
console.log('\nPages');
// ---------------------------------------------------------------------------
check(
	'parsePage: a missing sha is absent (the viewer shows no version)',
	parsePage({ path: 'a.md', markdown: '# A' }).sha === undefined
);
check(
	'parsePage: missing path and markdown are empty strings',
	JSON.stringify(parsePage({})) === '{"path":"","markdown":""}'
);
check(
	'parseEdit: a missing sha is the empty string (the editor saves against it)',
	parseEdit({ path: 'a.md' }).sha === ''
);
check(
	'parseEdit: the requested path stands in when the server names none',
	parseEdit({}, 'b.md').path === 'b.md'
);
check(
	'parseEdit: a server-named path wins over the requested one',
	parseEdit({ path: 'a.md' }, 'b.md').path === 'a.md'
);
check(
	'parseReadPage: the page is the text block, the sha rides structured',
	(() => {
		const r = parseReadPage(ok({ sha: 'abc', markdown: 'ignored' }, '# Text'));
		return r.markdown === '# Text' && r.sha === 'abc';
	})()
);
check(
	'parseReadPage refuses an error result',
	throws(() => parseReadPage(failed('nope'))) === 'nope'
);
check(
	'parseAsset defaults',
	JSON.stringify(parseAsset({ size: 'big' })) === '{"mimeType":"","size":0,"dataUri":""}'
);
check(
	'parseSearchHits: hits or nothing',
	parseSearchHits({ hits: 'x' }).length === 0 &&
		parseSearchHits({ hits: [{ path: 'a' }] }).length === 1
);

// ---------------------------------------------------------------------------
console.log('\nViews');
// ---------------------------------------------------------------------------
check(
	'parseActivity: scope path',
	parseActivity({ entries: [{}], scope: { path: 'a.md' } }).scopePath === 'a.md'
);
check(
	'parseActivity: no scope is the whole brain',
	parseActivity({}).scopePath === undefined && parseActivity({}).entries.length === 0
);
check(
	'parseGraph: edges become links',
	parseGraph({ edges: [{ source: 'a', target: 'b' }] }).links.length === 1
);
check(
	'parseGraph: focus and truncated',
	(() => {
		const g = parseGraph({ focus: 'a.md', truncated: 'yes' });
		return g.focus === 'a.md' && g.truncated === true && g.nodes.length === 0;
	})()
);
check(
	'parseMembers: me defaults to a nameless viewer',
	JSON.stringify(parseMembers({}).me) === '{"user_id":"","role":"viewer"}'
);
check(
	'parseMembers: me as sent',
	parseMembers({ me: { user_id: 'u1', role: 'admin' } }).me.role === 'admin'
);

const access = parseBrainAccess({
	access: [{ user_id: 'u2' }],
	visibility: 'private',
	activeBrain: { id: 'o/x', label: 'X' },
	me: { user_id: 'u1', role: 'admin', orgRole: null }
});
check(
	'parseBrainAccess: the brain the panel acts on',
	access.brainId === 'o/x' && access.brainLabel === 'X'
);
check('parseBrainAccess: a guest has a null org role, not viewer', access.me.orgRole === null);
check('parseBrainAccess: visibility as sent', access.visibility === 'private');
check('parseBrainAccess: visibility defaults to org', parseBrainAccess({}).visibility === 'org');
check(
	'parseBrainAccess: the label defaults to "this brain"',
	parseBrainAccess({}).brainLabel === 'this brain'
);
check(
	'parseBrainAccess: an org role as sent',
	parseBrainAccess({ me: { orgRole: 'owner' } }).me.orgRole === 'owner'
);

const analytics = parseAnalytics({});
check('parseAnalytics: the org name defaults', analytics.orgName === 'your organization');
check(
	'parseAnalytics: a missing window is an empty one, not undefined',
	analytics.window.days === 0 && analytics.window.from === ''
);
check(
	'parseAnalytics: missing totals are zeroes, not undefined',
	analytics.totals.calls === 0 && analytics.totals.members === 0
);
check('parseAnalytics: canSeePeople defaults false', analytics.canSeePeople === false);
check(
	'parseAnalytics: as sent',
	parseAnalytics({ window: { days: 30 }, canSeePeople: true, footnote: 'f' }).window.days === 30
);

check(
	'parseAccounts: the roster or nothing',
	parseAccounts({ accounts: [{ kind: 'email' }] }).length === 1 && parseAccounts({}).length === 0
);
check(
	'parseIdentity: only strings are identity',
	JSON.stringify(
		parseIdentity({ email: 'a@example.com', login: 7, role: null, activeBrain: { label: 'X' } })
	) === '{"email":"a@example.com","activeBrainLabel":"X"}'
);

// ---------------------------------------------------------------------------
console.log('\nBrains');
// ---------------------------------------------------------------------------
check(
	'parseOrgs: ABSENT is undefined (an older Worker: fall back to the derivation)',
	parseOrgs({}) === undefined
);
check(
	'parseOrgs: EMPTY is an empty list (a real answer: nowhere to add a brain)',
	parseOrgs({ orgs: [] })?.length === 0
);
check(
	'parseOrgs: rows without an id are dropped, a missing label is the id',
	JSON.stringify(
		parseOrgs({
			orgs: [{ orgId: 'o1', orgLabel: 'One' }, { orgLabel: 'nameless' }, { orgId: 'o2' }]
		})
	) === '[{"orgId":"o1","orgLabel":"One"},{"orgId":"o2","orgLabel":"o2"}]'
);
const brains = parseBrains({
	brains: [{ id: 'o/x' }],
	active: 'o/x',
	switched: 1,
	features: { analytics: true }
});
check(
	'parseBrains: the list, the active id, the switch flag',
	brains.brains.length === 1 && brains.active === 'o/x' && brains.switched === true
);
check('parseBrains: features ride along', brains.features?.analytics === true);
check(
	'parseBrains: defaults',
	JSON.stringify(parseBrains({})) === '{"brains":[],"switched":false}'
);
check('parseBrains: an empty active id is unset', parseBrains({ active: '' }).active === undefined);

const ROWS: BrainRow[] = [
	{
		id: 'o1/a',
		label: 'A',
		role: 'admin',
		active: true,
		canManage: true,
		orgId: 'o1',
		orgLabel: 'One'
	},
	{
		id: 'o1/b',
		label: 'B',
		role: 'admin',
		active: false,
		canManage: true,
		orgId: 'o1',
		orgLabel: 'One'
	},
	{
		id: 'o2/c',
		label: 'C',
		role: 'viewer',
		active: false,
		canManage: false,
		orgId: 'o2',
		orgLabel: 'Two'
	},
	{ id: 'o3/d', label: 'D', role: 'admin', active: false, canManage: true, orgId: 'o3' },
	{ id: 'x/e', label: 'E', role: 'admin', active: false, canManage: true }
];
check(
	'derivedOrgTargets: one per manageable org, labelled by the org, falling back to the brain',
	JSON.stringify(derivedOrgTargets(ROWS)) ===
		'[{"orgId":"o1","orgLabel":"One"},{"orgId":"o3","orgLabel":"D"}]',
	'o2 is not manageable; x/e names no org'
);

// ---------------------------------------------------------------------------
console.log('\nThe router');
// ---------------------------------------------------------------------------
const kindFor = (view: unknown) => parseToolView(view === undefined ? {} : { view }).kind;
check('no view token is a page', kindFor(undefined) === 'page');
check(
	'an unknown view token is a page (a newer server degrades to content)',
	kindFor('something-new') === 'page'
);
for (const v of [
	'browse',
	'edit',
	'activity',
	'graph',
	'members',
	'analytics',
	'brain-access',
	'brains'
] as const)
	check(`view "${v}" opens ${v}`, kindFor(v) === v);
check('view "settings" opens settings', kindFor('settings') === 'settings');
check(
	'view "connected_accounts" opens the SAME settings screen',
	kindFor('connected_accounts') === 'settings'
);
check(
	'a browse result over budget carries no tree (the app fetches it)',
	(() => {
		const v = parseToolView({ view: 'browse' });
		return v.kind === 'browse' && v.tree === null;
	})()
);
check(
	'a browse result within budget carries the tree',
	(() => {
		const v = parseToolView({
			view: 'browse',
			paths: ['a.md'],
			pages: [{ path: 'a.md', title: 'A' }]
		});
		return v.kind === 'browse' && v.tree?.titleByPath['a.md'] === 'A';
	})()
);
check(
	'the edit route has a string sha, the page route may have none',
	(() => {
		const e = parseToolView({ view: 'edit', path: 'a.md' });
		const p = parseToolView({ path: 'a.md' });
		return e.kind === 'edit' && e.sha === '' && p.kind === 'page' && p.sha === undefined;
	})()
);
check(
	'the settings route folds identity and accounts together',
	(() => {
		const v = parseToolView({
			view: 'settings',
			email: 'a@example.com',
			accounts: [{ kind: 'github' }]
		});
		return v.kind === 'settings' && v.identity.email === 'a@example.com' && v.accounts.length === 1;
	})()
);

done();
