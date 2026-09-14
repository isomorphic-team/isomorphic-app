// Per-brain sharing: the panel, its in-place refresh, and the brain-vs-org role split.
//
// The access RULE (effectiveBrainRole) is pinned by `pnpm test:access`, which walks
// its whole input space in milliseconds. Nothing here re-tests that. What is only
// testable through the UI is whether the panel puts the rule's answer on screen and
// whether the controls it gates are actually gated.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

test('the panel lists everyone the access rule admits, labelled by how', async ({ page }) => {
	const app = await openApp(page, 'access');
	await expectView(app, 'brain-access');
	const main = app.locator('main[data-view="brain-access"]');

	// Personal is private and mine. All three admission paths must be visible at once,
	// because "who can see this" is wrong in a different way for each:
	//   Ada        me, via my own grant
	//   Grace      no grant at all, admitted by the ORG-ADMIN FLOOR
	//   Katherine  an org Editor explicitly shared in read-only, the case per-brain
	//              roles exist for (her brain role is BELOW her org role)
	await expect(main.getByText('Ada Lovelace')).toBeVisible();
	await expect(main.getByText('Grace Hopper')).toBeVisible();
	await expect(main.getByText('Organization admin')).toBeVisible();
	await expect(main.getByText('Katherine Johnson')).toBeVisible();

	// Devon is an org viewer with no grant on a private brain: the rule excludes them,
	// and a panel that listed them would be claiming access that does not exist.
	await expect(main.getByText('devon@example.com')).toHaveCount(0);

	// Tomás holds a grant and no membership: a GUEST, shown as one, after the
	// members, and offered only the roles a guest can hold.
	await expect(main.getByText('Tomás Rivera')).toBeVisible();
	await expect(main.getByText('Guest · tomas@client.example')).toBeVisible();
	const rows = main.locator('li');
	await expect(rows.last()).toContainText('Tomás Rivera');
	const guestSelect = rows.last().getByRole('combobox', { name: 'Role' });
	await expect(guestSelect).toHaveValue('editor');
	await expect(guestSelect.locator('option')).toHaveText(['Viewer', 'Editor']);
	// A member's select still offers admin, so the cap is the guest's, not the panel's.
	const memberRow = main.locator('li', { hasText: 'Katherine Johnson' });
	await expect(memberRow.getByRole('combobox', { name: 'Role' }).locator('option')).toHaveText([
		'Viewer',
		'Editor',
		'Admin'
	]);
});

test('changing a role refreshes the panel in place', async ({ page }) => {
	const app = await openApp(page, 'access');
	const main = app.locator('main[data-view="brain-access"]');
	const role = main.getByRole('combobox', { name: 'Role' }).first();
	await expect(role).toHaveValue('viewer');

	await role.selectOption('editor');
	// The mutation returns the fresh list, and the panel must re-render from it
	// without navigating away. Staying on brain-access IS the assertion: an
	// implementation that pushed a new view would also "work" and would be wrong.
	await expect(role).toHaveValue('editor', { timeout: 10_000 });
	await expectView(app, 'brain-access');
});

test('revoking removes the row', async ({ page }) => {
	const app = await openApp(page, 'access');
	const main = app.locator('main[data-view="brain-access"]');
	await expect(main.getByText('Katherine Johnson')).toBeVisible();
	await main
		.getByRole('button', { name: /Remove .*access/ })
		.first()
		.click();
	// Revocation has to actually revoke. Katherine holds a grant on a PRIVATE brain
	// and is not an org admin, so with the grant gone the rule admits her nowhere and
	// she must leave the list entirely.
	await expect(main.getByText('Katherine Johnson')).toHaveCount(0, { timeout: 10_000 });
});

test('sharing is gated on the brain role, not the org role', async ({ page }) => {
	// The whole point of the two-role split. Northwind is a client brain shared with
	// me read-only: my BRAIN role there is viewer, so the Share control must be absent
	// even though I am an owner elsewhere. Gating this on the org role instead is the
	// exact bug docs/design/brain-level-permissions.md exists to prevent, and it would
	// be invisible in every other view.
	const app = await openApp(page, 'brains');
	const rows = app.locator('main[data-view="brains"] li');

	const northwind = rows.filter({ hasText: 'Northwind' }).filter({ hasText: 'Viewer' });
	await expect(northwind.getByRole('button', { name: 'Share' })).toHaveCount(0);

	// And the control does appear where the brain role is admin, so the assertion
	// above is testing the gate rather than a Share button that renders nowhere.
	const personal = rows.filter({ hasText: 'Owner' });
	await expect(personal.getByRole('button', { name: 'Share' }).first()).toBeVisible();
});

test('a share to an address with no account shows up as an invite, and can be cancelled', async ({
	page
}) => {
	const app = await openApp(page, 'access');
	await expectView(app, 'brain-access');
	const main = app.locator('main[data-view="brain-access"]');
	await expect(main.getByText('Invited')).toHaveCount(0);

	// The share flow off the header, with an email nobody here has.
	await app.getByRole('banner').getByRole('button', { name: 'Share' }).click();
	await expectView(app, 'share-brain');
	await app.getByRole('textbox').first().fill('newperson@client.example');
	await app.getByRole('button', { name: 'Share', exact: true }).last().click();

	// Back on the panel, the invite is the evidence the share happened.
	await expectView(app, 'brain-access');
	await expect(main.getByText('Invited', { exact: true })).toBeVisible();
	const row = main.locator('li', { hasText: 'newperson@client.example' });
	await expect(row).toContainText('Guest once they sign in');
	await expect(row).toContainText('Editor');

	await row.getByRole('button', { name: 'Cancel invite for newperson@client.example' }).click();
	await expect(main.locator('li', { hasText: 'newperson@client.example' })).toHaveCount(0);
	await expect(main.getByText('Invited', { exact: true })).toHaveCount(0);
});
