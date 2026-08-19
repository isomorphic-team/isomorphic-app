// The wait itself, in a real browser.
//
// `pnpm test:loading` pins which phrases a wait is ALLOWED to draw. It cannot see any
// of what is here: that the label leads, that a swap happens at all, that the swapped
// line names the brain and the page the person is actually waiting on, and that
// prefers-reduced-motion stops the whole thing. Those live in the view, in an effect
// driven by a timer, over state the store holds.
//
// `#loading` is the route that makes it observable: it opens the tree normally and then
// holds the app's own fetches open forever, so the wait a click starts stays on screen
// (see dev/README.md).
//
// REAL TIME, AND SAMPLED. Two facts forced this shape, both learned the hard way when
// the first version passed on a developer's machine and failed on CI.
//
// `page.clock.install()` does NOT pause timers here. Probed directly: a setTimeout in
// the main frame AND in the app's iframe both fire without any runFor, so an installed
// clock only moves what `Date.now()` reports. The rotation is a setTimeout chain, so it
// runs on the wall clock no matter what this test does, and `runFor` merely added
// virtual jumps on top of it. (`advanceable` is still right for refresh.spec, which
// asserts on a rendered AGE and so only needs Date.now to move.)
//
// So the wait cannot be stepped, only watched, and a test that watches by asserting at
// fixed moments is a race against however slow the machine is: the first version
// checked "still the label" after a click plus three awaits, which on a loaded CI
// runner had already spent the 2.4s the label holds for. Sampling records the whole
// SEQUENCE from the moment the click lands, so slowness can delay the recording but
// cannot hide a frame from it, and every assertion below is about order rather than
// about what is on screen at some particular millisecond.

import { test, expect, type Page } from '@playwright/test';
import { openApp, expectView, appFrame } from './harness.ts';

const LABEL = 'Loading wiki/index.md…';

// Long enough for the label plus two swaps at the view's 2.4s / 2.8s cadence.
const WATCH_MS = 9000;
const SAMPLE_MS = 100;

// Click the `wiki` folder (its folder note is a page, so this is the ordinary navigate
// path, with the brain, the page and the page count all already known), then record
// every distinct line the wait draws.
//
// Sampling faster than the cadence by a wide margin: each line is up for at least
// 2.4s, so a 100ms sample cannot miss one.
async function watchAWait(page: Page): Promise<string[]> {
	const app = await openApp(page, 'loading');
	await expectView(app, 'browse');
	const line = app.locator('.loading-line');

	await app.getByText('wiki', { exact: true }).first().click();

	const seen: string[] = [];
	const deadline = Date.now() + WATCH_MS;
	while (Date.now() < deadline) {
		// Absent until the loading view mounts, and gone again if a result ever lands.
		const text = await line.textContent({ timeout: SAMPLE_MS }).catch(() => null);
		if (text && text !== seen.at(-1)) seen.push(text);
		await page.waitForTimeout(SAMPLE_MS);
	}
	return seen;
}

test('the caller’s own label leads, and the rotation follows it', async ({ page }) => {
	const seen = await watchAWait(page);

	// The literal label is FIRST. A load that resolves quickly must read exactly as it
	// did before any of this existed: nothing whimsical is ever the only thing on screen
	// while somebody waits for an answer.
	expect(seen[0], `sequence: ${seen.join(' → ')}`).toBe(LABEL);

	// Then it moves, more than once.
	expect(seen.length, `sequence: ${seen.join(' → ')}`).toBeGreaterThanOrEqual(3);

	// And the first thing after the label is SPECIFIC: the folder note is named by its
	// folder, the brain by its label, both read from state the app already had. A
	// rotation that reached the library jokes here would mean the personalization never
	// happened.
	expect(seen[1], `sequence: ${seen.join(' → ')}`).toMatch(/wiki|Personal/);

	// Every line is distinct from the one before it, so nothing "swaps" to itself.
	for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
});

test('the label is what gets announced, once', async ({ page }) => {
	const app = await openApp(page, 'loading');
	await expectView(app, 'browse');
	await app.getByText('wiki', { exact: true }).first().click();
	await expectView(app, 'loading');

	// The rotating line is decoration on this axis: a live region re-reading a new
	// phrase every few seconds is noise, so the announced element carries the label and
	// never re-keys.
	const status = app.locator('[role="status"]');
	await expect(status).toHaveText(LABEL);
	await page.waitForTimeout(WATCH_MS);
	await expect(status).toHaveText(LABEL);
	// Meanwhile the visible line has moved on, which is what makes the check meaningful.
	await expect(app.locator('.loading-line')).not.toHaveText(LABEL);
});

test('with reduced motion, one phrase holds and nothing swaps', async ({ page }) => {
	// emulateMedia rather than `test.use({ reducedMotion })`: the describe-level option
	// does not reach this page (verified by reading matchMedia in both frames, which
	// answered false in each), and a preference that silently fails to apply would turn
	// this test into one that asserts nothing.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const seen = await watchAWait(page);

	// The honest one is the one worth keeping when only one is allowed.
	expect(seen, 'nothing should swap under reduced motion').toEqual([LABEL]);

	// The shimmer is off too, and off by not being asked for rather than by being
	// overridden: the class carries the animation, so its absence is the assertion.
	await expect(appFrame(page).locator('.loading-line')).not.toHaveClass(/loading-shimmer/);
});
