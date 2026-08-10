// Visual baselines: display modes and themes.
//
// WHY THIS EXISTS. The app renders in three display modes (inline / fullscreen / pip)
// crossed with light and dark, and the mode-specific chrome is real logic, not just
// styling: `presentMode` strips the harness frame in inline because the APP draws its
// own border there, and `applyContentHeight` sizes the inline card to reported content
// height under a cap. Six combinations that no one checks by hand, where the failure
// is silent and only visible to a user.
//
// Snapshots are of the IFRAME, not the host page, so the harness's own chrome (its
// top bar, its page selector) cannot mask or contribute to a diff.
//
// PLATFORM. Baselines live under tests/ui/__screenshots__/<platform>/. Font
// rasterization differs between macOS and the Linux CI runner, so a baseline from one
// never matches the other, and `scripts/test-ui.ts` skips this project entirely on a
// platform that has none rather than failing a run for a missing file. See
// dev/README.md for how to generate them.
import { test, expect } from '@playwright/test';
import { openApp, expectView, settle, type Route, type DisplayMode } from './harness.ts';

// One route per shape of layout, rather than every route: a stat/chart view, a dense
// tree, a long-form page, and a list with controls.
const ROUTES: { route: Route; view: string; label: string }[] = [
	{ route: '', view: 'page', label: 'page' },
	{ route: 'browse', view: 'browse', label: 'browse' },
	{ route: 'analytics', view: 'analytics', label: 'analytics' },
	{ route: 'access', view: 'brain-access', label: 'access' }
];

for (const scheme of ['light', 'dark'] as const) {
	test.describe(`${scheme} theme`, () => {
		test.use({ colorScheme: scheme });

		for (const { route, view, label } of ROUTES) {
			test(`${label} renders`, async ({ page }) => {
				const app = await openApp(page, route);
				await expectView(app, view);
				await settle(page);
				await expect(page.locator('#frame-slot iframe')).toHaveScreenshot(`${label}-${scheme}.png`);
			});
		}
	});
}

// The three display modes, on one route. What varies here is the host-side framing and
// the app's response to it, which does not depend on which view is open — so this is a
// mode matrix, not a mode x route matrix.
for (const mode of ['inline', 'fullscreen', 'pip'] as const satisfies readonly DisplayMode[]) {
	test(`${mode} display mode`, async ({ page }) => {
		const app = await openApp(page, 'browse', { mode });
		await expectView(app, 'browse');
		await settle(page);
		// The whole host page here, deliberately: in pip and fullscreen the point IS
		// where the frame sits and how big it is, which a screenshot of the frame alone
		// cannot show.
		await expect(page).toHaveScreenshot(`mode-${mode}.png`, { fullPage: false });
	});
}
