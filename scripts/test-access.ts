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
import {
	listAccessibleBrains,
	listAccessibleOrgs,
	firstSuspendedOrg,
	resolveOrgForPerson,
	linkedUserIds,
	matchOrg,
	chooseOrg,
	getDefaultBrainForUser,
	listBrainAccess,
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

console.log('\ngetDefaultBrainForUser: never lands someone in a brain they cannot open');
check(
	'viewer lands on the org-visible brain',
	(await getDefaultBrainForUser(db, 'org1', 'carol', 'viewer'))?.brain_id === 'b-legacy'
);
check(
	"editor lands on the oldest brain they can reach, skipping the other person's private one",
	(await getDefaultBrainForUser(db, 'org1', 'bob', 'editor'))?.brain_id === 'b-legacy'
);

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

done();
