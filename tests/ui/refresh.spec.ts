// The page viewer's refresh control (issue #29).
//
// A render was a snapshot of a page that keeps moving: no way to reload it, nothing
// saying how old it was, and no signal when it stopped matching the brain. The rules
// about what a refresh may CLAIM are pure and pinned by `pnpm test:policy`; what only
// a browser can answer is whether the control is on the page at all, whether pressing
// it actually replaces the content, and whether the age it reports appears when it
// should. All three are app wiring, which no other battery sees.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

test('the page viewer offers a refresh, and it reports finding nothing new', async ({ page }) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');

	// Named, not "the second icon button": an icon-only control's accessible name is
	// the thing a screen reader has to work from, so asserting through it also asserts
	// the control is reachable.
	const refresh = app.getByRole('button', { name: /Refresh this page/ });
	await expect(refresh).toBeVisible();

	await refresh.click();
	// Nothing changed behind us, and the toast has to say so. A refresh that repaints
	// identical bytes in silence is indistinguishable from one that quietly failed,
	// which is the confusion this control exists to end.
	await expect(app.getByText('Already up to date')).toBeVisible();
	await expectView(app, 'page');
});

test('refreshing picks up an edit made behind the widget', async ({ page }) => {
	// The harness edits the open page immediately after sending the opening result,
	// so the widget is rendering content the brain has already moved past.
	const app = await openApp(page, 'stale');
	await expectView(app, 'page');

	const added = 'Added by somebody else while you were reading.';
	await expect(app.getByText(added)).toHaveCount(0);

	await app.getByRole('button', { name: /Refresh this page/ }).click();

	// Both halves matter: the content is actually replaced, and the app SAYS the page
	// moved rather than reporting the no-change message. Getting the second wrong
	// would leave the reader believing an edit they were told about never landed.
	await expect(app.getByText(added)).toBeVisible();
	await expect(app.getByText('Updated to the latest version')).toBeVisible();
});

test('the control reports the render age once it is worth reporting', async ({ page }) => {
	const app = await openApp(page, '', { advanceable: true });
	await expectView(app, 'page');

	// Fresh: the control is there and says nothing about age, because "0m" on a render
	// one second old trains the reader to ignore the number.
	const refresh = app.getByRole('button', { name: /Refresh this page/ });
	await expect(refresh).toHaveText('');
	await expect(refresh).toHaveAccessibleName('Refresh this page');

	// openApp freezes the clock, so time only moves when the test moves it. Nothing
	// re-renders the app on its own while somebody reads, which is why the view runs
	// its own tick; advancing past that tick is what proves the tick exists.
	await page.clock.runFor('05:00');

	await expect(refresh).toHaveText('5m');
	await expect(refresh).toHaveAccessibleName('Refresh this page (fetched 5m ago)');
});
