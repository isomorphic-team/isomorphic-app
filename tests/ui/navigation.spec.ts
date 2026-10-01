// Navigation: the file tree, folder notes, and the brain switcher.
//
// These are pure app logic with no golden test behind them. The folder-note
// convention in particular has no in-band signal (a folder IS its index.md, by naming
// alone), so the only thing that can catch "clicking a folder stopped opening its
// note" is a test that clicks a folder.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

test('clicking a folder with a folder note opens the note, it does not just expand', async ({
	page
}) => {
	const app = await openApp(page, 'browse');
	// `wiki/` has an index.md in the fixtures, so it IS a page. Clicking it must
	// navigate, not merely disclose children. FOLDER_NOTE_NAMES in
	// src/lib/view-directives.ts is the single source of truth for that rule; the app
	// tree re-exports it, and this asserts the tree actually honours it.
	await app.getByRole('button', { name: 'wiki', exact: true }).click();
	await expectView(app, 'page');
});

test('a note-less folder expands instead of navigating', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	// `concepts` has no index.md in the fixtures (see dev/README.md), so it discloses
	// its children and the view stays on the tree.
	const concepts = app.getByRole('button', { name: 'concepts', exact: true });
	await expect(concepts).toBeVisible();
	await concepts.click();
	await expectView(app, 'browse');
});

test('the tree SAYS which folders are also pages', async ({ page }) => {
	// The two folders above behave differently on a click, and until this icon the tree
	// drew them identically — the distinction lived entirely in what happened after you
	// pressed. FolderNoteIcon is FolderIcon's silhouette with two lines of text knocked
	// out of it, and the knockout (fill-rule evenodd) is what identifies it here.
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	const iconFor = (name: string) =>
		app
			.getByRole('button', { name, exact: true })
			.locator('xpath=preceding-sibling::span[1]')
			// The chevron is the other svg in that span; the file/folder glyph is the 15px one.
			.locator('svg[width="15"] path');
	// `wiki/` has an index.md, `concepts/` does not.
	await expect(iconFor('wiki')).toHaveAttribute('fill-rule', 'evenodd');
	await expect(iconFor('concepts')).not.toHaveAttribute('fill-rule', 'evenodd');
});

test('expand all reveals nested pages', async ({ page }) => {
	const app = await openApp(page, 'browse');
	const main = app.locator('main[data-view="browse"]');
	const before = await main.getByRole('button').count();
	await app.getByRole('button', { name: 'Expand all' }).click();
	await expect
		.poll(() => main.getByRole('button').count(), { timeout: 10_000 })
		.toBeGreaterThan(before);
});

test('show hidden reveals system files the normal tree omits', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	// `.isomorphic.json` is seeded into the fixtures precisely so this toggle has a
	// real system file to reveal. It must NOT be in the tree by default: the
	// visible/hidden split mirrors the server's list_pages, which serves content
	// pages and nothing else.
	await expect(app.getByText('.isomorphic.json')).toHaveCount(0);
	await app.getByRole('button', { name: 'Show hidden files' }).click();
	await expect(app.getByText('.isomorphic.json').first()).toBeVisible();
});

test('switching brains swaps the content, not just the label', async ({ page }) => {
	const app = await openApp(page, 'brains');
	// Each fixture brain has its OWN pages, so a switch that only repainted the crumb
	// would leave the previous brain's tree on screen. Northwind's tree is the proof:
	// `facilities` exists in no other fixture brain.
	await app.getByRole('button', { name: 'Northwind', exact: true }).click();
	await expectView(app, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await expect(app.getByRole('button', { name: 'facilities', exact: true })).toBeVisible();
});

test('a brain opened BY NAME is not retargeted by the brain list', async ({ page }) => {
	// Issue #26. The result opens Northwind; the connection's active-brain pointer still
	// says Personal, and the app re-reads that pointer through `brains` on every open.
	// It used to win, so the panel showed the previous brain's tree under a crumb naming
	// it, while the model reported the brain it had actually opened.
	const app = await openApp(page, 'other-brain');
	await expectView(app, 'browse');
	// The root crumb NAMES the brain (inert on the tree's own view, so it is text
	// rather than a link).
	await expect(app.locator('header').getByText('Northwind', { exact: true })).toBeVisible();
	await app.getByRole('button', { name: 'Expand all' }).click();
	// Northwind's own tree, not Personal's: `facilities` exists in no other fixture brain.
	await expect(app.getByRole('button', { name: 'facilities', exact: true })).toBeVisible();
});

test('the graph view renders the force-directed canvas', async ({ page }) => {
	const app = await openApp(page, 'graph');
	await expectView(app, 'graph');
	// A canvas, not SVG: the graph is drawn by hand rather than through a graph
	// library, to keep the bundle inside the Worker script limit. So the assertion is
	// that the canvas exists and was given a real size — a zero-sized canvas is how
	// this view fails while still "rendering".
	const canvas = app.locator('main[data-view="graph"] canvas');
	await expect(canvas).toBeVisible();
	const box = await canvas.boundingBox();
	expect(box?.width ?? 0).toBeGreaterThan(0);
	expect(box?.height ?? 0).toBeGreaterThan(0);
});

// The header's back button, in the MCP App, where the widget's own stack is the only
// history there is. Present on EVERY screen (it used to exist only on the org and
// account screens), and disabled rather than hidden when there is nowhere to go, so
// the trail does not shift sideways the moment you take a first step.
test('the back button returns to the screen you came from, and waits until there is one', async ({
	page
}) => {
	const app = await openApp(page, 'browse');
	const back = app.getByRole('button', { name: 'Back', exact: true });
	await expect(back).toBeVisible();
	await expect(back).toBeDisabled();

	await app.getByRole('button', { name: 'wiki', exact: true }).click();
	await expectView(app, 'page');
	await expect(back).toBeEnabled();

	await back.click();
	await expectView(app, 'browse');
	await expect(back).toBeDisabled();
});

// "Skip the editor": saving REPLACES the editor with the page, which used to leave the
// page as it stood before the edit on top of the stack, so Back from a page you had
// just saved showed you that same page again, stale. Back goes where you were before
// the page (`recordStep` in app/core/store.ts; `pnpm test:policy` pins the rule).
test('Back after saving an edit skips the editor and the pre-edit page', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'wiki', exact: true }).click();
	await expectView(app, 'page');

	await app.getByRole('banner').getByRole('button', { name: 'Edit', exact: true }).click();
	await expectView(app, 'edit');
	await app.getByRole('banner').getByRole('button', { name: 'Save', exact: true }).click();
	await expectView(app, 'page');

	await app.getByRole('button', { name: 'Back', exact: true }).click();
	await expectView(app, 'browse');
});
