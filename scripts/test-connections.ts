// Golden test for connections — PURE, no network. D1 is shimmed over node:sqlite from
// the real migrations.
//
// A connection is a shared working surface between two organizations, and ending one is
// a multi-step sequence that has to survive being interrupted. So most of what is worth
// asserting here is not a happy path: it is that access stops before any copying, that a
// half-finished end stays in the retry queue instead of declaring itself done, and that a
// second caller racing the first loses cleanly.
//
// The other half is the property the whole access model rests on: a connection is
// reachable ONLY through an anchor brain, so detaching the anchor IS the revocation, and
// a connection nobody has joined is reachable by nobody.
//
//   pnpm test:connections

import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../src/local/d1-sqlite.ts';
import {
	CONNECTIONS_ORG_ID,
	archiveBrain,
	beginEndConnection,
	connectionForBrain,
	connectionsAwaitingMirrors,
	connectionsForAnchors,
	createConnectionRecord,
	detachAnchors,
	ensureConnectionsOrg,
	finishEndConnection,
	getConnection,
	joinConnection,
	markMirror,
	partiesOf,
	partyOrgIds,
	pendingPartiesForEmail,
	setCopyCursor
} from '../src/lib/connections.ts';
import {
	getDefaultBrainForUser,
	listAccessibleBrains,
	listAccessibleOrgs
} from '../src/lib/orgs.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

// ---- D1 shim over node:sqlite ----

const sqlite = new DatabaseSync(':memory:');
applyMigrations(sqlite);

function shimStatement(sql: string, params: unknown[] = []): any {
	return {
		bind: (...p: unknown[]) => shimStatement(sql, p),
		first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
		all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
		run: async () => {
			const r = sqlite.prepare(sql).run(...(params as []));
			return { success: true, meta: { changes: Number(r.changes) } };
		}
	};
}
const db = {
	prepare: (sql: string) => shimStatement(sql),
	batch: async (stmts: { run: () => Promise<unknown> }[]) => {
		sqlite.exec('BEGIN');
		try {
			const out: unknown[] = [];
			for (const s of stmts) out.push(await s.run());
			sqlite.exec('COMMIT');
			return out;
		} catch (err) {
			sqlite.exec('ROLLBACK');
			throw err;
		}
	}
} as never;

// ---- fixtures: two organizations that cannot see each other ----

function exec(sql: string, ...p: unknown[]) {
	sqlite.prepare(sql).run(...(p as []));
}
const ORG = (id: string, name: string, owner: string) =>
	exec(
		`INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by) VALUES (?,?,?,?,?,?)`,
		id,
		name,
		'customer',
		1,
		owner,
		'u-seed'
	);
const USER = (id: string, email: string) =>
	exec(`INSERT INTO app_users (user_id, email) VALUES (?,?)`, id, email);
const MEMBER = (org: string, user: string, role: string) =>
	exec(`INSERT INTO memberships (org_id, user_id, role) VALUES (?,?,?)`, org, user, role);
const BRAIN = (id: string, org: string, name: string) => {
	const [owner, repo] = id.split('/');
	exec(
		`INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility) VALUES (?,?,?,?,?,'org')`,
		id,
		org,
		owner,
		repo,
		name
	);
};

ORG('org-acme', 'Acme', 'acme-co');
ORG('org-nw', 'Northwind', 'northwind');
USER('u-ann', 'ann@acme.example');
USER('u-nate', 'nate@northwind.example');
MEMBER('org-acme', 'u-ann', 'owner');
MEMBER('org-nw', 'u-nate', 'owner');
BRAIN('acme-co/client-work', 'org-acme', 'Client Work');
BRAIN('acme-co/internal', 'org-acme', 'Internal');
BRAIN('northwind/wiki', 'org-nw', 'Northwind Wiki');

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const NOW = '2026-08-19T12:00:00Z';

console.log('\nthe system organization');
{
	const id = await ensureConnectionsOrg(db, { platformOrg: 'iso-platform', installationId: 42 });
	check('is created on first touch', id === CONNECTIONS_ORG_ID);
	const again = await ensureConnectionsOrg(db, {
		platformOrg: 'iso-platform-2',
		installationId: 43
	});
	check('is idempotent', again === CONNECTIONS_ORG_ID);
	const rows = sqlite
		.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE org_id = ?`)
		.get(CONNECTIONS_ORG_ID) as { n: number };
	check('and does not duplicate', rows.n === 1, `got ${rows.n}`);
	const org = sqlite.prepare(`SELECT * FROM orgs WHERE org_id = ?`).get(CONNECTIONS_ORG_ID) as any;
	// Re-pointing the platform installation has to land, or a redeployed App would
	// leave every connection brain unreachable with no error anywhere.
	check(
		're-running refreshes the env-derived columns',
		org.brain_owner === 'iso-platform-2' && org.installation_id === 43,
		JSON.stringify(org)
	);
	check("model is 'system', not 'platform'", org.model === 'system', org.model);

	// THE load-bearing property. Every other guarantee in the design is downstream of
	// this one row having no members.
	const members = sqlite
		.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`)
		.get(CONNECTIONS_ORG_ID) as { n: number };
	check('it has no members, which is what everything else rests on', members.n === 0);

	const orgs = await listAccessibleOrgs(db, ['u-ann']);
	check(
		'so it can never be offered as a place to put a brain',
		!orgs.some((o) => o.org.org_id === CONNECTIONS_ORG_ID),
		JSON.stringify(orgs.map((o) => o.org.org_id))
	);
}

// The connection brain itself: an ordinary brain row, private, in the system org.
BRAIN('iso-platform/conn-northwind-4f9c2a1b', CONNECTIONS_ORG_ID, 'Northwind engagement');
exec(
	`UPDATE brains SET visibility = 'private' WHERE brain_id = ?`,
	'iso-platform/conn-northwind-4f9c2a1b'
);

console.log('\ncreating a connection');
{
	await createConnectionRecord(db, {
		connection_id: 'c1',
		brain_id: 'iso-platform/conn-northwind-4f9c2a1b',
		name: 'Northwind engagement',
		created_by: 'u-ann',
		initiator: { party_id: 'p-acme', org_id: 'org-acme', anchor_brain_id: 'acme-co/client-work' },
		invitee: { party_id: 'p-nw', email: 'Nate@Northwind.example', expires_at: FUTURE }
	});
	const c = await getConnection(db, 'c1');
	check('starts pending', c?.state === 'pending', c?.state);
	const parties = await partiesOf(db, 'c1');
	check('has two parties', parties.length === 2);
	const acme = parties.find((p) => p.party_id === 'p-acme')!;
	const nw = parties.find((p) => p.party_id === 'p-nw')!;
	check(
		'the initiator is joined, with its anchor',
		acme.org_id === 'org-acme' && acme.anchor_brain_id === 'acme-co/client-work'
	);
	// The far side has no anchor BY CONSTRUCTION: only they can say which of their
	// brains a connection hangs off, which is what makes joining deliberate rather
	// than something done to them.
	check(
		'the far side has no organization and no anchor yet',
		nw.org_id === null && nw.anchor_brain_id === null
	);
	check(
		'the invited email is normalized',
		nw.invited_email === 'nate@northwind.example',
		String(nw.invited_email)
	);
	check('only one organization is party so far', (await partyOrgIds(db, 'c1')).length === 1);
}

console.log('\nconnectionForBrain: the guard disconnect_brain and share_brain need');
{
	check(
		'finds the connection behind its brain',
		(await connectionForBrain(db, 'iso-platform/conn-northwind-4f9c2a1b'))?.connection_id === 'c1'
	);
	check(
		'and is null for an ordinary brain',
		(await connectionForBrain(db, 'acme-co/internal')) === null
	);
}

console.log('\nRule 1: a connection is in scope from the brain it is joined to');
{
	// Nobody can reach a pending connection, including the side that created it: it is
	// not a room until both parties are in it.
	check(
		'a pending connection is in scope for nobody',
		(await connectionsForAnchors(db, ['acme-co/client-work'])).length === 0
	);
}

console.log('\njoining');
{
	const pending = await pendingPartiesForEmail(db, 'NATE@northwind.example', NOW);
	check(
		'an invitation is found case-insensitively',
		pending.length === 1 && pending[0].party_id === 'p-nw',
		JSON.stringify(pending)
	);
	check(
		'and not for someone else',
		(await pendingPartiesForEmail(db, 'ann@acme.example', NOW)).length === 0
	);

	await joinConnection(db, {
		party_id: 'p-nw',
		org_id: 'org-nw',
		anchor_brain_id: 'northwind/wiki'
	});
	const c = await getConnection(db, 'c1');
	check('joining makes the connection live', c?.state === 'live', c?.state);
	const nw = (await partiesOf(db, 'c1')).find((p) => p.party_id === 'p-nw')!;
	check(
		'the party is bound to its organization and anchor',
		nw.org_id === 'org-nw' && nw.anchor_brain_id === 'northwind/wiki'
	);
	// Left set, the invitation would keep matching at every future sign-in of anyone
	// who ever shared that address.
	check('and the invitation is consumed', nw.invited_email === null && nw.expires_at === null);
	check(
		'both organizations are now party',
		(await partyOrgIds(db, 'c1')).sort().join() === 'org-acme,org-nw'
	);
	check(
		'a consumed invitation no longer matches',
		(await pendingPartiesForEmail(db, 'nate@northwind.example', NOW)).length === 0
	);
}

console.log('\nRule 1, once it is live');
{
	const fromAcme = await connectionsForAnchors(db, ['acme-co/client-work']);
	check(
		'in scope from the initiator’s anchor',
		fromAcme.length === 1 && fromAcme[0].connection.connection_id === 'c1'
	);
	check('and carries both parties', fromAcme[0]?.parties.length === 2);
	check(
		'in scope from the other side’s anchor too',
		(await connectionsForAnchors(db, ['northwind/wiki'])).length === 1
	);
	// The whole point of anchoring: a person with a client brain and a personal brain
	// does not see client rooms from the personal one.
	check(
		'NOT in scope from an unrelated brain in the same organization',
		(await connectionsForAnchors(db, ['acme-co/internal'])).length === 0
	);
	check('no anchors, no query', (await connectionsForAnchors(db, [])).length === 0);
}

console.log('\nexpiry: a stale invitation is skipped, not deleted');
{
	BRAIN('iso-platform/conn-stale-0000', CONNECTIONS_ORG_ID, 'Stale');
	await createConnectionRecord(db, {
		connection_id: 'c-stale',
		brain_id: 'iso-platform/conn-stale-0000',
		name: 'Stale',
		created_by: 'u-ann',
		initiator: { party_id: 'p-s-acme', org_id: 'org-acme', anchor_brain_id: 'acme-co/client-work' },
		invitee: { party_id: 'p-s-nw', email: 'nate@northwind.example', expires_at: PAST }
	});
	check(
		'an expired invitation does not match',
		(await pendingPartiesForEmail(db, 'nate@northwind.example', NOW)).length === 0
	);
	// Skipped rather than deleted, so the panel can say "this expired" instead of
	// showing a connection that mysteriously has one party.
	const row = sqlite
		.prepare(`SELECT * FROM connection_parties WHERE party_id = ?`)
		.get('p-s-nw') as any;
	check(
		'but the row survives, so it can be explained',
		!!row && row.invited_email === 'nate@northwind.example'
	);
}

console.log('\nending: claiming it');
{
	check('the first caller wins', (await beginEndConnection(db, 'c1', 'u-nate')) === true);
	// One conditional UPDATE is the whole concurrency guard: a second caller must lose
	// rather than run the sequence twice.
	check(
		'a concurrent second caller loses',
		(await beginEndConnection(db, 'c1', 'u-ann')) === false
	);
	const c = await getConnection(db, 'c1');
	check("state is 'ending'", c?.state === 'ending', c?.state);
	check('and it records who ended it', c?.ended_by === 'u-nate' && !!c?.ended_at);
}

console.log('\nending: access stops before any copying');
{
	await detachAnchors(db, 'c1');
	// Detaching the anchor IS the revocation, because access was derived from it. There
	// are no grant rows to hunt down and none to forget.
	check(
		'neither side can reach it any more',
		(await connectionsForAnchors(db, ['acme-co/client-work', 'northwind/wiki'])).length === 0
	);
	await detachAnchors(db, 'c1');
	check(
		'and detaching twice is harmless, so a resumed end is safe',
		(await partiesOf(db, 'c1')).every((p) => p.anchor_brain_id === null)
	);

	// Archiving is asserted on a brain the caller CAN otherwise see. Doing it on the
	// connection brain would have proved nothing: nobody is a member of the system
	// organization, so that brain never appears in this list archived or not, and the
	// check would have passed against a missing filter.
	BRAIN('acme-co/retired', 'org-acme', 'Retired');
	check(
		'before archiving, an ordinary brain resolves',
		(await listAccessibleBrains(db, ['u-ann'])).some((b) => b.id === 'acme-co/retired')
	);
	await archiveBrain(db, 'acme-co/retired');
	check(
		'an archived brain leaves the accessible set entirely',
		!(await listAccessibleBrains(db, ['u-ann'])).some((b) => b.id === 'acme-co/retired')
	);
	// One place, not per-consumer: the default-brain pick reads the same rule, or an
	// archived brain could still be the one someone lands in on their next request.
	check(
		'and can never be picked as a default',
		(await getDefaultBrainForUser(db, 'org-acme', 'u-ann', 'owner'))?.brain_id !== 'acme-co/retired'
	);
	await archiveBrain(db, 'iso-platform/conn-northwind-4f9c2a1b');
}

console.log('\nending: the mirror is what finishes it');
{
	// The failure this guards against is declaring the end complete with a party's copy
	// still missing, which would silently lose the record the whole design promises.
	check(
		'not finished while a joined party has no mirror',
		(await finishEndConnection(db, 'c1')) === false
	);

	await setCopyCursor(db, 'p-acme', 'wiki/m.md');
	check(
		'progress is recorded so a copy can resume',
		(await partiesOf(db, 'c1')).find((p) => p.party_id === 'p-acme')!.copy_cursor === 'wiki/m.md'
	);

	BRAIN('acme-co/mirror-northwind', 'org-acme', 'Northwind engagement (archive)');
	await markMirror(db, 'p-acme', 'acme-co/mirror-northwind');
	check(
		'landing a mirror clears the cursor',
		(await partiesOf(db, 'c1')).find((p) => p.party_id === 'p-acme')!.copy_cursor === null
	);
	check(
		'one of two mirrors is still not finished',
		(await finishEndConnection(db, 'c1')) === false
	);

	BRAIN('northwind/mirror-acme', 'org-nw', 'Northwind engagement (archive)');
	await markMirror(db, 'p-nw', 'northwind/mirror-acme');
	check('with both mirrors landed, it finishes', (await finishEndConnection(db, 'c1')) === true);
	check("state is 'ended'", (await getConnection(db, 'c1'))?.state === 'ended');
}

console.log('\nending a connection nobody joined');
{
	check(
		'can be claimed even though it never went live',
		(await beginEndConnection(db, 'c-stale', 'u-ann')) === true
	);
	await detachAnchors(db, 'c-stale');
	await markMirror(db, 'p-s-acme', 'acme-co/mirror-northwind');
	// A party that never joined is owed nothing: there is no organization to give a
	// copy to, and waiting for one would strand the connection in the retry queue.
	check(
		'a party that never joined is owed no mirror',
		(await finishEndConnection(db, 'c-stale')) === true
	);
}

console.log('\nthe resume queue');
{
	BRAIN('iso-platform/conn-half-0000', CONNECTIONS_ORG_ID, 'Half');
	await createConnectionRecord(db, {
		connection_id: 'c-half',
		brain_id: 'iso-platform/conn-half-0000',
		name: 'Half',
		created_by: 'u-ann',
		initiator: { party_id: 'p-h-acme', org_id: 'org-acme', anchor_brain_id: 'acme-co/client-work' },
		invitee: { party_id: 'p-h-nw', email: 'nate@northwind.example', expires_at: FUTURE }
	});
	await joinConnection(db, {
		party_id: 'p-h-nw',
		org_id: 'org-nw',
		anchor_brain_id: 'northwind/wiki'
	});
	await beginEndConnection(db, 'c-half', 'u-ann');
	await detachAnchors(db, 'c-half');

	const waiting = await connectionsAwaitingMirrors(db);
	// There is no cron here, so end_connection is its own resume entry point and this
	// is what it reads. Tolerable only because access already stopped: what is deferred
	// is the copy, not the revocation.
	check(
		'an interrupted end is still queued',
		waiting.some((c) => c.connection_id === 'c-half'),
		JSON.stringify(waiting.map((c) => c.connection_id))
	);
	check('and a finished one is not', !waiting.some((c) => c.connection_id === 'c1'));
}

console.log('\nthe schema itself');
{
	let threw = false;
	try {
		exec(
			`INSERT INTO connection_parties (party_id, connection_id, org_id) VALUES (?,?,?)`,
			'p-dup',
			'c-half',
			'org-acme'
		);
	} catch {
		threw = true;
	}
	check('one organization cannot be party to the same connection twice', threw);

	let threw2 = false;
	try {
		exec(
			`INSERT INTO connections (connection_id, brain_id, name) VALUES (?,?,?)`,
			'c-dup',
			'iso-platform/conn-half-0000',
			'Duplicate'
		);
	} catch {
		threw2 = true;
	}
	// connectionForBrain is a lookup, not a judgement, and that is only true because
	// the schema refuses a second connection over the same brain.
	check('one brain cannot back two connections', threw2);
}

console.log(
	failures === 0 ? '\nAll connection checks passed.' : `\n${failures} connection check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
