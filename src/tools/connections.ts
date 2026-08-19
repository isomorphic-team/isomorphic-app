// Connection tools: standing up, joining, and looking at a shared working surface
// between two organizations. Data layer and the reasoning behind the shape:
// src/lib/connections.ts and migrations/0007_connections.sql.
//
// THREE TOOLS, and the split is not arbitrary. `connections` reads; `create_connection`
// proposes one; `accept_connection` is the far side agreeing. There is no "share this
// connection with a colleague" verb and there must not be, because access to a
// connection is DERIVED from the brain each side joined it to. Adding a colleague is
// adding them to your own brain, which is a thing a person already knows how to do, and
// it means neither organization ever administers people in the other.
//
// Authorization here is org-scope on the caller's OWN organization, never on the
// connection's. A connection lives in an organization with no members, so there is no
// role in it to gate on and no one for `requiresOrg` to resolve.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { BRAIN_APP_URI } from './apps.ts';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import {
	brainLabel,
	getAppUserByEmail,
	matchBrain,
	roleAtLeast,
	type AccessibleBrain,
	type AccessibleOrg,
	type OrgScope,
	type Role,
	type TenantOpts
} from '../lib/orgs.ts';
import {
	INVITE_TTL_DAYS,
	archiveBrain,
	beginEndConnection,
	connectionsForAnchors,
	createMirrorBrain,
	detachAnchors,
	endingConnectionsForOrgs,
	finishEndConnection,
	getConnection,
	markMirror,
	partyOrgIds,
	setCopyCursor,
	createConnectionRecord,
	ensureConnectionsOrg,
	joinConnection,
	partiesOf,
	pendingPartiesForEmails,
	type Connection,
	type ConnectionParty
} from '../lib/connections.ts';
import { createAndScaffoldBrain } from '../lib/scaffold-core.ts';
import { copyMirrorPass, mirrorReadme, type MirrorEnd } from '../lib/mirror.ts';
import type { BrainStore, RepoRef } from '../lib/brain-repo.ts';
import { createBrain, orgLabel } from '../lib/orgs.ts';

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}
function ok(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

export interface ConnectionDeps {
	getContext: (opts?: TenantOpts) => Promise<BrainContext>;
	// STICKY, and used only by the `connections` panel. Opening an in-client view for a
	// named brain has to move the active brain with it, or the panel shows one brain's
	// connections under another brain's crumb. end_connection deliberately does not use
	// this: ending a relationship should not relocate the person doing it.
	getViewContext: (opts?: TenantOpts) => Promise<BrainContext>;
	orgContext: (opts?: { requires?: Role; org?: string }) => Promise<OrgScope>;
	// A client for the deployment's OWN GitHub org. A connection belongs to neither
	// party, so the client that creates its repository belongs to neither either: the
	// caller's own installation has no rights on the platform org.
	platformContext: () => Promise<{
		octokit: Parameters<typeof createAndScaffoldBrain>[0];
		org: string;
		installationId: number;
	}>;
	listBrains: () => Promise<AccessibleBrain[]>;
	// The caller's organizations and their role in each. Ending a connection is gated on
	// admin in EITHER party, which orgContext cannot express: it resolves exactly one.
	listOrgs: () => Promise<AccessibleOrg[]>;
	// Every address this person signs in under. An invitation is addressed to an email
	// and claimed later, so looking at only the current one would hide an invitation
	// sent to another of their addresses.
	personEmails: () => Promise<string[]>;
	// A store scoped to the PLATFORM installation, for reading a connection's own repo.
	platformStore: () => Promise<BrainStore>;
	// A writer for one organization's own GitHub namespace. This is the second token a
	// mirror needs: the copy is READ with the platform installation and WRITTEN with the
	// receiving organization's, which for a customer org is a different installation
	// entirely and the only one with rights to create a repository there.
	orgWriter: (orgId: string) => Promise<{
		store: BrainStore;
		createRepo: (name: string, description: string) => Promise<RepoRef>;
	} | null>;
	now: () => string;
}

// A connection repo name. NOT create_brain's `base-N` collision loop: PLATFORM_ORG is a
// single namespace shared by every connection on the deployment, so two customers
// naming a connection "Acme" is ordinary rather than exceptional, and a numeric retry
// would leak the existence and count of other tenants' connections through the name.
// Neither party ever sees this string.
function connRepoName(name: string, connectionId: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'connection';
	return `conn-${slug}-${connectionId.slice(0, 8)}`;
}

// A mirror's repo name. Unlike a connection repo this lands in ONE customer's own
// namespace, where a numeric collision suffix would be readable and would leak nothing,
// but the connection id is still the thing that makes it unique without a round trip to
// find out what is already there.
function mirrorRepoName(name: string, connectionId: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'connection';
	return `archive-${slug}-${connectionId.slice(0, 8)}`;
}

// The far side's organization name. A connection is meaningless rendered as an opaque
// id, and this is the only detail of the counterparty a party is entitled to: who they
// are, not who works there.
async function orgNameOf(db: BrainContext['db'], orgId: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT name, model, brain_owner FROM orgs WHERE org_id = ?1`)
		.bind(orgId)
		.first<{ name: string; model: string; brain_owner: string }>();
	if (!row) return null;
	return orgLabel({ ...row, org_id: orgId } as Parameters<typeof orgLabel>[0]);
}

function describeParty(p: ConnectionParty): string {
	if (p.org_id) return p.anchor_brain_id ? 'joined' : 'joined (no anchor)';
	return p.invited_email ? `invited ${p.invited_email}` : 'invited';
}

function connectionLine(c: Connection, parties: ConnectionParty[]): string {
	const state =
		c.state === 'pending'
			? ' (waiting for the other side to join)'
			: c.state === 'live'
				? ''
				: ` (${c.state})`;
	return `- ${c.name}${state} (${parties.map(describeParty).join('; ')})`;
}

export function registerConnectionTools(server: McpServer, deps: ConnectionDeps) {
	const {
		getContext,
		getViewContext,
		orgContext,
		platformContext,
		listBrains,
		listOrgs,
		personEmails,
		platformStore,
		orgWriter,
		now
	} = deps;

	// How many copy passes one request will drive before handing the rest to the next
	// call. There is no cron here, so the alternative to a bound is a request that runs
	// until the host times it out and reports nothing at all.
	const PASSES_PER_REQUEST = 4;

	// Where a party's copy has got to, as one string, because there is one column for it.
	//
	// `<owner>/<repo>#<path>`: which repository was made for this party, and how far the
	// walk through the source got. Both halves are needed to resume and neither can be
	// derived from the other, so encoding only the path (the first thing I wrote) loses
	// the repository and makes the next pass create a second one.
	function packCursor(repo: RepoRef, at: string | null): string {
		return `${repo.owner}/${repo.repo}#${at ?? ''}`;
	}
	function unpackCursor(raw: string | null): { repo: RepoRef; at: string | null } | null {
		if (!raw) return null;
		const hash = raw.indexOf('#');
		if (hash < 0) return null;
		const [owner, name] = raw.slice(0, hash).split('/');
		if (!owner || !name) return null;
		const at = raw.slice(hash + 1);
		return { repo: { owner, repo: name }, at: at || null };
	}

	// Give every joined party its read-only copy, as far as this request's budget goes.
	//
	// Failures are reported, never thrown. Access already stopped in the request that
	// ended the connection, so a copy that cannot be made right now is a delay rather
	// than a leak, and the room is archived rather than deleted so it can still be made
	// later. That is the whole reason this is allowed to be best-effort.
	async function advanceMirrors(
		db: BrainContext['db'],
		connectionId: string
	): Promise<{ done: boolean; note: string }> {
		const conn = await getConnection(db, connectionId);
		if (!conn) return { done: true, note: '' };
		const parties = await partiesOf(db, connectionId);
		// A party that never joined is owed nothing: there is no organization to give a
		// copy to, and waiting for one would strand the connection in the queue forever.
		const owed = parties.filter((x) => x.org_id && !x.mirror_brain_id);
		if (owed.length === 0) {
			await finishEndConnection(db, connectionId);
			return { done: true, note: '' };
		}
		const read = await platformStore().catch(() => null);
		if (!read) {
			return { done: false, note: ' The copies could not be started just now.' };
		}
		const [srcOwner, srcRepo] = conn.brain_id.split('/');
		const src: MirrorEnd = { store: read, repo: { owner: srcOwner, repo: srcRepo } };

		let stalled = 0;
		for (const party of owed) {
			const writer = await orgWriter(party.org_id!).catch(() => null);
			if (!writer) {
				stalled++;
				continue;
			}
			try {
				const resumed = unpackCursor(party.copy_cursor);
				let repo: RepoRef;
				let at: string | null = null;
				if (resumed) {
					repo = resumed.repo;
					at = resumed.at;
				} else {
					repo = await writer.createRepo(
						mirrorRepoName(conn.name, conn.connection_id),
						`${conn.name}: a read-only copy of an ended Isomorphic connection`
					);
					// The note goes in FIRST, so even a copy that never gets any further
					// leaves something that explains itself.
					await writer.store.commitFiles(repo, {
						message: 'What this is',
						writes: [
							{
								path: 'README.md',
								content: mirrorReadme({
									connectionName: conn.name,
									parties: parties.map((x) => x.org_id ?? 'an invited party'),
									endedAt: (conn.ended_at ?? now()).slice(0, 10)
								})
							}
						]
					});
					await createMirrorBrain(db, {
						brain_id: `${repo.owner}/${repo.repo}`,
						org_id: party.org_id!,
						repo_owner: repo.owner,
						repo_name: repo.repo,
						name: `${conn.name} (archive)`,
						connection_id: conn.connection_id
					});
					await setCopyCursor(db, party.party_id, packCursor(repo, null));
				}

				const dst: MirrorEnd = { store: writer.store, repo };
				let finished = false;
				for (let i = 0; i < PASSES_PER_REQUEST; i++) {
					const pass = await copyMirrorPass(src, dst, {
						branch: 'main',
						cursor: at,
						label: conn.name
					});
					at = pass.cursor;
					if (pass.done) {
						finished = true;
						break;
					}
				}
				// markMirror is what takes a party OUT of the queue, so it happens only
				// once the walk actually reached the end.
				if (finished) await markMirror(db, party.party_id, `${repo.owner}/${repo.repo}`);
				else {
					await setCopyCursor(db, party.party_id, packCursor(repo, at));
					stalled++;
				}
			} catch {
				stalled++;
			}
		}
		if (stalled > 0) {
			return {
				done: false,
				note: ' The read-only copies are still being written. Run end_connection again to carry on.'
			};
		}
		await finishEndConnection(db, connectionId);
		return { done: true, note: ' Each side now has a read-only copy.' };
	}

	// ---------- connections (read) ----------
	// An in-client view, like brain_access, and sticky for the same reason: opening it
	// for a NAMED brain has to move the active brain with it, or the panel renders one
	// brain's connections under another brain's crumb.
	registerAppTool(
		server,
		'connections',
		{
			title: 'Connections on this brain',
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } },
			description:
				'connections lists the shared working surfaces this brain is joined to, and any invitations waiting for you. A connection is a place two organizations write in together, owned by neither: it is not one of your brains and it does not appear in your brain list, it hangs off the brain it is about. Use this to answer "who are we sharing a space with", "is there a room for this client", or "was I invited to something".',
			inputSchema: {
				brain: z
					.string()
					.optional()
					.describe("Which brain's connections to list. Defaults to the active brain.")
			}
		},
		async ({ brain }) => {
			const ctx = await getViewContext({ brain });
			const rows = await connectionsForAnchors(ctx.db, [ctx.brainId]);
			const invitations = await pendingPartiesForEmails(ctx.db, await personEmails(), now());
			// Names for the organizations on either side. Only the caller's own are known
			// for certain; the far side is named from its own org row, which is the one
			// piece of the counterparty this deployment can see.
			const myOrgs = await listOrgs();
			const myOrgIds = new Set(myOrgs.map((o) => o.org.org_id));
			const orgNames = new Map(myOrgs.map((o) => [o.org.org_id, orgLabel(o.org)]));
			for (const r of rows) {
				for (const p of r.parties) {
					if (!p.org_id || orgNames.has(p.org_id)) continue;
					const far = await orgNameOf(ctx.db, p.org_id);
					if (far) orgNames.set(p.org_id, far);
				}
			}

			const lines: string[] = [];
			if (rows.length === 0) {
				lines.push(`"${ctx.activeBrain?.label ?? ctx.brainId}" is not connected to anything yet.`);
			} else {
				lines.push(`"${ctx.activeBrain?.label ?? ctx.brainId}" is connected to:`);
				for (const r of rows) lines.push(connectionLine(r.connection, r.parties));
			}
			if (invitations.length > 0) {
				lines.push('');
				lines.push(
					`Waiting for you (accept_connection to join, naming one of your brains to join it to):`
				);
				for (const inv of invitations) lines.push(`- ${inv.connectionName}`);
			}
			return {
				...ok(lines.join('\n')),
				structuredContent: {
					view: 'connections' as const,
					brainLabel: ctx.activeBrain?.label ?? ctx.brainId,
					connections: rows.map((r) => ({
						connection_id: r.connection.connection_id,
						name: r.connection.name,
						state: r.connection.state,
						brain: r.connection.brain_id,
						// The counterparty is what a person actually wants to see, so it is
						// resolved here rather than left as an org id the widget cannot name.
						parties: r.parties.map((p) => ({
							org: p.org_id ? (orgNames.get(p.org_id) ?? p.org_id) : null,
							invitedEmail: p.invited_email,
							mine: !!p.org_id && myOrgIds.has(p.org_id),
							joined: !!p.org_id
						}))
					})),
					invitations: invitations.map((i) => ({
						connection_id: i.connection_id,
						name: i.connectionName
					})),
					activeBrain: ctx.activeBrain
				}
			};
		}
	);

	// ---------- create_connection ----------
	server.registerTool(
		'create_connection',
		{
			title: 'Start a connection with another organization',
			description:
				"create_connection stands up a shared working surface with someone outside your organization: a place you both write in, owned by neither of you. Use it for a client engagement, a partner project, or any document two organizations author together. It is NOT how you share one of your own brains with a colleague (that is share_brain) and it is NOT a copy: there is one set of pages and both sides edit them. You name one of YOUR brains for it to hang off, and whoever can reach that brain can reach the room, so you never manage the other side's people and they never manage yours. The other party joins by naming a brain of their own; until they do, the room is yours to prepare.",
			inputSchema: {
				name: z
					.string()
					.describe(
						'What this relationship is called, e.g. "Northwind engagement". Both sides see this name.'
					),
				with: z
					.string()
					.describe(
						'The email address of someone at the other organization. They do not need an account yet; the invitation waits for them.'
					),
				about: z
					.string()
					.optional()
					.describe(
						'Which of YOUR brains this connection is about. Whoever can reach that brain can reach the room. Defaults to the brain you are in.'
					),
				org: z
					.string()
					.optional()
					.describe('Which of your organizations is party to it. Defaults to the active brain’s.')
			}
		},
		async ({ name, with: withEmail, about, org }) => {
			let ctx: OrgScope;
			try {
				ctx = await orgContext({ requires: 'admin', org });
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
			const display = name.trim();
			if (!display) return fail('Please give the connection a name.');
			const email = withEmail.trim().toLowerCase();
			if (!email.includes('@')) return fail(`"${withEmail}" is not an email address.`);

			// The ANCHOR has to be a brain of the caller's own, in the org they are acting
			// as: it is what confers access, so anchoring to someone else's brain would be
			// granting reach you do not hold.
			const mine = (await listBrains()).filter((b) => b.org_id === ctx.org.org_id);
			if (mine.length === 0) {
				return fail(
					'You need a brain of your own before you can connect one to anybody: a connection hangs off one of your brains, and that is what decides who on your side can reach it.'
				);
			}
			let anchor: AccessibleBrain | undefined;
			if (about) {
				const m = matchBrain(mine, about);
				if (!m.brain) {
					const names = (m.candidates ?? mine).map(brainLabel);
					return fail(
						m.candidates
							? `"${about}" matches several of your brains: ${names.join(', ')}. Be more specific.`
							: `No brain of yours matching "${about}". You could use: ${names.join(', ')}.`
					);
				}
				anchor = m.brain;
			} else {
				anchor = mine[0];
			}

			// A person invited to a room they can already reach is a no-op that reads as
			// success, so say so instead.
			const invitee = await getAppUserByEmail(ctx.db, email);
			if (invitee && invitee.user_id === ctx.actorUserId) {
				return fail('You cannot start a connection with yourself.');
			}

			const platform = await platformContext().catch((err: unknown) => err as Error);
			if (platform instanceof Error) return fail(platform.message);

			const connectionId = crypto.randomUUID();
			const repo = connRepoName(display, connectionId);
			let created: Awaited<ReturnType<typeof createAndScaffoldBrain>>;
			try {
				created = await createAndScaffoldBrain(platform.octokit, {
					org: platform.org,
					name: repo,
					description: `${display}: a shared Isomorphic connection`
				});
			} catch (err) {
				return fail(
					`Couldn't create the shared space: ${err instanceof Error ? err.message : String(err)}`
				);
			}

			const connectionsOrgId = await ensureConnectionsOrg(ctx.db, {
				platformOrg: platform.org,
				installationId: platform.installationId
			});
			const brainId = `${created.owner}/${created.name}`;
			// PRIVATE is not optional. The whole safety of a connection living in a
			// memberless organization rests on org-visibility having nobody to apply to;
			// anything else here would hand a role to members of an org that has none
			// today and might not always.
			await createBrain(ctx.db, {
				brain_id: brainId,
				org_id: connectionsOrgId,
				repo_owner: created.owner,
				repo_name: created.name,
				name: display,
				created_by: ctx.actorUserId,
				visibility: 'private'
			});
			const expires = new Date(Date.parse(now()) + INVITE_TTL_DAYS * 86_400_000).toISOString();
			await createConnectionRecord(ctx.db, {
				connection_id: connectionId,
				brain_id: brainId,
				name: display,
				created_by: ctx.actorUserId,
				initiator: {
					party_id: crypto.randomUUID(),
					org_id: ctx.org.org_id,
					anchor_brain_id: anchor.brain_id
				},
				invitee: { party_id: crypto.randomUUID(), email, expires_at: expires }
			});

			return {
				...ok(
					`Started "${display}", connected to ${brainLabel(anchor)}. It is yours to prepare until ${email} joins it to a brain of their own. Anyone who can reach ${brainLabel(anchor)} can reach this room, so add people there rather than here.`
				),
				structuredContent: {
					connection_id: connectionId,
					name: display,
					brain: brainId,
					anchor: anchor.id,
					invited: email
				}
			};
		}
	);

	// ---------- accept_connection ----------
	server.registerTool(
		'accept_connection',
		{
			title: 'Join a connection you were invited to',
			description:
				'accept_connection joins a shared working surface someone at another organization started with you. You name one of YOUR brains for it to hang off: whoever can reach that brain can reach the room, so this is also how you decide who on your side is in it. Call connections first to see what is waiting for you. Until you join, nobody at your organization can reach the room at all.',
			inputSchema: {
				connection: z.string().describe('Which invitation to accept, by the connection’s name.'),
				about: z
					.string()
					.describe(
						'Which of YOUR brains to join it to. Everyone who can reach that brain will be able to reach the room.'
					),
				org: z
					.string()
					.optional()
					.describe('Which of your organizations is joining. Defaults to the active brain’s.')
			}
		},
		async ({ connection, about, org }) => {
			let ctx: OrgScope;
			try {
				ctx = await orgContext({ requires: 'admin', org });
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
			const waiting = await pendingPartiesForEmails(ctx.db, await personEmails(), now());
			if (waiting.length === 0) return fail('You have no connection invitations waiting.');
			const q = connection.trim().toLowerCase();
			const hits = waiting.filter(
				(w) => w.connectionName.toLowerCase() === q || w.connectionName.toLowerCase().includes(q)
			);
			if (hits.length === 0) {
				return fail(
					`No invitation matching "${connection}". Waiting for you: ${waiting.map((w) => w.connectionName).join(', ')}.`
				);
			}
			if (hits.length > 1) {
				return fail(
					`"${connection}" matches several invitations: ${hits.map((w) => w.connectionName).join(', ')}. Be more specific.`
				);
			}
			const target = hits[0];

			const mine = (await listBrains()).filter((b) => b.org_id === ctx.org.org_id);
			const m = matchBrain(mine, about);
			if (!m.brain) {
				const names = mine.map(brainLabel);
				return fail(
					m.candidates
						? `"${about}" matches several of your brains: ${(m.candidates ?? []).map(brainLabel).join(', ')}. Be more specific.`
						: `No brain of yours matching "${about}". You could use: ${names.join(', ')}.`
				);
			}

			await joinConnection(ctx.db, {
				party_id: target.party_id,
				org_id: ctx.org.org_id,
				anchor_brain_id: m.brain.brain_id
			});
			const parties = await partiesOf(ctx.db, target.connection_id);
			return {
				...ok(
					`Joined "${target.connectionName}", connected to ${brainLabel(m.brain)}. Anyone who can reach ${brainLabel(m.brain)} can now reach this room, so add people there rather than here.`
				),
				structuredContent: {
					connection_id: target.connection_id,
					name: target.connectionName,
					anchor: m.brain.id,
					parties: parties.length,
					switched: false
				}
			};
		}
	);

	// ---------- end_connection ----------
	server.registerTool(
		'end_connection',
		{
			title: 'End a connection',
			description:
				'end_connection stops a shared working surface between two organizations. Either side can do it and neither needs the other to agree, because a relationship one party cannot leave is not a relationship. Access stops immediately for everyone on both sides, and neither side keeps the original: each organization is left a read-only copy of what was in it. Use this when an engagement finishes or a relationship ends. It is not disconnect_brain, which deletes a brain outright, and it is not reversible: a new connection would be a new room.',
			inputSchema: {
				connection: z.string().describe('Which connection to end, by name.'),
				reason: z.string().optional().describe('Optional note for the record about why it ended.')
			}
		},
		async ({ connection }) => {
			const ctx = await getContext();
			const mine = await listOrgs();
			const adminOrgs = mine.filter((o) => roleAtLeast(o.role, 'admin')).map((o) => o.org.org_id);
			const brains = await listBrains();
			const reachable = (
				await connectionsForAnchors(
					ctx.db,
					brains.map((b) => b.brain_id)
				)
			).map((r) => r.connection);
			// Connections already ENDING are resolvable too, and they have to be: ending one
			// detaches the anchors, and the anchors are the only way to name a connection.
			// Without this the copies could never be resumed, because nobody could refer to
			// the connection that owes them. Reaching it here is not reaching the ROOM, which
			// stays archived and unreachable for everyone.
			const resumable = await endingConnectionsForOrgs(ctx.db, adminOrgs);
			const candidates = [...reachable, ...resumable];
			const q = connection.trim().toLowerCase();
			const hits = candidates.filter(
				(c) => c.name.toLowerCase() === q || c.name.toLowerCase().includes(q)
			);
			if (hits.length === 0) {
				const names = candidates.map((c) => c.name);
				return fail(
					names.length
						? `No connection matching "${connection}". You can end: ${names.join(', ')}.`
						: 'None of your brains are connected to anything.'
				);
			}
			if (new Set(hits.map((h) => h.connection_id)).size > 1) {
				return fail(
					`"${connection}" matches several: ${hits.map((h) => h.name).join(', ')}. Be more specific.`
				);
			}
			const target = hits[0];

			// EITHER party may end it, so the gate is admin in ANY organization that is a
			// party. Deliberately not the brain role: roles on a connection are derived and
			// capped at editor, so there is no brain admin to gate on, and gating on the
			// room would let the counterparty's people end a relationship your own owner
			// could not.
			const parties = await partyOrgIds(ctx.db, target.connection_id);
			const canEnd = mine.some(
				(o) => parties.includes(o.org.org_id) && roleAtLeast(o.role, 'admin')
			);
			if (!canEnd) {
				return fail(
					`Ending "${target.name}" needs admin access in one of the organizations that is party to it.`
				);
			}

			// ONE conditional UPDATE is the whole concurrency guard: a second caller has to
			// lose rather than run the sequence twice. It also makes this call idempotent,
			// which is what lets the same tool drive the resume.
			const claimed = await beginEndConnection(ctx.db, target.connection_id, ctx.actorUserId ?? '');
			if (claimed) {
				// Access stops HERE, before any copying, and in one statement because access
				// was derived from the anchors rather than granted. There are no grant rows
				// to hunt down and none to forget.
				await detachAnchors(ctx.db, target.connection_id);
				// Archived, never deleted. The content has to outlive the relationship, or a
				// copy that fails to be made now could never be made at all.
				await archiveBrain(ctx.db, target.brain_id);
			}

			const mirrors = await advanceMirrors(ctx.db, target.connection_id);
			const headline = claimed
				? `Ended "${target.name}". Nobody on either side can reach it any more.`
				: `"${target.name}" has already ended.`;
			return {
				...ok(`${headline}${mirrors.note}`),
				structuredContent: {
					connection_id: target.connection_id,
					name: target.name,
					state: mirrors.done ? 'ended' : 'ending',
					mirrorsReady: mirrors.done
				}
			};
		}
	);
}
