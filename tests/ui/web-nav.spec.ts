// The app AS A WEB PAGE: the same bundle, served at `/b/<owner>/<repo>/<path>`,
// talking to `/mcp` over fetch instead of to a host over AppBridge.
//
// This is the only battery that drives that host. Every other spec here mounts the
// bundle in the harness's iframe as an MCP App, and `pnpm test:web` covers the
// Worker's rules as pure functions — so between them the WEB half of the app booted
// nowhere, and the first thing that ran it found a defect neither could see.
//
// THE DEFECT, since it is what these assertions exist for. Navigation never wrote
// the address bar. `webPathFor` — the URL builder — had no caller outside its own
// round-trip test, so clicking a link changed the page and left the URL naming the
// one you arrived on. Three things were broken at once and only the third is
// cosmetic: Back left the app entirely, Forward could not return, and the URL you
// copied to send someone was never the page you were reading. Sharing a link to a
// page is the reason the web app exists, so that last one is the whole feature.
//
// Assert on the PAIR (url, heading) every time, never on one alone. The bug was
// precisely a heading that moved while a URL stood still; a spec watching either by
// itself stays green through it.

import { test, expect, type Page } from '@playwright/test';
import { WEB_TEST_PORT, WEB_TEST_BRAIN } from '../../playwright.config.ts';

const BASE = `http://localhost:${WEB_TEST_PORT}`;
// Derived from the config's one constant, so the seed directory and the URLs the
// specs address cannot drift apart.
const BRAIN = WEB_TEST_BRAIN;
// The sibling brains web-dev seeds alongside it, named after the root for the same
// reason. Same three brains `pnpm app:dev` shows, from the same dev/seed.ts.
const ACME = `${BRAIN}-acme`;
const NORTHWIND = `${BRAIN}-northwind`;
const INDEX = `/b/${BRAIN}/wiki/index.md`;

// The app renders the page body into `.prose`; the heading is what the reader sees
// and the URL is what they would copy, so every assertion reads both.
async function at(page: Page): Promise<{ url: string; heading: string }> {
	return {
		url: page.url().replace(BASE, ''),
		heading: await page.locator('h1').first().innerText()
	};
}

// The app fetches the page after the document loads, so "the heading is present"
// is the readiness signal rather than any fixed wait.
async function settled(page: Page, heading?: string) {
	const h1 = page.locator('h1').first();
	await expect(h1).toBeVisible({ timeout: 15_000 });
	if (heading) await expect(h1).toHaveText(heading, { timeout: 15_000 });
}

test.describe('the app in a browser tab', () => {
	test('it boots from the URL, with no conversation behind it', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));

		await page.goto(`${BASE}${INDEX}`);
		await settled(page);

		// The flag the shell stamps is what selects the web transport. If this is
		// false the app is talking to a host that is not there.
		expect(await page.evaluate(() => (window as { __ISO_WEB__?: boolean }).__ISO_WEB__)).toBe(true);
		expect(await at(page)).toEqual({ url: INDEX, heading: 'Index' });
		// A page that boots with a thrown error can still look right; the widget
		// simply stops responding later.
		expect(errors).toEqual([]);
	});

	test('following a link moves the address bar with the page', async ({ page }) => {
		await page.goto(`${BASE}${INDEX}`);
		await settled(page);

		const link = page.locator('.prose a').first();
		const name = await link.innerText();
		await link.click();
		await settled(page, name);

		const now = await at(page);
		expect(now.heading).toBe(name);
		// The assertion the defect failed: the URL has to have MOVED, and it has to
		// name a page rather than merely differ.
		expect(now.url).not.toBe(INDEX);
		expect(now.url.startsWith(`/b/${BRAIN}/`)).toBe(true);
		expect(now.url.endsWith('.md')).toBe(true);
	});

	test('back and forward move between pages instead of leaving the app', async ({ page }) => {
		await page.goto(`${BASE}${INDEX}`);
		await settled(page);
		const first = await at(page);

		const link = page.locator('.prose a').first();
		const name = await link.innerText();
		await link.click();
		await settled(page, name);
		const second = await at(page);

		// Back. Before the fix this left for about:blank, because the click had put
		// no entry in the browser's history to return from.
		await page.goBack();
		await settled(page, first.heading);
		expect(await at(page)).toEqual(first);

		await page.goForward();
		await settled(page, second.heading);
		expect(await at(page)).toEqual(second);
	});

	test('the URL you copy opens the page you were reading', async ({ page, context }) => {
		await page.goto(`${BASE}${INDEX}`);
		await settled(page);

		const link = page.locator('.prose a').first();
		const name = await link.innerText();
		await link.click();
		await settled(page, name);
		const shared = await at(page);

		// A FRESH tab, which is the whole point: no in-memory state, nothing but the
		// URL. This is what a colleague receiving the link actually does.
		const other = await context.newPage();
		await other.goto(`${BASE}${shared.url}`);
		await settled(other, shared.heading);
		expect(await at(other)).toEqual(shared);
		await other.close();
	});

	// The destinations that are not a page. They ride the query string because the
	// path after the brain is a repo path, so `/b/o/r/graph` is a page called
	// `graph` — a collision that would appear the day someone wrote one.
	test('a search is a URL, and reopens cold', async ({ page, context }) => {
		await page.goto(`${BASE}${INDEX}`);
		await settled(page);

		// Through the app's own control, not by typing a URL: the point is that
		// searching WRITES the address bar, not merely that the app can read one.
		await page.getByTitle('Search', { exact: false }).first().click();
		const field = page.locator('input[type="search"], input[type="text"]').first();
		await field.fill('vision');
		await field.press('Enter');
		await expect(page.locator('.prose, [data-testid="search-results"], body')).toBeVisible();
		await expect
			.poll(() => new URL(page.url()).searchParams.get('q'), { timeout: 15_000 })
			.toBe('vision');

		// Cold, in a fresh tab: the query has to survive as the thing that rebuilds
		// the view, since the hits themselves are derived and were never in the URL.
		const other = await context.newPage();
		await other.goto(page.url());
		await expect
			.poll(() => other.locator('input').first().inputValue(), { timeout: 15_000 })
			.toBe('vision');
		await other.close();
	});

	test('the graph is a URL, and Back leaves it for the page you came from', async ({ page }) => {
		await page.goto(`${BASE}${INDEX}`);
		await settled(page);

		await page.goto(`${BASE}/b/${BRAIN}?view=graph`);
		// The graph builds from a tool call, so wait for the view rather than a tick.
		await expect(page.locator('svg, canvas').first()).toBeVisible({ timeout: 20_000 });
		expect(new URL(page.url()).searchParams.get('view')).toBe('graph');

		await page.goBack();
		await settled(page, 'Index');
		expect(await at(page)).toEqual({ url: INDEX, heading: 'Index' });
	});

	// The two that had no URL at all until the routing table was derived from the
	// tool surface rather than from the view list.
	// `?view=activity`, one of the two destinations that had no URL at all until the
	// routing table was derived from the tool surface instead of the view list.
	//
	// `?view=access` is NOT covered here and cannot be: `brain_access` is org-model
	// machinery that the local runtime deliberately does not register (no orgs, no
	// memberships), so this host serves no such tool. Its round trip is pinned in
	// `pnpm test:web`; the app actually opening it is uncovered, like every other
	// org-scope screen.
	test('activity is reachable by URL', async ({ page }) => {
		// Asserted on the RAIL's `aria-current`, not on body text. The first version
		// matched /change|edit|commit|history/ against the whole body, and "Edit" is a
		// button in the chrome of every page — so it passed while `?view=access` was
		// silently doing nothing, which is how that gap was found.
		await page.goto(`${BASE}/b/${BRAIN}?view=activity`);
		await expect(page.getByRole('button', { name: 'Recent changes' })).toHaveAttribute(
			'aria-current',
			'page',
			{ timeout: 20_000 }
		);
		// The URL has to SURVIVE the load: a view that opens and then rewrites the bar
		// back to the tree would look right on screen and break every link.
		expect(new URL(page.url()).searchParams.get('view')).toBe('activity');
	});

	// Back between two destinations that differ ONLY in the query string.
	//
	// The popstate handler parsed `location.pathname` and dropped `location.search`,
	// so returning to `?view=search` landed on the file tree instead — the pathname
	// is identical for every non-page destination, and the whole difference between
	// them is the half that was being thrown away. Every earlier Back test moved
	// between a page and something else, where the paths differ, so all of them
	// stayed green through it.
	// NAVIGATE IN-APP, never with a second `goto`. Two `goto`s and a `goBack` is a
	// document LOAD, which re-boots the app from the URL and reads the query
	// correctly — so a test written that way passes with the defect reinstated, which
	// is exactly what happened on the first attempt here. Only a pushState
	// navigation makes Back fire `popstate`, which is the code under test.
	test('back between two query-only destinations keeps the query', async ({ page }) => {
		await page.goto(`${BASE}${INDEX}`);
		await settled(page);

		await page.getByRole('button', { name: 'Search' }).click();
		const field = page.locator('input').first();
		await field.fill('vision');
		await field.press('Enter');
		await expect
			.poll(() => new URL(page.url()).searchParams.get('q'), { timeout: 15_000 })
			.toBe('vision');

		await page.getByRole('button', { name: 'Graph' }).click();
		await expect
			.poll(() => new URL(page.url()).searchParams.get('view'), { timeout: 20_000 })
			.toBe('graph');

		await page.goBack();
		await expect
			.poll(() => new URL(page.url()).searchParams.get('view'), { timeout: 15_000 })
			.toBe('search');
		// And the VIEW, not just the bar: the defect left the address bar correct and
		// put the file tree on screen, because the query it dropped was the whole
		// difference between these two destinations.
		await expect
			.poll(() => page.locator('input').first().inputValue(), { timeout: 15_000 })
			.toBe('vision');
	});

	// THE URL NAMES THE BRAIN, AND THE CALLS HAVE TO GO THERE.
	//
	// This is the test the harness could not previously hold, and the reason it now
	// serves three brains. With one brain, a URL naming any brain rendered that one,
	// so being wrong looked exactly like being right — and it WAS wrong: nothing read
	// the URL's brain, every call carried no `brain` at all, and the server answered
	// from the connection's active-brain pointer. A link to one brain silently showed
	// another's page whenever the path existed in both, which `wiki/index.md` does.
	//
	// Asserted on BOTH halves. The heading alone would pass if the app rendered the
	// right brain for the wrong reason; the request argument alone would pass if the
	// argument were sent and ignored.
	test('a URL opens the brain it names, not the active one', async ({ context }) => {
		for (const [brain, heading] of [
			[BRAIN, 'Index'],
			[ACME, 'Acme'],
			[NORTHWIND, 'Northwind']
		] as const) {
			const page = await context.newPage();
			const sent: string[] = [];
			await page.route('**/mcp', async (route) => {
				try {
					const body = JSON.parse(route.request().postData() ?? '{}');
					if (body.method === 'tools/call' && body.params?.name === 'read_page') {
						sent.push(body.params?.arguments?.brain ?? '(none)');
					}
				} catch {
					// Not a JSON-RPC body we care about; the request still goes through.
				}
				await route.continue();
			});

			await page.goto(`${BASE}/b/${brain}/wiki/index.md`);
			await settled(page, heading);
			expect(sent[0], `read_page for ${brain}`).toBe(brain);
			await page.close();
		}
	});

	test('a cross-origin tool call is refused by the real gate', async ({ request }) => {
		// Same gate the Worker runs. `pnpm test:web` asserts the rules directly; this
		// asserts they are actually MOUNTED in front of the endpoint, which is the
		// half a pure test cannot reach.
		//
		// A cross-origin JSON POST, from outside the browser so the `Origin` can be
		// set. Only the gate answers this with 403: without it the transport would
		// accept the request, since it is otherwise well-formed. (A non-JSON body is
		// NOT a discriminating probe: the transport refuses that with 415 on its own,
		// so such a test stays green with the gate unmounted.)
		const res = await request.post(`${BASE}/mcp`, {
			headers: {
				origin: 'https://evil.example',
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			data: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'list_pages', arguments: {} }
			}
		});
		expect(res.status()).toBe(403);
	});
});
