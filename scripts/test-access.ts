// Golden test for per-brain access: no network. Two halves:
//
//   1. The RULE (`effectiveBrainRole`), pure: its whole input space.
//   2. The QUERIES that apply it, against the real schema in an in-memory SQLite
//      (node:sqlite, a Node builtin) shimmed to the D1 surface.
//
// `effectiveBrainRole` is the single function deciding whether a caller can reach
// a brain at all and at what role. Everything downstream trusts it:
// listAccessibleBrains admits or drops each row by its verdict, getDefaultBrainForUser
// picks a landing brain with it, listBrainAccess renders the sharing panel from it,
// and tenantContext gates every write on what it returned. A wrong answer here is
// not a bug in a feature, it is someone reading a brain they were never shared.
//
// Half 1 alone would not be enough. The rule is applied by SQL joining brains →
// memberships → brain_memberships, and a wrong column or a dropped LEFT JOIN is an
// access bug no amount of testing the pure function can see, which is why half 2
// runs the real exported functions rather than restating their queries.
//
//   pnpm test:access

import {
	effectiveBrainRole,
	roleAtLeast,
	ASSIGNABLE_BRAIN_ROLES,
	type Role
} from '../src/lib/orgs.ts';
import { commitAuthorFor, githubNoreplyAuthor, validCommitAuthor } from '../src/lib/brain-repo.ts';
import { staticAuth } from '../src/lib/github.ts';
import { platformInstall } from '../src/lib/provision.ts';

import { checker } from './check.ts';

const { check, done } = checker('access-rule checks');

const ORG_ROLES: Role[] = ['viewer', 'editor', 'admin', 'owner'];
const GRANTS: (Role | null)[] = [null, 'viewer', 'editor', 'admin'];

// ---------------------------------------------------------------------------
console.log('\nOrg-visible brain: every member reaches it at their org role');
// ---------------------------------------------------------------------------
// This is the grandfathered path. Every brain that exists TODAY is visibility='org',
// so these cases are literally "nobody loses access when this ships".
for (const orgRole of ORG_ROLES) {
	const got = effectiveBrainRole({ visibility: 'org', orgRole });
	check(`${orgRole} in org → ${orgRole}`, got === orgRole, `got ${got}`);
}

// ---------------------------------------------------------------------------
console.log('\nPrivate brain: invisible without a grant, unless you are an org admin');
// ---------------------------------------------------------------------------
check(
	'viewer, no grant → NO ACCESS',
	effectiveBrainRole({ visibility: 'private', orgRole: 'viewer' }) === null
);
check(
	'editor, no grant → NO ACCESS',
	effectiveBrainRole({ visibility: 'private', orgRole: 'editor' }) === null
);
// The admin override, decided deliberately: an org owner controls the GitHub org
// that holds the repo, so hiding it in-product would be theater, and it stops a
// brain orphaning when the one person it was shared with leaves.
check(
	'org admin, no grant → admin (the override)',
	effectiveBrainRole({ visibility: 'private', orgRole: 'admin' }) === 'admin'
);
check(
	'org owner, no grant → owner (the override)',
	effectiveBrainRole({ visibility: 'private', orgRole: 'owner' }) === 'owner'
);

// ---------------------------------------------------------------------------
console.log('\nA grant lets access into a private brain, at the granted role');
// ---------------------------------------------------------------------------
for (const grant of ASSIGNABLE_BRAIN_ROLES) {
	check(
		`viewer in org + ${grant} grant → ${grant}`,
		effectiveBrainRole({ visibility: 'private', orgRole: 'viewer', grant }) === grant
	);
}
// The case that motivated per-brain roles at all: sharing your brain read-only
// with someone the org already trusts to write elsewhere.
check(
	'org EDITOR shared read-only → viewer (org role does not leak in)',
	effectiveBrainRole({ visibility: 'private', orgRole: 'editor', grant: 'viewer' }) === 'viewer'
);

// ---------------------------------------------------------------------------
console.log('\nResolution is ADDITIVE: a share can raise, never demote');
// ---------------------------------------------------------------------------
// If a grant could lower an effective role, a "share" would become a way to strip
// someone's existing access, and worse, an org admin could be demoted on a brain
// and lose the recovery path. Every combination must be >= what each source alone
// would have given.
for (const visibility of ['org', 'private']) {
	for (const orgRole of ORG_ROLES) {
		for (const grant of GRANTS) {
			const got = effectiveBrainRole({ visibility, orgRole, grant });
			const alone = effectiveBrainRole({ visibility, orgRole });
			const grantAlone = grant ?? null;
			if (alone && got) {
				check(
					`${visibility}/${orgRole}/${grant ?? 'no grant'} never demotes below ${alone}`,
					roleAtLeast(got, alone),
					`got ${got}`
				);
			}
			if (grantAlone && got) {
				check(
					`${visibility}/${orgRole}/${grantAlone} is at least the grant`,
					roleAtLeast(got, grantAlone),
					`got ${got}`
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
console.log('\nAn org viewer stays a viewer: a brain share is not an org promotion');
// ---------------------------------------------------------------------------
// Sharing a brain with someone at `admin` makes them admin OF THAT BRAIN. It must
// not make them an org admin: the org role is a separate axis, and the member
// tools gate on it (TenantOpts.requiresOrg). This test documents the boundary; the
// enforcement is that members.ts reads ctx.orgRole, never ctx.role.
const brainAdminOrgViewer = effectiveBrainRole({
	visibility: 'private',
	orgRole: 'viewer',
	grant: 'admin'
});
check('org viewer + admin grant → admin on the brain', brainAdminOrgViewer === 'admin');
check("...and 'owner' is never a brain role", !ASSIGNABLE_BRAIN_ROLES.includes('owner' as Role));

// ---------------------------------------------------------------------------
console.log('\nUnknown visibility fails OPEN to org-visible');
// ---------------------------------------------------------------------------
// Only the exact string 'private' restricts. A future visibility value (or a row
// written by an older/newer deploy) must degrade to today's behavior rather than
// making a brain unreachable by everyone: an over-restrictive default here means
// a brain nobody, including its owner, can open.
check(
	"unrecognized visibility behaves as 'org'",
	effectiveBrainRole({ visibility: 'team-only', orgRole: 'editor' }) === 'editor'
);
check(
	"empty visibility behaves as 'org'",
	effectiveBrainRole({ visibility: '', orgRole: 'viewer' }) === 'viewer'
);

// ---------------------------------------------------------------------------
console.log('\nNo org role at all: the sources that need a membership are skipped');
// ---------------------------------------------------------------------------
// A caller who holds no membership in the organization that owns a brain. Sources (1)
// org-visibility and (3) the org-admin floor have nobody to apply to, so they
// contribute nothing. Before this was explicit the function returned `undefined` for
// an org-visible brain with a null org role: neither a role nor null, and it only
// failed closed because the caller happened to test `if (!role)`.
for (const visibility of ['org', 'private', 'team-only', '']) {
	check(
		`${visibility || '(empty)'}: no membership, no grant → NO ACCESS`,
		effectiveBrainRole({ visibility, orgRole: null }) === null,
		String(effectiveBrainRole({ visibility, orgRole: null }))
	);
}
check(
	'a grant still works with no membership',
	effectiveBrainRole({ visibility: 'private', orgRole: null, grant: 'editor' }) === 'editor'
);
check(
	"and an org-visible brain does not widen a non-member's grant",
	effectiveBrainRole({ visibility: 'org', orgRole: null, grant: 'viewer' }) === 'viewer'
);
// A non-member is a GUEST, and a guest is capped: admin on a brain is the power to
// decide who reaches it, which stays with the organization's own people. share_brain
// refuses to write the row; this is what makes that refusal an invariant, since a
// row can reach the table by more than one path.
check(
	"a guest's admin grant resolves to editor",
	effectiveBrainRole({ visibility: 'private', orgRole: null, grant: 'admin' }) === 'editor'
);
check(
	"a MEMBER's admin grant is not capped",
	effectiveBrainRole({ visibility: 'private', orgRole: 'viewer', grant: 'admin' }) === 'admin'
);
check(
	'read-only still applies on top of the guest cap',
	effectiveBrainRole({ visibility: 'private', orgRole: null, grant: 'admin', readOnly: true }) ===
		'viewer'
);

// ---------------------------------------------------------------------------
console.log('\nRead-only caps the whole computation');
// ---------------------------------------------------------------------------
// A read-only brain has to be inert to EVERYONE, including the admins of the
// organization holding it. A viewer grant cannot do that: source (3) hands an org
// admin their own role straight back, and an org-visible brain hands every member
// theirs. So the cap is applied last, to whatever the sources produced.
for (const orgRole of ORG_ROLES) {
	check(
		`read-only: org ${orgRole} → viewer`,
		effectiveBrainRole({ visibility: 'org', orgRole, readOnly: true }) === 'viewer'
	);
}
check(
	'read-only: an explicit admin grant is still only viewer',
	effectiveBrainRole({
		visibility: 'private',
		orgRole: 'viewer',
		grant: 'admin',
		readOnly: true
	}) === 'viewer'
);
check(
	'read-only does not CREATE access where there was none',
	effectiveBrainRole({ visibility: 'private', orgRole: null, readOnly: true }) === null
);
check(
	'and is off by default',
	effectiveBrainRole({ visibility: 'org', orgRole: 'owner', readOnly: false }) === 'owner'
);

// ===========================================================================
// The QUERIES that apply the rule, run for real against the real schema.
// ===========================================================================
//
// Everything above pins the pure rule. That is necessary and not sufficient: the
// rule is applied by SQL that joins brains → memberships → brain_memberships, and
// a wrong column or a dropped LEFT JOIN is an access bug the pure test cannot see.
// So the schema is loaded into an in-memory SQLite, shimmed to the D1 surface
// (same shim the e2e batteries use), and the real exported functions are called.
// No network: node:sqlite is a Node builtin.

import { localD1 } from '../src/local/d1-sqlite.ts';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planBrainMove, loadMovePeople, describeMove, moveBrain } from '../src/lib/brain-move.ts';
import { connectCustomerOrg } from '../src/lib/org-connect.ts';
import { ensureStaticTenant, STATIC_USER_ID } from '../src/lib/static-tenant.ts';
import { credentialFor, GITHUB_TOKEN_KIND } from '../src/lib/storage-connections.ts';
import {
	listAccessibleBrains,
	listAccessibleOrgs,
	firstSuspendedOrg,
	resolveOrgForPerson,
	linkedUserIds,
	matchOrg,
	chooseOrg,
	chooseBrain,
	getDefaultBrainForUser,
	listBrainAccess,
	listPendingInvites,
	listPendingBrainInvites,
	createInvitation,
	setBrainGrant,
	removeBrainGrant,
	setBrainVisibility,
	deleteBrainGrants,
	deleteUserBrainGrantsInOrg
} from '../src/lib/orgs.ts';

// Schema comes from the REAL migrations, not src/db/auth-schema.sql, which is
// reference only. This battery pins the access rule, so it is the last place that
// should be asserting against a schema production does not run.
const { db, sqlite } = localD1();

// One customer org, three people at three org roles, three brains covering each
// access source: grandfathered org-visible, and two private ones owned by
// different people.
sqlite.exec(`
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at)
    VALUES ('org1', 'Northwind', 'customer', 1, 'northwind', 'alice', '2026-01-01');
  INSERT INTO app_users (user_id, email, name) VALUES
    ('alice', 'alice@example.com', 'Alice'),
    ('bob',   'bob@example.com',   'Bob'),
    ('carol', 'carol@example.com', 'Carol');
  INSERT INTO memberships (org_id, user_id, role) VALUES
    ('org1', 'alice', 'owner'),
    ('org1', 'bob',   'editor'),
    ('org1', 'carol', 'viewer');
  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at) VALUES
    ('b-legacy',  'org1', 'northwind', 'legacy',  'Legacy',      'org',     '2026-01-01'),
    ('b-alice',   'org1', 'northwind', 'alicep',  'Alice Notes', 'private', '2026-02-01'),
    ('b-bob',     'org1', 'northwind', 'bobp',    'Bob Notes',   'private', '2026-03-01');
  INSERT INTO brain_memberships (brain_id, user_id, role) VALUES
    ('b-alice', 'alice', 'admin'),
    ('b-bob',   'bob',   'admin');
`);

const ids = async (user: string) =>
	(await listAccessibleBrains(db, [user])).map((b) => b.id).sort();
const roleOn = async (user: string, id: string) =>
	(await listAccessibleBrains(db, [user])).find((b) => b.id === id)?.role;

console.log('\nlistAccessibleBrains: the real query');
check(
	'org owner sees all three (admin floor reaches both private brains)',
	JSON.stringify(await ids('alice')) ===
		JSON.stringify(['northwind/alicep', 'northwind/bobp', 'northwind/legacy'])
);
check(
	"org editor sees the org brain + their own, NOT the other person's private brain",
	JSON.stringify(await ids('bob')) === JSON.stringify(['northwind/bobp', 'northwind/legacy'])
);
check(
	'org viewer sees only the org-visible brain',
	JSON.stringify(await ids('carol')) === JSON.stringify(['northwind/legacy'])
);
check('editor is editor on the org brain', (await roleOn('bob', 'northwind/legacy')) === 'editor');
check(
	'editor is admin on their own private brain',
	(await roleOn('bob', 'northwind/bobp')) === 'admin'
);
check(
	'org role rides alongside the brain role',
	(await listAccessibleBrains(db, ['bob'])).every((b) => b.org_role === 'editor')
);

// A GUEST: a grant on a brain in an organization they hold no membership in.
// Reachable only because the query walks grants as well as memberships; it used
// to begin at memberships, and a guest produced no row at all.
console.log('\nlistAccessibleBrains: a guest reaches the one brain and nothing else');
sqlite.exec(`
  INSERT INTO app_users (user_id, email, name) VALUES ('gus', 'gus@client.example', 'Gus');
  INSERT INTO brain_memberships (brain_id, user_id, role, granted_by) VALUES
    ('b-alice', 'gus', 'admin', 'alice');
`);
{
	const gus = await listAccessibleBrains(db, ['gus']);
	check(
		'the shared brain is listed',
		JSON.stringify(gus.map((b) => b.id)) === JSON.stringify(['northwind/alicep']),
		JSON.stringify(gus.map((b) => b.id))
	);
	check('with a null org role, since they are not a member', gus[0]?.org_role === null);
	check('and capped at editor whatever the row says', gus[0]?.role === 'editor');
	check(
		'the org-visible brain is NOT among them: visibility is for members',
		!gus.some((b) => b.id === 'northwind/legacy')
	);
	// A member with a grant reached by both legs folds to one row that keeps the
	// membership: the union must not turn a member into a guest.
	const bob = await listAccessibleBrains(db, ['bob']);
	check(
		"a member's own brain is listed once",
		bob.filter((b) => b.id === 'northwind/bobp').length === 1
	);
	check(
		'...still carrying their org role',
		bob.find((b) => b.id === 'northwind/bobp')?.org_role === 'editor'
	);
}
sqlite.exec(`DELETE FROM brain_memberships WHERE user_id = 'gus'`);

console.log('\ngetDefaultBrainForUser: never lands someone in a brain they cannot open');
check(
	'viewer lands on the org-visible brain',
	(await getDefaultBrainForUser(db, 'org1', 'carol', 'viewer'))?.brain_id === 'b-legacy'
);
check(
	"editor lands on the oldest brain they can reach, skipping the other person's private one",
	(await getDefaultBrainForUser(db, 'org1', 'bob', 'editor'))?.brain_id === 'b-legacy'
);

console.log('\nlifecycle columns through the real query: archived is gone, read-only is viewer');
// archived_at is filtered in SQL (existence, not policy); read_only reaches the rule
// as its ceiling. Both ride the row every consumer already reads, so a wrong column
// name here would surface as an owner writing to a frozen brain, or a retired brain
// still in the switcher.
sqlite.exec(`
  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at, read_only, archived_at) VALUES
    ('b-frozen', 'org1', 'northwind', 'frozen', 'Frozen', 'org', '2026-04-01', 1, NULL),
    ('b-gone',   'org1', 'northwind', 'gone',   'Gone',   'org', '2026-05-01', 0, '2026-06-01');
`);
check(
	'an archived brain is invisible to everyone, the org owner included',
	!(await ids('alice')).includes('northwind/gone'),
	JSON.stringify(await ids('alice'))
);
check(
	'a read-only brain is still listed',
	(await ids('carol')).includes('northwind/frozen'),
	JSON.stringify(await ids('carol'))
);
check(
	'and the org OWNER holds only viewer on it',
	(await roleOn('alice', 'northwind/frozen')) === 'viewer',
	String(await roleOn('alice', 'northwind/frozen'))
);
check(
	'the flag rides on the row so the app can say so',
	(await listAccessibleBrains(db, ['alice'])).find((b) => b.id === 'northwind/frozen')
		?.read_only === true
);
check(
	'getDefaultBrainForUser never lands on an archived brain',
	(await getDefaultBrainForUser(db, 'org1', 'carol', 'viewer'))?.brain_id !== 'b-gone'
);
sqlite.exec(`DELETE FROM brains WHERE brain_id IN ('b-frozen', 'b-gone')`);

console.log('\nshare_brain round trip: grant, change, revoke');
await setBrainGrant(db, {
	brain_id: 'b-alice',
	user_id: 'carol',
	role: 'viewer',
	granted_by: 'alice'
});
check('after sharing, the viewer can reach the private brain', (await ids('carol')).length === 2);
check(
	'...at the granted role, not their org role',
	(await roleOn('carol', 'northwind/alicep')) === 'viewer'
);
await setBrainGrant(db, {
	brain_id: 'b-alice',
	user_id: 'carol',
	role: 'editor',
	granted_by: 'alice'
});
check(
	're-sharing upgrades in place (upsert, not a duplicate row)',
	(await roleOn('carol', 'northwind/alicep')) === 'editor' && (await ids('carol')).length === 2
);
await removeBrainGrant(db, 'b-alice', 'carol');
check('after revoking, the brain disappears again', (await ids('carol')).length === 1);

console.log('\nlistBrainAccess: the sharing panel');
const aliceAccess = await listBrainAccess(db, 'b-alice', 'org1', 'private');
check(
	'a private brain lists only its grantees (plus org admins)',
	aliceAccess.length === 1 && aliceAccess[0].user_id === 'alice'
);
check('...and says HOW they got in', aliceAccess[0].via === 'grant');
const legacyAccess = await listBrainAccess(db, 'b-legacy', 'org1', 'org');
check('an org-visible brain lists every org member', legacyAccess.length === 3);
check(
	'...each at their org role, marked as inherited',
	legacyAccess.every((e) => e.via === 'org') &&
		legacyAccess.find((e) => e.user_id === 'carol')?.role === 'viewer'
);
// The panel shows guests, after members, and says so. `guest` is derived from
// the absence of a membership rather than stored, so the same row reads `grant`
// the day its holder joins the organization.
await setBrainGrant(db, {
	brain_id: 'b-alice',
	user_id: 'gus',
	role: 'editor',
	granted_by: 'alice'
});
{
	const panel = await listBrainAccess(db, 'b-alice', 'org1', 'private');
	const gus = panel.find((e) => e.user_id === 'gus');
	check('a guest appears on the panel', !!gus);
	check(
		'...marked as a guest, at the granted role',
		gus?.via === 'guest' && gus?.role === 'editor'
	);
	check('...after the members', panel.findIndex((e) => e.user_id === 'gus') === panel.length - 1);
	sqlite.exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ('org1', 'gus', 'viewer')`);
	const joined = (await listBrainAccess(db, 'b-alice', 'org1', 'private')).find(
		(e) => e.user_id === 'gus'
	);
	check('the day they join the org, the same row reads as a direct share', joined?.via === 'grant');
	sqlite.exec(`DELETE FROM memberships WHERE user_id = 'gus'`);
	const gone = await listBrainAccess(db, 'b-legacy', 'org1', 'org');
	check(
		'a guest of one brain is not on the panel of another',
		!gone.some((e) => e.user_id === 'gus')
	);
}
sqlite.exec(`DELETE FROM brain_memberships WHERE user_id = 'gus'`);

// A brain invite carries the brain's org_id, so the two pending lists have to
// tell them apart: the roster must not show a member who was never invited to
// join, and the panel must not show the org's own invites.
console.log('\npending invites: a brain invite is on the panel, never on the roster');
await createInvitation(db, {
	invite_id: 'inv-org',
	org_id: 'org1',
	email: 'hire@example.com',
	role: 'editor',
	invited_by: 'alice'
});
await createInvitation(db, {
	invite_id: 'inv-brain',
	org_id: 'org1',
	brain_id: 'b-alice',
	email: 'client@example.com',
	role: 'viewer',
	invited_by: 'alice'
});
{
	const roster = (await listPendingInvites(db, 'org1')).map((i) => i.invite_id);
	check('the roster lists the org invite', roster.includes('inv-org'));
	check('...and NOT the brain invite', !roster.includes('inv-brain'), roster.join(','));
	const panel = (await listPendingBrainInvites(db, 'b-alice')).map((i) => i.invite_id);
	check('the panel lists the brain invite', panel.includes('inv-brain'));
	check('...and NOT the org invite', !panel.includes('inv-org'), panel.join(','));
	check("...nor another brain's", (await listPendingBrainInvites(db, 'b-bob')).length === 0);
}
sqlite.exec(`DELETE FROM invitations WHERE invite_id IN ('inv-org', 'inv-brain')`);

console.log('\nvisibility flip, and grants survive it');
await setBrainVisibility(db, 'b-bob', 'org');
check('going org-visible lets the whole org in', (await ids('carol')).includes('northwind/bobp'));
await setBrainVisibility(db, 'b-bob', 'private');
check('...and going back private shuts it again', !(await ids('carol')).includes('northwind/bobp'));
check(
	"...without dropping the owner's own grant",
	(await roleOn('bob', 'northwind/bobp')) === 'admin'
);

console.log('\nrevocation cleanup: removing someone must actually remove them');
await setBrainGrant(db, {
	brain_id: 'b-alice',
	user_id: 'bob',
	role: 'editor',
	granted_by: 'alice'
});
check('bob is shared in', (await ids('bob')).includes('northwind/alicep'));
await deleteUserBrainGrantsInOrg(db, 'org1', 'bob');
check(
	'removing him from the org drops his per-brain grants too',
	!(await ids('bob')).includes('northwind/alicep')
);
await deleteBrainGrants(db, 'b-bob');
check(
	'disconnecting a brain drops every grant on it',
	sqlite.prepare(`SELECT COUNT(*) AS n FROM brain_memberships WHERE brain_id = 'b-bob'`).get()
		?.n === 0
);

// ---------------------------------------------------------------------------
// Org resolution: which ORGS a person can act in.
// ---------------------------------------------------------------------------
// A different question from listAccessibleBrains, and the reason it needs its own
// query: that one inner-joins `brains`, so an org holding none is invisible to it.
// That is correct for "which brain do I act on" and wrong for "where do I PUT a new
// one", which is the only question asked about an org that has no brains yet.
//
// Dave is one human with two emails: a work identity that owns the brainless org and
// a personal identity that is a viewer in Northwind. Every org query has to see both
// from either, which is what identity linking means.
sqlite.exec(`
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, github_org_login, created_by, created_at)
    VALUES ('org2', 'Contoso Group', 'customer', 2, 'contoso-io', 'contoso-io', 'dave-work', '2026-04-01');
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at, suspended_at)
    VALUES ('org3', 'Dormant', 'customer', 3, 'dormant', 'dave-work', '2026-05-01', '2026-06-01');
  INSERT INTO app_users (user_id, email, name, person_id) VALUES
    ('dave-home', 'dave@example.com',      'Dave', 'p-dave'),
    ('dave-work', 'dave@thelab.example',   'Dave', 'p-dave');
  INSERT INTO app_users (user_id, email, name) VALUES
    ('erin', 'erin@example.com', 'Erin');
  INSERT INTO memberships (org_id, user_id, role) VALUES
    ('org1', 'dave-home', 'viewer'),
    ('org1', 'dave-work', 'admin'),
    ('org2', 'dave-work', 'owner'),
    ('org3', 'dave-work', 'owner'),
    ('org3', 'erin',      'owner');
`);

const orgIds = async (users: string[]) =>
	(await listAccessibleOrgs(db, users)).map((o) => o.org.org_id).sort();

console.log('\nlistAccessibleOrgs: an org with no brains is still somewhere you can act');
check(
	'the brainless org resolves',
	(await orgIds(['dave-work'])).includes('org2'),
	'the first brain in a new org would be unplaceable'
);
check(
	'...while listAccessibleBrains cannot see it at all',
	!(await listAccessibleBrains(db, ['dave-work'])).some((b) => b.org_id === 'org2')
);
check('a suspended org is never offered', !(await orgIds(['dave-work'])).includes('org3'));

// Erin belongs to ONE org and it is suspended, so listAccessibleOrgs returns nothing
// for her and she is indistinguishable from a brand-new user by that call alone.
// orgContext must not read that as "first touch" and provision her a fresh personal
// org: suspension has to keep meaning suspension.
check(
	'someone whose only org is suspended resolves to no orgs',
	(await orgIds(['erin'])).length === 0
);
check(
	'...but is NOT a new user: the suspended org is still findable',
	(await firstSuspendedOrg(db, ['erin']))?.org_id === 'org3',
	'a suspension would auto-provision a replacement org instead of erroring'
);
check(
	'...and someone with a working org reports no suspension',
	(await firstSuspendedOrg(db, ['dave-home'])) === null
);
check(
	'a genuinely new user reports none either',
	(await firstSuspendedOrg(db, ['nobody'])) === null
);

console.log('\n...and it unions across a person’s linked identities');
check(
	'the personal identity alone reaches only Northwind',
	JSON.stringify(await orgIds(['dave-home'])) === JSON.stringify(['org1'])
);
check(
	'the PERSON reaches the work org too',
	JSON.stringify(await orgIds(await linkedUserIds(db, 'dave-home'))) ===
		JSON.stringify(['org1', 'org2'])
);
check(
	'a shared org resolves at the HIGHEST of the two identities’ roles',
	(await listAccessibleOrgs(db, await linkedUserIds(db, 'dave-home'))).find(
		(o) => o.org.org_id === 'org1'
	)?.role === 'admin',
	'the person was demoted to their weaker identity’s role'
);
check(
	'...and each org appears once, not once per identity',
	(await listAccessibleOrgs(db, await linkedUserIds(db, 'dave-home'))).length === 2
);

console.log('\nmatchOrg: naming an org the way a human would');
const daveOrgs = await listAccessibleOrgs(db, await linkedUserIds(db, 'dave-home'));
check('by display name', matchOrg(daveOrgs, 'Contoso Group').org?.org.org_id === 'org2');
check('case-insensitively', matchOrg(daveOrgs, 'contoso group').org?.org.org_id === 'org2');
check('by GitHub owner', matchOrg(daveOrgs, 'contoso-io').org?.org.org_id === 'org2');
check('by substring', matchOrg(daveOrgs, 'ontoso').org?.org.org_id === 'org2');
check('a miss returns neither an org nor candidates', !matchOrg(daveOrgs, 'acme').org);
check('an empty handle never silently picks one', !matchOrg(daveOrgs, '   ').org);

console.log('\nchooseOrg: where a new brain actually gets written');
const threw = (fn: () => unknown) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};
check('a named handle wins', chooseOrg(daveOrgs, { org: 'Contoso Group' }).org.org_id === 'org2');
check(
	'...over the org the caller is working in',
	chooseOrg(daveOrgs, { org: 'Contoso Group', activeOrgId: 'org1' }).org.org_id === 'org2'
);
check(
	'with no handle, the org the caller is working in wins',
	chooseOrg(daveOrgs, { activeOrgId: 'org2' }).org.org_id === 'org2'
);
check(
	'with neither, the first org the query returned',
	chooseOrg(daveOrgs, {}).org.org_id === 'org1'
);
// The stability the old `LIMIT 1` lacked lives in the QUERY's ORDER BY, not in the
// pick, so it is asserted there: chooseOrg only promises to take the head.
check(
	'...and that order is the oldest org first, deterministically',
	JSON.stringify(daveOrgs.map((o) => o.org.org_id)) === JSON.stringify(['org1', 'org2'])
);
check(
	'an active brain in an org the caller lost access to falls back, not throws',
	chooseOrg(daveOrgs, { activeOrgId: 'org-gone' }).org.org_id === 'org1'
);
check(
	'an unmatched handle throws rather than picking one',
	threw(() => chooseOrg(daveOrgs, { org: 'acme' }))
);
check(
	'an AMBIGUOUS handle throws too (never silently takes the first)',
	threw(() => chooseOrg(daveOrgs, { org: 'org' })),
	'"org" is a substring of both org ids and must not resolve'
);
check(
	'no orgs at all throws',
	threw(() => chooseOrg([], {}))
);

console.log('\nchooseBrain: which brain a read or a write actually lands on');
// chooseOrg's twin, and until it was extracted it was the untested half: the same
// ladder sat inline in a private method on McpSession. It decides the target of
// every read and every write, so it gets the same treatment as the org side.
{
	// Alice reaches the org-visible brain and her own private one, oldest first.
	const aliceBrains = await listAccessibleBrains(db, ['alice']);
	const ids = aliceBrains.map((b) => b.id);
	// Three, not two: the org-visible one, her own private one, and Bob's private one,
	// which she reaches through the org-admin floor rather than a grant.
	check('the fixture gives this caller three brains', aliceBrains.length === 3, ids.join(', '));

	check(
		'a named handle wins',
		chooseBrain(aliceBrains, { brain: 'alicep' }).repo_name === 'alicep'
	);
	check(
		'...over the brain the caller is working in',
		chooseBrain(aliceBrains, { brain: 'alicep', activeBrainId: ids[0] }).repo_name === 'alicep'
	);
	check(
		'with no handle, the brain the caller is working in wins',
		chooseBrain(aliceBrains, { activeBrainId: ids[1] }).id === ids[1]
	);
	check(
		'with neither, the first brain the query returned',
		chooseBrain(aliceBrains, {}).id === ids[0]
	);
	// The same fallback chooseOrg has: a stale pointer must not strand the caller.
	check(
		'an active brain the caller lost access to falls back rather than throwing',
		chooseBrain(aliceBrains, { activeBrainId: 'northwind/gone' }).id === ids[0]
	);
	check(
		'an unmatched handle throws rather than picking one',
		threw(() => chooseBrain(aliceBrains, { brain: 'nonexistent' }))
	);
	// The case that matters most: silently taking the first of several would write
	// into a brain the caller did not name.
	check(
		'an AMBIGUOUS handle throws too',
		threw(() => chooseBrain(aliceBrains, { brain: 'northwind' })),
		'the org owns both repos, so the handle cannot pick one'
	);
	check(
		'no brains at all throws',
		threw(() => chooseBrain([], {}))
	);
	// A blank handle THROWS rather than falling through to the active brain. That is
	// the behavior the Worker already had and it matches chooseOrg: a caller who
	// passed a `brain` argument asked for a specific one, and quietly acting on a
	// different brain because their string was empty is the silent-wrong-target case
	// this whole function exists to prevent.
	check(
		'a blank handle throws rather than silently falling back to the active brain',
		threw(() => chooseBrain(aliceBrains, { brain: '   ', activeBrainId: ids[1] }))
	);
}

console.log('\ncommitAuthorFor: how a human edit is attributed in git history');
// Nothing tested this before: it lived inline in McpSession, in two copies, and it
// decides what `git blame` shows for every write a person makes.
check(
	'the app_users row wins, since its address is the verified one',
	commitAuthorFor({ name: 'Ada', email: 'ada@example.com' }, 'token@example.com')?.email ===
		'ada@example.com'
);
check(
	'the token email is the fallback when there is no row yet',
	commitAuthorFor(null, 'token@example.com')?.email === 'token@example.com'
);
check(
	'...and when the row carries no address',
	commitAuthorFor({ name: 'Ada', email: null }, 'token@example.com')?.email === 'token@example.com'
);
check(
	'a person with no name is attributed under their address, not dropped',
	commitAuthorFor({ name: null, email: 'ada@example.com' }, '')?.name === 'ada@example.com'
);
check(
	'no address anywhere means no attribution, so the App authors instead',
	commitAuthorFor(null, '') === undefined
);
check(
	'whitespace is trimmed rather than written into history',
	commitAuthorFor({ name: '  Ada  ', email: '  ada@example.com  ' }, '')?.name === 'Ada'
);
check(
	'a whitespace-only address counts as none',
	commitAuthorFor({ name: 'Ada', email: '   ' }, '   ') === undefined
);

console.log('\ngithubNoreplyAuthor: the GitHub-identity attribution rule');
// The third attribution rule, for the path with no app_users row to read. The format
// is GitHub's canonical noreply form, and getting it wrong is silent: the commit still
// lands, it just attributes to nobody, on every write that identity makes.
check(
	'the canonical <id>+<login>@users.noreply.github.com form',
	githubNoreplyAuthor(1234, 'ada')?.email === '1234+ada@users.noreply.github.com'
);
check('the name is the login', githubNoreplyAuthor(1234, 'ada')?.name === 'ada');
check(
	'no login means no attribution, so the App authors instead',
	githubNoreplyAuthor(1234, null) === undefined
);
check('...and an empty login too', githubNoreplyAuthor(1234, '') === undefined);
check(
	'a whitespace-only login counts as none, never as a blank address',
	githubNoreplyAuthor(1234, '   ') === undefined
);
check(
	'a padded login is trimmed on both sides of the address',
	githubNoreplyAuthor(7, '  ada  ')?.email === '7+ada@users.noreply.github.com'
);

console.log('\nvalidCommitAuthor: WHETHER a computed attribution is usable');
// The guard the other two rules feed into, and the last of the three that had no
// test. It decides whether a commit carries a human at all: createCommit rejects a
// garbage email, and a bad value is worse than falling back to the App author.
check(
	'a well-formed author is kept',
	validCommitAuthor({ name: 'Ada', email: 'ada@example.com' })?.email === 'ada@example.com'
);
check('no author at all is undefined, not a throw', validCommitAuthor(undefined) === undefined);
check(
	'a blank name is refused: git blame on an empty string helps nobody',
	validCommitAuthor({ name: '   ', email: 'ada@example.com' }) === undefined
);
check(
	'an address with no @ is refused rather than sent to createCommit',
	validCommitAuthor({ name: 'Ada', email: 'not-an-email' }) === undefined
);
check(
	'...and one with no dot in the domain',
	validCommitAuthor({ name: 'Ada', email: 'ada@localhost' }) === undefined
);
check(
	'...and one carrying whitespace inside it',
	validCommitAuthor({ name: 'Ada', email: 'ada @example.com' }) === undefined
);
check(
	'both sides are trimmed, so padding never reaches history',
	(() => {
		const a = validCommitAuthor({ name: '  Ada  ', email: '  ada@example.com  ' });
		return a?.name === 'Ada' && a?.email === 'ada@example.com';
	})()
);

// The three rules COMPOSE: the two that decide WHO both hand their answer to this
// one, so a tightening here silently unattributes an entire identity path. These
// two checks are the seam, and they are the reason the guard is worth pinning at
// all rather than merely reading.
check(
	'what commitAuthorFor produces survives the guard',
	validCommitAuthor(commitAuthorFor({ name: 'Ada', email: 'ada@example.com' }, ''))?.name === 'Ada'
);
check(
	'a person with no name is attributed under their address, not dropped',
	validCommitAuthor(commitAuthorFor({ name: null, email: 'ada@example.com' }, ''))?.name ===
		'ada@example.com'
);
check(
	'the GitHub noreply address survives the guard, + and all',
	validCommitAuthor(githubNoreplyAuthor(1234, 'ada'))?.email ===
		'1234+ada@users.noreply.github.com',
	'a stricter email pattern here would silently unattribute every GitHub-identity commit'
);

console.log('\nstaticAuth: what a self-hosted deployment resolves to, or is told');
// AUTH_MODE=static is the documented self-hosting entry point, so these errors are
// the first thing a stranger hits when their config is incomplete.
const REPO = { BRAIN_REPO_OWNER: 'acme', BRAIN_REPO_NAME: 'brain' };
check(
	'a token resolves to the token path',
	staticAuth({ ...REPO, GITHUB_TOKEN: 'ghp_x' }).kind === 'token'
);
check(
	'an installation id resolves to the App path',
	staticAuth({ ...REPO, GITHUB_APP_INSTALLATION_ID: '42' }).kind === 'installation'
);
check(
	'...and parses to a number, not a string',
	(() => {
		const a = staticAuth({ ...REPO, GITHUB_APP_INSTALLATION_ID: '42' });
		return a.kind === 'installation' && a.installationId === 42;
	})()
);
check(
	'the token wins when both are set, being the more specific act',
	staticAuth({ ...REPO, GITHUB_TOKEN: 'ghp_x', GITHUB_APP_INSTALLATION_ID: '42' }).kind === 'token'
);
check(
	'the repo travels with the choice',
	staticAuth({ ...REPO, GITHUB_TOKEN: 'x' }).owner === 'acme'
);
check(
	'no repo named at all is refused, whatever the credential',
	threw(() => staticAuth({ GITHUB_TOKEN: 'ghp_x' }))
);
check(
	'half a repo is refused too',
	threw(() => staticAuth({ BRAIN_REPO_OWNER: 'acme', GITHUB_TOKEN: 'ghp_x' }))
);
check(
	'a repo with no credential is refused',
	threw(() => staticAuth(REPO))
);
// Deliberate improvement over the inline version, which accepted any non-empty
// string here and sent Number('abc') = NaN to GitHub as an installation id.
check(
	'a non-numeric installation id is refused here, not at GitHub',
	threw(() => staticAuth({ ...REPO, GITHUB_APP_INSTALLATION_ID: 'not-a-number' }))
);
check(
	'a whitespace-only credential counts as absent',
	threw(() => staticAuth({ ...REPO, GITHUB_TOKEN: '   ' }))
);

console.log('\nplatformInstall: the config both provisioning paths read');
// The two call sites in the Worker each read these two variables inline and threw
// the same sentence. The copies had drifted on the one thing that matters: the
// GitHub path coerced the id unconditionally, so `Number('abc')` reached
// provisionBrainForUser as NaN and failed later, at GitHub, as an auth problem.
const PLATFORM = { PLATFORM_ORG: 'acme-brains', PLATFORM_INSTALLATION_ID: '99' };
check(
	'a configured platform resolves to its org and installation',
	(() => {
		const p = platformInstall(PLATFORM);
		return p.org === 'acme-brains' && p.installationId === 99;
	})()
);
check(
	'the installation id is a number, not the string it arrives as',
	typeof platformInstall(PLATFORM).installationId === 'number'
);
check(
	'a missing org is refused',
	threw(() => platformInstall({ PLATFORM_INSTALLATION_ID: '99' }))
);
check(
	'a missing installation id is refused',
	threw(() => platformInstall({ PLATFORM_ORG: 'acme-brains' }))
);
check(
	'both errors name both variables, since either one alone is not enough',
	(() => {
		try {
			platformInstall({});
			return false;
		} catch (e) {
			const m = String((e as Error).message);
			return m.includes('PLATFORM_ORG') && m.includes('PLATFORM_INSTALLATION_ID');
		}
	})()
);
check(
	'a whitespace-only value counts as unset rather than as an org named " "',
	threw(() => platformInstall({ PLATFORM_ORG: '   ', PLATFORM_INSTALLATION_ID: '99' }))
);
check(
	'a non-numeric installation id is refused here, not passed on as NaN',
	threw(() => platformInstall({ ...PLATFORM, PLATFORM_INSTALLATION_ID: 'not-a-number' })),
	'this is the defect the two inline copies shared'
);
check(
	'...and that error names the variable and shows what was read',
	(() => {
		try {
			platformInstall({ ...PLATFORM, PLATFORM_INSTALLATION_ID: 'abc' });
			return false;
		} catch (e) {
			const m = String((e as Error).message);
			return m.includes('PLATFORM_INSTALLATION_ID') && m.includes('abc');
		}
	})()
);
check(
	'a fractional id is refused: installation ids are whole numbers',
	threw(() => platformInstall({ ...PLATFORM, PLATFORM_INSTALLATION_ID: '9.5' }))
);
check(
	'zero and negatives are refused rather than sent to GitHub',
	threw(() => platformInstall({ ...PLATFORM, PLATFORM_INSTALLATION_ID: '0' })) &&
		threw(() => platformInstall({ ...PLATFORM, PLATFORM_INSTALLATION_ID: '-3' }))
);
check(
	'surrounding whitespace is tolerated on both, since these come from env files',
	(() => {
		const p = platformInstall({ PLATFORM_ORG: ' acme-brains ', PLATFORM_INSTALLATION_ID: ' 99 ' });
		return p.org === 'acme-brains' && p.installationId === 99;
	})()
);

console.log('\nresolveOrgForPerson: the whole decision, against the real schema');
// This is what the Worker's orgContext calls. It lives here rather than inline in the
// Worker so the empty case is drivable, because empty is where the subtlety is:
// "brand new" and "your only org is suspended" look identical to listAccessibleOrgs
// and must not produce the same outcome.
const threwAsync = async (p: Promise<unknown>) => {
	try {
		await p;
		return false;
	} catch {
		return true;
	}
};
const daveIds = await linkedUserIds(db, 'dave-home');
check(
	'a person with no membership anywhere returns null (the caller provisions)',
	(await resolveOrgForPerson(db, ['nobody'])) === null
);
check(
	'someone whose only org is suspended THROWS instead of returning null',
	await threwAsync(resolveOrgForPerson(db, ['erin'])),
	'a suspension would be provisioned past, replacing their org with a new one'
);
check(
	'a named org resolves across linked identities',
	(await resolveOrgForPerson(db, daveIds, { org: 'Contoso Group' }))?.org.org_id === 'org2'
);
check(
	'an unknown org name throws rather than falling back to a default',
	await threwAsync(resolveOrgForPerson(db, daveIds, { org: 'acme' })),
	'writing into the wrong org is worse than refusing'
);

// The active-org lookup is a real query in the Worker, so it must not run when it
// cannot change the answer. Counting the thunk pins that, and pins that it IS used
// when it can.
let thunkCalls = 0;
const activeOrgId = async () => {
	thunkCalls++;
	return 'org2';
};
check(
	'with no handle, the org the caller is working in wins',
	(await resolveOrgForPerson(db, daveIds, { activeOrgId }))?.org.org_id === 'org2' &&
		thunkCalls === 1
);
thunkCalls = 0;
await resolveOrgForPerson(db, daveIds, { org: 'Contoso Group', activeOrgId });
check('...and is not even asked for when a handle was named', thunkCalls === 0);
thunkCalls = 0;
check(
	'...nor when the person belongs to exactly one org',
	(await resolveOrgForPerson(db, ['dave-home'], { activeOrgId }))?.org.org_id === 'org1' &&
		thunkCalls === 0
);

// ---------------------------------------------------------------------------
// Storage bindings and moving a brain between orgs
// (docs/design/storage-and-tenancy.md). The binding decides which credential
// reads a brain, so it is an access question in the same sense the rule is: a
// wrong installation is a brain that stops opening, or one read through an
// account that was never meant to reach it.

console.log('\nStorage bindings: the migration backfill');
{
	// A database as production had it before 0010, with rows in it, then 0010
	// applied on top. localD1 applies every migration to an EMPTY database, where a
	// backfill has nothing to do and so proves nothing.
	const pre = new DatabaseSync(':memory:');
	const files = readdirSync(fileURLToPath(new URL('../migrations/', import.meta.url)))
		.filter((f) => f.endsWith('.sql'))
		.sort();
	const at = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
	for (const f of files.filter((f) => f < '0010')) pre.exec(at(f));
	pre.exec(`
	  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at) VALUES
	    ('p1', 'a@example.com', 'platform', 100, 'platform-org', 'u', '2026-01-01'),
	    ('p2', 'b@example.com', 'platform', 100, 'platform-org', 'u', '2026-01-02'),
	    ('c1', 'Acme', 'customer', 200, 'acme', 'u', '2026-01-03');
	  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name) VALUES
	    ('bp1', 'p1', 'platform-org', 'brain-a'),
	    ('bc1', 'c1', 'acme', 'wiki');
	`);
	pre.exec(at(files.find((f) => f.startsWith('0010'))!));
	const conns = pre
		.prepare('SELECT connection_id, account, owner_org_id FROM storage_connections ORDER BY 1')
		.all() as { connection_id: string; account: string; owner_org_id: string | null }[];
	check(
		'one connection per installation, however many orgs share it',
		JSON.stringify(conns.map((c) => c.connection_id)) ===
			JSON.stringify(['github-app:100', 'github-app:200'])
	);
	check(
		'the shared platform installation is owned by no org',
		conns.find((c) => c.connection_id === 'github-app:100')?.owner_org_id === null
	);
	check(
		"a customer installation is owned by the customer's org",
		conns.find((c) => c.connection_id === 'github-app:200')?.owner_org_id === 'c1'
	);
	const bound = pre
		.prepare('SELECT brain_id, storage_connection_id FROM brains ORDER BY 1')
		.all() as { brain_id: string; storage_connection_id: string }[];
	check(
		"every existing brain is bound to its org's installation",
		JSON.stringify(bound) ===
			JSON.stringify([
				{ brain_id: 'bc1', storage_connection_id: 'github-app:200' },
				{ brain_id: 'bp1', storage_connection_id: 'github-app:100' }
			])
	);
}

console.log('\nStorage bindings: which credential reads a brain');
{
	const { db, sqlite } = localD1();
	sqlite.exec(`
	  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at) VALUES
	    ('lab', 'The Lab', 'customer', 1, 'lab-gh', 'jo', '2026-01-01'),
	    ('cli', 'Client Co', 'hosted', 9, 'platform-org', 'jo', '2026-01-02');
	  INSERT INTO app_users (user_id, email) VALUES
	    ('jo', 'jo@example.com'), ('li', 'li@example.com'), ('max', 'max@example.com'),
	    ('cy', 'cy@example.com'), ('ed', 'ed@example.com');
	  INSERT INTO memberships (org_id, user_id, role) VALUES
	    ('lab', 'jo', 'owner'), ('lab', 'li', 'admin'), ('lab', 'max', 'editor'),
	    ('cli', 'jo', 'admin'), ('cli', 'cy', 'editor');
	  INSERT INTO storage_connections (connection_id, provider, kind, external_id, account, owner_org_id)
	    VALUES ('github-app:1', 'github', 'github-app-installation', '1', 'lab-gh', 'lab');
	  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at,
	                      storage_connection_id) VALUES
	    ('b-bound',   'lab', 'lab-gh', 'client-wiki', 'Client Wiki', 'private', '2026-02-01', 'github-app:1'),
	    ('b-unbound', 'lab', 'lab-gh', 'client-desk', 'Client Desk', 'org',     '2026-02-02', NULL);
	  INSERT INTO brain_memberships (brain_id, user_id, role) VALUES
	    ('b-bound', 'max', 'admin'), ('b-bound', 'ed', 'viewer');
	  INSERT INTO invitations (invite_id, org_id, email, role, invited_by, token_hash, expires_at,
	                           brain_id, accepted_at) VALUES
	    ('i-open', 'lab', 'new@example.com', 'viewer', 'jo', '', '2099-01-01', 'b-bound', NULL),
	    ('i-done', 'lab', 'old@example.com', 'viewer', 'jo', '', '2099-01-01', 'b-bound', '2026-03-01');
	`);
	const brainFor = async (user: string, brainId: string) =>
		(await listAccessibleBrains(db, [user])).find((b) => b.brain_id === brainId);

	check(
		"a bound brain is read through its binding's installation",
		(await brainFor('jo', 'b-bound'))?.installation_id === 1 &&
			(await brainFor('jo', 'b-bound'))?.storage_account === 'lab-gh'
	);
	check(
		"an unbound brain (written by pre-0010 code) falls back to its org's installation",
		(await brainFor('jo', 'b-unbound'))?.installation_id === 1 &&
			(await brainFor('jo', 'b-unbound'))?.storage_connection_id === null
	);

	console.log('\nMoving a brain: who reaches it afterwards (planBrainMove)');
	const people = await loadMovePeople(db, { brainId: 'b-bound', fromOrgId: 'lab', toOrgId: 'cli' });
	const plan = planBrainMove({ visibility: 'private', readOnly: false, people });
	const of = (u: string) => plan.find((c) => c.user_id === u);
	check(
		'an admin of the org it leaves, with no grant and no place in the new org, loses it',
		of('li')?.outcome === 'loses' && of('li')?.before === 'admin' && of('li')?.after === null
	);
	check(
		'a grant holder who is not in the new org becomes a guest, capped at editor',
		of('max')?.outcome === 'changed' &&
			of('max')?.before === 'admin' &&
			of('max')?.after === 'editor' &&
			of('max')?.afterVia === 'guest'
	);
	check(
		'the caller, admin in both orgs, keeps admin through the org-admin floor',
		of('jo')?.after === 'admin' && of('jo')?.afterVia === 'org-admin'
	);
	check('a member of the new org does NOT gain a private brain', of('cy') === undefined);
	check(
		'a guest with a viewer grant is a guest on both sides: unchanged',
		of('ed')?.outcome === 'unchanged' && of('ed')?.after === 'viewer'
	);
	check('losses sort first, so the preview leads with them', plan[0].outcome === 'loses');
	const orgVisible = planBrainMove({
		visibility: 'org',
		readOnly: false,
		people: await loadMovePeople(db, { brainId: 'b-unbound', fromOrgId: 'lab', toOrgId: 'cli' })
	});
	check(
		'on an org-visible brain, a member of the new org gains it at their org role',
		orgVisible.find((c) => c.user_id === 'cy')?.outcome === 'gains' &&
			orgVisible.find((c) => c.user_id === 'cy')?.after === 'editor'
	);
	check(
		'...and a member of the old org who is not in the new one loses it',
		orgVisible.find((c) => c.user_id === 'max')?.outcome === 'loses'
	);
	check(
		'a read-only brain stays capped at viewer on both sides',
		planBrainMove({ visibility: 'org', readOnly: true, people }).every(
			(c) => !c.after || c.after === 'viewer'
		)
	);

	console.log('\nMoving a brain: the preview (describeMove)');
	const text = describeMove({
		brain: 'Client Wiki',
		from: 'The Lab',
		to: 'Client Co',
		storageAccount: 'lab-gh on GitHub',
		changes: plan,
		pendingInvites: 1
	});
	check(
		'says storage stays where it is, and where that is',
		text.includes('Storage stays where it is: lab-gh on GitHub')
	);
	check('names the guest cap', text.includes('max@example.com: Admin → Editor (guest'));
	check('names the loss', text.includes('li@example.com: Admin → no access'));
	check('says the pending invitation moves', text.includes('1 pending invitation moves with it'));
	check(
		'ends by saying nothing has changed yet',
		text.includes('Nothing has changed yet') && text.trimEnd().endsWith('confirm: true to move it.')
	);

	console.log('\nMoving a brain: the statements (moveBrain)');
	await moveBrain(db, { brainId: 'b-unbound', toOrgId: 'cli', sourceConnectionId: 'github-app:1' });
	check(
		"an unbound brain is pinned to its source org's connection, not left to fall back",
		(await brainFor('jo', 'b-unbound'))?.org_id === 'cli' &&
			(await brainFor('jo', 'b-unbound'))?.installation_id === 1,
		'unpinned, it would resolve through the destination org (installation 9), which cannot reach it'
	);
	await moveBrain(db, { brainId: 'b-bound', toOrgId: 'cli', sourceConnectionId: 'github-app:999' });
	const row = sqlite
		.prepare('SELECT org_id, storage_connection_id FROM brains WHERE brain_id = ?')
		.get('b-bound') as { org_id: string; storage_connection_id: string };
	check(
		'an already-bound brain keeps its binding',
		row.org_id === 'cli' && row.storage_connection_id === 'github-app:1'
	);
	check(
		"...and is read through it, not through its new org's installation",
		(await brainFor('jo', 'b-bound'))?.installation_id === 1 &&
			(await brainFor('jo', 'b-bound'))?.storage_account === 'lab-gh'
	);
	const inv = sqlite
		.prepare('SELECT invite_id, org_id FROM invitations WHERE brain_id = ? ORDER BY 1')
		.all('b-bound') as { invite_id: string; org_id: string }[];
	check(
		'a pending brain invite moves with the brain; an accepted one is history and stays',
		JSON.stringify(inv) ===
			JSON.stringify([
				{ invite_id: 'i-done', org_id: 'lab' },
				{ invite_id: 'i-open', org_id: 'cli' }
			])
	);
	check(
		'grants survive the move: the guest still reaches it, capped',
		(await brainFor('max', 'b-bound'))?.role === 'editor' &&
			(await brainFor('max', 'b-bound'))?.org_role === null
	);
	check(
		"the old org's admin no longer reaches it",
		(await brainFor('li', 'b-bound')) === undefined
	);
}

console.log('\nCreating orgs: a customer org from a GitHub install (connectCustomerOrg)');
{
	const { db, sqlite } = localD1();
	sqlite.exec(`INSERT INTO app_users (user_id, email) VALUES ('ann', 'ann@example.com');`);
	const first = await connectCustomerOrg(db, {
		userId: 'ann',
		installationId: 55,
		orgLogin: 'acme-gh',
		name: 'Acme Corp'
	});
	const org = sqlite
		.prepare('SELECT name, model, brain_owner FROM orgs WHERE org_id = ?')
		.get(first.orgId) as { name: string; model: string; brain_owner: string };
	check(
		'takes the name chosen in create_org, and the GitHub login as its storage account',
		first.created &&
			org.name === 'Acme Corp' &&
			org.model === 'customer' &&
			org.brain_owner === 'acme-gh'
	);
	const conn = sqlite
		.prepare('SELECT owner_org_id, account FROM storage_connections WHERE connection_id = ?')
		.get('github-app:55') as { owner_org_id: string; account: string } | undefined;
	check(
		'owns the connection its installation makes, so it may list and adopt through it',
		conn?.owner_org_id === first.orgId && conn?.account === 'acme-gh'
	);
	const again = await connectCustomerOrg(db, {
		userId: 'ann',
		installationId: 55,
		orgLogin: 'acme-gh',
		name: 'Something Else'
	});
	check(
		're-installing adopts the same org and does not rename it',
		!again.created &&
			again.orgId === first.orgId &&
			(sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get() as { n: number }).n === 1 &&
			(sqlite.prepare('SELECT name FROM orgs').get() as { name: string }).name === 'Acme Corp'
	);
	const bare = await connectCustomerOrg(db, {
		userId: 'ann',
		installationId: 56,
		orgLogin: 'beta-gh'
	});
	check(
		'with no chosen name (an install not started from create_org), it is named after the login',
		(sqlite.prepare('SELECT name FROM orgs WHERE org_id = ?').get(bare.orgId) as { name: string })
			.name === 'beta-gh'
	);
}

console.log('\nA single-user (static) deployment runs the org model (ensureStaticTenant)');
{
	const { db, sqlite } = localD1();
	const count = (t: string) =>
		(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
	const reach = async () => listAccessibleBrains(db, [STATIC_USER_ID]);

	await ensureStaticTenant(db, { owner: 'solo', repo: 'notes', credential: { kind: 'token' } });
	const [b] = await reach();
	check(
		'the operator reaches exactly the configured brain, as owner',
		(await reach()).length === 1 &&
			b?.id === 'solo/notes' &&
			b.role === 'owner' &&
			b.org_role === 'owner'
	);
	check(
		'it is read through the token, not an installation',
		credentialFor(b).kind === 'token' && b.storage_kind === GITHUB_TOKEN_KIND
	);
	const secretFree = sqlite
		.prepare('SELECT external_id FROM storage_connections WHERE connection_id = ?')
		.get('github-token:env') as { external_id: string };
	check(
		'the connection names where the token lives and never holds it',
		secretFree.external_id === 'env'
	);

	await ensureStaticTenant(db, { owner: 'solo', repo: 'notes', credential: { kind: 'token' } });
	check(
		'writing it again changes nothing: one org, one member, one brain',
		count('orgs') === 1 && count('memberships') === 1 && count('brains') === 1
	);

	await ensureStaticTenant(db, {
		owner: 'solo',
		repo: 'journal',
		credential: { kind: 'installation', installationId: 42 }
	});
	const after = await reach();
	check(
		'config is the truth: a new repo REPLACES the old brain rather than sitting beside it',
		after.length === 1 && after[0].id === 'solo/journal',
		after.map((x) => x.id).join()
	);
	const cred = credentialFor(after[0]);
	check(
		'...and a new credential is picked up: now the App installation',
		cred.kind === 'installation' && cred.installationId === 42
	);

	// A database that already had a row for the repo (an oauth deployment turned
	// single-user, say): the unique (owner, repo) constraint must not fail the batch.
	const { db: db2, sqlite: sqlite2 } = localD1();
	sqlite2.exec(`
	  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by)
	    VALUES ('old', 'Old', 'customer', 5, 'solo', 'x');
	  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name) VALUES ('b-legacy-id', 'old', 'solo', 'notes');
	`);
	let adopted = true;
	try {
		await ensureStaticTenant(db2, { owner: 'solo', repo: 'notes', credential: { kind: 'token' } });
	} catch {
		adopted = false;
	}
	const reached = await listAccessibleBrains(db2, [STATIC_USER_ID]);
	check(
		'an existing row for the configured repo is adopted, not a constraint failure',
		adopted && reached.length === 1 && reached[0].brain_id === 'b-legacy-id'
	);
}

console.log('\ncredentialFor: which credential reads a brain');
check(
	'no binding (written before migration 0010): the org installation, as before',
	JSON.stringify(credentialFor({ storage_kind: null, installation_id: 7 })) ===
		JSON.stringify({ kind: 'installation', installationId: 7 })
);
check(
	'an installation binding: that installation',
	JSON.stringify(credentialFor({ storage_kind: 'github-app-installation', installation_id: 9 })) ===
		JSON.stringify({ kind: 'installation', installationId: 9 })
);
check(
	'a token binding: the token, whatever installation id the row carries',
	credentialFor({ storage_kind: 'github-token', installation_id: 0 }).kind === 'token'
);

done();
