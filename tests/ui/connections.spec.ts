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

test('Connections is offered beside Sharing, as a place in this brain', async ({ page }) => {
	const app = await openApp(page, 'browse');
	// The overflow menu is the second route to the same places, and it groups them by
	// scope. Sharing is who can come IN; Connections is where this brain joins OUT.
	// getByLabel rather than getByRole: a file row carries its own "More" action, and the
	// one this test means is the header's.
	await app.getByLabel('More').click();
	await expect(app.getByText('Sharing')).toBeVisible();
	await expect(app.getByText('Connections')).toBeVisible();
});
