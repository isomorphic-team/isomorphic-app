// The org Analytics tab, and the determinism the whole suite rests on.
//
// This is the view most exposed to clock drift: every number is derived from a
// rolling window and every "last active" is rendered relative to now. If the two
// frozen clocks in tests/ui/harness.ts ever stop working, this file fails first and
// says so plainly, instead of the visual baselines rotting silently overnight.
import { test, expect } from '@playwright/test';
import { openApp, expectView, FROZEN_NOW } from './harness.ts';

test('the window is anchored to the frozen clock', async ({ page }) => {
	const app = await openApp(page, 'analytics');
	await expectView(app, 'analytics');
	const main = app.locator('main[data-view="analytics"]');

	// 30 days ending on the frozen date. Asserting the literal endpoints is the point:
	// if either clock comes unfrozen, these move and this test names the reason.
	await expect(main.getByText(FROZEN_NOW.slice(0, 10))).toBeVisible();
	await expect(main.getByText('2026-07-07')).toBeVisible();
});

test('relative times are stable, not drifting with the wall clock', async ({ page }) => {
	const app = await openApp(page, 'analytics');
	const main = app.locator('main[data-view="analytics"]');
	// Fixture rows land at day granularity (midnight UTC) and the frozen instant is
	// noon, so the most recent activity is always exactly 12h old. Read through an
	// unfrozen app clock this said "5d ago" and would say "6d ago" tomorrow — the
	// failure that motivated freezing the app's clock as well as the harness's.
	await expect(main.getByText('Last active 12h ago').first()).toBeVisible();
});

test('the per-person table is present for an admin', async ({ page }) => {
	const app = await openApp(page, 'analytics');
	const main = app.locator('main[data-view="analytics"]');
	// ME is the org owner in the fixtures, so the admin-gated people table is in the
	// payload. Authorization itself (that a non-admin gets the rows WITHHELD from the
	// payload rather than hidden by the widget) is asserted in `pnpm test:scope`,
	// against the payload, which is the only place it can be checked honestly.
	await expect(main.getByText('By person')).toBeVisible();
	await expect(main.getByText('Ada Lovelace')).toBeVisible();
	// A member at zero is the actionable row the tab exists to surface, and the fold
	// has to keep them rather than drop them for having no rows.
	await expect(main.getByText('Never active')).toBeVisible();
	// Someone who has since left the org still counts toward totals.
	await expect(main.getByText('Removed member')).toBeVisible();
});

test('the window buttons re-query', async ({ page }) => {
	const app = await openApp(page, 'analytics');
	const main = app.locator('main[data-view="analytics"]');
	await expect(main.getByText('2026-07-07')).toBeVisible();
	await app.getByRole('button', { name: '7d' }).click();
	// A 7-day window ending on the frozen date starts on 2026-07-30.
	await expect(main.getByText('2026-07-30')).toBeVisible({ timeout: 10_000 });
});

test('the footnote about what is not counted travels with the view', async ({ page }) => {
	const app = await openApp(page, 'analytics');
	// The tab measures the PRODUCT, not the repository: an edit made on github.com or
	// by a merged PR never reaches a tool handler and is invisible here. That caveat
	// is load-bearing for how the numbers get read, so it ships with every rendering.
	await expect(
		app.locator('main[data-view="analytics"]').getByText(/Counts activity in Isomorphic only/)
	).toBeVisible();
});
