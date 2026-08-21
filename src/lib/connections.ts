// Connections: a shared working surface between two organizations, stored as an
// ordinary brain that neither of them owns. Schema and the reasoning behind it:
// migrations/0007_connections.sql. Full design: docs/design/brain-seams.md.
//
// DATA ONLY, no octokit and no authorization. Authorization lives in the tools, for
// the same reason it does everywhere else here: this file is pure enough that
// `pnpm test:connections` can drive every state transition against a real SQLite,
// and a lifecycle that can be replayed in a test is one whose interrupted states
// have been looked at.
//
// Worker-safe (no node:*), because worker.ts reaches this through the tool layer.

import type { D1Database } from '@cloudflare/workers-types';
import { createOrg, matchBrain, brainLabel, type AccessibleBrain, type Org } from './orgs.ts';

// ---- the system organization ----

// Every connection brain lives in ONE organization that has no members, ever.
//
// It has to live somewhere: brains.org_id is NOT NULL, and the brain's org row is
// what supplies its GitHub installation token (resolveProductContext). Giving
// connections their own memberless organization is what makes three separate rules
// hold by construction rather than by a filter someone can forget:
//
//   • listAccessibleOrgs / chooseOrg start FROM memberships, so a connection's org
//     can never appear as a place to create or put a brain. "An anchor admits you to
//     a brain, never to an organization" needs no code.
//   • effectiveBrainRole's org-visibility source and org-admin floor both need a
//     member to apply to. With none, a connection brain is reachable ONLY through
//     the anchor branch, so a bug there makes connections invisible rather than
//     over-shared. It fails closed.
//   • resolveProductContext needs no change at all: it already mints the token from
//     the brain's own org row.
//
// `model` is 'system' and not 'platform' for a concrete reason: orgDisplay renders
// any 'platform' org as "Personal", so reusing that value would file every client
// room under the user's own personal heading.
export const CONNECTIONS_ORG_ID = 'org-connections';
export const CONNECTIONS_ORG_MODEL = 'system';
export const CONNECTIONS_ORG_NAME = 'Shared';

// Idempotent, and NOT a migration: brain_owner and installation_id are per-deployment
// values that live in env, while migrations are static SQL that the local runtime execs
// too. Same shape as provisionOrgForUser's lazy org mint, so a self-hoster gets this
// with no extra setup step. Re-running it refreshes the two env-derived columns, which
// is what makes a re-pointed platform installation land rather than silently diverge.
export async function ensureConnectionsOrg(
	db: D1Database,
	env: { platformOrg: string; installationId: number }
): Promise<string> {
	const existing = await db
		.prepare(`SELECT org_id FROM orgs WHERE org_id = ?1`)
		.bind(CONNECTIONS_ORG_ID)
		.first<{ org_id: string }>();
	if (existing) {
		await db
			.prepare(`UPDATE orgs SET brain_owner = ?2, installation_id = ?3 WHERE org_id = ?1`)
			.bind(CONNECTIONS_ORG_ID, env.platformOrg, env.installationId)
			.run();
		return CONNECTIONS_ORG_ID;
	}
	await createOrg(db, {
		org_id: CONNECTIONS_ORG_ID,
		name: CONNECTIONS_ORG_NAME,
		model: CONNECTIONS_ORG_MODEL,
		installation_id: env.installationId,
		brain_owner: env.platformOrg,
		github_org_login: null,
		// No user created this and none owns it. Deliberately not the caller: an
		// audit trail pointing at whoever happened to make the first connection on
		// the deployment would be worse than an empty one.
		created_by: ''
	});
	return CONNECTIONS_ORG_ID;
}

export function isConnectionsOrg(org: Pick<Org, 'org_id'>): boolean {
	return org.org_id === CONNECTIONS_ORG_ID;
}

// ---- rows ----

export type ConnectionState = 'pending' | 'live' | 'ending' | 'ended';

export interface Connection {
	connection_id: string;
	brain_id: string;
	name: string;
	state: ConnectionState;
	created_by: string | null;
	created_at: string;
	ended_by: string | null;
	ended_at: string | null;
}

export interface ConnectionParty {
	party_id: string;
	connection_id: string;
	org_id: string | null;
	invited_email: string | null;
	invited_at: string | null;
	expires_at: string | null;
	anchor_brain_id: string | null;
	mirror_brain_id: string | null;
	copy_cursor: string | null;
	joined_at: string | null;
}

// How long a party has to join before the invitation goes stale. Expired rows are
// SKIPPED, never deleted, so the panel can say "this invitation expired" rather than
// showing a connection that appears to have one party for no visible reason.
export const INVITE_TTL_DAYS = 30;

// WHICH BRAIN A CONNECTION HANGS OFF, and it must never be guessed.
//
// The anchor is the access decision: whoever can reach it can reach the room, and
// nothing re-anchors a live connection (setAnchor below has no caller), so a wrong
// answer here is permanent, and it is a permanent answer about who can read another
// organization's material.
//
// It used to fall back to `mine[0]`, which listAccessibleBrains orders by created_at,
// so omitting the argument silently anchored to the caller's OLDEST brain while the
// argument's own description promised "the brain you are in". On an org whose first
// brain is the company-wide one, that is the widest possible reading of a field nobody
// filled in.
//
// The order is: what you named, then where you are, then your only brain, then a
// refusal that lists the candidates. Refusing to guess is the rule chooseOrg already
// follows, for a smaller stake than this one.
//
// Pure and here rather than in the tool, so pnpm test:connections can drive the whole
// decision: the tool layer only supplies the three inputs.
export function resolveAnchor(
	named: string | undefined,
	mine: AccessibleBrain[],
	activeBrainId: string | null
): { brain?: AccessibleBrain; error?: string } {
	if (mine.length === 0) {
		return {
			error:
				'You need a brain of your own before you can connect one to anybody: a connection hangs off one of your brains, and that is what decides who on your side can reach it.'
		};
	}
	const names = mine.map(brainLabel);
	if (named) {
		const m = matchBrain(mine, named);
		if (m.brain) return { brain: m.brain };
		return {
			error: m.candidates
				? `"${named}" matches several of your brains: ${(m.candidates ?? mine).map(brainLabel).join(', ')}. Be more specific.`
				: `No brain of yours matching "${named}". You could use: ${names.join(', ')}.`
		};
	}
	// `id` is the canonical owner/repo handle, which is what a resolved context reports
	// as its brainId. `brain_id` is the table's key and happens to hold the same string
	// today; matching on the documented handle keeps that a coincidence rather than a
	// dependency.
	const active = activeBrainId ? mine.find((b) => b.id === activeBrainId) : undefined;
	if (active) return { brain: active };
	if (mine.length === 1) return { brain: mine[0] };
	return {
		error: `Which of your brains should this hang off? Whoever can reach it can reach the room, so it is not something to guess at. You could use: ${names.join(', ')}.`
	};
}

// ---- creating ----

// One connection, two parties: the initiator (joined, with its anchor) and the far
// side (pending, by email). The far side has no anchor yet BY CONSTRUCTION, because
// only they can say which of their brains a connection hangs off, and that is what
// makes joining a deliberate act rather than something done to them.
export async function createConnectionRecord(
	db: D1Database,
	c: {
		connection_id: string;
		brain_id: string;
		name: string;
		created_by: string;
		initiator: { party_id: string; org_id: string; anchor_brain_id: string };
		invitee: { party_id: string; email: string; expires_at: string };
	}
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO connections (connection_id, brain_id, name, state, created_by)
				 VALUES (?1, ?2, ?3, 'pending', ?4)`
			)
			.bind(c.connection_id, c.brain_id, c.name, c.created_by),
		db
			.prepare(
				`INSERT INTO connection_parties
				   (party_id, connection_id, org_id, anchor_brain_id, joined_at)
				 VALUES (?1, ?2, ?3, ?4, datetime('now'))`
			)
			.bind(c.initiator.party_id, c.connection_id, c.initiator.org_id, c.initiator.anchor_brain_id),
		db
			.prepare(
				`INSERT INTO connection_parties
				   (party_id, connection_id, invited_email, invited_at, expires_at)
				 VALUES (?1, ?2, ?3, datetime('now'), ?4)`
			)
			.bind(
				c.invitee.party_id,
				c.connection_id,
				c.invitee.email.toLowerCase(),
				c.invitee.expires_at
			)
	]);
}

// ---- reading ----

export async function getConnection(
	db: D1Database,
	connectionId: string
): Promise<Connection | null> {
	return await db
		.prepare(`SELECT * FROM connections WHERE connection_id = ?1`)
		.bind(connectionId)
		.first<Connection>();
}

// Is this brain a connection's storage? The guard `disconnect_brain` and `share_brain`
// both need: one deletes a brain (which would orphan the connection and destroy the
// room with no mirror), and the other would otherwise refuse every share on a
// connection brain with a message about organization membership that cannot be acted
// on, since a connection's organization has no members.
export async function connectionForBrain(
	db: D1Database,
	brainId: string
): Promise<Connection | null> {
	return await db
		.prepare(`SELECT * FROM connections WHERE brain_id = ?1`)
		.bind(brainId)
		.first<Connection>();
}

export async function partiesOf(db: D1Database, connectionId: string): Promise<ConnectionParty[]> {
	const { results } = await db
		.prepare(`SELECT * FROM connection_parties WHERE connection_id = ?1 ORDER BY party_id`)
		.bind(connectionId)
		.all<ConnectionParty>();
	return results ?? [];
}

export interface ConnectionWithParties {
	connection: Connection;
	parties: ConnectionParty[];
}

// Every LIVE connection anchored to one of these brains. This is Rule 1: a connection
// is in scope when you are in the brain it is joined to, which bounds what anyone sees
// by the degree of the brain they are in rather than by how many relationships exist.
// One indexed lookup on connection_parties_anchor_idx, no traversal.
//
// Pending as well as live. The side that CREATED a connection has to be able to put
// something in the room before inviting anyone to look at it, so hiding it until the
// other party joins would make the flow "create an empty room, wait, then start work".
// The far side is not reachable this way regardless: they have no anchor until they
// join. An ending or ended connection has had its anchors detached already.
export async function connectionsForAnchors(
	db: D1Database,
	brainIds: string[]
): Promise<ConnectionWithParties[]> {
	if (brainIds.length === 0) return [];
	const ph = brainIds.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT DISTINCT c.* FROM connection_parties p
			   JOIN connections c ON c.connection_id = p.connection_id
			  WHERE p.anchor_brain_id IN (${ph}) AND c.state IN ('pending', 'live')
			  ORDER BY c.created_at ASC, c.connection_id ASC`
		)
		.bind(...brainIds)
		.all<Connection>();
	const out: ConnectionWithParties[] = [];
	for (const connection of results ?? []) {
		out.push({ connection, parties: await partiesOf(db, connection.connection_id) });
	}
	return out;
}

// Which organizations are party to a connection. The end-of-connection gate reads this:
// either party may end it, so the caller needs admin in any one of these, and that is a
// different shape from orgContext, which resolves exactly one organization.
export async function partyOrgIds(db: D1Database, connectionId: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT org_id FROM connection_parties
			  WHERE connection_id = ?1 AND org_id IS NOT NULL`
		)
		.bind(connectionId)
		.all<{ org_id: string }>();
	return (results ?? []).map((r) => r.org_id);
}

// ---- joining ----

// Pending invitations for this email that have not expired. `now` is passed in rather
// than read here so a test can look at the boundary; the Worker passes its own clock.
export async function pendingPartiesForEmail(
	db: D1Database,
	email: string,
	now: string
): Promise<ConnectionParty[]> {
	const { results } = await db
		.prepare(
			`SELECT p.* FROM connection_parties p
			   JOIN connections c ON c.connection_id = p.connection_id
			  WHERE p.invited_email = ?1
			    AND p.org_id IS NULL
			    AND c.state = 'pending'
			    AND (p.expires_at IS NULL OR p.expires_at > ?2)
			  ORDER BY p.party_id`
		)
		.bind(email.toLowerCase(), now)
		.all<ConnectionParty>();
	return results ?? [];
}

// Invitations waiting for a PERSON, across every address they sign in under. Plural
// because identity linking means one human can hold several emails and an invitation
// sent to one of them has to be visible from all of them.
//
// Carries the connection's name, because the invitee cannot resolve the connection any
// other way: they have no anchor yet, so it is absent from every brain list they can
// see, which is the whole point of joining being a deliberate act.
export interface PendingInvitation extends ConnectionParty {
	connectionName: string;
}

export async function pendingPartiesForEmails(
	db: D1Database,
	emails: string[],
	now: string
): Promise<PendingInvitation[]> {
	if (emails.length === 0) return [];
	const lowered = emails.map((e) => e.toLowerCase());
	const ph = lowered.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT p.*, c.name AS connectionName FROM connection_parties p
			   JOIN connections c ON c.connection_id = p.connection_id
			  WHERE p.invited_email IN (${ph})
			    AND p.org_id IS NULL
			    AND c.state = 'pending'
			    AND (p.expires_at IS NULL OR p.expires_at > ?${lowered.length + 1})
			  ORDER BY c.created_at ASC, p.party_id ASC`
		)
		.bind(...lowered, now)
		.all<PendingInvitation>();
	return results ?? [];
}

// Bind a party to an organization and an anchor, and make the connection live.
//
// Two statements in one batch, and the connections UPDATE is CONDITIONAL on the state
// still being 'pending'. Joining is the moment a second organization gains reach, so a
// concurrent second join must lose rather than both appear to win.
export async function joinConnection(
	db: D1Database,
	j: { party_id: string; org_id: string; anchor_brain_id: string }
): Promise<void> {
	const party = await db
		.prepare(`SELECT connection_id FROM connection_parties WHERE party_id = ?1`)
		.bind(j.party_id)
		.first<{ connection_id: string }>();
	if (!party) throw new Error('That invitation no longer exists.');
	await db.batch([
		db
			.prepare(
				`UPDATE connection_parties
				    SET org_id = ?2, anchor_brain_id = ?3, joined_at = datetime('now'),
				        invited_email = NULL, expires_at = NULL
				  WHERE party_id = ?1`
			)
			.bind(j.party_id, j.org_id, j.anchor_brain_id),
		db
			.prepare(
				`UPDATE connections SET state = 'live'
				  WHERE connection_id = ?1 AND state = 'pending'`
			)
			.bind(party.connection_id)
	]);
}

// Re-anchor a party that is already joined, for a brain being reorganized. Never
// changes which organization is party to what.
export async function setAnchor(
	db: D1Database,
	partyId: string,
	anchorBrainId: string
): Promise<void> {
	await db
		.prepare(`UPDATE connection_parties SET anchor_brain_id = ?2 WHERE party_id = ?1`)
		.bind(partyId, anchorBrainId)
		.run();
}

// ---- ending ----

// Step 1 of ending: claim the connection. ONE conditional UPDATE is the entire
// concurrency guard, and it returns false when a concurrent call already won, so the
// caller reports "already ending" instead of running the sequence twice.
export async function beginEndConnection(
	db: D1Database,
	connectionId: string,
	endedBy: string
): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE connections
			    SET state = 'ending', ended_by = ?2, ended_at = datetime('now')
			  WHERE connection_id = ?1 AND state IN ('pending', 'live')`
		)
		.bind(connectionId, endedBy)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

// Step 2, and the one whose failure would be a security problem rather than an
// inconvenience, which is why it runs before any copying. Access is derived from the
// anchor, so detaching it IS the revocation: there are no grant rows to hunt down.
// Idempotent, so a resumed end re-runs it harmlessly.
export async function detachAnchors(db: D1Database, connectionId: string): Promise<void> {
	await db
		.prepare(`UPDATE connection_parties SET anchor_brain_id = NULL WHERE connection_id = ?1`)
		.bind(connectionId)
		.run();
}

export async function archiveBrain(db: D1Database, brainId: string): Promise<void> {
	await db
		.prepare(`UPDATE brains SET archived_at = datetime('now') WHERE brain_id = ?1`)
		.bind(brainId)
		.run();
}

// Record how far a party's mirror copy has got. The copy is unbounded work and one
// commitFiles cannot hold a large brain, so it is paged: each pass leaves a valid repo
// holding a subset and advances the cursor.
export async function setCopyCursor(
	db: D1Database,
	partyId: string,
	cursor: string | null
): Promise<void> {
	await db
		.prepare(`UPDATE connection_parties SET copy_cursor = ?2 WHERE party_id = ?1`)
		.bind(partyId, cursor)
		.run();
}

// A party's mirror has landed. Setting this is what takes the party out of the retry
// queue, so it must happen only once the copy is complete.
export async function markMirror(
	db: D1Database,
	partyId: string,
	mirrorBrainId: string
): Promise<void> {
	await db
		.prepare(
			`UPDATE connection_parties SET mirror_brain_id = ?2, copy_cursor = NULL WHERE party_id = ?1`
		)
		.bind(partyId, mirrorBrainId)
		.run();
}

// Step 7: finish, but only when every JOINED party actually has its mirror. A pending
// party never joined and is owed nothing. Returns false when work remains, which is
// what keeps an 'ending' connection in the retry queue instead of being declared done
// with a copy still missing.
export async function finishEndConnection(db: D1Database, connectionId: string): Promise<boolean> {
	const outstanding = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM connection_parties
			  WHERE connection_id = ?1 AND org_id IS NOT NULL AND mirror_brain_id IS NULL`
		)
		.bind(connectionId)
		.first<{ n: number }>();
	if ((outstanding?.n ?? 0) > 0) return false;
	await db
		.prepare(`UPDATE connections SET state = 'ended' WHERE connection_id = ?1`)
		.bind(connectionId)
		.run();
	return true;
}

// The brains row for a mirror. Not createBrain, because the two differ in exactly the
// ways that matter: a mirror is org-visible (the party is an ORGANIZATION, so the copy
// belongs to all of it rather than to whoever happened to hold access on the last day),
// it is read_only, and it carries the connection it came from so a reader a year later
// can find out what it is.
export async function createMirrorBrain(
	db: D1Database,
	b: {
		brain_id: string;
		org_id: string;
		repo_owner: string;
		repo_name: string;
		name: string;
		connection_id: string;
		created_by?: string | null;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO brains
			   (brain_id, org_id, repo_owner, repo_name, name, created_by, visibility, read_only, mirror_of)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'org', 1, ?7)
			 ON CONFLICT(repo_owner, repo_name) DO NOTHING`
		)
		.bind(
			b.brain_id,
			b.org_id,
			b.repo_owner,
			b.repo_name,
			b.name,
			b.created_by ?? null,
			b.connection_id
		)
		.run();
}

// A connection an admin of one of its parties may still act on even though nobody can
// reach its ROOM any more. Those are different questions: the anchors are gone, so the
// brain resolves for nobody, but the copies still have to be finished and somebody has
// to be able to drive that. Without this the end sequence would be unresumable, because
// the only way to name a connection is through the anchors it no longer has.
export async function endingConnectionsForOrgs(
	db: D1Database,
	orgIds: string[]
): Promise<Connection[]> {
	if (orgIds.length === 0) return [];
	const ph = orgIds.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT DISTINCT c.* FROM connections c
			   JOIN connection_parties p ON p.connection_id = c.connection_id
			  WHERE p.org_id IN (${ph}) AND c.state = 'ending'
			  ORDER BY c.ended_at ASC`
		)
		.bind(...orgIds)
		.all<Connection>();
	return results ?? [];
}

// Connections left mid-end: the resume queue. There is no cron in this Worker, so
// end_connection is its own resume entry point and this is what it looks at. That is
// tolerable only because revocation already completed synchronously; what is deferred
// is the copy, not the loss of access.
export async function connectionsAwaitingMirrors(db: D1Database): Promise<Connection[]> {
	const { results } = await db
		.prepare(`SELECT * FROM connections WHERE state = 'ending' ORDER BY ended_at ASC`)
		.all<Connection>();
	return results ?? [];
}
