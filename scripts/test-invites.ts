// Golden test for invitation claiming: no network. Three halves:
//
//   1. The RULE (`planInviteClaims`), pure: which invites join an org, at what
//      role, and which are merely marked accepted.
//   2. The QUERIES that apply it, against the real schema in an in-memory SQLite
//      (node:sqlite, a Node builtin) shimmed to the D1 surface.
//   3. `provisionOrgForUser`, the first-touch path, over the same database.
//
// This exists because of issue #69, where an invitation could be permanently
// unclaimable with nothing surfaced to either side. The scenarios below are that
// report: an address linked to an existing account, and an account that already
// belongs to one org being invited to a second. Both were silently dropped, so
// the assertions are written as "the invitee can now reach the org's brain"
// rather than as "a row was written".
//
//   pnpm test:invites

import { localD1 } from '../src/local/d1-sqlite.ts';
import { checker } from './check.ts';
import { planInviteClaims, claimPendingInvites, type MatchedInvite } from '../src/lib/invites.ts';
import { noBrainOutcome, provisionOrgForUser } from '../src/lib/provision.ts';
import {
	createInvitation,
	listPendingInvites,
	listMembers,
	listAccessibleBrains,
	linkedUserIds,
	mergePersons,
	upsertAppUser,
	type Role
} from '../src/lib/orgs.ts';

const { check, done } = checker('invite checks');

const inv = (id: string, org: string, role: Role, user = 'u1'): MatchedInvite => ({
	invite_id: id,
	org_id: org,
	role,
	user_id: user
});

// ===========================================================================
// 1. The rule.
// ===========================================================================

console.log('\nplanInviteClaims: what an invitation does');
check('nothing pending → nothing to do', planInviteClaims([], ['orgA']).length === 0);

{
	const claims = planInviteClaims([inv('i1', 'orgB', 'editor')], ['orgA']);
	check('an invite to another org joins it', claims.length === 1 && claims[0].joins);
	check('at the invited role', claims[0].role === 'editor');
	check('under the invited address', claims[0].user_id === 'u1');
}

{
	// The membership row is what the admin wants NOW; the invite is what they
	// wanted when they sent it. A stale invite must never demote anyone.
	const claims = planInviteClaims([inv('i1', 'orgA', 'viewer')], ['orgA']);
	check('an invite to an org you are already in writes no membership', !claims[0].joins);
	check('and is still accepted, so the roster stops showing it', claims.length === 1);
}

{
	const claims = planInviteClaims([inv('i1', 'orgB', 'viewer'), inv('i2', 'orgB', 'admin')], []);
	check('two invites to one org collapse to one join', claims.filter((c) => c.joins).length === 1);
	check('at the highest role invited', claims.find((c) => c.joins)?.role === 'admin');
	check('and both are accepted', claims.length === 2);
}

check(
	'the highest role wins whichever order it arrives in',
	planInviteClaims([inv('i1', 'orgB', 'admin'), inv('i2', 'orgB', 'viewer')], []).find(
		(c) => c.joins
	)?.role === 'admin'
);

check(
	'equal roles keep the earlier invite, so the answer does not depend on row order',
	planInviteClaims([inv('i1', 'orgB', 'editor'), inv('i2', 'orgB', 'editor')], []).find(
		(c) => c.joins
	)?.invite_id === 'i1'
);

check(
	'invites to different orgs each join',
	planInviteClaims([inv('i1', 'orgB', 'editor'), inv('i2', 'orgC', 'viewer')], []).filter(
		(c) => c.joins
	).length === 2
);

check(
	'the membership lands on the address that was invited, not the signed-in one',
	planInviteClaims([inv('i1', 'orgB', 'editor', 'work-id')], [])[0].user_id === 'work-id'
);

// ---------------------------------------------------------------------------
console.log('\nnoBrainOutcome: what a member with no reachable brain is told');
// ---------------------------------------------------------------------------
// Anyone who can create a brain gets the app's create state, which is what this
// path did for every role before. A viewer cannot, so stranding them there is
// the case worth fixing, and which of the two problems they have is invisible
// from their side.
for (const role of ['editor', 'admin', 'owner'] as Role[]) {
	for (const orgHasAnyBrain of [true, false]) {
		check(
			`${role}, ${orgHasAnyBrain ? 'unshared brains' : 'empty org'} → the create state`,
			noBrainOutcome({ role, orgHasAnyBrain }).kind === 'create'
		);
	}
}
check(
	'viewer, brains exist but none reachable → "not shared with you"',
	(() => {
		const got = noBrainOutcome({ role: 'viewer', orgHasAnyBrain: true });
		return got.kind === 'error' && got.message.includes('shared with you');
	})()
);
check(
	'viewer, empty org → ask your admin to finish setup',
	(() => {
		const got = noBrainOutcome({ role: 'viewer', orgHasAnyBrain: false });
		return got.kind === 'error' && got.message.includes('no brain configured');
	})()
);

// ===========================================================================
// 2. The queries, run for real against the real schema.
// ===========================================================================

// Schema comes from the real migrations, not src/db/auth-schema.sql, which is
// reference only. Invitations decide org membership, so this battery is
// authorization-adjacent and should not assert against a schema production does
// not run.
const { db, sqlite } = localD1();

// Two orgs. Ada belongs to Org A and works there; Org B is a customer org with
// one org-visible brain, and its admin is about to invite her second address.
sqlite.exec(`
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at) VALUES
    ('orgA', 'Ada Home',  'platform', 1, 'platform-org', 'ada-home', '2026-01-01'),
    ('orgB', 'Northwind', 'customer', 2, 'northwind',    'boss',     '2026-02-01'),
    ('orgC', 'Contoso',   'customer', 3, 'contoso',      'boss',     '2026-03-01');
  INSERT INTO app_users (user_id, email, name) VALUES
    ('ada-home', 'ada@personal.example',  'Ada'),
    ('ada-work', 'ada@northwind.example', 'Ada'),
    ('boss',     'boss@northwind.example','Boss'),
    ('cy',       'cy@contoso.example',    'Cy');
  INSERT INTO memberships (org_id, user_id, role, added_at) VALUES
    ('orgA', 'ada-home', 'owner',  '2026-01-01'),
    ('orgB', 'boss',     'owner',  '2026-02-01'),
    ('orgC', 'boss',     'owner',  '2026-03-01');
  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at) VALUES
    ('b-home',      'orgA', 'platform-org', 'brain-ada', 'Ada',       'org', '2026-01-02'),
    ('b-northwind', 'orgB', 'northwind',    'brain',     'Northwind', 'org', '2026-02-02');
`);

const brainIds = async (userIds: string[]) =>
	(await listAccessibleBrains(db, userIds)).map((b) => b.id).sort();

// ---------------------------------------------------------------------------
console.log('\nDefect 1: linking an invited address consumes its invitation');
// ---------------------------------------------------------------------------
// Ada already has an account, so nothing about her is "first sign-in". The link
// flow verifies ada@northwind.example and merges it into her person; that
// verification is the whole basis on which an invite is honoured.
await createInvitation(db, {
	invite_id: 'inv-work',
	org_id: 'orgB',
	email: 'ADA@Northwind.Example', // an admin typed it; matching is case-insensitive
	role: 'editor',
	invited_by: 'boss'
});
await mergePersons(db, 'ada-home', 'ada-work');

const adaIds = await linkedUserIds(db, 'ada-home');
check('the two accounts are one person', adaIds.sort().join(',') === 'ada-home,ada-work');
check(
	'before claiming, Org B is invisible to her',
	JSON.stringify(await brainIds(adaIds)) === JSON.stringify(['platform-org/brain-ada'])
);

const linkClaims = await claimPendingInvites(db, adaIds);
check('the invitation is claimed', linkClaims.length === 1 && linkClaims[0].joins);
check('under the invited address, not the signed-in one', linkClaims[0]?.user_id === 'ada-work');
check(
	"Org B's brain now resolves for the person",
	JSON.stringify(await brainIds(adaIds)) ===
		JSON.stringify(['northwind/brain', 'platform-org/brain-ada'])
);
check(
	'at the invited role',
	(await listAccessibleBrains(db, adaIds)).find((b) => b.id === 'northwind/brain')?.role ===
		'editor'
);
check(
	"the admin's roster no longer shows it pending",
	(await listPendingInvites(db, 'orgB')).length === 0
);
check(
	'and she appears on the roster',
	(await listMembers(db, 'orgB')).some((m) => m.user_id === 'ada-work' && m.role === 'editor')
);
check('claiming again does nothing', (await claimPendingInvites(db, adaIds)).length === 0);

// ---------------------------------------------------------------------------
console.log('\nDefect 2: an existing member can be invited to a second org');
// ---------------------------------------------------------------------------
// This is the case the old `!existing` gate blocked outright: the invited
// address is one the person already signs in with and already holds a
// membership under.
await createInvitation(db, {
	invite_id: 'inv-contoso',
	org_id: 'orgC',
	email: 'ada@personal.example',
	role: 'viewer',
	invited_by: 'boss'
});
const secondOrg = await claimPendingInvites(db, await linkedUserIds(db, 'ada-home'));
check('the invitation is claimed', secondOrg.length === 1 && secondOrg[0].joins);
check(
	'membership is added to the id that already had one elsewhere',
	secondOrg[0]?.user_id === 'ada-home' && secondOrg[0]?.org_id === 'orgC'
);
check(
	'she is now in three orgs',
	(await listMembers(db, 'orgC')).some((m) => m.user_id === 'ada-home')
);

// ---------------------------------------------------------------------------
console.log('\nWhat is NOT claimed');
// ---------------------------------------------------------------------------
sqlite.exec(`
  INSERT INTO invitations (invite_id, org_id, email, role, invited_by, token_hash, invited_at, expires_at, accepted_at) VALUES
    ('inv-expired', 'orgC', 'cy@contoso.example', 'admin', 'boss', '', '2026-01-01', datetime('now', '-1 day'), NULL),
    ('inv-done',    'orgC', 'cy@contoso.example', 'admin', 'boss', '', '2026-01-01', datetime('now', '+30 days'), '2026-02-01');
`);
check('an expired invite is not claimed', (await claimPendingInvites(db, ['cy'])).length === 0);
check(
	'an already-accepted invite is not claimed',
	(await listMembers(db, 'orgC')).every((m) => m.user_id !== 'cy')
);
check('no user ids means no work', (await claimPendingInvites(db, [])).length === 0);

// An invite addressed to someone with no account yet matches nothing, and stays
// pending for their first sign-in.
await createInvitation(db, {
	invite_id: 'inv-stranger',
	org_id: 'orgC',
	email: 'nobody@contoso.example',
	role: 'viewer',
	invited_by: 'boss'
});
check(
	"someone else's invitation is untouched",
	(await claimPendingInvites(db, await linkedUserIds(db, 'ada-home'))).length === 0 &&
		(await listPendingInvites(db, 'orgC')).some((i) => i.invite_id === 'inv-stranger')
);

// ===========================================================================
// 3. provisionOrgForUser: first touch, and the AUTO_PROVISION gate.
// ===========================================================================

console.log('\nprovisionOrgForUser: an invitation is not provisioning');
// A brand-new person, invited to Org B, on a deployment that mints nothing.
await createInvitation(db, {
	invite_id: 'inv-new',
	org_id: 'orgB',
	email: 'new@northwind.example',
	role: 'editor',
	invited_by: 'boss'
});
{
	// Claiming must happen ABOVE the AUTO_PROVISION gate. Below it, this throws.
	let got: Awaited<ReturnType<typeof provisionOrgForUser>> | null = null;
	let msg = '';
	try {
		got = await provisionOrgForUser({
			db,
			user: { user_id: 'new-user', email: 'new@northwind.example', name: 'New' },
			autoProvision: false
		});
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	check(
		'AUTO_PROVISION=false still lands an invitee in their org',
		got?.org.org_id === 'orgB',
		msg
	);
	check('at the invited role', got?.role === 'editor');
	check('on the org-visible brain', got?.brain?.brain_id === 'b-northwind');
}

{
	// Nobody invited this one, and there is nothing to mint them.
	let msg = '';
	try {
		await provisionOrgForUser({
			db,
			user: { user_id: 'stranger', email: 'stranger@example.com', name: null },
			autoProvision: false
		});
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	check('an uninvited person is still turned away', msg.includes('An admin must invite you'));
}

{
	const got = await provisionOrgForUser({
		db,
		user: { user_id: 'fresh', email: 'fresh@example.com', name: null },
		org: 'platform-org',
		installationId: 1,
		autoProvision: true
	});
	check('with AUTO_PROVISION on, an uninvited person gets a personal org', got.role === 'owner');
	check('which holds no brain yet', got.brain === null);
	check('and is a platform-model org', got.org.model === 'platform');
}

console.log('\nprovisionOrgForUser: a member with no brain is told which problem it is');
// Org B holds a brain, so a member who cannot reach any of them has a sharing
// problem, not an empty org.
sqlite.exec(`UPDATE brains SET visibility = 'private' WHERE brain_id = 'b-northwind';`);
sqlite.exec(
	`UPDATE memberships SET role = 'viewer' WHERE org_id = 'orgB' AND user_id = 'new-user';`
);
{
	let msg = '';
	try {
		await provisionOrgForUser({
			db,
			user: { user_id: 'new-user', email: 'new@northwind.example', name: null },
			autoProvision: false
		});
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	check('a viewer, brains exist but none shared → say so', msg.includes('shared with you'));
}
{
	// The same state for someone who can act is the app's create-a-brain screen.
	sqlite.exec(
		`UPDATE memberships SET role = 'editor' WHERE org_id = 'orgB' AND user_id = 'new-user';`
	);
	const got = await provisionOrgForUser({
		db,
		user: { user_id: 'new-user', email: 'new@northwind.example', name: null },
		autoProvision: false
	});
	check('an editor in the same state gets the create state, not an error', got.brain === null);
}
sqlite.exec(`UPDATE brains SET visibility = 'org' WHERE brain_id = 'b-northwind';`);

// Org C holds no brain at all.
await upsertAppUser(db, { user_id: 'cy', email: 'cy@contoso.example', name: 'Cy' });
sqlite.exec(
	`INSERT INTO memberships (org_id, user_id, role, added_at) VALUES ('orgC', 'cy', 'viewer', '2026-04-01');`
);
{
	let msg = '';
	try {
		await provisionOrgForUser({
			db,
			user: { user_id: 'cy', email: 'cy@contoso.example', name: null },
			autoProvision: false
		});
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	check('an empty org and a viewer → ask your admin', msg.includes('no brain configured'));
}

done();
