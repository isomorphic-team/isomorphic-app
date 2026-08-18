// Route smoke: every hash route the harness serves mounts the view it promises.
//
// This is the cheapest test in the suite and catches the widest failure: the app
// bundle booting at all. A broken import, a codegen regression, a view that throws on
// first render, a registry kind that no longer resolves — all of it lands here, and
// before this existed none of it was caught by anything.
import { test, expect } from '@playwright/test';
import { openApp, expectView, ROUTES, type Route } from './harness.ts';

for (const [route, kind] of Object.entries(ROUTES) as [Route, string][]) {
	test(`#${route || '(default)'} mounts the ${kind} view`, async ({ page }) => {
		// A view that throws during render leaves the host connected and the frame
		// blank, which reads identically to "slow". Collecting page errors turns that
		// into the actual stack.
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));

		const app = await openApp(page, route);
		await expectView(app, kind);
		expect(errors, `uncaught error while rendering #${route}`).toEqual([]);
	});
}

test('the app never falls through to the error view on a normal open', async ({ page }) => {
	const app = await openApp(page, 'browse');
	// The error view is what the app shows when the handshake fails. Its absence is
	// the assertion that the REAL AppBridge handshake completed, which is the one
	// piece of prod machinery this harness does not stub.
	await expect(app.locator('main[data-view="error"]')).toHaveCount(0);
});

test('the opening page route renders the fixture page content', async ({ page }) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');
	// Not just "a view mounted": the tool RESULT reached the app and rendered. This is
	// the sendToolResult path, the one every other route depends on.
	await expect(app.locator('main[data-view="page"]')).not.toBeEmpty();
});

test('cold boot draws the tree with no opening tool result', async ({ page }) => {
	// The path where the app receives NO opening payload and has to self-boot: it calls
	// openBrowse() and ensureBrainList() itself after 1200ms. A real host does this
	// whenever the result is slower than the handshake, and it is the only path where
	// the app draws a brain's tree without any app-tool payload to learn the brain
	// from. Worth its own test because a regression here looks like "sometimes the app
	// comes up blank", which is exactly the kind of bug that gets called flaky.
	const app = await openApp(page, 'cold');
	await expectView(app, 'browse');
	await expect(page.locator('#status')).toContainText('cold');
});

// The other side of that self-boot, and the bug it caused: "no result yet" is not the
// same claim as "no result is coming". A host announces a tool call when it STARTS and
// delivers the result when the tool FINISHES, so a view_page slower than the deadline
// (cold Worker, index catch-up on a large brain) opens the tree by mistake — and the
// tree's own list_pages, issued BEFORE the page arrived, answers after it. What the user
// saw was the right page for a moment, then the file tree.
test('a result slower than the self-boot deadline is not replaced by the file tree', async ({
	page
}) => {
	const app = await openApp(page, 'slow-result');
	await expectView(app, 'page');
	// Past the point where the tree fetch the self-boot fired comes back (the harness
	// delays list_pages by 1600ms). The page has to still be there.
	await page.waitForTimeout(2500);
	await expect(app.locator('main[data-view="browse"]')).toHaveCount(0);
	await expectView(app, 'page');
});

test('the overtaken tree fetch does not repoint the widget at the brain it answered about', async ({
	page
}) => {
	// #slow-result's opening result names Northwind, the way a `brain:`-targeted
	// view_page does. The tree fetch that lost the race went out before any result had
	// named a brain, so it answers about the CONNECTION's brain (Personal) — and its
	// payload carries that brain, its path policy, and its whole page list. Adopting a
	// stale answer would rename the crumb and cache the wrong brain's tree behind it.
	const app = await openApp(page, 'slow-result');
	await expectView(app, 'page');
	await page.waitForTimeout(2500);
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
	// than opening the tree — no wasted list_pages, and no flash to fall back from.
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
