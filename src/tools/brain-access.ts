// Brain-sharing tools: the per-brain access surface.
//
// The brain-scope sibling of src/tools/members.ts. That file moves `memberships`
// (who is in the ORG, and at what org role); this one moves `brain_memberships`
// plus `brains.visibility` (who can reach ONE brain, and at what brain role).
// Keeping them apart is the point of the model:
//
//   ORG role:   invite/remove people, set org roles, create, connect, and
//               disconnect brains. (create_org makes a new org and needs no role.)
//   BRAIN role: read, write, move/delete pages, configure, share.
//
// Authorization (enforced here, not in the lib):
//   • Reading a brain's access list needs only access to that brain (any role):
//     knowing who else is in a room you are already in is not privileged.
//   • Mutations require ADMIN ON THE BRAIN (`requires: 'admin'`), which an org
//     admin always has via the floor, and a creator has via their own grant.
//   • Guardrails: you can't grant above your own brain role, someone outside the
//     brain's org is a GUEST capped at editor (GUEST_ROLE_CAP), and you can't
//     revoke your own access (an org admin can always fix a mistake, and this
//     stops someone locking themselves out of their own brain).
//
// Two tools, not four: `brain_access` reads (widget + data), `share_brain` writes
// every mutation: grant, change role, revoke (`access: 'none'`), and the
// org-wide visibility flip. Revoke and re-share are the same verb from the user's
// side, and a separate unshare_brain would be a third name for it.

import type { McpServer } from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	type TenantOpts,
	type Role,
	type BrainAccessEntry,
	listBrainAccess,
	listPendingBrainInvites,
	getBrainGrant,
	setBrainGrant,
	removeBrainGrant,
	setBrainVisibility,
	getAppUserByEmail,
	getMemberRole,
	createInvitation,
	getPendingBrainInvite,
	cancelBrainInvites,
	roleAtLeast,
	roleLabel,
	parseRole,
	GUEST_ROLE_CAP
} from '../lib/orgs.ts';
import { webPathFor } from '../lib/web-app.ts';
import { brainArgFor, fail } from './shared.ts';
import type { BrainAccessWire } from '../lib/tool-payloads.ts';

const brainArg = brainArgFor(
	"Which brain's sharing to act on (name/handle). Defaults to the active brain."
);

// The brain a tool call resolved to, as the access tools need it: the PK to write
// grants against plus its current visibility.
async function resolveBrainRow(
	ctx: BrainContext
): Promise<{ brain_id: string; visibility: string; org_id: string } | null> {
	return await ctx.db
		.prepare(`SELECT brain_id, visibility, org_id FROM brains WHERE brain_id = ?1`)
		.bind(ctx.brainId)
		.first<{ brain_id: string; visibility: string; org_id: string }>();
}

// The shared structuredContent payload, so the panel renders identically whether
// it was opened (brain_access) or refreshed after a mutation. `me` lets the UI
// gate affordances (admin+ shares; you can't revoke yourself) in one round-trip.
async function accessPayload(
	ctx: BrainContext,
	row: { brain_id: string; visibility: string; org_id: string }
): Promise<BrainAccessWire> {
	const [entries, invites] = await Promise.all([
		listBrainAccess(ctx.db, row.brain_id, row.org_id, row.visibility),
		listPendingBrainInvites(ctx.db, row.brain_id)
	]);
	return {
		view: 'brain-access' as const,
		access: entries,
		// Shares to addresses with no account yet, claimed as grants once that address signs in.
		invites,
		visibility: row.visibility,
		activeBrain: ctx.activeBrain,
		me: { user_id: ctx.actorUserId ?? '', role: ctx.role, orgRole: ctx.orgRole }
	};
}

// Plain-text rendering for non-UI hosts (Claude Code, Inspector) and as the
// summary the model narrates back.
function accessText(
	label: string,
	visibility: string,
	entries: BrainAccessEntry[],
	invites: { email: string; role: Role }[] = []
): string {
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
				: e.via === 'guest'
					? 'guest, not in the organization'
					: e.via === 'org'
						? 'via organization'
						: 'via organization admin';
		return `- ${who}: ${roleLabel(e.role)} (${how})`;
	});
	const pending = invites.map(
		(i) => `- ${i.email}: ${roleLabel(i.role)} (invited, not signed in yet)`
	);
	return [head, ...lines, ...pending].join('\n');
}

// Why a share to someone outside the organization cannot be written, or null.
// Admin on a brain is the power to decide who reaches it, and that stays with
// people the organization can see on its roster (effectiveBrainRole caps a guest
// the same way, so this is the message and that is the invariant).
function guestRefusal(actorRole: Role, target: Role): string | null {
	if (!roleAtLeast(actorRole, target)) {
		return `You can't grant more access than you have on this brain (${roleLabel(actorRole)}).`;
	}
	if (roleAtLeast(target, 'admin')) {
		return `Someone outside the organization can be a guest ${roleLabel(GUEST_ROLE_CAP)} of this brain at most, not an admin. Invite them to the organization with invite_member if they should manage who reaches it.`;
	}
	return null;
}

export function registerBrainAccessTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	opts: { webBaseUrl?: string } = {}
) {
	// Where a guest who has never signed in goes. The web app's URL for the brain
	// when this deployment serves one; otherwise the connector is the only door.
	const signInHint = (brainId: string): string =>
		opts.webBaseUrl
			? `They sign in at ${opts.webBaseUrl}${webPathFor(brainId, '')} with that email address (a magic link), or connect Isomorphic in Claude with it.`
			: `They connect Isomorphic in Claude and sign in with that email address (a magic link).`;
	// ---------- brain_access (sharing panel: interactive widget + data) ----------
	registerAppTool(
		server,
		'brain_access',
		{
			title: 'Who can access this brain',
			description:
				"Show who can reach a brain and at what level (Viewer / Editor / Admin), and whether it's private or shared with the whole organization: rendered inline as the interactive Isomorphic sharing panel (brain admins get controls to share, change access, and revoke) AND returned as text you can reason over. Call brain_access whenever the user asks who can see / who has access to / who a brain is shared with, and whenever YOU need that list as data. This is per-BRAIN access, not the organization's roster of members.",
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
						text: accessText(ctx.activeBrain.label, sc.visibility, sc.access, sc.invites)
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
				"Change who can access a brain. Either share it with ONE person by email at a given level (`email` + `access`: viewer | editor | admin, or `none` to revoke), or change the brain's overall `visibility` ('private' = only people it's shared with, 'org' = everyone in the organization). Use when the user wants to share / unshare a brain, give someone access, change what someone can do in a brain, or make a brain private or organization-wide. Requires admin on that brain. The person does NOT need to be in the organization: someone outside it becomes a GUEST of this one brain (viewer or editor, never admin) and reaches nothing else, and an address with no account yet is invited and joins as a guest when they first sign in. share_brain changes access to this one brain only, never anyone's organization membership or role.",
			inputSchema: z.object({
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
			})
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
				if (!emailTrim.includes('@')) return fail(`"${emailTrim}" is not an email address.`);
				const user = await getAppUserByEmail(ctx.db, emailTrim);

				// No account yet: a BRAIN invite, claimed as a grant once the address signs in.
				// Never a membership, so sharing cannot widen what they reach.
				if (!user) {
					const pending = await getPendingBrainInvite(ctx.db, row.brain_id, emailTrim);
					if (access === 'none') {
						if (!pending) {
							notes.push(`${emailTrim} has no account and no pending invitation to this brain.`);
						} else {
							await cancelBrainInvites(ctx.db, row.brain_id, emailTrim);
							notes.push(`Cancelled ${emailTrim}'s invitation to "${ctx.activeBrain.label}".`);
						}
					} else {
						const target: Role = access ? (parseRole(access) ?? 'editor') : 'editor';
						const refused = guestRefusal(ctx.role, target);
						if (refused) return fail(refused);
						if (pending) await cancelBrainInvites(ctx.db, row.brain_id, emailTrim);
						await createInvitation(ctx.db, {
							invite_id: crypto.randomUUID(),
							org_id: ctx.orgId,
							brain_id: row.brain_id,
							email: emailTrim,
							role: target,
							invited_by: ctx.actorUserId
						});
						notes.push(
							`Invited ${emailTrim} to "${ctx.activeBrain.label}" as ${roleLabel(target)}: they'll be a guest of this brain once they sign in. ${signInHint(ctx.activeBrain.id)}`
						);
					}
					const sc = await accessPayload(ctx, row);
					return {
						content: [{ type: 'text' as const, text: notes.join(' ') }],
						structuredContent: sc
					};
				}

				// A non-member is a GUEST of this one brain: reachable now that
				// listAccessibleBrains walks grants as well as memberships, and capped
				// at editor by the rule and by the refusal below.
				const orgRole = await getMemberRole(ctx.db, ctx.orgId, user.user_id);
				const guest = !orgRole;

				if (access === 'none') {
					await cancelBrainInvites(ctx.db, row.brain_id, user.email);
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
					if (guest) {
						const refused = guestRefusal(ctx.role, target);
						if (refused) return fail(refused);
					}
					const existing = await getBrainGrant(ctx.db, row.brain_id, user.user_id);
					await setBrainGrant(ctx.db, {
						brain_id: row.brain_id,
						user_id: user.user_id,
						role: target,
						granted_by: ctx.actorUserId
					});
					const asWhat = guest ? `a guest ${roleLabel(target)}` : roleLabel(target);
					notes.push(
						existing
							? `${user.email} is now ${asWhat} on "${ctx.activeBrain.label}".`
							: `Shared "${ctx.activeBrain.label}" with ${user.email} as ${asWhat}.`
					);
					if (guest && !existing) notes.push(signInHint(ctx.activeBrain.id));
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
