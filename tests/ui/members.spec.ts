// The org roster: the list, its admin mutations, and the lockout guardrails.
//
// Separate from sharing.spec.ts on purpose. `members` is ORG scope and
// `brain_access` is BRAIN scope — different tools, different views, different role
// question. They share role NAMES and nothing else, and a test file that treated them
// as the same surface would be reproducing the exact confusion the two-scope split
// exists to prevent.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

const roster = (app: Awaited<ReturnType<typeof openApp>>) =>
	app.locator('main[data-view="members"]');

test('the roster lists every member with their org role', async ({ page }) => {
	const app = await openApp(page, 'members');
	await expectView(app, 'members');
	const main = roster(app);
	for (const who of ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson', 'devon@example.com']) {
		await expect(main.getByText(who, { exact: false }).first()).toBeVisible();
	}
	// Emails included: all members can see the roster, emails and all.
	await expect(main.getByText('cael@example.com')).toBeVisible();
});

test('the owner row carries no role control and no remove', async ({ page }) => {
	// Two lockout guardrails converge on this row (owner is never assignable,
	// removable, or demotable; and you can never edit your own membership), and both
	// live in members.ts rather than in the generic role plumbing. The row rendering
	// controls would be the visible half of losing either.
	const app = await openApp(page, 'members');
	const owner = roster(app).locator('li').filter({ hasText: 'Ada Lovelace' });
	await expect(owner.getByRole('combobox', { name: 'Role' })).toHaveCount(0);
	await expect(owner.getByRole('button', { name: /^Remove/ })).toHaveCount(0);

	// The controls DO exist on other rows, so the assertion above is testing the
	// guardrail rather than a roster that renders no controls at all.
	const other = roster(app).locator('li').filter({ hasText: 'cael@example.com' });
	await expect(other.getByRole('combobox', { name: 'Role' })).toHaveCount(1);
});

test('changing a role updates the roster in place', async ({ page }) => {
	const app = await openApp(page, 'members');
	const row = roster(app).locator('li').filter({ hasText: 'mira@example.com' });
	const role = row.getByRole('combobox', { name: 'Role' });
	await expect(role).toHaveValue('editor');

	await role.selectOption('admin');
	await expect(role).toHaveValue('admin', { timeout: 10_000 });
	// The mutation returns the fresh roster and the view re-renders from it without
	// navigating away.
	await expectView(app, 'members');
});

test('removing a member drops the row', async ({ page }) => {
	const app = await openApp(page, 'members');
	const main = roster(app);
	await expect(main.getByText('devon@example.com')).toBeVisible();
	await main.getByRole('button', { name: 'Remove devon@example.com' }).click();
	await expect(main.getByText('devon@example.com')).toHaveCount(0, { timeout: 10_000 });
});

test('pending invites are listed, aged against the frozen clock', async ({ page }) => {
	const app = await openApp(page, 'members');
	const main = roster(app);
	await expect(main.getByText('Pending invites')).toBeVisible();
	await expect(main.getByText('newhire@example.com')).toBeVisible();
	// The seed invite is created two days before the frozen instant. Reading exactly
	// "2d ago" is the members-view proof that both clocks are held: the harness makes
	// the timestamp, the app renders the interval.
	await expect(main.getByText('Invited 2d ago')).toBeVisible();
});

test('inviting someone is a pushed flow that lands back on the roster', async ({ page }) => {
	const app = await openApp(page, 'members');
	// Every add-shaped action in this app opens its own view rather than an inline
	// composer (the app/ui/Flow.tsx convention). Invite is the org-scope one.
	await app.getByRole('banner').getByRole('button', { name: 'Invite' }).click();
	await expectView(app, 'invite-member');

	// Guarded until there is an address to send to, so the flow cannot post an empty
	// invite that the server would only reject.
	const send = app.getByRole('button', { name: 'Send invite' });
	await expect(send).toBeDisabled();
	await app.getByRole('textbox', { name: 'Email address' }).fill('newcomer@example.com');
	await expect(send).toBeEnabled();
	await send.click();

	// Back on the roster, with the new invite in the pending list.
	await expectView(app, 'members');
	await expect(roster(app).getByText('newcomer@example.com')).toBeVisible({ timeout: 10_000 });
});
