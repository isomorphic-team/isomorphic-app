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

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

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

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
	listAccessibleBrains,
	getDefaultBrainForUser,
	listBrainAccess,
	setBrainGrant,
	removeBrainGrant,
	setBrainVisibility,
	deleteBrainGrants,
	deleteUserBrainGrantsInOrg
} from '../src/lib/orgs.ts';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../src/db/auth-schema.sql', import.meta.url), 'utf8'));
function shimStatement(sql: string, params: unknown[] = []) {
	return {
		bind: (...p: unknown[]) => shimStatement(sql, p),
		first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
		all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
		run: async () => {
			sqlite.prepare(sql).run(...(params as []));
			return { success: true };
		}
	};
}
const db = { prepare: (sql: string) => shimStatement(sql) } as never;

// One customer org, three people at three org roles, three brains covering each
// access source: grandfathered org-visible, and two private ones owned by
// different people.
sqlite.exec(`
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by)
    VALUES ('org1', 'Northwind', 'customer', 1, 'northwind', 'alice');
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

console.log(
	failures === 0 ? '\nAll access-rule checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
