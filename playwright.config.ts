// Playwright config for the MCP App UI tests (`pnpm test:ui`).
//
// WHAT THESE TESTS DRIVE. Not a new fixture: the existing local host harness
// (`dev/harness.ts`), served by `scripts/app-dev.ts --once`. That harness already
// loads the REAL generated `ui://` bytes into a sandboxed iframe and drives them with
// the REAL AppBridge over the REAL PostMessageTransport, answering tool calls from
// in-memory fixtures. So a test here exercises the actual app bundle and the actual
// host protocol, and only the tool RESULTS are stubbed.
//
// WHAT THEY DELIBERATELY DO NOT COVER. Tool semantics. The view engine, page patches,
// the access rule, the analytics fold, and OKF structure are all pinned by pure golden
// tests (`test:views`, `test:patch`, `test:access`, `test:usage`, `test:structure`)
// that run in milliseconds with no browser. Re-asserting any of that through the DOM
// would be a slower duplicate that fails for unrelated reasons. These tests answer a
// different question: does the app MOUNT, WIRE UP, and ROUTE.
//
// And they say nothing about the real host. The harness IS the host here, so the
// claude.ai mount gap (docs/references.md), the real iframe CSP, and the auth round
// trip stay invisible. Those need a real host; see dev/README.md.
import { defineConfig, devices } from '@playwright/test';

// Deliberately NOT 5175. That is `pnpm app:dev`'s port, and a maintainer with the
// preview open should not have their session hijacked (or the run fail on a port
// clash) just because they also ran the tests.
export const UI_TEST_PORT = Number(process.env.UI_TEST_PORT) || 5176;

// The WEB host's own server (`scripts/web-dev.ts`), which is a different program
// from the harness: it serves the bundle as a top-level document and answers its
// tool calls over HTTP from the local runtime. Same reasoning as above for the
// port — not 5177 either, which is `pnpm web:dev`'s.
export const WEB_TEST_PORT = Number(process.env.WEB_TEST_PORT) || 5178;
const WEB_TEST_UPSTREAM = Number(process.env.WEB_TEST_UPSTREAM) || 8789;

export default defineConfig({
	testDir: './tests/ui',
	// Snapshots are platform-specific: font rasterization and scrollbar metrics differ
	// between macOS and the Linux CI runner, so a baseline captured on one fails on the
	// other for reasons that have nothing to do with the app. Keeping {platform} in the
	// path lets both live side by side, and lets `scripts/test-ui.ts` check whether
	// THIS platform has baselines before it runs the visual project at all.
	snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
	fullyParallel: true,
	// A stray `test.only` locally is a nuisance; in CI it silently shrinks the suite to
	// one test and reports green.
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	// The html reporter is CI-only, and exists to be UPLOADED: ci.yml collects
	// playwright-report/ and test-results/ on failure. Without it the retained traces
	// below are written and then discarded with the runner. `open: 'never'` because
	// nothing on a runner can open a browser.
	reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: `http://localhost:${UI_TEST_PORT}`,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	expect: {
		// Anti-aliasing differs by a pixel or two between runs of the same browser on the
		// same machine. A tiny ratio absorbs that without hiding a real layout break,
		// which moves far more than 1% of the frame.
		toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' }
	},
	projects: [
		{
			name: 'functional',
			use: { ...devices['Desktop Chrome'] },
			testIgnore: [/visual\.spec\.ts/, /web-nav\.spec\.ts/]
		},
		{
			name: 'visual',
			use: { ...devices['Desktop Chrome'] },
			testMatch: /visual\.spec\.ts/
		},
		{
			// The web host. A separate project because it has its own baseURL: these
			// specs load a top-level document from the web server, not the harness.
			name: 'web',
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${WEB_TEST_PORT}` },
			testMatch: /web-nav\.spec\.ts/
		}
	],
	webServer: [
		{
			// --once: one build, then a static server. No watchers, no live-reload channel,
			// so nothing can reload the page mid-assertion. See scripts/app-dev.ts.
			command: 'pnpm exec tsx scripts/app-dev.ts --once',
			env: { PORT: String(UI_TEST_PORT) },
			url: `http://localhost:${UI_TEST_PORT}/`,
			// Reuse a server a maintainer already has up locally; never in CI, where a
			// leftover process would mean testing a stale bundle.
			reuseExistingServer: !process.env.CI,
			// The server runs `pnpm gen:app` before it can serve, which is tens of seconds on
			// a cold CI runner.
			timeout: 180_000,
			stdout: 'pipe',
			stderr: 'pipe'
		},
		{
			// The web app, over its own brain. `--reset` and a dedicated BRAIN_DIR
			// because this one is a real git repo the app WRITES to: sharing the
			// preview's brain would make a run depend on whatever a maintainer last
			// edited, and would edit it back.
			command: 'pnpm exec tsx scripts/web-dev.ts --reset',
			env: {
				PORT: String(WEB_TEST_PORT),
				UPSTREAM_PORT: String(WEB_TEST_UPSTREAM),
				BRAIN_DIR: 'dev/web-test-brain'
			},
			url: `http://localhost:${WEB_TEST_PORT}/b/local/web-test-brain`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
			stdout: 'pipe',
			stderr: 'pipe'
		}
	]
});
