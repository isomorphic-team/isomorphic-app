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
import {
	applyPolicy,
	resetPolicy,
	isEditablePath,
	applyBrainContext,
	activeBrain
} from '../app/core/store.ts';

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

console.log(
	failures === 0 ? '\nAll wire-contract checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
