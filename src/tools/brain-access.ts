// Brain-sharing tools: the per-brain access surface.
//
// The brain-scope sibling of src/tools/members.ts. That file moves `memberships`
// (who is in the ORG, and at what org role); this one moves `brain_memberships`
// plus `brains.visibility` (who can reach ONE brain, and at what brain role).
// Keeping them apart is the point of the model:
//
//   ORG role:   invite/remove people, set org roles, connect the GitHub org,
//               create brains, connect/disconnect brains.
//   BRAIN role: read, write, move/delete pages, configure, share.
//
// Authorization (enforced here, not in the lib):
//   • Reading a brain's access list needs only access to that brain (any role):
//     knowing who else is in a room you are already in is not privileged.
//   • Mutations require ADMIN ON THE BRAIN (`requires: 'admin'`), which an org
//     admin always has via the floor, and a creator has via their own grant.
//   • Guardrails: you can only share with people already in the brain's org
//     (invite them to the org first), you can't grant above your own brain role,
//     and you can't revoke your own access (an org admin can always fix a
//     mistake, and this stops someone locking themselves out of their own brain).
//
// Two tools, not four: `brain_access` reads (widget + data), `share_brain` writes
// every mutation: grant, change role, revoke (`access: 'none'`), and the
// org-wide visibility flip. Revoke and re-share are the same verb from the user's
// side, and a separate unshare_brain would be a third name for it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { connectionForBrain } from '../lib/connections.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	type TenantOpts,
	type Role,
	type BrainAccessEntry,
	listBrainAccess,
	getBrainGrant,
	setBrainGrant,
	removeBrainGrant,
	setBrainVisibility,
	getAppUserByEmail,
	getMemberRole,
	roleAtLeast,
	roleLabel,
	parseRole
} from '../lib/orgs.ts';

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

const brainArg = z
	.string()
	.optional()
	.describe("Which brain's sharing to act on (name/handle). Defaults to the active brain.");

// The brain a tool call resolved to, as the access tools need it: the PK to write
// grants against plus its current visibility. tenantContext resolves a brain by
// repo, so look the row up by the canonical owner/repo id.
async function resolveBrainRow(
	ctx: BrainContext
): Promise<{ brain_id: string; visibility: string; org_id: string } | null> {
	return await ctx.db
		.prepare(
			`SELECT brain_id, visibility, org_id FROM brains WHERE repo_owner = ?1 AND repo_name = ?2`
		)
		.bind(ctx.repoArgs.owner, ctx.repoArgs.repo)
		.first<{ brain_id: string; visibility: string; org_id: string }>();
}

// The shared structuredContent payload, so the panel renders identically whether
// it was opened (brain_access) or refreshed after a mutation. `me` lets the UI
// gate affordances (admin+ shares; you can't revoke yourself) in one round-trip.
async function accessPayload(
	ctx: BrainContext,
	row: { brain_id: string; visibility: string; org_id: string }
) {
	const entries = await listBrainAccess(ctx.db, row.brain_id, row.org_id, row.visibility);
	return {
		view: 'brain-access' as const,
		access: entries,
		visibility: row.visibility,
		activeBrain: ctx.activeBrain,
		me: { user_id: ctx.actorUserId ?? '', role: ctx.role, orgRole: ctx.orgRole }
	};
}

// Plain-text rendering for non-UI hosts (Claude Code, Inspector) and as the
// summary the model narrates back.
function accessText(label: string, visibility: string, entries: BrainAccessEntry[]): string {
	const head =
		visibility === 'private'
			? `"${label}" is private: ${entries.length} ${entries.length === 1 ? 'person has' : 'people have'} access:`
			: `"${label}" is shared with everyone in the organization (${entries.length} ${entries.length === 1 ? 'person' : 'people'}):`;
	if (entries.length === 0) return head;
	const lines = entries.map((e) => {
		const who = e.name ? `${e.name} <${e.email}>` : e.email;
		const how =
			e.via === 'grant'
				? 'shared directly'
				: e.via === 'org'
					? 'via organization'
					: 'via organization admin';
		return `- ${who}: ${roleLabel(e.role)} (${how})`;
	});
	return `${head}\n${lines.join('\n')}`;
}

export function registerBrainAccessTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	// ---------- brain_access (sharing panel: interactive widget + data) ----------
	registerAppTool(
		server,
		'brain_access',
		{
			title: 'Who can access this brain',
			description:
				"Show who can reach a brain and at what level (Viewer / Editor / Admin), and whether it's private or shared with the whole organization: rendered inline as the interactive Isomorphic sharing panel (brain admins get controls to share, change access, and revoke) AND returned as text you can reason over. Call it whenever the user asks who can see / who has access to / who a brain is shared with, and whenever YOU need that list as data before calling share_brain. This is per-BRAIN access; for the organization's roster of people and their org roles, call members instead.",
			inputSchema: { brain: brainArg },
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ brain }) => {
			const ctx = await getContext({ brain });
			const row = await resolveBrainRow(ctx);
			if (!row) return fail('Brain sharing is only available for organization accounts.');
			const sc = await accessPayload(ctx, row);
			return {
				content: [
					{
						type: 'text' as const,
						text: accessText(ctx.activeBrain.label, sc.visibility, sc.access)
					}
				],
				structuredContent: sc
			};
		}
	);

	// ---------- share_brain (brain admin+) ----------
	// Every mutation on a brain's access, in one verb: share with a person, change
	// what they can do, revoke them (`access: 'none'`), and flip the brain between
	// private and organization-wide.
	server.registerTool(
		'share_brain',
		{
			title: 'Share a brain / change who can access it',
			description:
				"Change who can access a brain. Either share it with ONE person by email at a given level (`email` + `access`: viewer | editor | admin, or `none` to revoke), or change the brain's overall `visibility` ('private' = only people it's shared with, 'org' = everyone in the organization). Use when the user wants to share / unshare a brain, give someone access, change what someone can do in a brain, or make a brain private or organization-wide. Requires admin on that brain. The person must already be a member of the organization: invite them with invite_member first. To change someone's ORGANIZATION role instead, use set_member_role.",
			inputSchema: {
				email: z
					.string()
					.optional()
					.describe(
						'Email of the person to share with (or revoke). Omit when only changing visibility.'
					),
				access: z
					.enum(['viewer', 'editor', 'admin', 'none'])
					.optional()
					.describe(
						"What they can do: viewer (read), editor (write), admin (also share). 'none' revokes their access. Defaults to editor when sharing with someone new."
					),
				visibility: z
					.enum(['private', 'org'])
					.optional()
					.describe(
						"'private' = only people the brain is shared with (plus organization admins); 'org' = every member of the organization."
					),
				brain: brainArg
			}
		},
		async ({ email, access, visibility, brain }) => {
			// BRAIN-scope admin: sharing changes who reaches this brain's content.
			const ctx = await getContext({ requires: 'admin', brain });
			const row = await resolveBrainRow(ctx);
			if (!row) return fail('Brain sharing is only available for organization accounts.');
			if (!ctx.orgId || !ctx.actorUserId) {
				return fail('Brain sharing is only available for organization accounts.');
			}
			if (!email && !visibility) {
				return fail(
					'Nothing to change: pass `email` (with `access`) to share with someone, or `visibility` to make the brain private or organization-wide.'
				);
			}
			// A CONNECTION has no audience of its own, so there is nothing here to share.
			// Access to one is derived from the brain each side joined it to, which is
			// what lets two organizations collaborate without either administering the
			// other's people. Without this the guardrail below would refuse every share
			// anyway (a connection's organization has no members), but with a message
			// about inviting someone to an organization that cannot be acted on.
			const connection = await connectionForBrain(ctx.db, row.brain_id);
			if (connection) {
				return fail(
					`"${connection.name}" is a connection, not an ordinary brain. Who can reach it follows from the brain each side joined it to, so to change who on your side can see it, change who can reach that brain.`
				);
			}

			const notes: string[] = [];

			// ----- visibility flip -----
			if (visibility && visibility !== row.visibility) {
				await setBrainVisibility(ctx.db, row.brain_id, visibility);
				row.visibility = visibility;
				notes.push(
					visibility === 'org'
						? `"${ctx.activeBrain.label}" is now visible to everyone in the organization.`
						: `"${ctx.activeBrain.label}" is now private: only people it's shared with (and organization admins) can reach it.`
				);
			} else if (visibility) {
				notes.push(
					visibility === 'org'
						? `"${ctx.activeBrain.label}" was already organization-wide.`
						: `"${ctx.activeBrain.label}" was already private.`
				);
			}

			// ----- per-person grant -----
			if (email) {
				const emailTrim = email.trim();
				const user = await getAppUserByEmail(ctx.db, emailTrim);
				if (!user) {
					return fail(
						`${emailTrim} doesn't have an account yet. Invite them to the organization first with invite_member: then you can share this brain with them.`
					);
				}
				// A brain can only be shared inside its own org: a grant to a non-member
				// would be unreachable anyway (listAccessibleBrains starts from
				// memberships), so writing one would be a silent no-op.
				const orgRole = await getMemberRole(ctx.db, ctx.orgId, user.user_id);
				if (!orgRole) {
					return fail(
						`${user.email} isn't a member of this organization. Invite them with invite_member first, then share the brain.`
					);
				}

				if (access === 'none') {
					if (user.user_id === ctx.actorUserId) {
						return fail(
							"You can't revoke your own access to a brain. Ask another admin to remove you."
						);
					}
					const existing = await getBrainGrant(ctx.db, row.brain_id, user.user_id);
					if (!existing) {
						notes.push(
							row.visibility === 'private'
								? `${user.email} wasn't shared on this brain.`
								: `${user.email} had no direct share to remove; they reach this brain because it's visible to the whole organization. Set visibility to 'private' to restrict it.`
						);
					} else {
						await removeBrainGrant(ctx.db, row.brain_id, user.user_id);
						notes.push(
							row.visibility === 'private'
								? `Removed ${user.email} from "${ctx.activeBrain.label}".`
								: `Removed ${user.email}'s direct share, but the brain is visible to the whole organization, so they can still reach it. Set visibility to 'private' to restrict it.`
						);
					}
				} else {
					const target: Role = access ? (parseRole(access) ?? 'editor') : 'editor';
					if (!roleAtLeast(ctx.role, target)) {
						return fail(
							`You can't grant more access than you have on this brain (${roleLabel(ctx.role)}).`
						);
					}
					const existing = await getBrainGrant(ctx.db, row.brain_id, user.user_id);
					await setBrainGrant(ctx.db, {
						brain_id: row.brain_id,
						user_id: user.user_id,
						role: target,
						granted_by: ctx.actorUserId
					});
					notes.push(
						existing
							? `${user.email} is now ${roleLabel(target)} on "${ctx.activeBrain.label}".`
							: `Shared "${ctx.activeBrain.label}" with ${user.email} as ${roleLabel(target)}.`
					);
				}
			}

			const sc = await accessPayload(ctx, row);
			return {
				content: [{ type: 'text' as const, text: notes.join(' ') }],
				structuredContent: sc
			};
		}
	);
}
