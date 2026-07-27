// Golden test for the path-policy WIRE CONTRACT between the Worker and the app —
// pure, no network, no DOM (app/core/store.ts imports only types + brain-policy).
//
// The bug this exists to catch: the app's file tree rendering one brain under a
// DIFFERENT brain's policy. `brainPolicy` is app-global and was only refreshed by
// results from the five app tools, so a tree fetched by the widget itself (via
// list_pages, which is what a brain switch re-fetches with) kept whatever policy
// was there before — another brain's, or the hardcoded wiki/ default.
//
// On a whole-repo brain (`contentRoots: ["."]`) that default is maximally wrong:
// every folder reads as "no content page could live here" and vanishes from the
// tree, and every root page reads as read-only and shows a lock.
//
//   pnpm test:policy

import { parsePaths } from '../src/lib/brain-config.ts';
import { pathPolicyOf, isContentPath, isHiddenName } from '../src/lib/brain-policy.ts';
import { applyPolicy, resetPolicy, isEditablePath } from '../app/core/store.ts';

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

console.log('\nPath policy — Worker→app wire contract\n');

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

console.log(
	failures === 0 ? '\nAll path-policy checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
