// THE CARD IS A BOUNDED BOX, and three separate bugs came from forgetting it.
//
// The app renders inline as a card in the chat column that sizes to its content up to a
// cap and then scrolls WITHIN itself. So a floating panel has only the room its side of
// the trigger actually offers, chrome has to paint above content that is positioned,
// and the window must never be shorter than the navigation drawn down its left edge.
// None of that is visible to a golden test and none of it is visible to a screenshot
// baseline either, because every one of these failures needs a control to be OPEN and a
// specific card height to show up.
//
// What each assertion is standing in for, so a future edit knows what it would be
// undoing:
//
//   * A panel that exceeds its room does not merely get clipped. It makes the CARD
//     scrollable, and opening a menu focuses its first row, which scrolls the card to
//     reach it and drags the rail up out of sight. It then reads as a rail clipped by a
//     too-short window, which is not what happened.
//   * `position: sticky` creates a stacking context, so a z-index inside the rail or
//     the header cannot lift anything above a later sibling. That is how the ⋯ menu came
//     to render underneath the analytics chart's bars.
//   * The rail's height is the window's floor. It falls out of flex sizing today and is
//     stated explicitly so it survives an `overflow-hidden` landing on main.
import { test, expect } from '@playwright/test';
import { openApp, settle, ROUTES, type DisplayMode } from './harness.ts';

type App = Awaited<ReturnType<typeof openApp>>;

const rail = (app: App) => app.locator('aside[aria-label="Places"]');

// Routes that deliberately never resolve, or self-boot on a timer: they have no settled
// layout to measure.
const UNSETTLED = new Set(['cold', 'loading', 'slow-result', 'pending-input']);

test.describe('the window', () => {
	for (const mode of ['inline', 'fullscreen', 'pip'] as DisplayMode[]) {
		test(`is never shorter than the rail, in ${mode}`, async ({ page }) => {
			const app = await openApp(page, 'browse', { mode });
			await settle(page);
			const m = await rail(app).evaluate((el) => {
				const nav = el.querySelector('nav') as HTMLElement;
				const root = el.parentElement as HTMLElement;
				return { rail: nav.scrollHeight, root: root.getBoundingClientRect().height };
			});
			expect(m.rail).toBeGreaterThan(0);
			expect(m.root + 0.5).toBeGreaterThanOrEqual(m.rail);
		});
	}

	test('shows every rail control on the shortest card the app produces', async ({ page }) => {
		// Inline sizes to content, so the file tree of a one-folder brain is the smallest
		// card this app ever draws: ~170px, which is the rail's own height. Every control
		// has to be inside it.
		const app = await openApp(page, 'browse', { mode: 'inline' });
		await settle(page);
		for (const name of ['Files', 'Graph', 'Search', 'Recent changes', 'Sharing', 'More'])
			await expect(rail(app).getByRole('button', { name, exact: true })).toBeInViewport();
	});
});

test.describe('a menu', () => {
	test('never exceeds the room on its side, and never makes the card scroll', async ({ page }) => {
		// Inline, because that is where the card is short enough for the ceiling to bite.
		const app = await openApp(page, '', { mode: 'inline' });
		await settle(page);
		await app.getByRole('button', { name: 'Display: Inline' }).click();
		await settle(page);
		const m = await app.locator('[role="menu"]').evaluate((panel) => {
			const scroller = document.scrollingElement as HTMLElement;
			const r = panel.getBoundingClientRect();
			return {
				pastBottom: r.bottom - window.innerHeight,
				pastTop: -r.top,
				scrolled: scroller.scrollTop,
				// A panel with no cap at all is the regression this guards: it would be
				// free to run to its natural height whatever the card allows.
				capped: getComputedStyle(panel).maxHeight
			};
		});
		expect(m.pastBottom).toBeLessThanOrEqual(0.5);
		expect(m.pastTop).toBeLessThanOrEqual(0.5);
		expect(m.scrolled).toBeLessThanOrEqual(0.5);
		expect(m.capped).not.toBe('none');
	});

	test('opens above its trigger when below is cramped and above is roomier', async ({ page }) => {
		// The rail's ⋯ used to be a menu and this geometry is what killed it: a trigger
		// low in a short card. Menu.tsx stated in its own header that it did not flip, on
		// the grounds that every menu hangs off the TOP bar — true until the rail put one
		// at the bottom of a column.
		//
		// The tree's per-row ⋯ is the surviving control with that shape, and it is the
		// honest exerciser: the lowest row of an expanded tree has ~27px beneath it and
		// the whole card above. Before the shared rule it had no cap at all and ran ~50px
		// past the bottom of the card.
		const app = await openApp(page, 'browse', { mode: 'inline' });
		await app.getByRole('button', { name: 'Expand all' }).click();
		await settle(page);
		// The visually lowest row, whichever the fixtures make that.
		await app.locator('main[data-view="browse"]').evaluate(() => {
			const trs = [...document.querySelectorAll('[data-row-menu] > button')] as HTMLElement[];
			let low = trs[0];
			for (const t of trs)
				if (t.getBoundingClientRect().bottom > low.getBoundingClientRect().bottom) low = t;
			low.setAttribute('data-lowest', '');
		});
		await app.locator('[data-lowest]').click({ force: true });
		await settle(page);
		const m = await app.locator('main[data-view="browse"]').evaluate(() => {
			const panel = document.querySelector('[data-row-menu] > div') as HTMLElement | null;
			if (!panel) return null;
			const r = panel.getBoundingClientRect();
			const trig = document.querySelector('[data-lowest]')!.getBoundingClientRect();
			return {
				// Wholly above the trigger, rather than hanging off its bottom edge.
				flipped: r.bottom <= trig.top + 1,
				pastBottom: r.bottom - window.innerHeight,
				capped: getComputedStyle(panel).maxHeight,
				scrolled: (document.scrollingElement as HTMLElement).scrollTop
			};
		});
		expect(m).not.toBeNull();
		expect(m!.flipped).toBe(true);
		expect(m!.pastBottom).toBeLessThanOrEqual(0.5);
		expect(m!.capped).not.toBe('none');
		expect(m!.scrolled).toBeLessThanOrEqual(0.5);
	});
});

test.describe('the chrome layer', () => {
	test('paints above content that is positioned', async ({ page }) => {
		// The analytics chart's bar row sits in a `relative` wrapper at z-auto, and
		// <main> is a later sibling than the rail, so that wrapper used to paint over the
		// whole rail — menu included.
		const app = await openApp(page, 'analytics', { mode: 'fullscreen' });
		await page.setViewportSize({ width: 520, height: 420 });
		await settle(page);
		// SCROLL THE CHART UNDER THE STICKY HEADER FIRST. Without this the display menu
		// hangs in the top-right over empty space and the test is vacuous — it passed
		// against a header with no z-index at all, which is the exact failure it is meant
		// to catch.
		await app.locator('main[data-view="analytics"]').evaluate(() => {
			(document.scrollingElement as HTMLElement).scrollTop = 150;
		});
		await settle(page);
		await app.getByRole('button', { name: /^Display:/ }).click();
		await settle(page);
		// Topmost element at several points down the panel must be the panel or inside
		// it. `toBeVisible` cannot catch this: a panel painted underneath is still
		// "visible", which is why the first attempts at this test passed against the
		// broken build.
		const covered = await app.locator('[role="menu"]').evaluate((panel) => {
			const r = panel.getBoundingClientRect();
			for (const f of [0.15, 0.5, 0.85]) {
				const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
				if (!(at && panel.contains(at))) return true;
			}
			return false;
		});
		expect(covered).toBe(false);
	});
	test('outranks every layer the content declares', async ({ page }) => {
		// The test above only proves chrome declares SOME layer: it passes at z-10,
		// because the chart's wrapper is z-auto. What z-30 actually buys is clearing the
		// content overlays that name a layer of their own — the analytics tooltip at 10
		// and ProseMirror's column-resize handle at 20. So this states the invariant
		// rather than one instance of it.
		const app = await openApp(page, 'analytics', { mode: 'fullscreen' });
		await settle(page);
		// Hover a bar so the tooltip actually exists to be counted.
		await app.locator('main[data-view="analytics"] [role="img"] > div').first().hover();
		await settle(page);
		const z = await app.locator('header').evaluate((header) => {
			const num = (el: Element) => {
				const v = getComputedStyle(el).zIndex;
				return v === 'auto' ? null : Number(v);
			};
			const main = document.querySelector('main') as HTMLElement;
			const content = [...main.querySelectorAll('*'), main]
				.map(num)
				.filter((n): n is number => n !== null);
			return { chrome: num(header), content: Math.max(0, ...content) };
		});
		expect(z.chrome).not.toBeNull();
		expect(z.chrome!).toBeGreaterThan(z.content);
	});
});

test.describe('every route', () => {
	// A sweep rather than one case, because the failure was never about a particular
	// screen: it was about a card short enough for the rail to be the tallest thing in
	// it, and which screens those are changes with the fixtures.
	//
	// ONE TEST PER MODE, AND A BUDGET STATED OUT LOUD. This was a single test walking
	// all three modes, which is ~48 full app boots. It passed locally and timed out on
	// CI at the default 30s, which is the classic shape of a test that measures the
	// machine rather than the app. Split, the three run on separate workers and each
	// retries alone; the raised budget is because a sweep is MEANT to be long, and
	// trimming one until it fits the default is how it quietly stops sweeping.
	test.describe.configure({ timeout: 120_000 });

	for (const mode of ['inline', 'fullscreen', 'pip'] as DisplayMode[]) {
		test(`keeps the rail whole in ${mode}`, async ({ page }) => {
			const bad: string[] = [];
			for (const route of Object.keys(ROUTES)) {
				if (UNSETTLED.has(route)) continue;
				const app = await openApp(page, route as never, { mode });
				// Only INLINE needs settling: its card is sized by a host message
				// (onsizechange), so a measurement taken mid-resize reads a height the
				// app never actually showed. Fullscreen and pip own a fixed window that
				// presentMode has already set, so the wait there was pure sleeping —
				// two thirds of this sweep's wall clock, spent on nothing.
				if (mode === 'inline') await settle(page);
				const m = await rail(app).evaluate((el) => {
					const nav = el.querySelector('nav') as HTMLElement;
					const root = el.parentElement as HTMLElement;
					const nr = nav.getBoundingClientRect();
					const rr = root.getBoundingClientRect();
					return { out: Math.max(0, nr.bottom - rr.bottom, rr.top - nr.top) };
				});
				if (m.out > 0.5) bad.push(`${route} by ${m.out.toFixed(1)}px`);
			}
			expect(bad).toEqual([]);
		});
	}
});
