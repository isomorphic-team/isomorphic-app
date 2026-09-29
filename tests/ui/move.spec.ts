// A browser user can organize the brain without dragging or using an MCP client.
// The picker calls the same move_page tool as drag-and-drop. The real move tool's
// link and folder behavior is covered by the librarian end-to-end battery.
import { test, expect, type FrameLocator } from '@playwright/test';
import { openApp } from './harness.ts';

async function moveMenu(app: FrameLocator, name: string) {
	const row = app.getByRole('button', { name, exact: true }).locator('..');
	await row.hover();
	await row.getByRole('button', { name: 'More' }).click();
	await row.getByRole('button', { name: 'Move to…' }).click();
}

test('a note moves into a chosen folder through the file tree', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'Vision');

	const destination = app.getByRole('combobox', { name: 'Destination folder' });
	await expect(destination).toBeVisible();
	await destination.selectOption('wiki/playbooks');
	await expect(app.getByText('New location: wiki/playbooks/vision.md')).toBeVisible();
	await app.getByRole('button', { name: 'Move', exact: true }).click();
	const requests = await page.evaluate(
		() =>
			(window as unknown as { __toolRequests?: { name: string; args: unknown }[] })
				.__toolRequests ?? []
	);
	expect(requests.find((request) => request.name === 'move_page')?.args).toMatchObject({
		path: 'wiki/concepts/vision.md',
		new_path: 'wiki/playbooks/vision.md'
	});

	await expect(app.getByText('Moved ✓')).toBeVisible();
});

test('the folder picker excludes itself and its descendants and cancel does not move', async ({
	page
}) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'concepts');

	const destination = app.getByRole('combobox', { name: 'Destination folder' });
	await expect(destination.locator('option[value="wiki/concepts"]')).toHaveCount(0);
	await expect(destination.locator('option[value="wiki/concepts/assets"]')).toHaveCount(0);
	await expect(destination.locator('option[value="wiki/people"]')).toHaveCount(1);
	await app.getByRole('button', { name: 'Cancel' }).click();
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

	await app.getByRole('combobox', { name: 'Destination folder' }).selectOption('wiki/people');
	await expect(app.getByText('New location: wiki/people/concepts')).toBeVisible();
	await app.getByRole('button', { name: 'Move', exact: true }).click();
	const requests = await page.evaluate(
		() =>
			(window as unknown as { __toolRequests?: { name: string; args: unknown }[] })
				.__toolRequests ?? []
	);
	expect(requests.find((request) => request.name === 'move_page')?.args).toMatchObject({
		path: 'wiki/concepts',
		new_path: 'wiki/people/concepts'
	});
});

test('an attachment has the same move action as other draggable files', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	await moveMenu(app, 'vision-sketch.png');
	await app.getByRole('combobox', { name: 'Destination folder' }).selectOption('wiki/people');
	await expect(app.getByText('New location: wiki/people/vision-sketch.png')).toBeVisible();
	await app.getByRole('button', { name: 'Cancel' }).click();
});

test('keyboard focus reveals the file menu that opens the picker', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	const row = app.getByRole('button', { name: 'Vision', exact: true }).locator('..');
	const menu = row.getByRole('button', { name: 'More' });
	await menu.focus();
	await expect(menu).toHaveCSS('opacity', '1');
	await menu.press('Enter');
	await row.getByRole('button', { name: 'Move to…' }).press('Enter');
	await expect(app.getByRole('combobox', { name: 'Destination folder' })).toBeFocused();
	await app.getByRole('button', { name: 'Cancel' }).press('Enter');
	await expect(menu).toBeFocused();
});
