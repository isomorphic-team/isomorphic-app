// The editor: opening, editing, saving, and the one invariant that protects
// generated content from ProseMirror.
//
// The markdown round trip itself is pinned by `pnpm test:roundtrip`, and the patch
// engine by `pnpm test:page-write`. Neither of those can see the editor. What is only
// visible here is whether the app WIRES the editor up: whether typing reaches the
// document, whether Save sends what you typed, and whether Cancel really discards.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

type App = Awaited<ReturnType<typeof openApp>>;

// The ProseMirror surface inside the edit view.
const editorOf = (app: App) => app.locator('main[data-view="edit"] [contenteditable="true"]');

// Save/Cancel are rendered in BOTH the header action bar and the view body, so an
// unscoped getByRole is a strict-mode violation. The header copy is the one the
// editor's chrome owns (see the Header note in app/main.tsx), so drive that.
const action = (app: App, name: 'Save' | 'Cancel') =>
	app.getByRole('banner').getByRole('button', { name, exact: true });

test('typing reaches the document and Save persists it', async ({ page }) => {
	const app = await openApp(page, 'edit=wiki/open-questions.md');
	await expectView(app, 'edit');

	const editor = editorOf(app);
	await expect(editor).toBeVisible();
	await editor.click();
	// End of the document, so the insertion cannot land inside existing structure and
	// make this a test of ProseMirror's schema rather than of the save path.
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\nA line typed by the UI test.');

	await action(app, 'Save').click();

	// Saving swaps to the page view, and only once the fresh content is in hand. The
	// text being THERE is what proves the editor's markdown reached write_page rather
	// than the view merely navigating.
	await expectView(app, 'page');
	await expect(
		app.locator('main[data-view="page"]').getByText('A line typed by the UI test.')
	).toBeVisible({ timeout: 10_000 });
});

test('Cancel discards the edit', async ({ page }) => {
	const app = await openApp(page, 'edit=wiki/open-questions.md');
	const editor = editorOf(app);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\nThis text must never be saved.');

	await action(app, 'Cancel').click();
	await expectView(app, 'page');
	await expect(
		app.locator('main[data-view="page"]').getByText('This text must never be saved.')
	).toHaveCount(0);
});

test('the editor never shows a generated snapshot region', async ({ page }) => {
	// `wiki/orgs/acme-health.md` carries live okf-view directives. The server sends the
	// editor `stripSnapshots(...)`, so the author sees the FENCE but not the generated
	// rendering between the snapshot markers. This matters beyond tidiness: snapshot
	// text that round-tripped ProseMirror would be re-serialized as ordinary prose and
	// then written back as authored content, and the next save would regenerate on top
	// of it. The harness mirrors the same call, so the invariant is testable here.
	const app = await openApp(page, 'edit=wiki/orgs/acme-health.md');
	await expectView(app, 'edit');
	const editor = editorOf(app);
	await expect(editor).toBeVisible();
	await expect(editor).not.toContainText('okf-view:snapshot');
});

test('the same page renders its view live outside the editor', async ({ page }) => {
	// The other half of the contract: what the editor strips, the page view computes.
	// A page whose okf-view came back as a raw fence in BOTH places would pass the
	// test above for the wrong reason.
	const app = await openApp(page, '');
	await expectView(app, 'page');
	const main = app.locator('main[data-view="page"]');
	await expect(main).not.toContainText('okf-view:snapshot');
});

// Property edits are a draft inside the editor: nothing is written until Save, and
// Save carries them in the SAME write_page call as the body, so the two land in one
// commit against the sha the editor opened.
type ToolCall = { name: string; args: Record<string, unknown> };
const writesOf = (page: Page) =>
	page.evaluate(() =>
		((window as unknown as { __toolArgs?: ToolCall[] }).__toolArgs ?? []).filter(
			(c) => c.name === 'write_page'
		)
	);

test('the viewer shows properties read-only', async ({ page }) => {
	const app = await openApp(page, 'page=wiki/concepts/vision.md');
	await expectView(app, 'page');
	const panel = app.locator('main[data-view="page"] dl').first();
	await expect(panel.getByText('high', { exact: true })).toBeVisible();
	await expect(panel.getByRole('button')).toHaveCount(0);
	await expect(app.getByText('+ Add property')).toHaveCount(0);
});

test('property edits and the body save together in one write', async ({ page }) => {
	const app = await openApp(page, 'edit=wiki/concepts/vision.md');
	await expectView(app, 'edit');

	// The legacy `published` status is offered so the select can show it, and any
	// change lands on an OKF lifecycle value.
	await app.getByRole('button', { name: 'published', exact: true }).click();
	const status = app.getByRole('combobox');
	await expect(status.locator('option')).toHaveText(['published', 'draft', 'stable', 'deprecated']);
	await status.selectOption('stable');

	await app.getByRole('button', { name: 'high', exact: true }).click();
	await app.locator('main[data-view="edit"] dl input').fill('medium');
	await page.keyboard.press('Enter');

	await app.getByText('+ Add property').click();
	await app.getByPlaceholder('name').fill('owner');
	await app.getByPlaceholder('value').fill('Northwind');
	await page.keyboard.press('Enter');

	// Nothing is written while editing.
	expect(await writesOf(page)).toHaveLength(0);

	const editor = editorOf(app);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\nSaved with its properties.');
	await action(app, 'Save').click();
	await expectView(app, 'page');

	const writes = await writesOf(page);
	expect(writes).toHaveLength(1);
	expect(writes[0].args).toMatchObject({
		path: 'wiki/concepts/vision.md',
		sha: 'preview-sha',
		status: 'stable',
		fields: { confidence: 'medium', owner: 'Northwind' }
	});
	expect(String(writes[0].args.content)).toContain('Saved with its properties.');

	const panel = app.locator('main[data-view="page"] dl').first();
	await expect(panel.getByText('stable', { exact: true })).toBeVisible({ timeout: 10_000 });
	await expect(panel.getByText('medium', { exact: true })).toBeVisible();
	await expect(panel.getByText('Northwind', { exact: true })).toBeVisible();
});

test('removing a property is a null in the same write', async ({ page }) => {
	const app = await openApp(page, 'edit=wiki/concepts/vision.md');
	await expectView(app, 'edit');
	await app.getByRole('button', { name: 'Remove Confidence' }).click();
	await expect(app.getByText('high', { exact: true })).toHaveCount(0);

	await action(app, 'Save').click();
	await expectView(app, 'page');
	const writes = await writesOf(page);
	expect(writes).toHaveLength(1);
	expect(writes[0].args).toMatchObject({ fields: { confidence: null } });
	await expect(app.locator('main[data-view="page"]').getByText('Confidence')).toHaveCount(0);
});

test('Cancel discards property edits', async ({ page }) => {
	const app = await openApp(page, 'edit=wiki/concepts/vision.md');
	await expectView(app, 'edit');
	await app.getByRole('button', { name: 'high', exact: true }).click();
	await app.locator('main[data-view="edit"] dl input').fill('low');
	await page.keyboard.press('Enter');
	await expect(app.getByRole('button', { name: 'low', exact: true })).toBeVisible();

	await action(app, 'Cancel').click();
	await expectView(app, 'page');
	expect(await writesOf(page)).toHaveLength(0);
	const panel = app.locator('main[data-view="page"] dl').first();
	await expect(panel.getByText('high', { exact: true })).toBeVisible();
});
