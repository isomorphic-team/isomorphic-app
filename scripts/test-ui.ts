// UI tests for the MCP App, over the local host harness. Playwright + Chromium.
//
//   pnpm test:ui
//
// This wrapper exists so `pnpm test:ui` can be a member of the aggregate `pnpm test`
// without making a ~100 MB browser download a hard prerequisite for running the test
// suite at all. Every other battery in this repo is pure Node and offline; a
// contributor who clones the repo and runs `pnpm test` should not hit a wall here.
//
// So it SKIPS GREEN, loudly, on either of two conditions, rather than failing:
//
//   1. Chromium is not installed. Prints the one command that fixes it.
//   2. This platform has no visual baselines. Screenshots are platform-specific
//      (font rasterization differs between macOS and the Linux CI runner), and a
//      missing baseline is a setup gap, not a regression. Only the visual project is
//      skipped; the functional tests still run.
//
// UI_STRICT=1 turns both skips into failures. CI sets it: there a missing browser
// means the container stopped carrying one, and missing baselines mean the visual
// comparison would silently not run. Baselines for `linux` and `darwin` are committed.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const strict = process.env.UI_STRICT === '1';

function warn(message: string, fix?: string) {
	// `::warning::` renders as an annotation on the run in GitHub Actions and is just
	// a line of text everywhere else.
	console.log(`${process.env.GITHUB_ACTIONS ? '::warning::' : '  ! '}${message}`);
	if (fix) console.log(`    fix: ${fix}`);
}

// ---------- 1. is there a browser? ----------

let browserPath: string | null = null;
try {
	// Resolved through the installed Playwright rather than by guessing at the cache
	// layout, which differs by platform and by version.
	const { chromium } = await import('@playwright/test');
	const p = chromium.executablePath();
	browserPath = p && existsSync(p) ? p : null;
} catch {
	browserPath = null;
}

if (!browserPath) {
	const message = 'Chromium is not installed, so the UI tests did not run.';
	if (strict) {
		console.error(`\n  ✗ ${message}`);
		console.error('    UI_STRICT=1 is set, so this is a failure.');
		console.error('    fix: pnpm exec playwright install --with-deps chromium\n');
		process.exit(1);
	}
	console.log('\nUI tests (MCP App over the local host harness)');
	warn(message, 'pnpm exec playwright install chromium');
	console.log('  skipped\n');
	process.exit(0);
}

// ---------- 2. are there visual baselines for this platform? ----------

// Must match `snapshotPathTemplate` in playwright.config.ts, whose {platform} token
// is process.platform ('darwin' | 'linux' | 'win32').
const shots = new URL(`tests/ui/__screenshots__/${process.platform}/`, root);
const hasBaselines = existsSync(shots) && readdirSync(shots).some((f) => f.endsWith('.png'));

// `web` runs unconditionally beside `functional`: it needs the same browser and no
// baselines. It is a separate project because it drives a different HOST — the
// bundle as a top-level document over its own server — not because it is optional.
const projects = ['functional', 'web'];
if (hasBaselines) {
	projects.push('visual');
} else {
	const message = `No visual baselines for ${process.platform}, so the visual project did not run.`;
	const fix = `pnpm ui:baselines  (then commit tests/ui/__screenshots__/${process.platform}/; see dev/README.md §Visual baselines)`;
	if (strict) {
		console.error(`\n  ✗ ${message}`);
		console.error('    UI_STRICT=1 is set, so this is a failure.');
		console.error(`    fix: ${fix}\n`);
		process.exit(1);
	}
	warn(message, fix);
}

// ---------- run ----------

console.log(`\nUI tests — projects: ${projects.join(', ')}\n`);

const result = spawnSync(
	'pnpm',
	['exec', 'playwright', 'test', ...projects.map((p) => `--project=${p}`)],
	{ cwd: fileURLToPath(root), stdio: 'inherit' }
);

process.exit(result.status ?? 1);
