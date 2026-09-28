// The header holds still.
//
// Two defects, neither visible to the visual baselines, which only ever photograph a
// screen that has FINISHED:
//
//   - The title started in two places. Brain screens lead the trail with the brain
//     glyph and org/account screens had nothing there, so crossing between them slid
//     the title 25px sideways and back. (ScopeMark in components/Breadcrumb.)
//   - A load redrew the whole bar. The loading view has no place of its own, so the
//     trail fell through to the brain crumb while it waited: More → Members read
//     "More", then "Personal", then "Members". The header's actions emptied and came
//     back, and the back button greyed out and relit. (chromeView in the store.)
//
// The load cases run on `#loading`, which holds the app's own fetches open forever, so
// the load STAYS on screen and can be asserted on. Sampling a real load frame by frame
// was tried first and could not fail: the harness answers in well under a frame, so the
// loading frame usually never painted and the sampler passed with the defect reinstated.
import { test, expect, type FrameLocator } from '@playwright/test';
import { openApp, expectView, type Route } from './harness.ts';

/** The trail's first word, and where it starts in px from the frame's left edge. */
function title(app: FrameLocator): Promise<{ text: string; x: number }> {
	return app.locator('header nav').evaluate((nav) => {
		const first = [...nav.querySelectorAll('button, span, a')].find(
			(e) => e.children.length === 0 && (e.textContent ?? '').trim()
		);
		if (!first) throw new Error('the trail has no text');
		return {
			text: (first.textContent ?? '').trim(),
			x: Math.round(first.getBoundingClientRect().x)
		};
	});
}

/** The view's own actions in the header's right-hand slot (window controls excluded). */
const actions = (app: FrameLocator) => app.locator('header span.ml-auto > button');

// One screen per shape the trail can take: the tree (the brain crumb alone), a page
// (brain + path), a brain destination, the two org screens, the account screens, the
// brains list, and the first-run flow.
const ROUTES: Route[] = [
	'browse',
	'page=wiki/index.md',
	'graph',
	'members',
	'analytics',
	'settings',
	'brains',
	'nobrains'
];

test('the title starts at the same place on every screen', async ({ page }) => {
	const seen: Record<string, number> = {};
	for (const route of ROUTES) seen[route] = (await title(await openApp(page, route))).x;
	const xs = new Set(Object.values(seen));
	expect(xs.size, `title x by screen: ${JSON.stringify(seen)}`).toBe(1);
});

test('while a page loads, the bar still shows where you are, actions and all', async ({ page }) => {
	const app = await openApp(page, 'loading');
	const back = app.getByRole('button', { name: 'Back', exact: true });
	const before = await title(app);
	const count = await actions(app).count();
	expect(count).toBeGreaterThan(0);

	// read_page never answers here, so this load stays on screen.
	await app.getByRole('button', { name: 'wiki', exact: true }).click();
	await expectView(app, 'loading');

	expect(await title(app)).toEqual(before);
	// The tree's actions exist only while the tree is mounted. The bar keeps them in
	// place, disabled, rather than dropping to the window controls for the wait.
	await expect(actions(app)).toHaveCount(count);
	await expect(actions(app).first()).toBeDisabled();
	// Somewhere to go back to, and a load does not grey that out.
	await expect(back).toBeEnabled();

	// Back from a load is "never mind": the screen it started from, at once.
	await back.click();
	await expectView(app, 'browse');
	await expect(back).toBeDisabled();
});

// The tree's trail is the brain crumb alone, which is also what the old loading frame
// drew, so the case above cannot tell them apart. A search's trail can.
test('a search in flight keeps the trail it started from', async ({ page }) => {
	const app = await openApp(page, 'loading');
	await app
		.locator('aside')
		.getByRole('button', { name: /Search/ })
		.first()
		.click();
	await expectView(app, 'search');
	const trail = () => app.locator('header nav').innerText();
	const before = await trail();
	expect(before).toContain('Search');

	// search_pages never answers here.
	const field = app.locator('main input').first();
	await field.fill('vision');
	await field.press('Enter');
	await expectView(app, 'loading');
	expect(await trail()).toBe(before);
});

test('leaving an account screen for an org one never draws the brain in between', async ({
	page
}) => {
	const app = await openApp(page, 'loading');
	await app.locator('aside').getByRole('button', { name: /More/ }).first().click();
	await expectView(app, 'more');
	const more = await title(app);
	expect(more.text).toBe('More');

	// members never answers here.
	await app
		.locator('main')
		.getByRole('button', { name: /Members/ })
		.first()
		.click();
	await expectView(app, 'loading');
	// Before the fix: "Personal", 25px to the right, until the roster arrived.
	expect(await title(app)).toEqual(more);

	await app.getByRole('button', { name: 'Back', exact: true }).click();
	await expectView(app, 'more');
});
