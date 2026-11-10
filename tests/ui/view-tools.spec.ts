// The view's app tools, driven from the host side of the real bridge.
//
// What only a browser can answer: that the view declares the `tools` capability in
// its handshake (without it a host lists nothing), that the host's tools/list reaches
// the view's handler, and that a call actually moves what the user sees. The contract
// itself (definitions, argument checks, the unsaved-edits guard, the result text) is
// pure and pinned by `pnpm test:app-resource`.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const listTools = (page: Page) =>
	page.evaluate(async () => {
		const w = window as unknown as {
			__viewTools: { list: () => Promise<{ tools: { name: string }[] }> };
		};
		return (await w.__viewTools.list()).tools.map((t) => t.name);
	});

const callTool = (page: Page, name: string, args: Record<string, unknown> = {}) =>
	page.evaluate(
		async ([n, a]) => {
			const w = window as unknown as {
				__viewTools: { call: (n: string, a: Record<string, unknown>) => Promise<unknown> };
			};
			return (await w.__viewTools.call(n as string, a as Record<string, unknown>)) as ToolResult;
		},
		[name, args] as const
	);

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

test('the host can list the view tools', async ({ page }) => {
	await openApp(page, '');
	expect(await listTools(page)).toEqual([
		'get_open_view',
		'show_page',
		'show_search',
		'reload_view'
	]);
});

test('get_open_view reports the page on screen', async ({ page }) => {
	const app = await openApp(page, '');
	await expectView(app, 'page');
	const r = await callTool(page, 'get_open_view');
	expect(r.isError).toBeFalsy();
	expect(textOf(r)).toContain('Path: wiki/concepts/vision.md');
});

test('show_page moves the view to the page it names', async ({ page }) => {
	const app = await openApp(page, 'browse');
	await expectView(app, 'browse');
	const r = await callTool(page, 'show_page', { path: '/wiki/open-questions.md' });
	expect(r.isError).toBeFalsy();
	await expectView(app, 'page');
	expect(textOf(r)).toContain('Path: wiki/open-questions.md');
});

test('show_page on a missing page is an error result', async ({ page }) => {
	await openApp(page, '');
	const r = await callTool(page, 'show_page', { path: 'wiki/no-such-page.md' });
	expect(r.isError).toBe(true);
});

test('show_search puts results on screen', async ({ page }) => {
	const app = await openApp(page, '');
	const r = await callTool(page, 'show_search', { query: 'vision' });
	expect(r.isError).toBeFalsy();
	await expectView(app, 'search');
	expect(textOf(r)).toContain('Search: vision');
});

test('reload_view picks up an edit made behind the view', async ({ page }) => {
	const app = await openApp(page, 'stale');
	await expectView(app, 'page');
	const added = 'Added by somebody else while you were reading.';
	await expect(app.getByText(added)).toHaveCount(0);
	const r = await callTool(page, 'reload_view');
	expect(r.isError).toBeFalsy();
	await expect(app.getByText(added)).toBeVisible();
	expect(textOf(r)).toContain('The page changed');
});

test('a call never navigates away from unsaved edits', async ({ page }) => {
	const app = await openApp(page, 'edit=wiki/open-questions.md');
	await expectView(app, 'edit');
	const editor = app.locator('main[data-view="edit"] [contenteditable="true"]');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\nUnsaved text.');

	const r = await callTool(page, 'show_page', { path: 'wiki/index.md' });
	expect(r.isError).toBe(true);
	expect(textOf(r)).toContain('unsaved edits');
	await expectView(app, 'edit');
});
