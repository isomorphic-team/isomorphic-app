// A browser user can organize the brain without dragging or using an MCP client.
// The move mode calls the same move_page tool as drag-and-drop. The real move tool's
// link and folder behavior is covered by the librarian end-to-end battery.
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { openApp } from './harness.ts';

async function moveMenu(app: FrameLocator, name: string) {
	const row = app.getByRole('button', { name, exact: true }).locator('..');
	await row.hover();
	await row.getByRole('button', { name: 'More' }).click();
	await row.getByRole('button', { name: 'Move to…' }).click();
}

async function expectMove(page: Page, path: string, new_path: string) {
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(
						window as unknown as { __toolArgs?: { name: string; args: unknown }[] }
					).__toolArgs?.find((request) => request.name === 'move_page')?.args
			)
		)
		.toMatchObject({ path, new_path, brain: 'personal-wiki-0a1b2c' });
}

test('a note moves by choosing a folder in the visible tree', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'Vision');
	await expect(app.getByRole('status')).toContainText('Moving vision.md: choose a folder');
	await expect(app.locator('[data-moving-source]')).toContainText('Vision');
	await expect(app.getByRole('button', { name: 'Vision', exact: true })).toBeVisible();
	await expect(
		app.getByRole('button', { name: 'Move to wiki/concepts', exact: true })
	).toBeDisabled();
	await app.getByRole('button', { name: 'Move to wiki/playbooks', exact: true }).click();
	await expectMove(page, 'wiki/concepts/vision.md', 'wiki/playbooks/vision.md');
	await expect(
		app.getByText('Moved wiki/concepts/vision.md → wiki/playbooks/vision.md.')
	).toBeVisible();
	await expect(app.getByRole('status')).toHaveCount(0);
});

// Move is a header mode, the way editing is: the instruction is the header's second row
// and Cancel replaces the tree's own actions, which return when the mode ends.
test('move mode takes over the header the way the editor does', async ({ page }) => {
	const app = await openApp(page, 'browse');
	const header = app.locator('header');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'Vision');
	await expect(header.locator('[data-row="mode"]').getByRole('status')).toContainText(
		'Moving vision.md: choose a folder'
	);
	await expect(header.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await expect(header.getByRole('button', { name: 'New note' })).toHaveCount(0);
	await header.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(header.locator('[data-row="mode"]')).toBeHidden();
	await expect(header.getByRole('button', { name: 'New note' })).toBeVisible();
});

test('invalid folders stay visible but cannot be chosen, and Cancel writes nothing', async ({
	page
}) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'concepts');
	for (const folder of ['wiki', 'wiki/concepts', 'wiki/concepts/assets']) {
		await expect(
			app.getByRole('button', { name: `Move to ${folder}`, exact: true })
		).toBeDisabled();
	}
	await expect(app.getByRole('button', { name: 'Move to wiki/people', exact: true })).toBeEnabled();
	await app.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(app.getByRole('button', { name: 'concepts', exact: true })).toBeVisible();
	const calls = await page.evaluate(
		() => (window as unknown as { __toolCalls?: string[] }).__toolCalls ?? []
	);
	expect(calls).not.toContain('move_page');
});

test('a folder move uses its full path and an eligible destination', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'concepts');
	await app.getByRole('button', { name: 'Move to wiki/people', exact: true }).click();
	await expectMove(page, 'wiki/concepts', 'wiki/people/concepts');
});

test('an attachment moves through the same tree controls', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'vision-sketch.png');
	await app.getByRole('button', { name: 'Move to wiki/people', exact: true }).click();
	await expectMove(page, 'wiki/concepts/assets/vision-sketch.png', 'wiki/people/vision-sketch.png');
});

test('Escape cancels move mode and returns keyboard focus to the source menu', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	const row = app.getByRole('button', { name: 'Vision', exact: true }).locator('..');
	const menu = row.getByRole('button', { name: 'More' });
	await menu.focus();
	await expect(menu).toHaveCSS('opacity', '1');
	await menu.press('Enter');
	await row.getByRole('button', { name: 'Move to…' }).press('Enter');
	const cancel = app.getByRole('button', { name: 'Cancel', exact: true });
	await expect(cancel).toBeFocused();
	await cancel.press('Escape');
	await expect(menu).toBeFocused();
});

test('Tab and Enter choose a destination without navigating away', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'Vision');
	await expect(app.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await app.getByRole('button', { name: 'Collapse wiki', exact: true }).focus();
	await app.getByRole('button', { name: 'Collapse wiki', exact: true }).press('Tab');
	const destination = app.getByRole('button', { name: 'Move to wiki', exact: true });
	await expect(destination).toBeFocused();
	await destination.press('Enter');
	await expectMove(page, 'wiki/concepts/vision.md', 'wiki/vision.md');
});

test('a folder can be expanded with the keyboard during move mode', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand wiki', exact: true }).click();
	await moveMenu(app, 'people');
	await app.getByRole('button', { name: 'Expand concepts', exact: true }).press('Enter');
	await expect(
		app.getByRole('button', { name: 'Move to wiki/concepts/assets', exact: true })
	).toBeVisible();
	await app
		.getByRole('button', { name: 'Move to wiki/concepts/assets', exact: true })
		.press('Escape');
	await expect(app.getByRole('status')).toHaveCount(0);
});

test('no valid destination still offers a focused Cancel button', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await moveMenu(app, 'wiki');
	await expect(app.getByText('There are no other editable folders.')).toBeVisible();
	await expect(app.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await expect(
		app.getByRole('button', { name: /^Move to / }).filter({ hasText: 'Move here' })
	).toHaveCount(0);
});
