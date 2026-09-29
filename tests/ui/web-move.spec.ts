// Exercise the picker's failure and proposal responses over the web transport.
// Only move_page is intercepted; tree reads use the real local runtime.
import { test, expect, type Page } from '@playwright/test';
import { WEB_TEST_BRAIN } from '../../playwright.config.ts';

async function openMove(page: Page) {
	await page.goto(`/b/${WEB_TEST_BRAIN}`);
	await page.getByRole('button', { name: 'Expand all' }).click();
	const row = page.getByRole('button', { name: 'Vision', exact: true }).locator('..');
	await row.hover();
	await row.getByRole('button', { name: 'More', exact: true }).click();
	await row.getByRole('button', { name: 'Move to…' }).click();
	await page.getByRole('combobox', { name: 'Destination folder' }).selectOption('wiki/playbooks');
}

test('a transport failure releases the picker so the user can retry or cancel', async ({
	page
}) => {
	await page.route('**/mcp', async (route) => {
		if (route.request().postDataJSON().params?.name !== 'move_page') return route.continue();
		await route.fulfill({ status: 503, body: 'Unavailable' });
	});
	await openMove(page);
	await page.getByRole('button', { name: 'Move', exact: true }).click();
	await expect(page.getByText(/Move failed:.*503/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Vision', exact: true })).toBeVisible();
});

test('a tool refusal preserves the selection and allows another attempt', async ({ page }) => {
	const message = 'A page already exists at this destination.';
	await page.route('**/mcp', async (route) => {
		const request = route.request().postDataJSON();
		if (request.params?.name !== 'move_page') return route.continue();
		await route.fulfill({
			json: {
				jsonrpc: '2.0',
				id: request.id,
				result: { isError: true, content: [{ type: 'text', text: message }] }
			}
		});
	});
	await openMove(page);
	await page.getByRole('button', { name: 'Move', exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Destination folder' })).toHaveValue(
		'wiki/playbooks'
	);
	await expect(page.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
});

test('a proposed move shows the server response instead of claiming it landed', async ({
	page
}) => {
	const message = 'Proposed moving Vision. Review and merge it here: https://example.com/pull/1';
	await page.route('**/mcp', async (route) => {
		const request = route.request().postDataJSON();
		if (request.params?.name !== 'move_page') return route.continue();
		expect(request.params.arguments).toMatchObject({
			path: 'wiki/concepts/vision.md',
			new_path: 'wiki/playbooks/vision.md',
			brain: WEB_TEST_BRAIN
		});
		await route.fulfill({
			json: {
				jsonrpc: '2.0',
				id: request.id,
				result: { content: [{ type: 'text', text: message }] }
			}
		});
	});
	await openMove(page);
	await page.getByRole('button', { name: 'Move', exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(page.getByText('Moved ✓', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Vision', exact: true })).toBeVisible();
});
