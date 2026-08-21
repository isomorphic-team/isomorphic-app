// Organization usage analytics: how much the org actually uses its brains, by
// person and by brain.
//
// ONE TOOL, TWO AUDIENCES, the `members` pattern: it opens the interactive tab in
// the Isomorphic app AND returns the numbers as text the model can reason over
// ("who has not touched the brain this month?").
//
// SCOPE AND GATING. This is an ORG-scope surface: every brain in one org shows
// the same tab, so it sits in the nav's Organization group beside Members, and
// its authorization reads ctx.orgRole, never ctx.role. Gating on the brain role
// would let one shared brain confer visibility into the whole organization's
// behaviour, which is the exact conflation docs/design/brain-level-permissions.md
// exists to prevent.
//
// The two halves are gated differently, on purpose:
//   • ORG TOTALS and the per-brain table are open to any member (viewer+), like
//     the roster. They say how the organization is doing.
//   • THE PEOPLE TABLE is admin+. Per-person read counts are a record of what a
//     colleague did with their week, which is a materially different thing to
//     publish than the roster's names and emails. Non-admins get the totals with
//     no people rows attached, and the payload says so rather than sending data
//     the widget is trusted to hide.
//
// Registered ONLY when USAGE_ANALYTICS is on (src/worker.ts). With recording off
// there is nothing to show, and a tab that renders a permanent wall of zeroes is
// worse than no tab.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	type TenantOpts,
	brainLabel,
	getOrgById,
	listBrainsInOrg,
	listMembers,
	roleAtLeast
} from '../lib/orgs.ts';
import { readUsage } from '../lib/usage-store.ts';
import { dayKey, shiftDay, summarize, summaryText, FOOTNOTE } from '../lib/usage.ts';

const DEFAULT_DAYS = 30;
// 90 days is the point past which one D1 read stops being obviously cheap. The
// window is a parameter rather than a fixed month because "since we onboarded"
// is the question a new org actually asks.
const MAX_DAYS = 90;

const brainArg = z
	.string()
	.optional()
	.describe("Which brain's organization to report on (name/handle). Defaults to the active brain.");

export function registerAnalyticsTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	registerAppTool(
		server,
		'analytics',
		{
			title: 'Organization usage analytics',
			description:
				'Show how much the organization is using its brains: how many members were active, reads vs edits over time, a per-brain breakdown, and (for admins) a per-person table including members who have not used it at all. Call `analytics` when the user asks about usage, adoption, engagement, activity levels, who is or is not using the brain, or how a brain is being used over time. Counts activity in Isomorphic only; edits made directly on GitHub are not included (use view_activity for the repository history).',
			inputSchema: {
				days: z
					.number()
					.optional()
					.describe(`How many days back to report on (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).`),
				brain: brainArg
			},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
		},
		async ({ days, brain }) => {
			const ctx = await getContext({ brain });
			if (!ctx.orgId) {
				throw new Error(
					'Usage analytics is only available for organization accounts (this connection is a single-tenant install).'
				);
			}
			const orgId = ctx.orgId;
			const span = Math.min(Math.max(1, Math.round(days ?? DEFAULT_DAYS)), MAX_DAYS);
			const to = dayKey(new Date());
			const from = shiftDay(to, -(span - 1));

			const [usage, roster, orgBrains, org] = await Promise.all([
				readUsage(ctx.db, orgId, from, to),
				listMembers(ctx.db, orgId),
				listBrainsInOrg(ctx.db, orgId),
				getOrgById(ctx.db, orgId)
			]);

			const summary = summarize({
				rows: usage.rows,
				roster: roster.map((m) => ({
					user_id: m.user_id,
					name: m.name,
					email: m.email,
					role: m.role
				})),
				// usage_daily records ctx.brainId, which is "owner/repo" — not the
				// brains-table PK. Derive the same key here or every brain row reads zero.
				brains: orgBrains.map((b) => ({
					brain_id: `${b.repo_owner}/${b.repo_name}`,
					label: brainLabel(b)
				})),
				from,
				to
			});

			const orgName =
				org?.model === 'platform' ? 'Personal' : (org?.name?.trim() ?? 'your organization');
			const canSeePeople = !!ctx.orgRole && roleAtLeast(ctx.orgRole, 'admin');
			// Withheld rather than hidden: a non-admin's payload never carries the
			// per-person numbers at all, so the gate does not depend on the widget.
			const people = canSeePeople ? summary.people : [];

			return {
				content: [
					{
						type: 'text' as const,
						text: summaryText({ ...summary, people }, orgName)
					}
				],
				structuredContent: {
					view: 'analytics' as const,
					orgName,
					window: summary.window,
					totals: summary.totals,
					series: summary.series,
					brains: summary.brains,
					people,
					canSeePeople,
					truncated: usage.truncated,
					footnote: FOOTNOTE,
					activeBrain: ctx.activeBrain
				}
			};
		}
	);
}
