// Exercise the move mode's failure and proposal responses over the web transport.
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
}

test('a transport failure releases the move mode so the user can retry or cancel', async ({
	page
}) => {
	await page.route('**/mcp', async (route) => {
		if (route.request().postDataJSON().params?.name !== 'move_page') return route.continue();
		await route.fulfill({ status: 503, body: 'Unavailable' });
	});
	await openMove(page);
	await page.getByRole('button', { name: 'Move to wiki/playbooks', exact: true }).click();
	await expect(page.getByText(/Move failed:.*503/)).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Move to wiki/playbooks', exact: true })
	).toBeEnabled();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Vision', exact: true })).toBeVisible();
});

test('a tool refusal keeps move mode available for another attempt', async ({ page }) => {
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
	await page.getByRole('button', { name: 'Move to wiki/playbooks', exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toContainText('Moving vision.md: choose a folder');
	await expect(
		page.getByRole('button', { name: 'Move to wiki/playbooks', exact: true })
	).toBeEnabled();
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
	await page.getByRole('button', { name: 'Move to wiki/playbooks', exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(page.getByText('Moved ✓', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Vision', exact: true })).toBeVisible();
});

// A whole-repository content policy has no folder row for its root. It must still
// be selectable, and a root-level destination must not gain a leading slash.
test('a whole-repository brain offers its root as a move destination', async ({ page }) => {
	await page.route('**/mcp', async (route) => {
		const request = route.request().postDataJSON();
		if (request.params?.name === 'move_page') {
			expect(request.params.arguments).toMatchObject({
				path: 'wiki/concepts/vision.md',
				new_path: 'vision.md',
				brain: WEB_TEST_BRAIN
			});
			return route.fulfill({
				json: {
					jsonrpc: '2.0',
					id: request.id,
					result: { content: [{ type: 'text', text: 'Root move proposed.' }] }
				}
			});
		}
		if (!['browse_brain', 'list_pages'].includes(request.params?.name)) return route.continue();
		const response = await route.fetch();
		const body = await response.json();
		if (body.result?.structuredContent?.config) {
			body.result.structuredContent.config = { paths: { '.': 'content' } };
		}
		await route.fulfill({ response, json: body });
	});
	await openMove(page);
	await page.getByRole('button', { name: 'Move to brain root', exact: true }).click();
	await expect(page.getByText('Root move proposed.', { exact: true })).toBeVisible();
	// The successful proposal refreshes the tree; let those intercepted reads finish.
	await page.unrouteAll({ behavior: 'wait' });
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`a longer filename keeps the move instruction visible in a narrow ${colorScheme} window`, async ({
		page
	}) => {
		await page.setViewportSize({ width: 360, height: 740 });
		await page.emulateMedia({ colorScheme });
		await page.goto(`/b/${WEB_TEST_BRAIN}`);
		await page.getByRole('button', { name: 'Expand all' }).click();
		const row = page
			.getByRole('button', { name: '0001 — MCP write tools', exact: true })
			.locator('..');
		await row.hover();
		await row.getByRole('button', { name: 'More', exact: true }).click();
		await row.getByRole('button', { name: 'Move to…' }).click();
		const status = page.getByRole('status');
		await expect(status).toContainText('choose a folder');
		// Visibility alone misses text clipped by ellipsis. Measure the instruction's
		// actual glyph rectangles against the label area beside Cancel.
		const instructionFits = await status.evaluate((bar) => {
			const label = [...bar.querySelectorAll('span')].find((span) =>
				span.textContent?.includes('choose a folder')
			)!;
			const bounds = label.getBoundingClientRect();
			const instruction = [...label.childNodes].find(
				(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('choose a folder')
			)!;
			const range = document.createRange();
			range.selectNodeContents(instruction);
			return [...range.getClientRects()].every(
				(rect) =>
					rect.left >= bounds.left - 1 &&
					rect.right <= bounds.right + 1 &&
					rect.bottom <= bounds.bottom + 1
			);
		});
		expect(instructionFits).toBe(true);
		await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		expect(overflow).toBe(false);
	});
}
