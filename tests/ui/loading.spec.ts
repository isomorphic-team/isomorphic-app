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
// RECORDED IN THE PAGE, NOT POLLED FROM THE TEST. Three things forced this shape, each
// after a version of this file passed locally and failed on CI.
//
// 1. `page.clock.install()` does not pause timers here. Probed directly: a setTimeout in
//    the main frame AND in the app's iframe both fire with no `runFor`, so an installed
//    clock moves only what `Date.now()` reports while a setTimeout chain keeps running
//    on the wall clock. A rotation therefore cannot be stepped, only watched.
//    (`advanceable` is still right for refresh.spec, which asserts on a rendered AGE.)
// 2. Asserting at fixed moments races the machine. The first version checked "still the
//    label" after a click plus three awaits, which on a loaded runner had already spent
//    the 2.4s the label holds for.
// 3. Polling from the test races it too, and worse, SILENTLY. The second version sampled
//    `textContent({ timeout: 100 })` every 100ms; on CI every one of those calls timed
//    out under load, so it recorded nothing at all and failed with an empty sequence
//    rather than a wrong one.
//
// A MutationObserver inside the frame has none of those properties. It records every
// line the moment the DOM changes, at the speed the browser itself runs, and the test
// makes two round trips total: one to install it, one to collect. How slow the runner is
// changes when the answer arrives, not what it says.

import { test, expect, type Page, type Frame } from '@playwright/test';
import { openApp, expectView, appFrame } from './harness.ts';

const LABEL = 'Loading wiki/index.md…';

// Three lines take 5.2s at the view's 2.4s / 2.8s cadence. The deadline is far past that
// because waiting on the RECORDING costs nothing when it arrives early: the checks below
// return as soon as the rotation has shown enough, so this budget is only ever spent on
// a runner slow enough to need it. A tight bound bought nothing and was what turned a
// slow machine into a red build.
const ROTATION_DEADLINE_MS = 20000;
const ENOUGH = 3;

// Proving a thing does NOT happen means giving it the time in which it would have, so
// this one is paid in full every run.
const HOLD_MS = 9000;

declare global {
	interface Window {
		__seen?: string[];
	}
}

// The app's own frame. `appFrame` returns a FrameLocator, which cannot evaluate.
function appDoc(page: Page): Frame {
	const frame = page.frames().find((f) => f !== page.mainFrame());
	if (!frame) throw new Error('the app iframe never attached');
	return frame;
}

// Record every distinct line the wait draws, from before the wait even starts.
async function record(page: Page): Promise<void> {
	await appDoc(page).evaluate(() => {
		window.__seen = [];
		const read = () => {
			const text = document.querySelector('.loading-line')?.textContent ?? '';
			if (text && text !== window.__seen!.at(-1)) window.__seen!.push(text);
		};
		read();
		// childList catches the swap, which re-keys the span rather than editing it;
		// characterData is belt and braces in case that ever changes.
		new MutationObserver(read).observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true
		});
	});
}

const collect = (page: Page) => appDoc(page).evaluate(() => window.__seen ?? []);

// Click the `wiki` folder: its folder note is a page, so this is the ordinary navigate
// path, with the brain, the page and the page count all already known to the app.
async function startAWait(page: Page) {
	const app = await openApp(page, 'loading');
	await expectView(app, 'browse');
	await record(page);
	await app.getByText('wiki', { exact: true }).first().click();
	await expectView(app, 'loading');
	return app;
}

test('the caller’s own label leads, and the rotation follows it', async ({ page }) => {
	await startAWait(page);

	// Returns as soon as the rotation has shown enough to judge. The failure message
	// carries whatever WAS recorded, which is the difference between "it rotated wrongly"
	// and "nothing was ever recorded". The second version of this file failed the latter
	// way and read like the former.
	await appDoc(page)
		.waitForFunction((n) => (window.__seen?.length ?? 0) >= n, ENOUGH, {
			timeout: ROTATION_DEADLINE_MS
		})
		.catch(async () => {
			throw new Error(
				`the rotation never reached ${ENOUGH} lines: [${(await collect(page)).join(' → ')}]`
			);
		});
	const seen = await collect(page);
	const trail = `sequence: ${seen.join(' → ')}`;

	// The literal label is FIRST. A load that resolves quickly must read exactly as it
	// did before any of this existed: nothing whimsical is ever the only thing on screen
	// while somebody waits for an answer.
	expect(seen[0], trail).toBe(LABEL);

	// The first thing after the label is SPECIFIC: the folder note is named by its
	// folder, the brain by its label, both read from state the app already had. A
	// rotation that reached the library jokes here would mean the personalization never
	// happened.
	expect(seen[1], trail).toMatch(/wiki|Personal/);

	// Nothing ever swaps to itself.
	for (let i = 1; i < seen.length; i++) expect(seen[i], trail).not.toBe(seen[i - 1]);
});

test('the label is what gets announced, once', async ({ page }) => {
	const app = await startAWait(page);

	// The rotating line is decoration on this axis: a live region re-reading a new
	// phrase every few seconds is noise, so the announced element carries the label and
	// never re-keys.
	const status = app.locator('[role="status"]');
	await expect(status).toHaveText(LABEL);
	await appDoc(page)
		.waitForFunction((n) => (window.__seen?.length ?? 0) >= n, ENOUGH, {
			timeout: ROTATION_DEADLINE_MS
		})
		.catch(() => {
			throw new Error('the rotation never moved, so this check would pass vacuously');
		});
	await expect(status).toHaveText(LABEL);
	// The visible line HAS moved on, which is what makes the check above meaningful.
	await expect(app.locator('.loading-line')).not.toHaveText(LABEL);
});

test('with reduced motion, one phrase holds and nothing swaps', async ({ page }) => {
	// emulateMedia rather than `test.use({ reducedMotion })`: the describe-level option
	// does not reach this page (verified by reading matchMedia in both frames, which
	// answered false in each), and a preference that silently fails to apply would turn
	// this test into one that asserts nothing.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await startAWait(page);

	await page.waitForTimeout(HOLD_MS);
	const seen = await collect(page);
	expect(seen, 'nothing should swap under reduced motion').toEqual([LABEL]);

	// The shimmer is off too, and off by not being asked for rather than by being
	// overridden: the class carries the animation, so its absence is the assertion.
	await expect(appFrame(page).locator('.loading-line')).not.toHaveClass(/loading-shimmer/);
});
