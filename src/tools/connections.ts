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
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import {
	brainLabel,
	getAppUserByEmail,
	matchBrain,
	type AccessibleBrain,
	type OrgScope,
	type Role,
	type TenantOpts
} from '../lib/orgs.ts';
import {
	INVITE_TTL_DAYS,
	connectionsForAnchors,
	createConnectionRecord,
	ensureConnectionsOrg,
	joinConnection,
	partiesOf,
	pendingPartiesForEmails,
	type Connection,
	type ConnectionParty
} from '../lib/connections.ts';
import { createAndScaffoldBrain } from '../lib/scaffold-core.ts';
import { createBrain } from '../lib/orgs.ts';

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}
function ok(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

export interface ConnectionDeps {
	getContext: (opts?: TenantOpts) => Promise<BrainContext>;
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
	// Every address this person signs in under. An invitation is addressed to an email
	// and claimed later, so looking at only the current one would hide an invitation
	// sent to another of their addresses.
	personEmails: () => Promise<string[]>;
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
	const { getContext, orgContext, platformContext, listBrains, personEmails, now } = deps;

	// ---------- connections (read) ----------
	server.registerTool(
		'connections',
		{
			title: 'Connections on this brain',
			annotations: { readOnlyHint: true },
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
			const ctx = await getContext({ brain });
			const rows = await connectionsForAnchors(ctx.db, [ctx.brainId]);
			const invitations = await pendingPartiesForEmails(ctx.db, await personEmails(), now());

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
					connections: rows.map((r) => ({
						connection_id: r.connection.connection_id,
						name: r.connection.name,
						state: r.connection.state,
						brain: r.connection.brain_id,
						parties: r.parties.map((p) => ({
							org_id: p.org_id,
							invited_email: p.invited_email,
							anchor_brain_id: p.anchor_brain_id,
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
}
