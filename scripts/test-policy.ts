// Golden test for the WIRE CONTRACT between the Worker and the app — pure, no
// network, no DOM (app/core/store.ts imports only types + brain-policy).
//
// Two facts ride the same payload, and BOTH have shipped broken by being left off
// `list_pages`. That tool is the app's own navigation channel: the widget calls it
// directly (a brain switch re-fetches with it, and the self-boot in connectToHost
// opens the tree with it), so its result never passes through handleToolResult and
// is frequently the only thing the app has to go on.
//
//   PATH POLICY — the file tree rendering one brain under a DIFFERENT brain's
//   policy. `brainPolicy` is app-global and was only refreshed by results from the
//   app tools, so a tree fetched by the widget kept whatever policy was there
//   before. On a whole-repo brain (`contentRoots: ["."]`) the wiki/ default is
//   maximally wrong: every folder reads as "no content page could live here" and
//   vanishes from the tree, and every root page reads as read-only and shows a lock.
//
//   BRAIN IDENTITY — the trail's root crumb naming a brain it cannot identify. Every
//   app tool carries `activeBrain`; list_pages did not, so a self-booted widget drew
//   the whole tree with `activeBrain` null and the root crumb fell back to the word
//   "Files", rendering the trail as "Files / Files".
//
//   pnpm test:policy

import { readFileSync } from 'node:fs';
import { parsePaths } from '../src/lib/brain-config.ts';
import { pathPolicyOf, isContentPath, isHiddenName } from '../src/lib/brain-policy.ts';
import { browseSummary, treeFitsInline, MAX_INLINE_TREE_CHARS } from '../src/lib/browse.ts';
import {
	applyPolicy,
	resetPolicy,
	isEditablePath,
	applyBrainContext,
	activeBrain,
	browseCache,
	setBrowseCache,
	setActiveBrain,
	pickShownBrain
} from '../app/core/store.ts';
import { renderAge, refreshOutcome } from '../app/core/util.ts';
import { DEST_META, destinationsIn, activeDestination, isMorePlace } from '../app/core/nav.ts';
import { panelPlacement, GAP, COMFORTABLE } from '../app/core/menu-placement.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

// A whole-repo brain, exactly as a live .isomorphic.json declares it.
const wholeRepo = { paths: parsePaths({ contentRoots: ['.'], sourceRoots: [], logPath: '' }) };
// A conventional brain, the shape the app defaults to.
const wikiStyle = { paths: parsePaths({}) };

// What actually crosses the wire: pathPolicyOf(config) serialized in
// structuredContent, then handed to applyPolicy on the other side.
function deliver(policy: { paths: Record<string, string> }) {
	return JSON.parse(JSON.stringify({ config: pathPolicyOf(policy as never) }));
}

// The app's tree rule (Browse.tsx buildTree): a FOLDER is hidden when no content
// page could live under it; a FILE shows a lock when it is not editable.
const pages = [
	'CHANGELOG.md',
	'CLAUDE.md',
	'GAPS.md',
	'README.md',
	'_template.md',
	'decisions/README.md',
	'guides/bitwarden.md',
	'incidents/README.md',
	'policies/README.md',
	'references/README.md',
	'runbooks/README.md',
	'meta/README.md'
];
function render() {
	const folders = new Set<string>();
	for (const p of pages) {
		const d = p.split('/').slice(0, -1).join('/');
		if (d) folders.add(d);
	}
	const visibleFolders = [...folders].filter(
		(f) => !(isHiddenName(f) || !isEditablePath(`${f}/x.md`))
	);
	const rootFiles = pages.filter((p) => !p.includes('/'));
	return {
		folders: `${visibleFolders.length}/${folders.size}`,
		locked: `${rootFiles.filter((p) => !isEditablePath(p)).length}/${rootFiles.length}`
	};
}

console.log('\nWorker→app wire contract\n');

console.log('parse');
check('contentRoots ["."] means the whole repo is content', wholeRepo.paths['.'] === 'content');
check('an absent config keeps the wiki/ default', wikiStyle.paths['wiki/'] === 'content');

console.log('\nwire round-trip');
{
	const wire = deliver(wholeRepo);
	check(
		'pathPolicyOf survives JSON',
		JSON.stringify(wire.config.paths) === JSON.stringify(wholeRepo.paths)
	);
	check(
		'what the Worker sends is what applyPolicy consumes',
		(() => {
			resetPolicy();
			applyPolicy(wire);
			return isEditablePath('README.md');
		})()
	);
}

console.log('\nthe reported bug: a whole-repo brain under the wiki/ default');
{
	resetPolicy(); // the app's starting state, and what a brain switch now restores
	const before = render();
	check('folders all vanish', before.folders === '0/7', before.folders);
	check('every root page is locked', before.locked === '5/5', before.locked);

	applyPolicy(deliver(wholeRepo));
	const after = render();
	check('policy delivered → folders come back', after.folders === '7/7', after.folders);
	check('policy delivered → no page is locked', after.locked === '0/5', after.locked);
}

console.log('\nbrain switch must not inherit the previous brain’s policy');
{
	applyPolicy(deliver(wholeRepo)); // browsing the whole-repo brain
	check('whole-repo brain: README.md editable', isEditablePath('README.md'));

	// Switch to a conventional brain. Before the fix nothing cleared this, so the
	// new brain rendered under the old brain's roles.
	resetPolicy();
	check(
		'after switch: falls back to the documented default, not brain A',
		!isEditablePath('README.md')
	);
	check('after switch: wiki/ pages editable', isEditablePath('wiki/note.md'));

	applyPolicy(deliver(wikiStyle));
	check('brain B policy applied', isEditablePath('wiki/note.md') && !isEditablePath('README.md'));

	// ...and back the other way, which is the direction that produced the screenshot.
	resetPolicy();
	applyPolicy(deliver(wholeRepo));
	check('switching back re-widens correctly', isEditablePath('README.md'));
}

console.log('\nmalformed / missing payloads never widen access');
{
	applyPolicy(deliver(wikiStyle));
	applyPolicy({}); // a result with no config at all (brains, members, switch_brain)
	check('a config-less result leaves the policy alone', !isEditablePath('README.md'));

	applyPolicy({ config: { paths: { '.': 'not-a-role' } } });
	check('an unknown role is dropped, not trusted', !isEditablePath('README.md'));

	applyPolicy({ config: { paths: [] } });
	check('a non-object paths is ignored', !isEditablePath('README.md'));
}

console.log('\nthe app and the Worker agree');
{
	// isEditablePath IS isContentPath against the delivered policy — the whole point
	// of bundling brain-policy.ts into both. Assert they cannot drift.
	applyPolicy(deliver(wholeRepo));
	const probes = ['README.md', 'wiki/a.md', 'deep/nested/page.md', '.isomorphic.json'];
	const agree = probes.every((p) => isEditablePath(p) === isContentPath(p, wholeRepo as never));
	check('app verdict matches the Worker predicate on every probe', agree);
	check('the config file itself is never editable', !isEditablePath('.isomorphic.json'));
}

console.log('\nbrain identity rides the same payload');
{
	// The SEND side. Driving the real handler would need a live index and a store, so
	// this reads the source the way test-usage scans the tool files for registered
	// names: the assertion is that the field is in the payload at all, and the failure
	// it catches is someone editing that return without it.
	//
	// COMMENTS ARE STRIPPED FIRST, and that is not a detail — the prose around this
	// return names every field in it, so the first version of this check passed on a
	// comment while the payload itself had already lost `activeBrain`.
	const core = readFileSync(new URL('../src/tools/core.ts', import.meta.url), 'utf8').replace(
		/^[ \t]*\/\/.*$/gm,
		''
	);
	// The only structuredContent in the file is the no-prefix branch's (the prefix
	// branch returns text alone).
	const at = core.indexOf('structuredContent: {');
	const payload = at === -1 ? '' : core.slice(at, core.indexOf('};', at));
	check('list_pages sends the path policy', /config:\s*pathPolicyOf\(config\)/.test(payload));
	check('list_pages sends the active brain', /\bactiveBrain\b/.test(payload));
	check(
		'…resolved from the context, not invented',
		/const \{[^}]*\bactiveBrain\b[^}]*\} = await getContext/.test(core)
	);

	// The RECEIVE side: what the app does with it, and what it refuses to do without it.
	applyBrainContext({ activeBrain: { id: 'acme/brain-acme', label: 'Acme' } });
	check('the app adopts a delivered brain', activeBrain?.label === 'Acme');

	applyBrainContext({}); // a payload with no brain at all (search_pages, read_page)
	check('a brain-less result leaves the crumb alone', activeBrain?.label === 'Acme');

	applyBrainContext({ activeBrain: { id: 'x' } }); // half a brain — id, no label
	check('a malformed brain is ignored, not half-adopted', activeBrain?.label === 'Acme');

	applyBrainContext({ activeBrain: { id: 'northwind/brain-nw', label: 'Northwind' } });
	check('a switch is adopted in full', activeBrain?.id === 'northwind/brain-nw');
}

// ---------------------------------------------------------------------------
// Which brain the widget is SHOWING (issue #26).
//
// The model can aim any view tool at a named brain (`view_page(brain: X)`), and the
// panel rendered a different one: the crumb, the file tree and the picker's checkmark
// all followed the CONNECTION's active-brain pointer, which the app re-read on every
// open and which lags the request that just moved it. So the tool reported one brain
// while the user was looking at another.
// ---------------------------------------------------------------------------

const A = { id: 'acme/brain-acme', label: 'Acme' };
const B = { id: 'northwind/brain-nw', label: 'Northwind' };
const rows = [
	{ id: A.id, label: A.label, active: true },
	{ id: B.id, label: B.label, active: false }
];
const someTree = {
	paths: ['wiki/a.md'],
	titleByPath: {},
	assets: [],
	hidden: [],
	needsConfig: false
};

console.log('\nopening a named brain retargets the whole widget');
{
	setActiveBrain(A);
	setBrowseCache(someTree);
	applyPolicy(deliver(wholeRepo)); // brain A is a whole-repo brain

	// A view_page/browse_brain the MODEL aimed at another brain. Nothing about this
	// path goes near switchBrain, which is where the invalidation used to live.
	applyBrainContext({ activeBrain: B });
	check('the widget follows the brain the result names', activeBrain?.id === B.id);
	check('brain A’s file tree is dropped', browseCache === null);
	check('…and so is its path policy', !isEditablePath('README.md'));

	// Same brain again: nothing to invalidate, and re-fetching the tree on every
	// result would undo the cache's whole purpose.
	setBrowseCache(someTree);
	applyBrainContext({ activeBrain: B });
	check('a result for the SAME brain keeps the cached tree', browseCache !== null);
}

console.log('\nthe connection’s pointer never overrides the brain on screen');
{
	setActiveBrain(B); // the widget was opened on Northwind by name

	// The brain list the app fetches on every open. `active` is the pointer, written
	// fire-and-forget by the request that opened us and read back here — this is the
	// stale answer that used to retarget the widget.
	const picked = pickShownBrain(rows, A.id, false);
	check('a plain brains list does not move the widget', picked?.id === B.id);
	check('…and refreshes the label from the list row', picked?.label === 'Northwind');

	// A deliberate change of brain (switch_brain / create_brain, which set `switched`)
	// IS the answer to this question, and must win.
	const switched = pickShownBrain(rows, A.id, true);
	check('a switch_brain result moves the widget', switched?.id === A.id);

	// The self-boot: no result has named a brain, so the pointer is all there is.
	setActiveBrain(null);
	check(
		'with nothing on screen yet, the pointer wins',
		pickShownBrain(rows, A.id, false)?.id === A.id
	);

	// A brain we can no longer see (unshared, disconnected) is not a destination.
	setActiveBrain(B);
	check(
		'a shown brain missing from the list falls back to the pointer',
		pickShownBrain([rows[0]], A.id, false)?.id === A.id
	);
	check('a list naming neither leaves the widget alone', pickShownBrain([], A.id, false) === null);
}

// ---------------------------------------------------------------------------
// What the page viewer is allowed to say about its own render (issue #29).
//
// A render was a snapshot of a page that keeps moving, with no control to reload it
// and nothing recording which version or which moment it came from. Both rules below
// decide what the reader is TOLD, which is the part that can be wrong in a way no
// type catches: a control that reports an age reports a false one just as readily as
// a true one, and a refresh that claims "no change" on a page that did change is
// worse than the silence it replaced.
// ---------------------------------------------------------------------------

console.log('\nhow old a render says it is');
{
	const now = Date.parse('2026-08-17T12:00:00Z');
	const ago = (ms: number) => now - ms;

	check('a render with no fetch time claims no age', renderAge(undefined, now) === null);
	check('nor does one stamped zero', renderAge(0, now) === null);
	// Under the threshold the honest answer is silence, not "0m": a control that
	// announces an age on a one-second-old render teaches the reader to ignore it.
	check('a fresh render says nothing', renderAge(ago(1_000), now) === null);
	check('…still nothing at 59s', renderAge(ago(59_000), now) === null);
	check('one minute is where it starts speaking', renderAge(ago(60_000), now) === '1m');
	check('minutes below the hour', renderAge(ago(45 * 60_000), now) === '45m');
	check(
		'…and 59m does not round up to an hour',
		renderAge(ago(59 * 60_000 + 59_000), now) === '59m'
	);
	check('hours below the day', renderAge(ago(3 * 3600_000), now) === '3h');
	check('…and 23h stays hours', renderAge(ago(23 * 3600_000 + 59 * 60_000), now) === '23h');
	check('a day and beyond', renderAge(ago(50 * 3600_000), now) === '2d');
	// A clock that moved backwards under us would otherwise produce a negative age
	// and, once floored, a confident "0m" on a render from the future.
	check('a backwards clock claims nothing', renderAge(now + 60_000, now) === null);
}

console.log('\nwhat a finished refresh may claim');
{
	check('the same blob means nothing moved', refreshOutcome('abc', 'abc') === 'current');
	check('a different blob means it did', refreshOutcome('abc', 'def') === 'updated');
	// Either side missing is a real case (a Worker that predates the sha), and the
	// answer is to withhold the claim rather than guess one. Guessing 'updated' cries
	// wolf on every refresh; guessing 'current' hides the edit the reader came for.
	check('no sha before means no claim', refreshOutcome(undefined, 'def') === 'unknown');
	check('no sha after means no claim', refreshOutcome('abc', undefined) === 'unknown');
	check('neither side means no claim', refreshOutcome(undefined, undefined) === 'unknown');
	check('an empty sha is missing, not equal', refreshOutcome('', '') === 'unknown');
}

// ---------------------------------------------------------------------------
// What browse_brain carries (the same issue's second half).
//
// It returned every path twice — text plus structuredContent, with a title per page —
// which on a 556-page brain came to 83,708 characters and was refused as a tool result.
// The tree now rides along only while it is small; over budget the app fetches it with
// list_pages, which is the `else openBrowse()` branch of handleToolResult.
// ---------------------------------------------------------------------------

function fakeBrain(n: number) {
	const folders = ['people', 'projects', 'customers', 'meetings'];
	const paths = Array.from(
		{ length: n },
		(_, i) => `wiki/${folders[i % folders.length]}/page-${i}-with-a-realistic-name.md`
	);
	return {
		paths,
		pages: paths.map((path, i) => ({ path, title: `Page ${i} With A Realistic Title` })),
		assets: [],
		hidden: []
	};
}

console.log('\nbrowse_brain fits in a tool result');
{
	const big = fakeBrain(556); // the reported brain
	check('a few hundred pages no longer ride inline', !treeFitsInline(big));
	check('a small brain still does', treeFitsInline(fakeBrain(20)));
	check(
		'the budget is the serialized payload, not a page count',
		JSON.stringify(fakeBrain(20)).length <= MAX_INLINE_TREE_CHARS &&
			JSON.stringify(big).length > MAX_INLINE_TREE_CHARS
	);

	const summary = browseSummary('Acme', big);
	check('the summary names the brain', summary.includes('Acme'));
	check('…and how many pages it has', summary.includes('556'));
	check('…and tallies the folders below the shared root', /people \(139\)/.test(summary));
	check('…not the one root they all share', !/\bwiki \(/.test(summary));
	check('…and says where the full list lives', summary.includes('list_pages'));
	check(
		'the summary is a fraction of the payload it replaces',
		summary.length < JSON.stringify(big).length / 10
	);

	// Every path directly under the root: there is no folder to tally, and "(top level)"
	// is not a folder anyone can open, so it is counted apart.
	const flat = { paths: ['a.md', 'b.md'], pages: [], assets: [], hidden: [] };
	check(
		'a flat brain counts its pages, not a folder',
		/\(top level\) \(2\)/.test(browseSummary('Flat', flat))
	);
	check(
		'an empty brain says so plainly',
		browseSummary('Fresh', { paths: [], pages: [], assets: [], hidden: [] }) ===
			'Fresh has no pages yet.'
	);
}

// ---------- the nav's destinations ----------
//
// The bar's right-hand cluster and the ⋯ menu are two renderings of ONE list, which is
// the point of app/core/nav.ts: they used to be two hand-written lists that had already
// drifted. What is pinned here is the pair of decisions the renderings make no judgement
// about — which destinations a given deployment actually has, and which view counts as
// standing on one. A destination offered where its tool is not registered comes back
// "unknown tool" on click, and one that lights up on the wrong view tells the user they
// are somewhere they are not.
console.log('\nnav destinations');
{
	const full = { analytics: true, canManageBrains: true };
	const bare = { analytics: false, canManageBrains: false };

	check(
		'the rail is the five views OF a brain, in rail order',
		destinationsIn('brain', full).join() === 'files,graph,search,activity,sharing'
	);
	check(
		'…and none of them is gated — every one is open to anyone who can reach the brain',
		destinationsIn('brain', bare).join() === 'files,graph,search,activity,sharing'
	);
	check(
		'a deployment with USAGE_ANALYTICS off never offers Analytics',
		destinationsIn('org', bare).join() === 'members' &&
			destinationsIn('org', full).join() === 'members,analytics'
	);
	check(
		'Manage brains appears only for an admin of some org',
		destinationsIn('account', bare).join() === 'settings' &&
			destinationsIn('account', full).join() === 'brains,settings'
	);
	// Every destination is filed under exactly one scope, so the three lists partition
	// the set: a destination missing from all three is unreachable, and one in two of
	// them appears twice in the same menu.
	const partitioned = (['brain', 'org', 'account'] as const).flatMap((s) =>
		destinationsIn(s, full)
	);
	check(
		'the three scopes partition the whole destination list',
		partitioned.length === Object.keys(DEST_META).length &&
			new Set(partitioned).size === partitioned.length
	);
	check(
		'every destination has a scope the cluster or the menu will render',
		(Object.keys(DEST_META) as (keyof typeof DEST_META)[]).every((k) =>
			['brain', 'org', 'account'].includes(DEST_META[k].scope)
		)
	);

	check('a view that IS a destination marks it', activeDestination('browse') === 'files');
	check('…including the org ones', activeDestination('members') === 'members');
	// A pushed flow has not left the destination it was opened from, so the control that
	// got you there stays lit rather than going dark mid-flow.
	check(
		'a flow step counts as its parent destination',
		activeDestination('invite-member') === 'members'
	);
	check('…the sharing one too', activeDestination('share-brain') === 'sharing');
	// Marking Files while reading a page would claim you are looking at the tree.
	check('a page is not a destination', activeDestination('page') === null);
	check('nor is the editor', activeDestination('edit') === null);
	// Search is a PLACE now (its own page, its own field), so it marks itself. It was
	// briefly a control in the chrome that swapped the trail for an input, and null here
	// is what that version asserted.
	check('search is a destination and marks itself', activeDestination('search') === 'search');
	// The cluster only ever lights a destination that is IN it. An unknown kind (a view
	// added later without a mapping) must read as "nowhere", never as the previous view.
	check('an unmapped view marks nothing', activeDestination('brand-new-view') === null);

	// THE ⋯ RAIL ITEM stays lit past its own page. More is an index of the org and
	// account destinations, so arriving at one of them by way of it has not left it —
	// without this the rail goes dark two steps in and stops answering "where am I".
	check('More marks itself', isMorePlace('more'));
	check('…and everything it leads to', isMorePlace('members') && isMorePlace('settings'));
	check('…including a flow pushed off one of those', isMorePlace('invite-member'));
	// The rail shows the brain's own five itself, so they light their own icon, never ⋯.
	check(
		'a brain destination is never the ⋯',
		!isMorePlace('browse') && !isMorePlace('search') && !isMorePlace('graph')
	);
	check(
		'nor is a page, an editor, or an unknown view',
		!isMorePlace('page') && !isMorePlace('edit') && !isMorePlace('brand-new-view')
	);

	// A blurb is what the More page puts under each row. Required on every destination
	// (see DEST_META) so a new one cannot land as a bare word with a gap beneath it.
	check(
		'every destination carries a non-empty blurb',
		(Object.keys(DEST_META) as (keyof typeof DEST_META)[]).every(
			(k) => typeof DEST_META[k].blurb === 'string' && DEST_META[k].blurb.trim().length > 0
		)
	);
}

console.log('\nmenu placement');
{
	// The rule two popovers share: ui/Menu's panel and the file tree's per-row ⋯. A
	// panel taller than the room on its side does not clip, it makes the CARD scroll,
	// which drags the chrome out of sight and reads as a clipped rail.
	const H = 500;

	const top = panelPlacement({ top: 20, bottom: 40 }, H);
	check('a trigger in the top bar opens downward', !top.up);
	check('…taking the room beneath it, less the gap', top.maxH === H - 40 - GAP);

	const low = panelPlacement({ top: 470, bottom: 490 }, H);
	check('a trigger at the bottom of a short card flips up', low.up);
	check('…taking the room above it instead', low.maxH === 470 - GAP);

	// The flip is not "whichever side is bigger". Down is preferred while down is
	// usable, or a menu with plenty of room beneath it would jump above the trigger the
	// moment the card grew a little taller than the panel.
	const roomy = panelPlacement({ top: 300, bottom: 320 }, H);
	check(
		'a cramped side does not flip while it is still comfortable',
		H - 320 - GAP >= COMFORTABLE ? !roomy.up : roomy.up
	);
	const both = panelPlacement({ top: 200, bottom: 220 }, 1000);
	check('plenty of room below wins even with more above', !both.up);

	// A panel is never given a negative budget: a trigger past the bottom edge (a row
	// scrolled out of view) would otherwise produce maxHeight: -30px.
	check(
		'an off-screen trigger yields no negative cap',
		panelPlacement({ top: 900, bottom: 950 }, 500).maxH >= 0
	);
	check(
		'…and a trigger above the top edge does too',
		panelPlacement({ top: -80, bottom: -60 }, 500).maxH >= 0
	);
}

console.log(
	failures === 0 ? '\nAll wire-contract checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
