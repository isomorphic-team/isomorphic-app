// The header's TWO ROWS: navigation on top, what-you-can-do-here below.
//
// The split is the whole point of the chrome, and nothing else can see it. The
// destination list and the "which view am I standing on" rule have a pure golden test
// (`pnpm test:policy`, over app/core/nav.ts), but that test cannot tell whether the
// controls are actually in the bar, whether the row below appears for the views that
// have actions and stays away for the ones that do not, or whether the trail still
// offers the siblings it is supposed to offer and no longer offers the destinations it
// is not. All four are wiring, and wiring is what this battery is for.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

type App = Awaited<ReturnType<typeof openApp>>;

const banner = (app: App) => app.getByRole('banner');
const actionRow = (app: App) => app.locator('header [data-row="actions"]');

test('the brain’s own views are one press from the bar', async ({ page }) => {
	// The page view is the case that used to be hardest: a page's trail ends in a path
	// crumb, so it had no destination picker at all and the ⋯ menu was the only way to
	// Recent changes. Now it is one press, from here and from everywhere else.
	const app = await openApp(page, '');
	await expectView(app, 'page');

	await banner(app).getByRole('button', { name: 'Recent changes' }).click();
	await expectView(app, 'activity');

	await banner(app).getByRole('button', { name: 'Sharing' }).click();
	await expectView(app, 'brain-access');

	await banner(app).getByRole('button', { name: 'Files', exact: true }).click();
	await expectView(app, 'browse');
});

test('the destination you are looking at is marked, and only that one', async ({ page }) => {
	const app = await openApp(page, 'browse');
	// aria-current, not aria-pressed: these are navigation, and a nav control is current
	// or it is not — it is never a toggle that happens to be down.
	await expect(banner(app).getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(banner(app).getByRole('button', { name: 'Recent changes' })).not.toHaveAttribute(
		'aria-current',
		'page'
	);

	// A page is not a destination, so nothing in the cluster is current there. Marking
	// Files on a page would claim you are looking at the tree while reading a page.
	const onPage = await openApp(page, '');
	await expectView(onPage, 'page');
	await expect(
		banner(onPage).getByRole('button', { name: 'Files', exact: true })
	).not.toHaveAttribute('aria-current', 'page');
});

test('a crumb picker offers the folder’s contents, never the app’s destinations', async ({
	page
}) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');

	// The `concepts` crumb's picker: what else is in wiki/. This is the traversal the
	// trail exists for and it has to survive the destinations moving out of it.
	await banner(app).getByRole('button', { name: 'What else is in wiki', exact: true }).click();
	const menu = app.getByRole('menu');
	await expect(menu).toBeVisible();
	// Destinations are NOT crumb siblings. A view could never have stood where a path
	// segment stands, which is the reason they left.
	for (const name of ['Recent changes', 'Sharing', 'Graph', 'Your settings']) {
		await expect(menu.getByText(name, { exact: true })).toHaveCount(0);
	}
	// Real siblings, and clicking one navigates: `wiki/open-questions.md` sits beside
	// the `concepts` folder in the fixtures.
	await expect(menu.getByRole('menuitem', { name: 'people' })).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Open questions' }).click();
	await expectView(app, 'page');
	await expect(
		app.locator('main[data-view="page"]').getByRole('heading', { name: 'Open questions' })
	).toBeVisible();
});

test('the second row carries the view’s actions, and is absent when there are none', async ({
	page
}) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');
	await expect(actionRow(app)).toBeVisible();
	await expect(actionRow(app).getByRole('button', { name: 'Edit' })).toBeVisible();
	// The nav cluster stays in the row ABOVE. If Edit and Files ever share a row again,
	// this is the assertion that says so.
	await expect(actionRow(app).getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);

	// Recent changes declares no actions, so the row collapses to nothing rather than
	// ruling off 28px of empty bar.
	await banner(app).getByRole('button', { name: 'Recent changes' }).click();
	await expectView(app, 'activity');
	await expect(actionRow(app)).toBeHidden();
});

test('editing puts the toolbar and Save in the second row and takes navigation out of the first', async ({
	page
}) => {
	const app = await openApp(page, 'edit=wiki/concepts/vision.md');
	await expectView(app, 'edit');

	// The formatting toolbar is the row-two pattern every other view now follows.
	await expect(actionRow(app).getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
	await expect(actionRow(app).getByRole('button', { name: 'Save', exact: true })).toBeVisible();

	// Every destination leaves the page, and leaving mid-edit abandons the edit — so
	// while editing the cluster is not there to be pressed.
	for (const name of ['Files', 'Graph', 'Recent changes', 'Sharing', 'Search']) {
		await expect(banner(app).getByRole('button', { name })).toHaveCount(0);
	}
});
