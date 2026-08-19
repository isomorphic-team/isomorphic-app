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
// (see dev/README.md). The clock is INSTALLED rather than fixed, so the rotation only
// advances when this test advances it and a slow machine can never read a different
// phrase than a fast one.

import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

const LABEL = 'Loading wiki/index.md…';

// Click the `wiki` folder: its folder note is a page, so this is the ordinary navigate
// path, with the brain, the page and the page count all already known to the app.
async function startAWait(page: import('@playwright/test').Page) {
	const app = await openApp(page, 'loading', { advanceable: true });
	await expectView(app, 'browse');
	await app.getByText('wiki', { exact: true }).first().click();
	await expectView(app, 'loading');
	return app;
}

test('the caller’s own label leads, and the rotation follows it', async ({ page }) => {
	const app = await startAWait(page);
	const line = app.locator('.loading-line');

	// The literal label holds first. A load that resolves quickly must read exactly as
	// it did before any of this existed: nothing whimsical is ever the only thing on
	// screen while someone waits for an answer.
	await expect(line).toHaveText(LABEL);
	await page.clock.runFor(2000);
	await expect(line).toHaveText(LABEL);

	// Past the first swap it is something else, and something SPECIFIC: the folder note
	// is named by its folder, and the brain by its label, both read from state the app
	// already had. A rotation that reached the generic pool this early would mean the
	// personalization never happened.
	await page.clock.runFor(1000);
	await expect(line).not.toHaveText(LABEL);
	await expect(line).toHaveText(/wiki|Personal/);

	// And it keeps moving.
	const second = await line.textContent();
	await page.clock.runFor(3000);
	await expect(line).not.toHaveText(second ?? '');
});

test('the label is what gets announced, once', async ({ page }) => {
	const app = await startAWait(page);
	// The rotating line is decoration on this axis: a live region re-reading a new
	// phrase every few seconds is noise, so the announced element carries the label and
	// never re-keys.
	await expect(app.locator('[role="status"]')).toHaveText(LABEL);
	await page.clock.runFor(6000);
	await expect(app.locator('[role="status"]')).toHaveText(LABEL);
	await expect(app.locator('.loading-line')).not.toHaveText(LABEL);
});

test.describe('with reduced motion', () => {
	// emulateMedia rather than `test.use({ reducedMotion })`: the describe-level option
	// does not reach this page (verified by reading matchMedia in both frames, which
	// answered false in each), and a preference that silently fails to apply would turn
	// this test into one that asserts nothing.
	test('one phrase holds and nothing swaps', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const app = await startAWait(page);
		const line = app.locator('.loading-line');
		// The honest one is the one worth keeping when only one is allowed.
		await expect(line).toHaveText(LABEL);
		await page.clock.runFor(12000);
		await expect(line).toHaveText(LABEL);
		// The shimmer is off too, and off by not being asked for rather than by being
		// overridden: the class carries the animation, so its absence is the assertion.
		await expect(line).not.toHaveClass(/loading-shimmer/);
	});
});
