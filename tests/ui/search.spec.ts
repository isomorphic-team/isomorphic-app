// Search, through the real app over the host harness: the search page itself, and
// cross-brain search.
//
// The engine is pinned by `pnpm test:search` (which brains a search reaches, how hits
// are budgeted across them). What only a browser can catch is the CLICK: a fan-out
// result names a brain other than the one you are in, and `navigateTo` resolves a path
// against the ACTIVE brain. So opening a foreign hit has to switch first, or the app
// asks the wrong brain for the path and renders a missing page. Nothing else in the
// suite exercises that ordering.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

// Present in the Northwind fixture and nowhere else, so a hit for it is proof the
// search left the brain the app opened in (Personal).
const ONLY_IN_NORTHWIND = 'Primary site';

type App = Awaited<ReturnType<typeof openApp>>;

// Open the search page from the rail.
async function openSearch(app: App) {
	await app.locator('aside[aria-label="Places"]').getByRole('button', { name: 'Search' }).click();
	await expectView(app, 'search');
	return app.locator('main[data-view="search"]').getByPlaceholder('Search this brain…');
}

async function search(app: App) {
	const box = await openSearch(app);
	await box.fill(ONLY_IN_NORTHWIND);
	await box.press('Enter');
	return box;
}

test('search is a PAGE that owns its own field', async ({ page }) => {
	// Search arrives like every other destination in the rail, with the field ON the
	// page: that gives it room for a long query, keeps the query visible while you read
	// the results, and leaves somewhere to put the empty state.
	const app = await openApp(page, 'browse');
	const box = await openSearch(app);
	const body = app.locator('main[data-view="search"]');
	// Nothing has been asked yet, so this is an invitation and not "no results". Saying
	// "no matches for ''" would report a failure that never happened.
	await expect(body.getByText('Search the pages of this brain by their text.')).toBeVisible();
	await expect(box).toBeFocused();

	// A term in the fixture pages, so this exercises a hit rather than the empty state.
	await box.fill('vision');
	await box.press('Enter');
	await expectView(app, 'search');
	const hit = body.getByRole('button').filter({ hasText: 'wiki/concepts/vision.md' });
	await expect(hit.first()).toBeVisible();
	// The query survives the search, in the thing you typed it into.
	await expect(body.getByPlaceholder('Search this brain…')).toHaveValue('vision');
	// And a hit navigates.
	await hit.first().click();
	await expectView(app, 'page');
});

test('a search stays in the active brain until you widen it', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await search(app);
	await expectView(app, 'search');
	// The default reach is one brain. Fan-out being opt-in is the whole reason an
	// ordinary search keeps an ordinary blast radius, so assert the narrow case first:
	// this text is in the fixtures, just not in THIS brain.
	await expect(app.getByText(`No matches for “${ONLY_IN_NORTHWIND}”`)).toBeVisible();
});

test('widening the search finds the other brain, and every hit names it', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await search(app);
	await app.getByRole('button', { name: 'Search all your brains' }).click();
	// A result set that does not say which brain each line came from is how one
	// client's material gets quoted into another client's conversation.
	await expect(app.getByText('Northwind', { exact: true }).first()).toBeVisible();
});

test('opening a foreign hit switches brain before it loads the page', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await search(app);
	await app.getByRole('button', { name: 'Search all your brains' }).click();

	const hit = app.getByRole('button').filter({ hasText: ONLY_IN_NORTHWIND }).first();
	await expect(hit).toBeVisible();
	await hit.click();

	// It must land on the PAGE, not on the new brain's file tree: switchBrain ends in
	// openBrowse, and reusing it here would drop the user somewhere they did not ask
	// for. The hit named a page.
	await expectView(app, 'page');
	// And the crumb must follow the content. The inverse (content from one brain under
	// another brain's name) is issue #26, which the store's pickShownBrain exists to
	// prevent; this is the same invariant reached from the search side.
	await expect(app.getByRole('button', { name: 'Northwind' }).first()).toBeVisible();
});
