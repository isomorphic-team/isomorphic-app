// Member-management tools — the org-admin surface for the roster.
//
// One roster tool, two audiences: `members` both opens the interactive roster in
// the Isomorphic app (MCP Apps / SEP-1865, where an admin gets inline role dropdowns
// and an invite box) AND returns the roster as text, so the user can say "who's on
// my team?" and the model can reason over it. The mutations (`invite_member` /
// `set_member_role` / `remove_member`) are conversational; the app drives edits by
// calling them back through the host, riding the same OAuth token.
//
// Authorization (enforced here, not in the lib):
//   • Reading the roster is open to any member (viewer+).
//   • Mutations require admin+ (getContext({ requires: 'admin' })).
//   • Lockout-proof guardrails: the OWNER role is never assignable, never
//     removable, and never demotable through these tools, so every org keeps one
//     recoverable super-user. An actor can't edit or remove THEMSELVES (the owner
//     can always fix a mistake), and can't grant a role above their own.
//
// Scope: everything is bound to the caller's resolved org (ctx.orgId). The legacy
// github/static single-tenant paths have no org row, so these tools reject there
// with a clear "organization accounts only" message.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	type TenantOpts,
	type Role,
	type Member,
	type Invite,
	listMembers,
	listPendingInvites,
	getMemberRole,
	getAppUserByEmail,
	addMembership,
	setMemberRole,
	removeMembership,
	deleteUserBrainGrantsInOrg,
	createInvitation,
	revokeInvite,
	roleAtLeast,
	roleLabel,
	parseRole
} from '../lib/orgs.ts';

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

// Member tools are org-scoped; the org follows the selected brain, so `brain` picks
// which brain's org roster to act on (defaults to the active brain).
const brainArg = z
	.string()
	.optional()
	.describe("Which brain's organization to target (name/handle). Defaults to the active brain.");

// Resolve the org scope, or throw the caller-facing "org accounts only" error. The
// product-native (authjs) path always sets both; the legacy single-tenant paths
// never do — member management doesn't apply to a single-tenant install.
function requireOrg(ctx: BrainContext): { orgId: string; actorUserId: string } {
	if (!ctx.orgId || !ctx.actorUserId) {
		throw new Error(
			'Member management is only available for organization accounts (this connection is a single-tenant install).'
		);
	}
	return { orgId: ctx.orgId, actorUserId: ctx.actorUserId };
}

// The roster payload shared by every member tool's structuredContent, so the app
// renders identically whether it was opened (members) or refreshed after a
// mutation. `me` lets the UI gate affordances (admin+ manages; you can't edit your
// own row) without a second round-trip.
async function roster(ctx: BrainContext, orgId: string, actorUserId: string) {
	const [members, invites] = await Promise.all([
		listMembers(ctx.db, orgId),
		listPendingInvites(ctx.db, orgId)
	]);
	return {
		view: 'members' as const,
		members,
		invites,
		me: { user_id: actorUserId, role: ctx.orgRole },
		activeBrain: ctx.activeBrain
	};
}

// Plain-text roster for non-UI hosts (Claude Code, Inspector) and as the readable
// summary the model narrates back.
function rosterText(members: Member[], invites: Invite[]): string {
	const lines = members.map((m) => {
		const who = m.name ? `${m.name} <${m.email}>` : m.email;
		return `- ${who} — ${roleLabel(m.role)}`;
	});
	let text = members.length ? `Members (${members.length}):\n${lines.join('\n')}` : 'No members.';
	if (invites.length) {
		text +=
			`\n\nPending invites (${invites.length}):\n` +
			invites.map((i) => `- ${i.email} — ${roleLabel(i.role)} (invited)`).join('\n');
	}
	return text;
}

export function registerMemberTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	// ---------- members (roster: interactive widget + data) ----------
	// One tool, both modes: it renders the inline roster for the user AND returns the
	// roster as text the model can reason over (e.g. before a member mutation). The
	// widget always renders (its _meta.ui is static), which for this low-frequency
	// admin surface is fine — see the "tool-surface consolidation" note.
	registerAppTool(
		server,
		'members',
		{
			title: 'Organization members',
			description:
				"The organization's members and roles (Viewer / Editor / Admin / Owner) plus pending invites — shown inline as the interactive Isomorphic roster (admins get controls to invite, change roles, and remove people) AND returned as text you can reason over. Call it whenever the user wants to see, check, or manage members / who has access / their team, and whenever YOU need the roster as data (e.g. before invite_member / set_member_role / remove_member).",
			inputSchema: { brain: brainArg },
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ brain }) => {
			const ctx = await getContext({ brain });
			const { orgId, actorUserId } = requireOrg(ctx);
			const sc = await roster(ctx, orgId, actorUserId);
			return {
				content: [{ type: 'text' as const, text: rosterText(sc.members, sc.invites) }],
				structuredContent: sc
			};
		}
	);

	// ---------- invite_member (admin+) ----------
	server.registerTool(
		'invite_member',
		{
			title: 'Invite a person to the organization',
			description:
				"Invite someone to the organization by email at a given role (Viewer, Editor, or Admin — default Editor). If they've already signed in, they're added immediately; otherwise they join automatically at their first sign-in. Admin only.",
			inputSchema: {
				email: z.string().describe("The invitee's email address."),
				role: z
					.enum(['viewer', 'editor', 'admin'])
					.optional()
					.describe('Role to grant (viewer | editor | admin). Defaults to editor.'),
				brain: brainArg
			}
		},
		async ({ email, role, brain }) => {
			const ctx = await getContext({ requiresOrg: 'admin', brain });
			const { orgId, actorUserId } = requireOrg(ctx);
			const emailTrim = email.trim();
			if (!emailTrim || !emailTrim.includes('@'))
				return fail(`"${email}" is not a valid email address.`);
			const target: Role = role ?? 'editor';
			if (!roleAtLeast(ctx.orgRole, target)) {
				return fail(`You can't grant a role higher than your own (${roleLabel(ctx.orgRole)}).`);
			}

			const existing = await getAppUserByEmail(ctx.db, emailTrim);
			if (existing) {
				const current = await getMemberRole(ctx.db, orgId, existing.user_id);
				if (current) {
					return fail(
						`${existing.email} is already a member (${roleLabel(current)}). Use set_member_role to change their role.`
					);
				}
				// Already signed in but not in this org → add directly. (An unaccepted
				// invitation would never fire for them: first-sign-in provisioning, which
				// consumes invites, short-circuits for a user who already has an account.)
				await addMembership(ctx.db, { org_id: orgId, user_id: existing.user_id, role: target });
				const sc = await roster(ctx, orgId, actorUserId);
				return {
					content: [
						{
							type: 'text' as const,
							text: `Added ${existing.email} as ${roleLabel(target)}.`
						}
					],
					structuredContent: sc
				};
			}

			// Brand-new email → pending invitation, consumed at first sign-in.
			await createInvitation(ctx.db, {
				invite_id: crypto.randomUUID(),
				org_id: orgId,
				email: emailTrim,
				role: target,
				invited_by: actorUserId
			});
			const sc = await roster(ctx, orgId, actorUserId);
			return {
				content: [
					{
						type: 'text' as const,
						text: `Invited ${emailTrim} as ${roleLabel(target)} — they'll join automatically when they first sign in.`
					}
				],
				structuredContent: sc
			};
		}
	);

	// ---------- set_member_role (admin+) ----------
	server.registerTool(
		'set_member_role',
		{
			title: "Change a member's role",
			description:
				"Change an existing member's role to Viewer, Editor, or Admin. Admin only. You can't change your own role or the owner's.",
			inputSchema: {
				email: z.string().describe('Email of the member to change.'),
				role: z.enum(['viewer', 'editor', 'admin']).describe('New role: viewer | editor | admin.'),
				brain: brainArg
			}
		},
		async ({ email, role, brain }) => {
			const ctx = await getContext({ requiresOrg: 'admin', brain });
			const { orgId, actorUserId } = requireOrg(ctx);
			const next = parseRole(role);
			if (!next || next === 'owner') return fail(`"${role}" is not an assignable role.`);
			if (!roleAtLeast(ctx.orgRole, next)) {
				return fail(`You can't grant a role higher than your own (${roleLabel(ctx.orgRole)}).`);
			}

			const user = await getAppUserByEmail(ctx.db, email.trim());
			const current = user ? await getMemberRole(ctx.db, orgId, user.user_id) : null;
			if (!user || !current) return fail(`${email.trim()} is not a member of this organization.`);
			if (user.user_id === actorUserId) return fail("You can't change your own role.");
			if (current === 'owner') return fail("The owner's role can't be changed here.");
			if (current === next) {
				return fail(`${user.email} is already ${roleLabel(next)}.`);
			}

			await setMemberRole(ctx.db, orgId, user.user_id, next);
			const sc = await roster(ctx, orgId, actorUserId);
			return {
				content: [{ type: 'text' as const, text: `${user.email} is now ${roleLabel(next)}.` }],
				structuredContent: sc
			};
		}
	);

	// ---------- remove_member (admin+) ----------
	// Removes a person from the org whether they're an accepted member (delete the
	// membership) or only a pending invite (revoke it). Owner is never removable;
	// you can't remove yourself.
	server.registerTool(
		'remove_member',
		{
			title: 'Remove a person from the organization',
			description:
				"Remove someone from the organization by email — revokes their access, or cancels a pending invitation if they haven't joined yet. Admin only. You can't remove yourself or the owner.",
			inputSchema: {
				email: z.string().describe('Email of the member or pending invite to remove.'),
				brain: brainArg
			}
		},
		async ({ email, brain }) => {
			const ctx = await getContext({ requiresOrg: 'admin', brain });
			const { orgId, actorUserId } = requireOrg(ctx);
			const emailTrim = email.trim();
			const user = await getAppUserByEmail(ctx.db, emailTrim);
			const current = user ? await getMemberRole(ctx.db, orgId, user.user_id) : null;

			if (user && current) {
				if (user.user_id === actorUserId) return fail("You can't remove yourself.");
				if (current === 'owner') return fail("The owner can't be removed.");
				// Membership AND every per-brain grant they hold in this org. Leaving the
				// grants behind would make removal a no-op for any brain they had been
				// shared individually; they would still resolve access to it.
				await removeMembership(ctx.db, orgId, user.user_id);
				await deleteUserBrainGrantsInOrg(ctx.db, orgId, user.user_id);
				const sc = await roster(ctx, orgId, actorUserId);
				return {
					content: [
						{ type: 'text' as const, text: `Removed ${user.email} from the organization.` }
					],
					structuredContent: sc
				};
			}

			// Not an accepted member — maybe a pending invite for this email.
			const invites = await listPendingInvites(ctx.db, orgId);
			const pending = invites.filter((i) => i.email.toLowerCase() === emailTrim.toLowerCase());
			if (pending.length) {
				for (const inv of pending) await revokeInvite(ctx.db, orgId, inv.invite_id);
				const sc = await roster(ctx, orgId, actorUserId);
				return {
					content: [
						{ type: 'text' as const, text: `Revoked the pending invite for ${emailTrim}.` }
					],
					structuredContent: sc
				};
			}

			return fail(`No member or pending invite found for ${emailTrim}.`);
		}
	);
}
