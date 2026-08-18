// The editor: opening, editing, saving, and the one invariant that protects
// generated content from ProseMirror.
//
// The markdown round trip itself is pinned by `pnpm test:roundtrip`, and the patch
// engine by `pnpm test:patch`. Neither of those can see the editor. What is only
// visible here is whether the app WIRES the editor up: whether typing reaches the
// document, whether Save sends what you typed, and whether Cancel really discards.
import { test, expect } from '@playwright/test';
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

test('a legacy published status can migrate to an OKF lifecycle value', async ({ page }) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');

	await app.getByText('published', { exact: true }).click();
	const status = app.getByRole('combobox');
	await expect(status.locator('option')).toHaveText(['published', 'draft', 'stable', 'deprecated']);
	await status.selectOption('stable');

	await expect(app.getByText('stable', { exact: true })).toBeVisible();
});
