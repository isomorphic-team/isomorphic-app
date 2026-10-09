// Boot smoke: the opening tool result reaches the app, and the self-boot does not
// overrule a result that is late or announced.
//
// The route sweep (every route in ROUTES mounts its view, never the error view, with
// no uncaught error, including `#cold`'s self-boot) is the inline pass of
// `bounds.spec.ts`'s "every route" sweep, which boots each route once already.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

test('the opening page route renders the fixture page content', async ({ page }) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');
	// Not just "a view mounted": the tool RESULT reached the app and rendered. This is
	// the sendToolResult path, the one every other route depends on.
	await expect(app.locator('main[data-view="page"]')).not.toBeEmpty();
});

// "No result yet" is not the same claim as "no result is coming". A host announces a
// tool call when it STARTS and delivers the result when the tool FINISHES, so a
// view_page slower than the self-boot deadline (cold Worker, index catch-up on a large
// brain) must not be replaced by the tree the self-boot opens, even though the tree's
// own list_pages, issued BEFORE the page arrived, answers after it.
test('a result slower than the self-boot deadline keeps its page and its brain', async ({
	page
}) => {
	const app = await openApp(page, 'slow-result');
	await expectView(app, 'page');
	// Past the point where the tree fetch the self-boot fired comes back (the harness
	// delays list_pages by 1600ms). The page has to still be there.
	await page.waitForTimeout(2500);
	await expect(app.locator('main[data-view="browse"]')).toHaveCount(0);
	await expectView(app, 'page');

	// #slow-result's opening result names Northwind, the way a `brain:`-targeted
	// view_page does. The tree fetch that lost the race went out before any result had
	// named a brain, so it answers about the CONNECTION's brain (Personal), with that
	// brain's path policy and page list. Adopting it would rename the crumb and cache the
	// wrong brain's tree behind it.
	await expect(app.locator('header').getByText('Northwind', { exact: true })).toBeVisible();
	// The brain crumb is the Files button on a page view. What opens has to be
	// Northwind's tree: `facilities` exists in no other fixture brain.
	await app.getByRole('button', { name: 'Northwind', exact: true }).click();
	await expectView(app, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await expect(app.getByRole('button', { name: 'facilities', exact: true })).toBeVisible();
});

test('the app waits for a result the host has told it is coming', async ({ page }) => {
	// #pending-input: the host announced the call (sendToolInput) before running it. That
	// is the app's signal that a result is on its way, so it must keep waiting rather
	// than opening the tree: no wasted list_pages, and no flash to fall back from.
	const app = await openApp(page, 'pending-input');
	await expectView(app, 'page');
	// Asserted on what the app ASKED FOR, not on what was on screen at some instant:
	// the self-boot's tree fetch and the result it raced are both timers, so a
	// screen-state check here would be a coin flip. `list_pages` is the self-boot's
	// first act and the app has no other reason to call it, so its absence is the
	// proof. Well past the 1200ms deadline by now.
	await page.waitForTimeout(1500);
	const calls = await page.evaluate(
		() => (window as unknown as { __toolCalls?: string[] }).__toolCalls ?? []
	);
	expect(calls, 'the app fetched the tree instead of waiting for the result').not.toContain(
		'list_pages'
	);
});
