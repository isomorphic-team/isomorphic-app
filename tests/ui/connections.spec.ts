// Connections in the app: a shared surface is reached from the brain it is joined to,
// and never from the brain switcher.
//
// That distinction is the whole product decision and it lives entirely in the app: the
// server sends connections in the same list as everything else, deliberately, because
// that list is what a result's brain is resolved against. Only a browser can catch the
// filtering going wrong in either direction: a connection appearing as a peer of a
// workspace, or the crumb failing to name one when a result opens it.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

test('the panel lists what this brain is joined to, and who is on the other side', async ({
	page
}) => {
	const app = await openApp(page, 'connections');
	await expectView(app, 'connections');
	await expect(app.getByText('Northwind engagement')).toBeVisible();
	// The counterparty is the one thing a person needs at a glance. A connection rendered
	// without it is just a name.
	await expect(app.getByText('Northwind', { exact: false }).first()).toBeVisible();
});

test('an invitation is listed apart from the connections themselves', async ({ page }) => {
	const app = await openApp(page, 'connections');
	// Not reachable yet, and shown separately for that reason: until you join it to a
	// brain of your own there is no brain for it to hang off, so it cannot appear as a
	// place you can open.
	await expect(app.getByText('Waiting for you')).toBeVisible();
	await expect(app.getByText('Acme partnership')).toBeVisible();
});

test('opening a connection shows its pages, under its own name', async ({ page }) => {
	const app = await openApp(page, 'connections');
	await expectView(app, 'connections');

	// The panel LISTS connections; this is the only route into one from the chrome, so
	// without a working click a person can see that a shared space exists and has no way
	// to read it.
	await app.getByRole('button', { name: /Northwind engagement/ }).click();

	// Its own pages, not the anchor brain's. The room holds a kickoff page that exists in
	// no other fixture brain, so finding it proves the app is reading the connection.
	await expectView(app, 'browse');
	await app.getByRole('button', { name: 'Expand all' }).click();
	// The tree labels a page by its TITLE where it has one, so this is "Kickoff" rather
	// than the filename.
	await expect(app.getByRole('button', { name: /kickoff/i })).toBeVisible();

	// And the crumb follows the content. A second brain rendered under the first brain's
	// name is issue #26; entering a connection has to move the whole context with it.
	// getByText, not getByRole: on the Files view the brain crumb is deliberately inert,
	// so it is a span rather than a button.
	await expect(app.getByText('Northwind engagement').first()).toBeVisible();
});

test('a connection is not offered in the brain switcher', async ({ page }) => {
	const app = await openApp(page, '');
	// The crumb LABEL opens Files; the chevron beside it opens the switcher. They are
	// two controls in one unit, and this test means the second.
	await app.getByRole('button', { name: 'Switch brain' }).click();
	// The fixture's connection IS in the brains payload, so this asserts the app filters
	// it rather than that it was never sent. Rendering a relationship as a peer of a
	// workspace is what makes the list sprawl.
	await expect(app.getByText('Acme wiki')).toBeVisible();
	await expect(app.getByText('Northwind engagement')).toHaveCount(0);
});

test('Connections stands in the rail beside Sharing, as a place in this brain', async ({
	page
}) => {
	const app = await openApp(page, 'browse');
	// Both are views OF this brain, and they are the pair that reads as opposites:
	// Sharing is who can come IN, Connections is where this brain reaches OUT. Scoped to
	// the rail because a file row carries controls of its own.
	const rail = app.locator('aside[aria-label="Places"]');
	await expect(rail.getByRole('button', { name: 'Sharing', exact: true })).toBeVisible();
	await rail.getByRole('button', { name: 'Connections', exact: true }).click();
	await expectView(app, 'connections');
});

test('Sharing POINTS AT the connections instead of listing them', async ({ page }) => {
	const app = await openApp(page, 'access');
	await expectView(app, 'brain-access');

	// The two lists must not merge, and this is the assertion that says why. Access runs
	// one way: reaching this brain gets you into the rooms it anchors, and being in one
	// of those rooms gets you nothing here. A room among the people who can reach this
	// brain would state the reverse, on the one page opened by someone worried about a
	// leak. So the room's name must NOT be on the sharing page.
	await expect(app.getByText('Northwind engagement')).toHaveCount(0);

	// What is there is a pointer, which answers the other half of the thought that
	// brings someone to this page without putting a brain in a list of people.
	const link = app.getByRole('button', { name: /Also joined to \d+ shared space/ });
	await expect(link).toBeVisible();

	await link.click();
	await expectView(app, 'connections');
	await expect(app.getByText('Northwind engagement')).toBeVisible();
});
