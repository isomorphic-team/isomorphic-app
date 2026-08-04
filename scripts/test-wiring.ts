// Golden test for the test wiring itself: every `test:*` script must appear in both
// `package.json`'s aggregate `test` script and `.github/workflows/ci.yml`.
//
// CONTRIBUTING.md and CLAUDE.md carried that as prose, which does not fail a pull
// request. A battery wired only into `package.json` passes for whoever wrote it and
// never runs on anyone else's change.
//
// Three directions, each catching a different mistake:
//   1. missing from the aggregate  -> `pnpm test` does not run it
//   2. missing from ci.yml         -> it does not gate a pull request
//   3. in ci.yml but not a script  -> a rename left CI running nothing
//
// `test:wiring` is itself a `test:*` script, so it checks its own wiring too.
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
