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
