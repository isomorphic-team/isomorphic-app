// THE CHROME: a rail of destinations on the left, a trail on the top-left saying where
// you are, and what-you-can-do-here on the top-right.
//
// The pure golden test (`pnpm test:policy`, over app/core/nav.ts) owns the DECISIONS:
// which destinations a deployment has, what order they sit in, which view counts as
// standing on which one, and whether the ⋯ is the current place. It cannot see any of
// the wiring, which is what this battery is for: that the controls are actually in the
// bar, that pressing one arrives, that the row below the trail appears only for the
// editor, that the trail opens nothing, and that navigation survives an open editor.
//
// It also pins the NEGATIVES, which is most of this chrome's history. Every arrangement
// before this one failed by letting one surface answer two questions: destinations
// inside the breadcrumb's chevrons, then destinations sharing a run of buttons with the
// page's own actions, then a ⋯ menu holding both places and a window control. The
// assertions that a thing is ABSENT are the ones that catch a slide back, so they are
// here deliberately and are not redundant with the positive ones.
//
// ONE openApp PER TEST, still. The harness now blanks the page before every open, so a
// second call in one test is no longer the silent trap it was — a hash-only goto is a
// same-document navigation, and specs were asserting against whatever the previous step
// had left on screen (see openApp in harness.ts). Splitting is kept anyway: two starting
// states in one test is two tests' worth of failure to read from one red line.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectView, settle } from './harness.ts';

type App = Awaited<ReturnType<typeof openApp>>;

const rail = (app: App) => app.locator('aside[aria-label="Places"]');
const bar = (app: App) => app.locator('header');
const actionRow = (app: App) => app.locator('header [data-row="actions"]');
/** A rail control by its accessible name. Scoped, because tree rows carry a ⋯ too. */
const go = (app: App, name: string) => rail(app).getByRole('button', { name, exact: true });
const railNames = (app: App) =>
	rail(app)
		.locator('button')
		.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

// The door from the card to the web app. What matters is the URL the app hands the
// HOST: the same page, same brain, at the base the server sent. The harness records
// every openLink request (dev/harness.ts) because no tab opens under test, and which
// browser it would open in is the host's decision, not the app's.
test.describe('open in browser', () => {
	const opened = (page: Page) =>
		page.evaluate(() => (window as unknown as { __openedLinks: string[] }).__openedLinks);

	test('asks the host to open the page you are reading', async ({ page }) => {
		const app = await openApp(page, '');
		await expectView(app, 'page');
		await app.getByRole('button', { name: 'Open in browser' }).click();
		expect(await opened(page)).toEqual([
			'https://brain.example/b/your-org/personal-wiki/wiki/concepts/vision.md'
		]);
	});

	test('names the destination, not just the brain, for a non-page view', async ({ page }) => {
		const app = await openApp(page, 'graph');
		await expectView(app, 'graph');
		await app.getByRole('button', { name: 'Open in browser' }).click();
		expect((await opened(page))[0]).toBe(
			'https://brain.example/b/your-org/personal-wiki?view=graph'
		);
	});

	test('is not offered in the editor, where unsaved text would be lost', async ({ page }) => {
		const app = await openApp(page, 'edit');
		await expectView(app, 'edit');
		await expect(app.getByRole('button', { name: 'Open in browser' })).toHaveCount(0);
	});
});

test.describe('the rail', () => {
	test('holds the brain’s own views, in order, and each one arrives', async ({ page }) => {
		const app = await openApp(page, 'browse');
		// Order is asserted here as well as in test:policy, because that test proves
		// DEST_META is in this order and this one proves the rail RENDERS it — the icons
		// come from a second record (components/Destinations.tsx), joined by key.
		expect(await railNames(app)).toEqual([
			'Files',
			'Graph',
			'Search',
			'Recent changes',
			'Sharing',
			'More'
		]);

		await go(app, 'Recent changes').click();
		await expectView(app, 'activity');
		await go(app, 'Sharing').click();
		await expectView(app, 'brain-access');
		await go(app, 'Search').click();
		await expectView(app, 'search');
		await go(app, 'Graph').click();
		await expectView(app, 'graph');
		await go(app, 'Files').click();
		await expectView(app, 'browse');
	});

	test('says so when Graph means THIS page rather than the whole brain', async ({ page }) => {
		// The one contextual control in the rail: from a page it passes that page's path
		// and view_graph returns the subgraph around it. A control whose meaning changes
		// with context has to say so, and its name is where it says it.
		const app = await openApp(page, '');
		await expectView(app, 'page');
		expect(await railNames(app)).toContain('Show this page in the graph');
		await go(app, 'Show this page in the graph').click();
		await expectView(app, 'graph');
	});

	test('marks the destination you are looking at, and only that one', async ({ page }) => {
		const app = await openApp(page, 'browse');
		// aria-current, not aria-pressed: these are navigation, and a nav control is
		// current or it is not — it is never a toggle that happens to be down.
		await expect(go(app, 'Files')).toHaveAttribute('aria-current', 'page');
		await expect(rail(app).locator('button[aria-current="page"]')).toHaveCount(1);
	});

	test('marks nothing while you read a page, which is not a destination', async ({ page }) => {
		// Marking Files here would claim you are looking at the tree. The page came from
		// the tree; it is not a place in the rail's list.
		const app = await openApp(page, '');
		await expectView(app, 'page');
		await expect(rail(app).locator('button[aria-current="page"]')).toHaveCount(0);
	});

	test('is still there while you edit, and a clean editor leaves without asking', async ({
		page
	}) => {
		const app = await openApp(page, 'edit=wiki/concepts/vision.md');
		await expectView(app, 'edit');
		// The rail used to empty itself out during an edit. That cost the user their
		// navigation and protected nothing, since the trail beside it stayed linked and
		// kept switching brains.
		await expect(go(app, 'Files')).toBeVisible();
		// Nothing typed, so nothing to lose and no question to ask.
		await go(app, 'Graph').click();
		await expectView(app, 'graph');
	});

	test('asks before a destination abandons an edit in progress', async ({ page }) => {
		const app = await openApp(page, 'edit=wiki/concepts/vision.md');
		await expectView(app, 'edit');
		await app.locator('.ProseMirror').click();
		await page.keyboard.type('a change nobody asked for');

		await go(app, 'Files').click();
		// Scoped to the dialog: the editor's own Cancel is still on screen behind it.
		const ask = app.getByRole('dialog', { name: 'Discard your changes?' });
		await expect(ask).toBeVisible();
		// Cancel keeps you where you were, with the edit intact.
		await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expectView(app, 'edit');

		await go(app, 'Files').click();
		await ask.getByRole('button', { name: 'Discard', exact: true }).click();
		await expectView(app, 'browse');
	});
});

test.describe('the ⋯', () => {
	test('is a PAGE, not a menu, and stays lit on everything it leads to', async ({ page }) => {
		const app = await openApp(page, 'browse');
		await go(app, 'More').click();
		await expectView(app, 'more');
		// The whole reason it stopped being a popover: a panel hanging off the rail is
		// bounded by the room beneath a trigger that sits ~145px down at any card height.
		await expect(app.getByRole('menu')).toHaveCount(0);
		await expect(go(app, 'More')).toHaveAttribute('aria-current', 'page');
		// Each row says what it is FOR. A menu had no room for that, and "Analytics"
		// alone is a guess.
		await expect(app.getByText('Who is in your organization')).toBeVisible();

		// Two steps in, the rail still answers "where am I". Without this it goes dark on
		// Members and reads as though you had left it.
		await app.getByRole('button', { name: /Members/ }).click();
		await expectView(app, 'members');
		await expect(go(app, 'More')).toHaveAttribute('aria-current', 'page');
	});

	test('does not hold the brain’s own views, or the display mode', async ({ page }) => {
		const app = await openApp(page, 'browse');
		await go(app, 'More').click();
		await expectView(app, 'more');
		const body = app.locator('main[data-view="more"]');
		// These five stand in the rail. A row each would be a second way to say the same
		// thing, which is what the ⋯ menu and the crumb pickers had become to each other.
		for (const name of ['Files', 'Graph', 'Search', 'Recent changes', 'Sharing'])
			await expect(body.getByText(name, { exact: true })).toHaveCount(0);
		// Display is a WINDOW control, not a place. Here, going fullscreen would mean
		// leaving what you were reading and then landing on this screen instead of on it.
		for (const name of ['Inline', 'Fullscreen', 'Pop-out'])
			await expect(body.getByText(name, { exact: true })).toHaveCount(0);
	});
});

test.describe('the trail', () => {
	test('opens nothing: no pickers on any crumb', async ({ page }) => {
		const app = await openApp(page, '');
		await expectView(app, 'page');
		// Every segment used to carry a picker. They lost to the same ceiling: a panel
		// hanging off the top row gets the space beneath it and no more.
		await expect(app.getByRole('menu')).toHaveCount(0);
		const labels = await bar(app)
			.locator('button')
			.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim()));
		expect(labels).toEqual([
			'Switch brain',
			'Personal',
			'wiki',
			'concepts',
			'Refresh this page',
			'Edit',
			// The window group, after the rule: the door to the web app, then the
			// display mode. The harness sends `features.webBase`, as a deployment
			// serving the web app does.
			'Open in browser',
			'Display: Inline'
		]);
	});

	test('is opened by the brain GLYPH, which goes to the Brains page', async ({ page }) => {
		const app = await openApp(page, 'browse');
		await bar(app).getByRole('button', { name: 'Switch brain' }).click();
		await expectView(app, 'brains');
		await expect(app.getByRole('menu')).toHaveCount(0);
		// Every brain at once, which is what the popover could not do: its list ran to
		// ~300px against ~130px of room, so it showed one and a half of them.
		const list = app.locator('main[data-view="brains"]');
		for (const name of ['Personal', 'Acme wiki', 'Acme handbook', 'Northwind'])
			await expect(list.getByText(name, { exact: true }).first()).toBeVisible();
	});

	test('sends a folder crumb WITH a note to the tree', async ({ page }) => {
		// wiki/ has a folder note. This crumb used to open that note while its neighbour
		// opened the tree, decided by a fact the trail never showed you.
		const app = await openApp(page, '');
		await app.getByRole('button', { name: 'wiki', exact: true }).click();
		await expectView(app, 'browse');
	});

	test('sends a folder crumb WITHOUT one to the same place', async ({ page }) => {
		const app = await openApp(page, '');
		await app.getByRole('button', { name: 'concepts', exact: true }).click();
		await expectView(app, 'browse');
		// Revealed AT the folder rather than dumped at the root.
		await expect(app.locator('[data-tree-focus]')).toBeVisible();
	});

	test('reads as a terminus on the file tree, where the brain IS the place', async ({ page }) => {
		// The tree's trail is the brain crumb alone: no tail, because the tree's place is
		// the brain's root and the crumb already names it. So it has to LOOK like where
		// you are. It rendered muted once, which by this bar's colour rule (fg is where
		// you are, muted is everything else) said you were nowhere.
		const app = await openApp(page, 'browse');
		const colours = await bar(app).evaluate((el) => {
			const label = [...el.querySelectorAll('span')].find(
				(s) => s.textContent?.trim() === 'Personal'
			);
			if (!label) return null;
			// Resolve the TOKENS through real elements, so both sides are the same
			// computed rgb() form and a palette change cannot turn this red for the
			// wrong reason.
			const probe = (token: string) => {
				const n = document.createElement('span');
				n.style.color = `var(${token})`;
				el.appendChild(n);
				const c = getComputedStyle(n).color;
				n.remove();
				return c;
			};
			return {
				label: getComputedStyle(label).color,
				fg: probe('--c-fg'),
				muted: probe('--c-muted')
			};
		});
		expect(colours).not.toBeNull();
		expect(colours!.label).toBe(colours!.fg);
		expect(colours!.label).not.toBe(colours!.muted);
	});
});

test.describe('the second row', () => {
	test('is absent on a view that is not the editor', async ({ page }) => {
		// A row that is always there cannot tell you anything by being there. It was a
		// permanent strip holding two icons once, and read as leftover space.
		const app = await openApp(page, '');
		await expectView(app, 'page');
		await expect(actionRow(app)).toBeHidden();
	});

	test('carries the formatting toolbar in the editor, and no destination', async ({ page }) => {
		const app = await openApp(page, 'edit=wiki/concepts/vision.md');
		await expectView(app, 'edit');
		await expect(actionRow(app).getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
		for (const name of ['Files', 'Graph', 'Recent changes', 'Sharing', 'Search'])
			await expect(actionRow(app).getByRole('button', { name, exact: true })).toHaveCount(0);
	});
});

test.describe('the display control', () => {
	test('sits in the bar, apart from the view’s own actions, and switches', async ({ page }) => {
		const app = await openApp(page, '');
		const trigger = bar(app).getByRole('button', { name: 'Display: Inline' });
		await expect(trigger).toBeVisible();
		await trigger.click();
		await app.getByRole('menuitem', { name: /Fullscreen/ }).click();
		await settle(page);
		await expect(bar(app).getByRole('button', { name: 'Display: Fullscreen' })).toBeVisible();
	});
});
