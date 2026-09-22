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

import { readFileSync, readdirSync } from 'node:fs';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { assertRole, type Role, type TenantOpts, type AccessibleBrain } from '../src/lib/orgs.ts';
import { registerMemberTools } from '../src/tools/members.ts';
import { registerBrainAccessTools } from '../src/tools/brain-access.ts';
import { registerMediaTools } from '../src/tools/media.ts';
import { DEFAULT_BRAIN_CONFIG } from '../src/lib/brain-policy.ts';
import { registerBrainTools } from '../src/tools/brains.ts';
import { registerAnalyticsTools } from '../src/tools/analytics.ts';
import { registerOrgOnboardingTools, type OrgOnboardingEnv } from '../src/tools/org-onboarding.ts';
import { registerLibrarianTools, type BrainContext } from '../src/tools/librarian.ts';

import { checker } from './check.ts';

const { check, done } = checker('scope checks');

// ---------------------------------------------------------------------------
// The schema, real, over node:sqlite shimmed to the D1 surface.
// ---------------------------------------------------------------------------
// localD1() rather than a copy of the shim. This file used to carry its own, on
// the grounds that a golden test should run as one self-contained file, and the
// cost of that showed up: the copies drifted, and the one that omitted
// `meta.changes` made the write-dedupe ledger report a fresh write as already in
// flight. A battery is still self-contained in what it ASSERTS; the D1 surface it
// asserts against is not the part worth re-deriving per file. test-index.ts keeps
// its own because it instruments the shim to count statements and batches, which
// is that battery's whole subject.
//
// The schema comes from the real migrations, not from src/db/auth-schema.sql,
// which is reference only. This battery pins the authorization model, so it is
// the last place that should assert against a schema production does not run.
const { db, sqlite } = localD1();

sqlite.exec(`
  INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by) VALUES
    ('org1', 'Northwind',     'customer', 1, 'northwind',    'u-boss'),
    ('org2', 'Contoso Group', 'customer', 2, 'contoso-io',   'u-boss'),
    ('org3', 'Hosted Co',     'hosted',   9, 'platform-org', 'u-boss');
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
	// NULL for a caller who holds no membership in the organization that owns the
	// brain they reached. Distinct from 'viewer' on purpose, and that distinction is
	// the whole reason the field is nullable: the org roster and the per-person
	// analytics table are precisely what someone from outside must never see, and
	// "not a member" has to be a different answer from "a member with few powers".
	orgRole: Role | null;
	role: Role;
	// A different role in a NAMED org, for the one tool that acts in two orgs at once
	// (update_brain's move). Absent: the persona holds `orgRole` wherever they look.
	orgRoleIn?: Record<string, Role>;
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
// Reaches the brain at editor with NO role in the organization that owns it. This is
// the shape no test exercised before org roles could be absent, and the one where an
// accidental pass reads as a permissions bug rather than as a leak.
const outsider: Persona = {
	label: 'an outsider: editor on this brain, not a member of its organization',
	userId: 'u-outside',
	orgRole: null,
	role: 'editor'
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
// Which brain each context resolution named. A resolution is not free (in the
// Worker it mints an installation token and reads the brain's config), so a tool
// that resolves one for a brain it did not need to has a cost no role assertion sees.
const brainAsks: (string | undefined)[] = [];

function contextFor(p: Persona) {
	return async (opts?: TenantOpts): Promise<BrainContext> => {
		brainAsks.push(opts?.brain);
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
			// The real default config, not an empty object: the content tools run path
			// predicates against it, and roleOf on a config with no paths throws — which
			// would read as a denial and quietly turn a real gate test into a no-op.
			config: DEFAULT_BRAIN_CONFIG,
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
type Handler = (
	args: Record<string, unknown>
) => Promise<{ isError?: boolean; content?: unknown; structuredContent?: unknown }>;

// What each org-scope resolution was asked for. The `org` argument only does anything
// if the tool actually forwards it. A tool that accepts it and drops it silently
// writes into the wrong organization, which no role assertion would catch.
const orgAsks: ({ requires?: Role; org?: string } | undefined)[] = [];

// Every write to the active-brain pointer the brain tools made. Only an explicit act
// may move it (see the last section), so most calls must leave this empty.
const moves: string[] = [];

// Each tool's registration config, for the checks that read `_meta` rather than call.
const configs = new Map<string, Record<string, unknown>>();

// What orgContext resolves a named `org` to. Every persona is placed at their one
// org role in whichever org they name, which is what the gate tests need: whether a
// tool ASKS for the right role, not how membership is looked up (test:access).
// `Hosted Co` stores its brains on the platform's shared installation.
const ORG_ROWS: Record<
	string,
	{
		org_id: string;
		name: string;
		model: string;
		installation_id: number;
		brain_owner: string;
		github_org_login: string | null;
	}
> = {
	Northwind: {
		org_id: 'org1',
		name: 'Northwind',
		model: 'customer',
		installation_id: 1,
		brain_owner: 'northwind',
		github_org_login: 'northwind'
	},
	'Contoso Group': {
		org_id: 'org2',
		name: 'Contoso Group',
		model: 'customer',
		installation_id: 2,
		brain_owner: 'contoso-io',
		github_org_login: 'contoso-io'
	},
	'Hosted Co': {
		org_id: 'org3',
		name: 'Hosted Co',
		model: 'hosted',
		installation_id: 9,
		brain_owner: 'platform-org',
		github_org_login: null
	}
};

// What create_org sees of the Worker's env. Mutable so a test can turn
// AUTO_PROVISION off; `kvPuts` records what the GitHub path stashed.
const kvPuts: { key: string; value: string }[] = [];
const onboardingEnv: OrgOnboardingEnv = {
	OAUTH_KV: {
		put: async (key: string, value: string) => {
			kvPuts.push({ key, value });
		}
	} as OrgOnboardingEnv['OAUTH_KV'],
	GITHUB_APP_SLUG: 'isomorphic-test',
	AUTO_PROVISION: 'true',
	PLATFORM_ORG: 'platform-org',
	PLATFORM_INSTALLATION_ID: '9'
};

function toolsFor(
	p: Persona,
	deployment: { webBaseUrl?: string } = { webBaseUrl: 'https://brain.example' }
): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, cfg: unknown, handler: Handler) => {
			configs.set(name, cfg as Record<string, unknown>);
			handlers.set(name, handler);
		}
	} as never;
	const getContext = contextFor(p);
	registerMemberTools(server, getContext);
	registerBrainAccessTools(server, getContext, { webBaseUrl: deployment.webBaseUrl });
	registerMediaTools(server, getContext);
	registerAnalyticsTools(server, getContext);
	registerLibrarianTools(server, getContext);
	const orgContext = async (opts?: { requires?: Role; org?: string }) => {
		orgAsks.push(opts);
		const orgRole = (opts?.org && p.orgRoleIn?.[opts.org]) || p.orgRole;
		assertRole(orgRole, opts?.requires);
		// assertRole threw for a null above when a role was required; an org-scope
		// call with no requirement from a non-member is not a shape any tool makes.
		if (!orgRole) throw new Error('not a member of any organization');
		return {
			octokit,
			org: {
				created_by: 'u-boss',
				created_at: '2026-01-01',
				suspended_at: null,
				...(ORG_ROWS[opts?.org ?? ''] ?? ORG_ROWS.Northwind)
			},
			role: orgRole,
			db,
			actorUserId: p.userId
		};
	};
	// Two orgs, one of which holds no brain at all: the case the brains payload has
	// to carry, since the widget cannot derive it from a list of brains.
	// A non-member belongs to no organization, so the list is empty rather than a
	// list carrying a null role.
	const listOrgs = async () =>
		(p.orgRole
			? [
					{ org_id: 'org1', name: 'Northwind', brain_owner: 'northwind' },
					{ org_id: 'org2', name: 'Contoso Group', brain_owner: 'contoso-io' }
				]
			: []
		).map((o) => ({
			role: p.orgRole as Role,
			org: {
				...o,
				model: 'customer',
				installation_id: 1,
				github_org_login: o.brain_owner,
				created_by: 'u-boss',
				created_at: '2026-01-01',
				suspended_at: null
			}
		}));
	registerOrgOnboardingTools(server, orgContext, listOrgs, onboardingEnv);
	registerBrainTools(server, {
		getContext,
		orgContext,
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
				storage_account: 'northwind',
				storage_connection_id: null,
				visibility: b.brain_id === 'b-main' ? 'private' : 'org',
				repo_owner: 'northwind',
				role: p.role,
				org_role: p.orgRole
			})) as AccessibleBrain[],
		listOrgs,
		activeBrainId: () => 'northwind/main',
		setActiveBrain: async (id) => {
			moves.push(id);
		},
		invalidateConfig: () => {},
		analyticsEnabled: true,
		db,
		webBaseUrl: deployment.webBaseUrl
	});
	return handlers;
}

// Invoke a tool as a persona. Returns 'allowed' | 'denied'. Denial is either a thrown
// authorization error (assertRole) or an isError result (an in-handler guard); both
// are refusals, and a test that accepted only one would miss a gate moving between them.
async function attempt(p: Persona, tool: string, args: Record<string, unknown> = {}) {
	const handler = toolsFor(p).get(tool);
	if (!handler) {
		return { outcome: 'missing' as const, detail: `tool ${tool} not registered`, text: '', sc: {} };
	}
	try {
		const res = await handler(args);
		const content = (res?.content ?? []) as { type?: string; text?: string }[];
		const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
		const sc = (res?.structuredContent ?? {}) as Record<string, unknown>;
		return res?.isError
			? { outcome: 'denied' as const, detail: JSON.stringify(res.content), text, sc }
			: { outcome: 'allowed' as const, detail: '', text, sc };
	} catch (e) {
		return { outcome: 'denied' as const, detail: String(e), text: '', sc: {} };
	}
}
const denies = async (p: Persona, tool: string, args?: Record<string, unknown>) =>
	(await attempt(p, tool, args)).outcome === 'denied';
const allows = async (p: Persona, tool: string, args?: Record<string, unknown>) =>
	(await attempt(p, tool, args)).outcome === 'allowed';

// The content tools run against the store, which this file replaces with a proxy that
// throws on contact. So "reached the store" IS the signal that the gate admitted the
// caller: it got past authorization and every in-handler guard, and died on the one
// thing a no-network test refuses to provide. Asserting on that marker keeps the
// admit direction real, rather than settling for only testing refusals.
const STORE_MARKER = 'reached in a no-network test';
async function passesGate(p: Persona, tool: string, args: Record<string, unknown> = {}) {
	const r = await attempt(p, tool, args);
	return r.outcome === 'allowed' || r.detail.includes(STORE_MARKER);
}

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
console.log('\nThe `org` argument reaches org-scope resolution');
// ===========================================================================
// Both tools that place a brain must resolve the org the CALLER named. Neither can
// route through a brain handle: the org waiting for its first repo has no brain to
// name, which is precisely the org someone is trying to connect one into. Asserted on
// what resolution was ASKED for, since the stub short-circuits before any write.
// The last thing orgContext was asked for, after running one tool call.
async function askFrom(tool: string, args: Record<string, unknown>) {
	orgAsks.length = 0;
	await attempt(orgBoss, tool, args);
	return orgAsks.at(-1);
}

const connectAsk = await askFrom('connect_brain', {
	repo: 'northwind/newrepo',
	org: 'Contoso Group'
});
check(
	'connect_brain forwards `org` to orgContext',
	connectAsk?.org === 'Contoso Group',
	`got ${JSON.stringify(connectAsk)}`
);
check('...and still gates it at admin', connectAsk?.requires === 'admin');

const createAsk = await askFrom('create_brain', { name: 'Scratch', org: 'Contoso Group' });
check(
	'create_brain forwards `org` to orgContext',
	createAsk?.org === 'Contoso Group',
	`got ${JSON.stringify(createAsk)}`
);
check('...and still gates it at editor', createAsk?.requires === 'editor');

const bareAsk = await askFrom('create_brain', { name: 'Scratch' });
check(
	'omitting `org` leaves the choice to resolution rather than forcing one',
	bareAsk !== undefined && bareAsk.org === undefined
);

// The widget's org picker reads this and cannot compute it: an org with no brains has
// no brain row to derive it from, so if the payload drops it the "connect a repo" flow
// silently loses exactly the org someone is trying to connect their first repo into.
const brainsPayload = (await toolsFor(orgBoss).get('brains')!({})) as {
	structuredContent?: { orgs?: { orgId: string }[] };
};
check(
	'the brains payload carries the orgs a brain can be added to',
	JSON.stringify(brainsPayload.structuredContent?.orgs?.map((o) => o.orgId)) ===
		JSON.stringify(['org1', 'org2']),
	`got ${JSON.stringify(brainsPayload.structuredContent?.orgs)}`
);
const viewerPayload = (await toolsFor(lurker).get('brains')!({})) as {
	structuredContent?: { orgs?: unknown[] };
};
check(
	'...and offers none to someone who admins no org',
	viewerPayload.structuredContent?.orgs?.length === 0,
	'a picker that offers an org the click would refuse'
);
// The web base rides on the same payload, for the same reason as `analytics`: the
// widget cannot ask what the server serves. Present exactly when the deployment
// supplied one; a deployment without a web app must not hand out a base for a
// route it does not mount.
{
	const features = (brainsPayload.structuredContent as { features?: { webBase?: string } })
		?.features;
	check(
		'the brains payload carries the web base when the deployment has one',
		features?.webBase === 'https://brain.example',
		`got ${JSON.stringify(features)}`
	);
	const without = (await toolsFor(orgBoss, { webBaseUrl: undefined }).get('brains')!({})) as {
		structuredContent?: { features?: { webBase?: string } };
	};
	check(
		'...and none when it has none',
		without.structuredContent?.features !== undefined &&
			!('webBase' in without.structuredContent.features),
		`got ${JSON.stringify(without.structuredContent?.features)}`
	);
}

// `brains` runs on every widget open and checks every manageable brain for "connected
// but not configured". A CONFIGURED brain must cost nothing: resolving its context
// mints a token and reads its config, and the freshness check behind that reached
// GitHub per brain and reindexed inline, which on an account with several brains was
// a 17-second call that Anthropic's edge cut off as a 502 (issues #50, #85). One
// indexed row is the whole answer.
console.log('\nbrains answers a configured brain from the index alone');
{
	sqlite
		.prepare(
			`INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)`
		)
		.run('northwind/main', 'wiki/index.md', 'Index', 'sha', '# Index');
	brainAsks.length = 0;
	await toolsFor(orgBoss).get('brains')!({});
	check(
		'a brain with an indexed page resolves no context at all',
		!brainAsks.includes('northwind/main'),
		`asked for: ${JSON.stringify(brainAsks)}`
	);
	check(
		'a brain with an empty index still does, since "no pages" may mean "not indexed yet"',
		brainAsks.includes('northwind/other'),
		`asked for: ${JSON.stringify(brainAsks)}`
	);
	sqlite.prepare(`DELETE FROM brain_pages WHERE brain_id = ?`).run('northwind/main');
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
console.log('\nContent writes gate on the BRAIN role, at editor');
// ===========================================================================
// Writing a page is a property of the brain, so an ORG owner who holds only viewer
// on this brain must be refused, and someone shared the brain as editor must not be.
// The refusals are asserted on the gate's own MESSAGE rather than on the verdict,
// because these tools have in-handler guards too and "denied" alone cannot tell a
// working gate from a path check that happened to reject the same call.
const CONTENT_WRITES: [string, Record<string, unknown>][] = [
	['write_page', { path: 'wiki/a.md', fields: { done: 'yes' } }],
	['move_page', { path: 'wiki/a.md', new_path: 'wiki/b.md' }],
	['delete_page', { path: 'wiki/a.md' }]
];
const gated = (detail: string) => /requires editor access/.test(detail);
for (const [tool, args] of CONTENT_WRITES) {
	const viewer = await attempt(lurker, tool, args);
	check(`${tool} refuses a brain viewer at the gate`, gated(viewer.detail), viewer.detail);
	const boss = await attempt(orgBoss, tool, args);
	check(`${tool} refuses an org OWNER who is only a brain viewer`, gated(boss.detail), boss.detail);
	check(
		`${tool} admits a brain editor (it reaches the store)`,
		await passesGate(writer, tool, args)
	);
	// The share_brain mirror: content is a brain act, so a brain admin does it even
	// as an org viewer.
	check(
		`${tool} admits a brain admin who is only an org viewer`,
		await passesGate(sharedAdmin, tool, args)
	);
}
// A bad patch must not be the thing that stops an unauthorized caller: authorization
// has to come first, or the error text tells a stranger which keys the page carries.
{
	const r = await attempt(lurker, 'write_page', { path: 'wiki/a.md', fields: { title: 'x' } });
	check('write_page checks the role before it validates the patch', gated(r.detail), r.detail);
}

// ===========================================================================
console.log('\nAttachments: writing needs editor, reading does not');
// ===========================================================================
// A 1x1 PNG, so attach_media gets past validateAttachment and actually reaches its
// gate rather than failing on the payload.
const PNG_1PX =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ATTACH_ARGS = {
	data: PNG_1PX,
	filename: 'logo.png',
	mime_type: 'image/png',
	page: 'wiki/vendors/acme.md'
};

check(
	'attach_media refuses a plain viewer',
	(await denies(lurker, 'attach_media', ATTACH_ARGS)) &&
		!(await passesGate(lurker, 'attach_media', ATTACH_ARGS))
);
check('attach_media admits an editor', await passesGate(writer, 'attach_media', ATTACH_ARGS));
// The mirror of the share_brain invariant: uploading is a brain act, so the brain
// admin does it even as an org viewer, and org rank alone does not confer it.
check(
	'attach_media admits a brain admin who is only an org viewer',
	await passesGate(sharedAdmin, 'attach_media', ATTACH_ARGS)
);
check(
	'attach_media refuses an org OWNER who holds only viewer on this brain',
	!(await passesGate(orgBoss, 'attach_media', ATTACH_ARGS))
);
// Reading an attachment is a read: gating it on editor would mean a viewer could
// open a page and see a broken image on it.
check(
	'read_media is open to a plain viewer',
	await passesGate(lurker, 'read_media', { path: 'wiki/vendors/assets/logo.png' })
);
// And it must not serve anything outside the brain's content, whatever the role.
check(
	'read_media refuses a path outside the content roots',
	await denies(sharedAdmin, 'read_media', { path: 'raw/secret.png' })
);
check(
	'read_media refuses a non-media path rather than guessing',
	await denies(sharedAdmin, 'read_media', { path: 'wiki/vendors/acme.md' })
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

const inviteOf = (brainId: string, email: string) =>
	sqlite
		.prepare(
			`SELECT role, org_id FROM invitations
			  WHERE brain_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL`
		)
		.get(brainId, email) as { role?: string; org_id?: string } | undefined;
const memberOf = (orgId: string, userId: string) =>
	sqlite
		.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`)
		.get(orgId, userId);

// GUESTS (docs/design/guest-access.md). Someone outside the organization is shared
// ONE brain: an account gets a grant, an unknown address gets a brain invite, and
// neither path ever writes a membership, which is what keeps a share from widening
// what they reach beyond the brain. Admin is refused for them in both paths.
check(
	'shares with someone who has an account but is not in this org (a guest)',
	await allows(sharedAdmin, 'share_brain', { email: 'outside@example.com', access: 'viewer' })
);
check('...writing a grant', grantOf('b-main', 'u-outside')?.role === 'viewer');
check(
	'...and NO membership',
	memberOf('org1', 'u-outside') === undefined,
	'a share to an outsider made them a member'
);
check(
	'refuses admin for a guest',
	await denies(sharedAdmin, 'share_brain', { email: 'outside@example.com', access: 'admin' })
);
check(
	'...leaving their grant where it was',
	grantOf('b-main', 'u-outside')?.role === 'viewer',
	'a refused admin share changed the row'
);
check(
	'the refusal says why',
	(
		await attempt(sharedAdmin, 'share_brain', { email: 'outside@example.com', access: 'admin' })
	).detail.includes('guest')
);
check(
	'revoking a guest is accepted',
	await allows(sharedAdmin, 'share_brain', { email: 'outside@example.com', access: 'none' })
);
check('...and the grant is gone', grantOf('b-main', 'u-outside') === undefined);

check(
	'an address with no account is INVITED to the brain',
	await allows(sharedAdmin, 'share_brain', { email: 'Nobody@Example.com', access: 'editor' })
);
check(
	"...as a brain invite in the brain's own org",
	inviteOf('b-main', 'nobody@example.com')?.role === 'editor' &&
		inviteOf('b-main', 'nobody@example.com')?.org_id === 'org1'
);
check(
	'...and the panel payload carries it as evidence',
	(
		(await attempt(sharedAdmin, 'brain_access', {})).sc as { invites?: { email: string }[] }
	).invites?.some((i) => i.email.toLowerCase() === 'nobody@example.com') === true
);
check(
	'...while the org roster does not list it as a pending member',
	!(
		(await attempt(sharedAdmin, 'members', {})).sc as { invites?: { email: string }[] }
	).invites?.some((i) => i.email === 'nobody@example.com')
);
check(
	'refuses admin for an address with no account too',
	await denies(sharedAdmin, 'share_brain', { email: 'nobody2@example.com', access: 'admin' })
);
check('...and wrote no invite', inviteOf('b-main', 'nobody2@example.com') === undefined);
check(
	'the reply tells the sharer where the guest signs in',
	// The one URL in the reply, compared whole rather than searched for as a
	// substring, which CodeQL reads as an allow-list check and flags.
	/https?:\/\/\S+/.exec(
		(await attempt(sharedAdmin, 'share_brain', { email: 'nobody3@example.com', access: 'viewer' }))
			.text
	)?.[0] === 'https://brain.example/b/northwind/main'
);
check(
	'revoking an invited address cancels the invite',
	await allows(sharedAdmin, 'share_brain', { email: 'nobody@example.com', access: 'none' })
);
check('...and it is gone', inviteOf('b-main', 'nobody@example.com') === undefined);
check(
	'...from the panel too',
	!(
		(await attempt(sharedAdmin, 'brain_access', {})).sc as { invites?: { email: string }[] }
	).invites?.some((i) => i.email.toLowerCase() === 'nobody@example.com')
);
check(
	'the invite rides the ordinary share gate: a brain editor cannot send one',
	await denies(writer, 'share_brain', { email: 'nobody4@example.com', access: 'viewer' })
);
sqlite.exec(`DELETE FROM invitations WHERE brain_id = 'b-main'`);
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
console.log('\nAN OUTSIDER reaches the brain and nothing around it');
// ---------------------------------------------------------------------------
// Someone from another organization can resolve a brain, and everything ORG-scope
// hanging off that brain must still refuse them. Every one of these gates reads
// ctx.orgRole, which is null for them.
{
	const denials = [
		['members', {}],
		['invite_member', { email: 'x@example.com', role: 'viewer' }],
		['set_member_role', { email: 'lurker@example.com', role: 'admin' }],
		['remove_member', { email: 'lurker@example.com' }]
	] as const;
	for (const [tool, args] of denials) {
		const r = await attempt(outsider, tool, args as Record<string, unknown>);
		check(`${tool} refuses them`, r.outcome === 'denied', `${r.outcome}: ${r.detail}`);
		// The message has to SAY they are not a member. Before assertRole took a nullable
		// role it interpolated the absent value straight into the sentence ("your role is
		// undefined"), which fails closed by accident and reads to a person as a bug
		// rather than as an answer.
		if (tool !== 'members')
			check(
				`  ...and the refusal says they are not a member`,
				/not a member/.test(r.detail) && !/your role is (undefined|null)/.test(r.detail),
				r.detail
			);
	}

	// Content reads stay open: they resolved the brain legitimately. It is the
	// surrounding ORGANIZATION that is not theirs.
	const read = await attempt(outsider, 'search_pages', { query: 'anything' });
	check(
		'but a content read still passes the gate',
		await passesGate(outsider, 'search_pages', { query: 'anything' }),
		`${read.outcome}: ${read.detail}`
	);

	// Asserted on the PAYLOAD, not on a flag: the rows have to be absent, not merely
	// marked. Same rule the org-viewer cases above already follow.
	const payload = await analyticsPayload(outsider);
	check(
		'analytics withholds the per-person table entirely',
		Array.isArray(payload.people) && payload.people.length === 0,
		JSON.stringify(payload.people)
	);
	check('and says so', payload.canSeePeople === false, String(payload.canSeePeople));
}

console.log('\nThe active brain moves only on an explicit act');
// The pointer is one KV key per USER, not per conversation (the transport is
// stateless), so anything that moves it as a side effect retargets every other open
// conversation's bare calls. It used to move whenever a widget tool merely RESOLVED a
// brain (`sticky` on TenantOpts, applied in worker.ts to the view tools and
// brain_access), which meant looking at a page in one chat silently changed which
// brain another chat's next write_page landed in. The widget never needed it: every
// widget-initiated call names its brain (brainArgs) and the crumb follows the brain
// the result names (pickShownBrain). Removed 2026-09-15.
//
// The half that decided lived in worker.ts's registration lambdas, which no handler
// test can reach, so this half is a source scan like test-usage's: the option must
// not exist, and the only writers must be the three tools that mean it.
{
	moves.length = 0;
	check(
		'switch_brain moves the pointer',
		(await allows(lurker, 'switch_brain', { brain: 'other' })) &&
			moves.length === 1 &&
			moves[0] === 'northwind/other',
		JSON.stringify(moves)
	);
	moves.length = 0;
	await attempt(lurker, 'brain_access', { brain: 'other' });
	await attempt(lurker, 'brains');
	check(
		'opening the sharing panel for another brain does not',
		moves.length === 0,
		JSON.stringify(moves)
	);

	const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
	const worker = src('src/worker.ts');
	check('worker.ts has no sticky resolution', !/\bsticky\b|maybeStick/.test(worker));
	check('TenantOpts has no sticky option', !/sticky\?:/.test(src('src/lib/orgs.ts')));
	// The Worker writes the pointer in exactly one place: the dependency it hands the
	// brain tools. A second `this.setActiveBrain(` is a new side effect to justify here.
	const workerWrites = worker.match(/this\.setActiveBrain\(/g) ?? [];
	check(
		'the Worker hands the pointer to the brain tools and writes it nowhere else',
		workerWrites.length === 1,
		String(workerWrites.length)
	);

	// Inside src/tools, every writer sits in switch_brain, create_brain or
	// disconnect_brain (the last only falls a dangling pointer back to a survivor).
	const allowed = new Set(['switch_brain', 'create_brain', 'disconnect_brain']);
	const toolsDir = new URL('../src/tools/', import.meta.url);
	const offenders: string[] = [];
	for (const f of readdirSync(toolsDir).filter((n) => n.endsWith('.ts'))) {
		const text = readFileSync(new URL(f, toolsDir), 'utf8');
		const re = /\bsetActiveBrain\(/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const before = text.slice(0, m.index);
			// The last registerTool('name' above the call is the tool it belongs to.
			const names = [...before.matchAll(/registerTool\(\s*'([a-z_]+)'/g)];
			const owner = names.length ? names[names.length - 1][1] : '(none)';
			if (!allowed.has(owner)) offenders.push(`${f}:${owner}`);
		}
	}
	check(
		'in src/tools only those three tools write it',
		offenders.length === 0,
		offenders.join(', ')
	);
}

console.log('\nbrains is data, not a widget');
// The model's usual reason to call `brains` is "which brains exist?", and while the
// tool carried `_meta.ui` every such lookup rendered a brain list in the chat that
// nobody asked to see. The app reads the same result from inside the widget, where
// no widget metadata is needed. test-app-resource registers only the app tools, so
// this is the one place that sees the brain tools' `_meta`.
{
	toolsFor(lurker);
	const meta = configs.get('brains')?._meta as Record<string, unknown> | undefined;
	check('brains is registered', configs.has('brains'));
	check('and carries no _meta.ui', !meta || !('ui' in meta), JSON.stringify(meta));
	check(
		'and none of the deprecated flat key either',
		!meta || !Object.keys(meta).some((k) => k.startsWith('ui/')),
		JSON.stringify(meta)
	);
}

// ===========================================================================
console.log('\nupdate_brain: rename is BRAIN scope, move is ORG scope in both orgs');
// ===========================================================================
// Last in the file because the admit cases really write: they rename and move
// b-main, and restore it afterwards so the file stays order-independent.
{
	const brainRow = () =>
		sqlite
			.prepare('SELECT org_id, name, storage_connection_id FROM brains WHERE brain_id = ?')
			.get('b-main') as { org_id: string; name: string; storage_connection_id: string | null };
	const restore = () =>
		sqlite.exec(
			`UPDATE brains SET org_id = 'org1', name = 'Main', storage_connection_id = NULL
			  WHERE brain_id = 'b-main';`
		);

	check('a brain viewer cannot rename', await denies(lurker, 'update_brain', { name: 'Renamed' }));
	check(
		'an org OWNER holding only brain viewer cannot rename either: the name is the brain’s',
		await denies(orgBoss, 'update_brain', { name: 'Renamed' })
	);
	const renamed = await attempt(sharedAdmin, 'update_brain', { name: 'Renamed' });
	check(
		'a brain admin with no org power can rename',
		renamed.outcome === 'allowed' && brainRow().name === 'Renamed',
		renamed.detail
	);
	restore();

	const move = { org: 'Contoso Group' };
	check(
		'a brain admin who is only an org viewer cannot move it out of the org',
		await denies(sharedAdmin, 'update_brain', move)
	);
	check('nor can an outsider holding a grant', await denies(outsider, 'update_brain', move));
	check('nor an org editor', await denies(writer, 'update_brain', move));
	const destOnly: Persona = {
		...writer,
		label: 'org editor here, org ADMIN in the destination',
		orgRoleIn: { 'Contoso Group': 'admin' }
	};
	check(
		'admin in the destination alone is not enough: taking it out needs admin here too',
		await denies(destOnly, 'update_brain', move)
	);

	orgAsks.length = 0;
	const preview = await attempt(orgBoss, 'update_brain', move);
	const ask = orgAsks.at(-1);
	check(
		'the destination is resolved at org ADMIN, by the name the caller gave',
		ask?.requires === 'admin' && ask?.org === 'Contoso Group',
		JSON.stringify(ask)
	);
	check(
		'without confirm, a move answers with a preview and writes nothing',
		preview.outcome === 'allowed' &&
			preview.text.includes('Nothing has changed yet') &&
			brainRow().org_id === 'org1' &&
			brainRow().storage_connection_id === null,
		preview.detail
	);
	// Admin on the brain AND in the org, so both halves of the call pass their gates
	// and only the missing `confirm` stops the rename.
	const fullAdmin: Persona = { ...orgBoss, label: 'org owner, brain admin', role: 'admin' };
	const both = await attempt(fullAdmin, 'update_brain', { ...move, name: 'Elsewhere' });
	check(
		'...and a rename in the same call is not applied either',
		both.outcome === 'allowed' && brainRow().name === 'Main',
		both.detail
	);
	check(
		'moving into the org it is already in is refused',
		await denies(orgBoss, 'update_brain', { org: 'Northwind', confirm: true })
	);

	const done_ = await attempt(orgBoss, 'update_brain', { ...move, confirm: true });
	check(
		'with confirm, it moves, pinned to the connection it was read through',
		done_.outcome === 'allowed' &&
			brainRow().org_id === 'org2' &&
			brainRow().storage_connection_id === 'github-app:1',
		`${done_.detail} ${JSON.stringify(brainRow())}`
	);
	check(
		'the reply says where it is still stored',
		done_.text.includes('still stored in northwind on GitHub'),
		done_.text
	);
	restore();

	console.log('\nconnect_brain: no adopting through hosted storage');
	const hosted = await attempt(orgBoss, 'connect_brain', { org: 'Hosted Co' });
	check(
		'an admin of a hosted org cannot list the shared platform account’s repos',
		hosted.outcome === 'denied' && hosted.detail.includes('hosted storage'),
		hosted.detail
	);
	check(
		'...refused before any GitHub call is made',
		!hosted.detail.includes('octokit'),
		hosted.detail
	);
	const adopt = await attempt(orgBoss, 'connect_brain', { org: 'Hosted Co', repo: 'someone-else' });
	check(
		'...nor adopt one by name',
		adopt.outcome === 'denied' && adopt.detail.includes('hosted storage')
	);
	const own = await attempt(orgBoss, 'connect_brain', { org: 'Contoso Group' });
	check(
		'an org on its own installation still reaches the listing (and so the GitHub call)',
		own.detail.includes('octokit'),
		own.detail
	);
}

// ===========================================================================
console.log('\ncreate_org: a hosted org on the spot, or a GitHub install link');
// ===========================================================================
{
	const orgNamed = (name: string) =>
		sqlite.prepare('SELECT org_id, model, installation_id FROM orgs WHERE name = ?').get(name) as
			{ org_id: string; model: string; installation_id: number } | undefined;

	const made = await attempt(lurker, 'create_org', { name: 'Gordon & Co' });
	const row = orgNamed('Gordon & Co');
	check(
		'any signed-in member can create a hosted org: it is theirs, not their current org’s',
		made.outcome === 'allowed' && row?.model === 'hosted' && row?.installation_id === 9,
		made.detail
	);
	const owner = row
		? (sqlite.prepare('SELECT user_id, role FROM memberships WHERE org_id = ?').all(row.org_id) as {
				user_id: string;
				role: string;
			}[])
		: [];
	check(
		'...with the creator as its one owner',
		JSON.stringify(owner) === JSON.stringify([{ user_id: 'u-lurker', role: 'owner' }])
	);
	const conn = sqlite
		.prepare('SELECT owner_org_id FROM storage_connections WHERE connection_id = ?')
		.get('github-app:9') as { owner_org_id: string | null } | undefined;
	check(
		'...on the platform connection, which no org owns (so it cannot adopt through it)',
		!!conn && conn.owner_org_id === null
	);

	check(
		'a name the caller already belongs to is refused, since `org` arguments resolve by name',
		await denies(orgBoss, 'create_org', { name: 'northwind' })
	);
	check('an empty name is refused', await denies(orgBoss, 'create_org', { name: '   ' }));

	onboardingEnv.AUTO_PROVISION = 'false';
	const closed = await attempt(orgBoss, 'create_org', { name: 'Invite Only Co' });
	check(
		'with AUTO_PROVISION off, a hosted org is refused and nothing is written',
		closed.outcome === 'denied' && !orgNamed('Invite Only Co'),
		closed.detail
	);

	kvPuts.length = 0;
	const gh = await attempt(orgBoss, 'create_org', { name: 'Acme Corp', github: true });
	const stashed = kvPuts[0] ? JSON.parse(kvPuts[0].value) : {};
	check(
		'the GitHub path still works with AUTO_PROVISION off: the install proves ownership',
		gh.outcome === 'allowed' &&
			gh.text.includes('https://github.com/apps/isomorphic-test/installations/new?state='),
		gh.detail
	);
	check('...it creates no org itself', !orgNamed('Acme Corp'));
	check(
		'...and carries the chosen name through the install, with the caller',
		kvPuts[0]?.key.startsWith('pending_org_connect:') &&
			stashed.name === 'Acme Corp' &&
			stashed.user_id === 'u-boss',
		JSON.stringify(stashed)
	);
	onboardingEnv.AUTO_PROVISION = 'true';
}

// ---------------------------------------------------------------------------
done();
