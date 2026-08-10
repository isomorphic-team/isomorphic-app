// Shared helpers for the UI tests. Everything that knows HOW to reach the app lives
// here, so a change to the harness's URL contract is one edit rather than fifty.
import { expect, type FrameLocator, type Page } from '@playwright/test';

/**
 * The instant every test pretends it is.
 *
 * The harness derives the analytics window, its per-day series, the activity feed's
 * relative timestamps, and invite ages from `?now=` (see dev/harness.ts). Freezing it
 * is what lets a test assert on a rendered date at all, and what stops every visual
 * baseline from rotting at the next UTC midnight.
 *
 * Chosen as a WEDNESDAY, deliberately: `usageFixtureRows` zeroes weekend rows, so a
 * weekend anchor would render the analytics tab's most recent days empty and quietly
 * weaken the one view whose whole point is showing activity.
 */
export const FROZEN_NOW = '2026-08-05T12:00:00Z';

/** Every hash route the harness understands, and the view kind it must land on. */
export const ROUTES = {
	'': 'page',
	browse: 'browse',
	edit: 'edit',
	'edit=wiki/playbooks/brand-voice.md': 'edit',
	members: 'members',
	analytics: 'analytics',
	brains: 'brains',
	access: 'brain-access',
	graph: 'graph',
	activity: 'activity',
	settings: 'settings',
	connected: 'settings',
	'browse-empty': 'browse',
	nobrains: 'add-brain',
	// No opening tool result at all: the app self-boots into the tree after 1200ms.
	cold: 'browse'
} as const;

/**
 * A route the harness understands.
 *
 * The named ones above, plus `edit=<any path>`: the edit route takes a page path, so
 * enumerating it would mean listing every fixture page. Spelling it as a template
 * literal keeps a typo in a NAMED route an error while letting the editor tests open
 * whichever page they need.
 */
export type Route = keyof typeof ROUTES | `edit=${string}`;
export type DisplayMode = 'inline' | 'fullscreen' | 'pip';

/**
 * The app itself, inside the harness's iframe.
 *
 * Selected STRUCTURALLY. The frame is `srcdoc` with `sandbox="allow-scripts"`, so it
 * has an opaque origin and NO url: any frameLocator that matches on url or name will
 * never resolve. Playwright reaches into it fine because it works at the browser
 * protocol level rather than through same-origin JS.
 */
export function appFrame(page: Page): FrameLocator {
	return page.frameLocator('#frame-slot iframe');
}

/** Open a route and wait until the app has actually rendered a view. */
export async function openApp(
	page: Page,
	route: Route = '',
	opts: { mode?: DisplayMode; now?: string } = {}
): Promise<FrameLocator> {
	const now = opts.now ?? FROZEN_NOW;

	// TWO clocks have to be frozen, and freezing one without the other still drifts.
	//
	//   ?now=      the HARNESS's clock. Fixes the DATA the fixtures produce: the
	//              analytics window and its day series, the activity feed's commit
	//              dates, invite ages.
	//   setFixedTime  the APP's clock, inside the iframe. Fixes how the app RENDERS
	//              those dates, which it does relatively ("last active 5d ago") off
	//              its own Date.now(). The harness cannot reach that.
	//
	// With only `?now=`, the analytics tab renders fixed data through a moving lens
	// and every relative label changes daily. Verified: it reads "12h ago" pinned and
	// "5d ago" when only the harness clock is frozen.
	//
	// setFixedTime, not install(): install() also freezes TIMERS, and the app's cold
	// self-boot is a 1200ms setTimeout that would then never fire.
	await page.clock.setFixedTime(new Date(now));

	const params = new URLSearchParams();
	params.set('now', now);
	if (opts.mode) params.set('mode', opts.mode);
	await page.goto(`/?${params}${route ? `#${route}` : ''}`);

	const app = appFrame(page);
	// Wait on the APP having rendered a view, not on the host's status line. The status
	// line says the transport connected, which is true a beat before the app has drawn
	// anything, and `#cold` deliberately never advances it past the handshake.
	// `[data-view]` is set on <main> at the single render site in app/main.tsx.
	await expect(app.locator('main[data-view]')).toBeAttached({ timeout: 30_000 });
	return app;
}

/** Assert which view is on screen. */
export async function expectView(app: FrameLocator, kind: string) {
	// Long timeout: `#cold` waits out the app's own 1200ms self-boot delay, and a
	// route that lands on `loading` first has to settle.
	await expect(app.locator(`main[data-view="${kind}"]`)).toBeVisible({ timeout: 15_000 });
}

/**
 * Settle the frame for a screenshot.
 *
 * The app animates the editor toolbar in (grid-template-rows, 200ms) and the harness
 * resizes the inline card from `onsizechange` as content lands, so a screenshot taken
 * the moment a view appears can catch either mid-flight. `animations: 'disabled'`
 * handles CSS animations; this covers the host-side resize, which is a JS message.
 */
export async function settle(page: Page) {
	await page.waitForTimeout(350);
	await page.evaluate(() => document.fonts?.ready);
}
