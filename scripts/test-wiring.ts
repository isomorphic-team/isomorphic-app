// Golden test for the test wiring itself: every `test:*` script must appear in both
// `package.json`'s aggregate `test` script and `.github/workflows/ci.yml`, and the
// Playwright container CI runs the UI job in must be the version of Playwright this
// checkout resolves.
//
// CONTRIBUTING.md and CLAUDE.md carried the first half as prose, which does not fail a
// pull request. A battery wired only into `package.json` passes for whoever wrote it
// and never runs on anyone else's change.
//
// Three directions, each catching a different mistake:
//   1. missing from the aggregate  -> `pnpm test` does not run it
//   2. missing from ci.yml         -> it does not gate a pull request
//   3. in ci.yml but not a script  -> a rename left CI running nothing
//
// `test:wiring` is itself a `test:*` script, so it checks its own wiring too.
//
// The image pin is here for the same reason: it is a fact stated in two files that
// nothing enforced. `mcr.microsoft.com/playwright:vX.Y.Z-noble` ships exactly the
// browser build Playwright X.Y.Z looks for, so bumping the dependency without bumping
// the tag leaves CI with a browser that is not the one the tests ask for. That failure
// arrives as a missing browser in a job that never mentions versions, hours after the
// bump, so catch it at `pnpm test` time instead.
//
//   pnpm test:wiring

import { createRequire } from 'node:module';
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

// ---------- the Playwright container tag ----------

// The INSTALLED version, not the `^1.62.1` range in package.json: a range says nothing
// about which browser build is on disk, and the range is what stays put while the
// resolution moves.
const require = createRequire(import.meta.url);
const installedPlaywright = (
	JSON.parse(readFileSync(require.resolve('@playwright/test/package.json'), 'utf8')) as {
		version: string;
	}
).version;

// Every `mcr.microsoft.com/playwright:v<version>-<distro>` mention, wherever it appears:
// ci.yml pins the job, dev/README.md hands a maintainer the command that generates the
// Linux visual baselines. Those two must agree or the baselines are captured against a
// different browser than the one that compares them.
const pinned: Array<{ file: string; version: string }> = [];
for (const file of ['.github/workflows/ci.yml', 'dev/README.md']) {
	const text = readFileSync(new URL(file, root), 'utf8');
	for (const m of text.matchAll(/mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/g)) {
		pinned.push({ file, version: m[1] });
	}
}

console.log(`\nthe Playwright container tag matches the installed Playwright`);
check(
	'ci.yml pins a Playwright container image',
	pinned.some((p) => p.file === '.github/workflows/ci.yml'),
	'the UI job runs in mcr.microsoft.com/playwright:v<version>-noble so apt never runs'
);
for (const { file, version } of pinned) {
	check(
		`${file} pins v${version}`,
		version === installedPlaywright,
		`Playwright resolves to ${installedPlaywright} — update the image tag to v${installedPlaywright}-noble`
	);
}

console.log(
	failures === 0 ? '\nAll test-wiring checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
