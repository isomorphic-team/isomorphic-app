// Golden test for the ORG / BRAIN scope boundary: no network.
//
// test-access.ts pins `effectiveBrainRole` and the queries that apply it, i.e. WHO
// can reach a brain and at what role. This test pins the other half: given those two
// roles, WHICH ONE each tool is allowed to gate on.
//
// That is a separate failure mode, and the more dangerous one. `effectiveBrainRole`
// can be perfectly correct while a tool reads the wrong field off the context, and no
// amount of testing the rule will notice. The specific bug this exists to prevent:
// member management once gated on `ctx.role`, which after per-brain access means the
// caller's role ON THE RESOLVED BRAIN. Someone who had a single brain shared with
// them as admin would have passed that check and been able to invite, demote, and
// remove people across the entire organization.
//
// So the invariant is directional, and both directions are asserted:
//
//   ORG-scope tools   (invite/set-role/remove/connect/disconnect) MUST read orgRole.
//   BRAIN-scope tools (read/write/configure/share)                MUST read role.
//
// Method: the real tool handlers are registered against a stub server that just
// captures them, and a fake `getContext` that reproduces exactly what worker.ts does
// (assertRole(ctx.role, requires) and assertRole(ctx.orgRole, requiresOrg)) over a
// real in-memory schema. The handlers, their gates, and their SQL are the real ones;
// only the transport and the identity resolution are stubbed. A handler that stops
// calling getContext, or calls it with the wrong option, fails here.
//
//   pnpm test:scope

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertRole, type Role, type TenantOpts, type AccessibleBrain } from '../src/lib/orgs.ts';
import { registerMemberTools } from '../src/tools/members.ts';
import { registerBrainAccessTools } from '../src/tools/brain-access.ts';
import { registerBrainTools } from '../src/tools/brains.ts';
import { registerAnalyticsTools } from '../src/tools/analytics.ts';
import type { BrainContext } from '../src/tools/librarian.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

// ---------------------------------------------------------------------------
// The schema, real, over node:sqlite shimmed to the D1 surface.
// ---------------------------------------------------------------------------
// Same shim shape as test-access.ts and the e2e batteries. Kept local rather than
// shared so each golden test still runs as one self-contained file.
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../src/db/auth-schema.sql', import.meta.url), 'utf8'));
// The analytics tool reads usage_daily, so the scope test needs its table too.
sqlite.exec(readFileSync(new URL('../migrations/0006_usage_daily.sql', import.meta.url), 'utf8'));
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

sqlite.exec(`
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by)
    VALUES ('org1', 'Northwind', 'customer', 1, 'northwind', 'u-boss');
  INSERT INTO app_users (user_id, email, name) VALUES
    ('u-boss',    'boss@example.com',    'Boss'),
    ('u-shared',  'shared@example.com',  'Shared'),
    ('u-writer',  'writer@example.com',  'Writer'),
    ('u-lurker',  'lurker@example.com',  'Lurker'),
    ('u-spare',   'spare@example.com',   'Spare'),
    ('u-outside', 'outside@example.com', 'Outside');
  INSERT INTO memberships (org_id, user_id, role) VALUES
    ('org1', 'u-boss',   'owner'),
    ('org1', 'u-shared', 'viewer'),
    ('org1', 'u-writer', 'editor'),
    ('org1', 'u-lurker', 'viewer'),
    ('org1', 'u-spare',  'viewer');
  INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at) VALUES
    ('b-main',  'org1', 'northwind', 'main',  'Main',  'private', '2026-01-01'),
    ('b-other', 'org1', 'northwind', 'other', 'Other', 'org',     '2026-02-01');
  INSERT INTO brain_memberships (brain_id, user_id, role) VALUES
    ('b-main', 'u-shared', 'admin'),
    ('b-main', 'u-writer', 'editor');
`);
// u-outside deliberately has an account but NO membership in org1: the "not a member
// of this organization" guardrail needs a real user row to reach.
//
// u-spare is the target for the org-mutation ALLOW cases, which really do mutate this
// database (they run the tools' actual SQL, which is the point). It exists so that
// removing someone to prove an admin CAN remove them does not quietly delete a
// membership a later section depends on, which is exactly what happened when the
// roster tests and the sharing tests shared one victim.

// ---------------------------------------------------------------------------
// Personas: the two roles as an explicit pair.
// ---------------------------------------------------------------------------
// Each is (org role, brain role). `sharedAdmin` is the escalation vector. `orgBoss`
// is its mirror: an org owner holding only VIEWER on this brain is not reachable
// through effectiveBrainRole (the org-admin floor would lift them to admin), and
// that is exactly why it belongs here. It is the only way to prove an org-scope gate
// reads orgRole rather than role, since for every REACHABLE persona an org admin is
// also a brain admin and the two fields agree.
interface Persona {
	label: string;
	userId: string;
	orgRole: Role;
	role: Role;
}
const sharedAdmin: Persona = {
	label: 'org viewer holding brain ADMIN (a brain was shared with them)',
	userId: 'u-shared',
	orgRole: 'viewer',
	role: 'admin'
};
const orgBoss: Persona = {
	label: 'org OWNER holding only brain viewer',
	userId: 'u-boss',
	orgRole: 'owner',
	role: 'viewer'
};
const writer: Persona = {
	label: 'org editor holding brain editor',
	userId: 'u-writer',
	orgRole: 'editor',
	role: 'editor'
};
const lurker: Persona = {
	label: 'org viewer holding brain viewer',
	userId: 'u-lurker',
	orgRole: 'viewer',
	role: 'viewer'
};

// Any octokit call means a handler reached the network on a path that should not.
// Throwing (rather than returning undefined) makes that a loud failure, not a pass.
const octokit = new Proxy(
	{},
	{
		get(_t, prop) {
			throw new Error(`octokit.${String(prop)} reached in a no-network test`);
		}
	}
) as never;

// Same trap for the storage seam, which is where the content tools go now. An
// authorization test must fail BEFORE any of these are touched, so reaching one is
// itself the bug being hunted.
const store = new Proxy(
	{},
	{
		get(_t, prop) {
			throw new Error(`store.${String(prop)} reached in a no-network test`);
		}
	}
) as never;

// The REAL gate, copied in shape from worker.ts's tenantContext: two independent
// assertions against two independent fields. If this test's copy and worker.ts ever
// diverge the test is worthless, so it is deliberately these two lines and nothing
// else: the thing under test is which OPTION each tool passes, not how assertRole works.
function contextFor(p: Persona) {
	return async (opts?: TenantOpts): Promise<BrainContext> => {
		assertRole(p.role, opts?.requires);
		assertRole(p.orgRole, opts?.requiresOrg);
		return {
			octokit,
			store,
			repoArgs: { owner: 'northwind', repo: 'main' },
			role: p.role,
			orgRole: p.orgRole,
			orgId: 'org1',
			actorUserId: p.userId,
			config: {} as never,
			db,
			brainId: 'northwind/main',
			activeBrain: { id: 'northwind/main', label: 'Main' }
		} as BrainContext;
	};
}

// ---------------------------------------------------------------------------
// Register the real tools against a stub server that only captures handlers.
// ---------------------------------------------------------------------------
// registerAppTool delegates to server.registerTool, so one method covers both.
type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content?: unknown }>;
function toolsFor(p: Persona): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, _cfg: unknown, handler: Handler) => handlers.set(name, handler)
	} as never;
	const getContext = contextFor(p);
	registerMemberTools(server, getContext);
	registerBrainAccessTools(server, getContext);
	registerAnalyticsTools(server, getContext);
	registerBrainTools(server, {
		getContext,
		orgContext: async (opts?: { requires?: Role }) => {
			assertRole(p.orgRole, opts?.requires);
			return { octokit, org: {} as never, role: p.orgRole, db, actorUserId: p.userId };
		},
		listBrains: async (): Promise<AccessibleBrain[]> =>
			[
				{ id: 'northwind/main', brain_id: 'b-main', repo_name: 'main', name: 'Main' },
				{ id: 'northwind/other', brain_id: 'b-other', repo_name: 'other', name: 'Other' }
			].map((b) => ({
				...b,
				org_id: 'org1',
				org_name: 'Northwind',
				org_model: 'customer',
				installation_id: 1,
				repo_owner: 'northwind',
				role: p.role,
				org_role: p.orgRole
			})) as AccessibleBrain[],
		activeBrainId: () => 'northwind/main',
		setActiveBrain: () => {},
		invalidateConfig: () => {},
		analyticsEnabled: true
	});
	return handlers;
}

// Invoke a tool as a persona. Returns 'allowed' | 'denied'. Denial is either a thrown
// authorization error (assertRole) or an isError result (an in-handler guard); both
// are refusals, and a test that accepted only one would miss a gate moving between them.
async function attempt(p: Persona, tool: string, args: Record<string, unknown> = {}) {
	const handler = toolsFor(p).get(tool);
	if (!handler) return { outcome: 'missing' as const, detail: `tool ${tool} not registered` };
	try {
		const res = await handler(args);
		return res?.isError
			? { outcome: 'denied' as const, detail: JSON.stringify(res.content) }
			: { outcome: 'allowed' as const, detail: '' };
	} catch (e) {
		return { outcome: 'denied' as const, detail: String(e) };
	}
}
const denies = async (p: Persona, tool: string, args?: Record<string, unknown>) =>
	(await attempt(p, tool, args)).outcome === 'denied';
const allows = async (p: Persona, tool: string, args?: Record<string, unknown>) =>
	(await attempt(p, tool, args)).outcome === 'allowed';

// Aimed at u-spare, never at a user another section asserts on. `remove_member` here
// genuinely deletes the membership row.
const ORG_MUTATIONS: [string, Record<string, unknown>][] = [
	['invite_member', { email: 'newcomer@example.com', role: 'viewer' }],
	['set_member_role', { email: 'spare@example.com', role: 'editor' }],
	['remove_member', { email: 'spare@example.com' }]
];

// ===========================================================================
console.log('\nORG-scope tools gate on the ORG role, never the brain role');
// ===========================================================================
// The regression guard. Every one of these must refuse someone who is admin on a
// brain but only a viewer in the org. If any starts passing, a single brain share
// has become organization-wide power.
for (const [tool, args] of ORG_MUTATIONS) {
	check(`${tool} refuses ${sharedAdmin.label}`, await denies(sharedAdmin, tool, args));
}
check(
	'connect_brain refuses them too (adding a brain to the org is an org act)',
	await denies(sharedAdmin, 'connect_brain', { repo: 'northwind/newrepo' })
);
check(
	'disconnect_brain refuses them too',
	await denies(sharedAdmin, 'disconnect_brain', { brain: 'northwind/other' })
);

// ===========================================================================
console.log('\n...and they admit an org admin who is NOT a brain admin');
// ===========================================================================
// The other direction, and the half that a naive "just use the higher role" fix would
// break. If these ever start failing, an org-scope tool has begun reading `role`.
for (const [tool, args] of ORG_MUTATIONS) {
	const r = await attempt(orgBoss, tool, args);
	check(`${tool} admits ${orgBoss.label}`, r.outcome === 'allowed', r.detail);
}

// ===========================================================================
console.log('\nBRAIN-scope tools gate on the BRAIN role, never the org role');
// ===========================================================================
// The mirror invariant. Sharing is a property of the brain, so the person who was
// given admin ON THE BRAIN can share it even though they are only an org viewer.
check(
	'share_brain admits the brain admin who is only an org viewer',
	await allows(sharedAdmin, 'share_brain', { email: 'lurker@example.com', access: 'viewer' })
);
check(
	'share_brain refuses an org editor who is only a brain editor',
	await denies(writer, 'share_brain', { email: 'lurker@example.com', access: 'viewer' })
);
check(
	'share_brain refuses an org OWNER who holds only viewer on this brain',
	await denies(orgBoss, 'share_brain', { email: 'lurker@example.com', access: 'viewer' })
);

// ===========================================================================
console.log('\nReads stay open to viewers in both scopes');
// ===========================================================================
// Gating is not a licence to over-restrict: the roster and the sharing panel are
// how a viewer finds out who to ask for access.
check('members is readable by a plain org viewer', await allows(lurker, 'members'));
check('brain_access is readable by a plain brain viewer', await allows(lurker, 'brain_access'));

// ===========================================================================
console.log('\nshare_brain guardrails');
// ===========================================================================
// These live in the tool, not in orgs.ts, so test-access.ts cannot see them.
const grantOf = (brainId: string, userId: string) =>
	sqlite
		.prepare(`SELECT role FROM brain_memberships WHERE brain_id = ? AND user_id = ?`)
		.get(brainId, userId) as { role?: string } | undefined;

check(
	'refuses an email with no account at all',
	await denies(sharedAdmin, 'share_brain', { email: 'nobody@example.com', access: 'viewer' })
);
check(
	'refuses someone who has an account but is not in this org',
	await denies(sharedAdmin, 'share_brain', { email: 'outside@example.com', access: 'viewer' })
);
check(
	'...and wrote no grant for them',
	grantOf('b-main', 'u-outside') === undefined,
	'a grant leaked through a rejected share'
);
check(
	'refuses revoking your own access (no self-lockout)',
	await denies(sharedAdmin, 'share_brain', { email: 'shared@example.com', access: 'none' })
);
check(
	"...and the actor's own grant survived the attempt",
	grantOf('b-main', 'u-shared')?.role === 'admin'
);
check(
	'refuses a call that changes nothing (no email, no visibility)',
	await denies(sharedAdmin, 'share_brain', {})
);

// A real grant, end to end through the tool, landing in the real table.
check(
	'a valid share is accepted',
	await allows(sharedAdmin, 'share_brain', { email: 'lurker@example.com', access: 'editor' })
);
check('...and the grant is in brain_memberships', grantOf('b-main', 'u-lurker')?.role === 'editor');
check(
	'revoking that person is accepted',
	await allows(sharedAdmin, 'share_brain', { email: 'lurker@example.com', access: 'none' })
);
check('...and the grant is gone', grantOf('b-main', 'u-lurker') === undefined);

// ===========================================================================
console.log('\nmember-management guardrails (lockout-proofing)');
// ===========================================================================
// Asserted here rather than in test-access.ts for the same reason: they are in the
// tool. Each one is a way an org could be left with nobody able to administer it.
check(
	'you cannot edit your own membership',
	await denies(orgBoss, 'set_member_role', { email: 'boss@example.com', role: 'viewer' })
);
check(
	'you cannot remove yourself',
	await denies(orgBoss, 'remove_member', { email: 'boss@example.com' })
);
check(
	'the owner is not demotable through these tools',
	await denies(orgBoss, 'set_member_role', { email: 'boss@example.com', role: 'admin' })
);

// ===========================================================================
console.log('\nanalytics: the per-person table is gated on the ORG role');
// ===========================================================================
// The same escalation this whole file exists to prevent, in its newest form.
// `analytics` shows org totals to any member, and per-person read/edit counts only
// to org admins. If that inner check ever reads ctx.role instead of ctx.orgRole,
// then being shared ONE brain as admin would expose what every colleague in the
// organization did with their week. That is the members.ts bug with a different
// payload, so it is asserted in both directions here.
//
// It is also asserted on the PAYLOAD, not just on allow/deny: the whole design is
// that a non-admin's rows are never sent, rather than sent and hidden by the
// widget. A regression that shipped the rows and trusted the UI would pass an
// allow/deny check and leak anyway.
async function analyticsPayload(p: Persona) {
	const handler = toolsFor(p).get('analytics');
	if (!handler) throw new Error('analytics not registered');
	const res = (await handler({})) as {
		isError?: boolean;
		structuredContent?: {
			canSeePeople?: boolean;
			people?: unknown[];
			totals?: { members?: number };
		};
	};
	return res.structuredContent ?? {};
}
{
	const shared = await analyticsPayload(sharedAdmin);
	check(
		`${sharedAdmin.label} can open analytics at all`,
		shared.totals?.members !== undefined,
		'org totals are open to any member, like the roster'
	);
	check(
		'brain admin + org viewer is NOT shown the people table',
		shared.canSeePeople === false,
		'gating this on ctx.role would leak the org from a single shared brain'
	);
	check(
		'and the per-person rows are WITHHELD, not merely flagged',
		Array.isArray(shared.people) && shared.people.length === 0,
		'the payload must not carry rows the viewer may not see'
	);

	const boss = await analyticsPayload(orgBoss);
	check(
		`${orgBoss.label} IS shown the people table`,
		boss.canSeePeople === true,
		'an org owner holding only brain viewer must still see it: this is org scope'
	);
	check(
		'and the rows are actually present for them',
		Array.isArray(boss.people) && boss.people.length > 0
	);

	const lurk = await analyticsPayload(lurker);
	check('a plain org viewer sees totals but no people table', lurk.canSeePeople === false);
	check(
		'an org editor is not an admin here either',
		(await analyticsPayload(writer)).canSeePeople === false
	);
}

// ---------------------------------------------------------------------------
if (failures) {
	console.error(`\n${failures} scope check(s) FAILED.`);
	process.exit(1);
}
console.log('\nAll scope checks passed.');
