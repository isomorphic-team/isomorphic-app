// The four add-shaped flows, and the sandbox rule that once broke all of them.
//
// Invite member / share brain / connect account / add brain all follow the same
// convention (app/ui/Flow.tsx): a pushed view with an affirmative button in the
// footer. They were also all built on `<form onSubmit>` + `<Button type="submit">`,
// which does NOTHING in a sandboxed iframe without `allow-forms` — the browser blocks
// submission and never dispatches the event, so the handler never runs and the button
// silently does nothing. See submitOnEnter in app/ui/Flow.tsx.
//
// That is the regression these tests exist to prevent, so each one drives a flow to
// COMPLETION rather than just checking it opens. A test that only asserted the form
// rendered would have passed throughout the outage.
import { test, expect } from '@playwright/test';
import { openApp, expectView } from './harness.ts';

test('share brain: the flow completes and the grant appears', async ({ page }) => {
	const app = await openApp(page, 'access');
	await expectView(app, 'brain-access');
	// The brain-scope twin of Invite, opened from the panel header.
	await app.getByRole('banner').getByRole('button', { name: 'Share' }).click();
	await expectView(app, 'share-brain');

	const share = app.getByRole('button', { name: 'Share', exact: true }).last();
	await app.getByRole('textbox').first().fill('devon@example.com');
	await share.click();

	// Back on the panel, with Devon now admitted. Devon is an org VIEWER with no grant
	// on a private brain, so before this they were correctly absent from the list —
	// their appearance is the grant taking effect, not a row that was always there.
	await expectView(app, 'brain-access');
	await expect(
		app.locator('main[data-view="brain-access"]').getByText('devon@example.com')
	).toBeVisible({ timeout: 10_000 });
});

test('add brain: the create flow completes and switches to the new brain', async ({ page }) => {
	// `#nobrains` is the first-touch state, where AddBrainView renders in its `first`
	// mode: no Cancel, because there is nothing to go back to.
	const app = await openApp(page, 'nobrains');
	await expectView(app, 'add-brain');

	await app.getByRole('textbox').first().fill('Test brain');
	await app.getByRole('button', { name: 'Create brain' }).click();

	// A fresh brain is empty, so landing on its tree is the success signal.
	await expectView(app, 'browse');
});

test('connect account: the link flow completes', async ({ page }) => {
	const app = await openApp(page, 'connected');
	await expectView(app, 'settings');
	await app.getByRole('banner').getByRole('button', { name: 'Connect' }).click();
	await expectView(app, 'connect-account');

	await app.getByRole('textbox').first().fill('another@example.com');
	// Same label as the header entry point, so scope to the flow's own footer.
	await app
		.locator('main[data-view="connect-account"]')
		.getByRole('button', { name: 'Connect', exact: true })
		.click();
	// link_identity returns a URL for the user to open rather than completing inline,
	// and the flow renders it in a FlowNote. Reaching that note is this flow's
	// completion signal.
	await expect(app.locator('main[data-view="connect-account"]')).toContainText(/https?:\/\//, {
		timeout: 10_000
	});
});

test('Enter submits a flow, since the form event never fires', async ({ page }) => {
	// The keyboard half of the same bug: pressing Enter in an input inside a <form>
	// also triggers native submission, and is blocked by the same sandbox rule. Every
	// flow therefore handles Enter explicitly (submitOnEnter). Without that, the only
	// way to complete any of these is the mouse.
	const app = await openApp(page, 'members');
	await app.getByRole('banner').getByRole('button', { name: 'Invite' }).click();
	await expectView(app, 'invite-member');

	const email = app.getByRole('textbox', { name: 'Email address' });
	await email.fill('keyboard@example.com');
	await email.press('Enter');

	await expectView(app, 'members');
	await expect(
		app.locator('main[data-view="members"]').getByText('keyboard@example.com')
	).toBeVisible({ timeout: 10_000 });
});
