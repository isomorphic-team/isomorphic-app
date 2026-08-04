// Golden test for the TEST WIRING itself: every `test:*` script has to be listed in
// BOTH `package.json`'s aggregate `test` script and `.github/workflows/ci.yml`.
//
// CONTRIBUTING.md and CLAUDE.md have both carried that instruction as prose for a
// while ("or it runs in exactly one place and nobody notices which"). Prose does not
// fail a pull request. The failure mode is silent in the direction that matters: a
// battery wired only into `package.json` passes locally for whoever wrote it and
// never runs on anyone else's change, so the regression it was written to catch
// comes back through CI green.
//
// Deliberately three-way, because each direction catches a different mistake:
//   1. missing from the aggregate  -> `pnpm test` is a lie
//   2. missing from ci.yml         -> the pull-request gate is a lie
//   3. in ci.yml but not a script  -> a rename left CI running nothing
//
// This test lints itself: `test:wiring` is a `test:*` script, so it has to appear in
// both places too, and it will report itself if it does not.
//
//   pnpm test:wiring

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
	scripts: Record<string, string>;
};
const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

const batteries = Object.keys(pkg.scripts).filter((s) => s.startsWith('test:'));
const aggregate = pkg.scripts.test ?? '';

// `- run: pnpm test:foo`, tolerant of quoting and trailing whitespace.
const inCi = new Set(Array.from(ci.matchAll(/pnpm\s+(test:[a-z0-9:-]+)/g), (m) => m[1]));

console.log(`\nthe ${batteries.length} test:* scripts are wired in both places`);
check('there is at least one battery to check', batteries.length > 0);

for (const name of batteries) {
	// Word-boundary the match so `test:index` cannot be satisfied by `test:index-foo`.
	const inAggregate = new RegExp(`pnpm ${name}(?![a-z0-9:-])`).test(aggregate);
	check(`${name} is in the aggregate \`test\` script`, inAggregate, 'add it to package.json');
	check(`${name} is in ci.yml`, inCi.has(name), 'add a `- run: pnpm ' + name + '` step');
}

console.log('\nci.yml does not run anything that stopped existing');
for (const name of inCi) {
	check(`${name} is a real package.json script`, name in pkg.scripts, 'renamed or removed?');
}

console.log(
	failures === 0 ? '\nAll test-wiring checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
