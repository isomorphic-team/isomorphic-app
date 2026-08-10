// Local host harness for the Isomorphic Brain MCP App.
//
// Nothing here is a reimplementation of the app. It:
//   1. Loads the REAL generated app bytes (BRAIN_APP_HTML — the exact string the
//      Worker serves as the ui:// resource) into a sandboxed iframe.
//   2. Drives it with the REAL host-side bridge (AppBridge from
//      @modelcontextprotocol/ext-apps) over the REAL PostMessageTransport — the
//      same machinery claude.ai uses.
//   3. Answers the app's callback tool calls (read_page / list_pages /
//      search_pages / edit_page / save_page) with REAL brain content pulled from
//      the live server.
//
// The only thing standing in for claude.ai is this file. The app can't tell the
// difference: it gets a spec-correct INITIALIZE handshake, a tool result, and
// live tool responses.

import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BRAIN_APP_HTML } from '../src/lib/app-bundle.generated.ts';
import { slugify, resolveRelative, parseFrontmatter } from '../src/lib/wiki.ts';
import { DEFAULT_BRAIN_CONFIG, isContentPath } from '../src/lib/brain-policy.ts';
import { renderViews, stripSnapshots, hasViews, type ViewContext } from '../src/lib/views.ts';
// The REAL per-brain access rule (pure, no D1) so the sharing preview resolves
// exactly like prod: org visibility + explicit grants + the org-admin floor.
import { effectiveBrainRole, roleLabel, roleAtLeast, type Role } from '../src/lib/orgs.ts';
import {
	dayKey,
	shiftDay,
	summarize,
	summaryText,
	FOOTNOTE,
	type UsageRow
} from '../src/lib/usage.ts';
import PAGES from './fixtures.json';

// Per-brain content. Previously a single shared `pages` map backed every brain, so
// switching brains (or a one-shot `brain:` arg) showed identical pages and you
// couldn't tell them apart. Now each brain has its OWN content: the Personal brain
// uses the rich shared fixtures; the team/client brains get small, obviously-distinct
// sets. Keyed by brain id (matches brainsFixture ids below).
const PERSONAL_PAGES = PAGES as Record<string, string>;
// Seed an otherwise-empty folder (persisted by a hidden .gitkeep) so the preview
// exercises the "empty folder shows" + "show hidden" behavior out of the box.
PERSONAL_PAGES['wiki/Projects/.gitkeep'] ??= '';

// Seed the config file itself so the "show hidden" toggle has the real system
// files to reveal (mirrors prod, where every brain repo carries one).
PERSONAL_PAGES['.isomorphic.json'] ??=
	'{\n  "paths": {\n    "wiki/": "content",\n    "raw/": "source",\n    "wiki/log.md": "log"\n  }\n}\n';

// Mirror of the server's visible/hidden split (list_pages): visible = content
// pages; EVERYTHING else (system files, .gitkeep, source, the log) is hidden.
// The fixtures all use the default wiki/+raw/ layout, so the default config is
// the right policy here.
const isContentPage = (p: string) => p.endsWith('.md') && isContentPath(p, DEFAULT_BRAIN_CONFIG);
const ACME_PAGES: Record<string, string> = {
	'wiki/index.md':
		'---\ntitle: Acme\n---\n\nKnowledge base for **Acme**. Start with our [[mission]] and the [[onboarding]] program.\n',
	'wiki/concepts/mission.md':
		'---\ntitle: Mission\n---\n\nAcme builds tools for small teams. See the [[content-pipeline]] for how we publish.\n',
	'wiki/programs/onboarding.md':
		'---\ntitle: Onboarding\n---\n\nOur flagship customer onboarding program. Run by [[lead]].\n',
	'wiki/people/lead.md':
		'---\ntitle: Team Lead\n---\n\nLeads Acme; owns the [[mission]] and the [[onboarding]] program.\n',
	'wiki/playbooks/content-pipeline.md':
		'---\ntitle: Content Pipeline\n---\n\nHow drafts move from research to published KB pages.\n'
};
const NORTHWIND_PAGES: Record<string, string> = {
	'wiki/index.md':
		'---\ntitle: Northwind\n---\n\nOperations wiki for **Northwind**. See the [[headquarters]] and [[intake]].\n',
	'wiki/facilities/headquarters.md':
		'---\ntitle: Headquarters\n---\n\nPrimary site. Intake follows the [[intake]] process; ops lead is the [[director]].\n',
	'wiki/protocols/intake.md':
		'---\ntitle: Intake\n---\n\nStandard intake process for [[headquarters]].\n',
	'wiki/people/director.md':
		'---\ntitle: Operations Director\n---\n\nOwns operational processes including [[intake]].\n'
};
const brainContent: Record<string, Record<string, string>> = {
	'your-org/personal-wiki': PERSONAL_PAGES,
	'acme-co/acme-wiki': ACME_PAGES,
	'northwind/northwind-wiki': NORTHWIND_PAGES
};
// The content map for a brain (auto-vivify so a freshly connect_brain'd brain works).
function pagesFor(id: string): Record<string, string> {
	return (brainContent[id] ??= {});
}
// Which brain a content call targets. The app now threads the DISPLAYED brain into
// every call (see brainArgs() in app/main.tsx), so honor an explicit `brain` arg
// (id or fuzzy label); otherwise fall back to the active brain — exactly the server's
// tenantContext precedence. This is what makes switching brains change the content.
function contentBrainId(args: Record<string, unknown>): string {
	const q = String(args?.brain ?? '')
		.trim()
		.toLowerCase();
	if (q) {
		const hit = brainsFixture.find(
			(b) => b.id.toLowerCase() === q || b.label.toLowerCase().includes(q)
		);
		if (hit) return hit.id;
	}
	return activeBrainId;
}

// Which page the "opening" tool (view_page) renders first. Change via the
// selector in the host chrome.
let openPath = 'wiki/concepts/vision.md';

// In-memory org roster so `#members` previews the members view (list / invite /
// set role / remove) without a server. `ME` is the owner, so the preview shows the
// full admin control set. Roles are the DB tokens the real tools use.
type PreviewRole = 'viewer' | 'editor' | 'admin' | 'owner';
const ME = { user_id: 'u-me', role: 'owner' as PreviewRole };
let orgMembers: {
	user_id: string;
	email: string;
	name: string | null;
	github_login: string | null;
	role: PreviewRole;
	added_at: string;
}[] = [
	{
		user_id: 'u-me',
		email: 'owner@example.com',
		name: 'Ada Lovelace',
		github_login: 'octodev',
		role: 'owner',
		added_at: '2026-01-04T00:00:00Z'
	},
	{
		user_id: 'u-cael',
		email: 'cael@example.com',
		name: 'Grace Hopper',
		github_login: null,
		role: 'admin',
		added_at: '2026-03-11T00:00:00Z'
	},
	{
		user_id: 'u-mira',
		email: 'mira@example.com',
		name: 'Katherine Johnson',
		github_login: null,
		role: 'editor',
		added_at: '2026-05-02T00:00:00Z'
	},
	{
		user_id: 'u-devon',
		email: 'devon@example.com',
		name: null,
		github_login: null,
		role: 'viewer',
		added_at: '2026-06-20T00:00:00Z'
	}
];
// Usage fixtures for `#analytics`. Rows are synthesized here and folded by the REAL
// summarize() from src/lib/usage.ts, the same way the harness runs the real views
// engine — so the preview exercises the actual fold, not a hand-written payload.
//
// Shaped to make the states that matter visible at a glance: one heavy reader, one
// editor, one member who has never touched it (the actionable row), one departed
// user, a quiet weekend, and a second brain nobody opened.
function usageFixtureRows(days: number): UsageRow[] {
	const today = dayKey(new Date());
	const rows: UsageRow[] = [];
	// The real brain ids, so the per-brain table joins its labels instead of falling
	// back to raw ids and showing every fixture brain at zero.
	const B1 = brainsFixture[0].id;
	const push = (day: string, user: string, brain: string, tool: string, calls: number) => {
		if (calls > 0) rows.push({ day, user_id: user, brain_id: brain, tool, calls, errors: 0 });
	};
	for (let i = 0; i < days; i++) {
		const day = shiftDay(today, -i);
		const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
		const weekend = dow === 0 || dow === 6;
		// Deterministic pseudo-variation: no Math.random, so reloads are stable.
		const jitter = (n: number) => ((i * 7 + n * 13) % 9) - 4;
		push(day, 'u-me', B1, 'read_page', weekend ? 0 : Math.max(0, 14 + jitter(1)));
		push(day, 'u-me', B1, 'search_pages', weekend ? 0 : Math.max(0, 5 + jitter(2)));
		push(day, 'u-me', B1, 'write_page', weekend || i % 3 ? 0 : 2 + (i % 2));
		push(day, 'u-cael', B1, 'read_page', weekend ? 0 : Math.max(0, 6 + jitter(3)));
		push(day, 'u-cael', B1, 'write_page', i % 4 ? 0 : 1);
		if (i % 6 === 0) push(day, 'u-mira', B1, 'view_page', 3);
		if (i === 2) push(day, 'u-me', '', 'invite_member', 1);
		// Someone who has since left the org: their calls still count toward totals.
		if (i > days - 8 && i % 2 === 0) push(day, 'u-gone', B1, 'read_page', 4);
	}
	return rows;
}

function analyticsResult(days: number): CallToolResult {
	const to = dayKey(new Date());
	const from = shiftDay(to, -(days - 1));
	const summary = summarize({
		rows: usageFixtureRows(days),
		roster: orgMembers.map((m) => ({
			user_id: m.user_id,
			name: m.name,
			email: m.email,
			role: m.role
		})),
		brains: brainsFixture.map((b) => ({ brain_id: b.id, label: b.label })),
		from,
		to
	});
	return {
		content: [{ type: 'text', text: summaryText(summary, 'Example Org') }],
		structuredContent: {
			view: 'analytics',
			orgName: 'Example Org',
			window: summary.window,
			totals: summary.totals,
			series: summary.series,
			brains: summary.brains,
			people: summary.people,
			// ME is the owner, so the preview shows the admin view. Flip to false to
			// preview the withheld state a viewer/editor sees.
			canSeePeople: true,
			truncated: false,
			footnote: FOOTNOTE,
			activeBrain: brainMeta(activeBrainId)
		}
	};
}

let orgInvites: {
	invite_id: string;
	email: string;
	role: PreviewRole;
	invited_at: string;
	expires_at: string;
}[] = [
	{
		invite_id: 'inv-1',
		email: 'newhire@example.com',
		role: 'editor',
		invited_at: new Date(Date.now() - 2 * 86400e3).toISOString(),
		expires_at: ''
	}
];
function rosterResult(msg: string): CallToolResult {
	return {
		content: [{ type: 'text', text: msg }],
		structuredContent: { view: 'members', members: orgMembers, invites: orgInvites, me: ME }
	};
}

// In-memory linked-identities set so `#connected` (and the Your-settings → Connected
// accounts row) preview the linking UX without a server: two emails (gmail = this
// sign-in) + two GitHub accounts, mirroring the founder's real person.
let connectedAccounts: {
	kind: 'email' | 'github';
	is_self: boolean;
	user_id?: string;
	email?: string;
	name?: string | null;
	github_user_id?: number;
	github_login?: string | null;
}[] = [
	{
		kind: 'email',
		is_self: true,
		user_id: 'u-me',
		email: 'owner@example.com',
		name: 'Ada Lovelace'
	},
	{
		kind: 'email',
		is_self: false,
		user_id: 'u-alt',
		email: 'owner.alt@example.com',
		name: null
	},
	{ kind: 'github', is_self: false, github_user_id: 10000001, github_login: 'octodev' },
	{ kind: 'github', is_self: false, github_user_id: 10000002, github_login: 'octoadmin' }
];
// Data-tool shape (list / unlink): just the fresh accounts array.
function connectedResult(msg: string): CallToolResult {
	return {
		content: [{ type: 'text', text: msg }],
		structuredContent: { accounts: connectedAccounts }
	};
}
// Widget shape (view_connected_accounts): the combined Your-settings payload —
// identity card fields + the connected accounts folded in.
function connectedSettingsResult(msg: string): CallToolResult {
	return {
		content: [{ type: 'text', text: msg }],
		structuredContent: {
			view: 'settings',
			email: 'owner@example.com',
			role: 'owner',
			org: 'your-org',
			activeBrain: { id: activeBrainId, label: 'Personal' },
			accounts: connectedAccounts
		}
	};
}

// In-memory multi-brain set so `#brains` (and the crumb's brain picker) previews the
// brain-selection UX without a server. Personal / team / client, mirroring the real
// motivating case — plus a SECOND brain in the Acme org, because one-brain-per-org is
// the case that hides the interesting behaviour: labels are repo-derived rather than
// the org's name once an org holds several, and the picker groups under an org heading
// instead of prepending "Acme — " to every row. With one brain each, nothing shows.
let brainsFixture = [
	{
		id: 'your-org/personal-wiki',
		label: 'Personal',
		role: 'Owner',
		orgId: 'org-personal',
		orgLabel: 'Personal',
		orgRole: 'owner' as PreviewRole,
		visibility: 'private'
	},
	{
		id: 'acme-co/acme-wiki',
		label: 'Acme wiki',
		role: 'Admin',
		orgId: 'org-acme',
		orgLabel: 'Acme',
		orgRole: 'admin' as PreviewRole,
		visibility: 'org'
	},
	{
		id: 'acme-co/acme-handbook',
		label: 'Acme handbook',
		role: 'Editor',
		orgId: 'org-acme',
		orgLabel: 'Acme',
		// Org-visible like its sibling. It cannot preview as Editor any more: role is
		// DERIVED now, and the org-admin floor lifts an org admin to admin on every
		// brain in the org, so an admin holding editor on one of them is not a state
		// the rule can produce.
		orgRole: 'admin' as PreviewRole,
		visibility: 'org'
	},
	{
		id: 'northwind/northwind-wiki',
		label: 'Northwind',
		role: 'Viewer',
		orgId: 'org-northwind',
		orgLabel: 'Northwind',
		orgRole: 'viewer' as PreviewRole,
		visibility: 'private'
	}
];
// Explicit per-brain grants (`brain_memberships`), keyed brain id -> user id.
// The brains together cover every path through effectiveBrainRole:
//   Personal   private, mine. Katherine (an org EDITOR) is shared in read-only,
//              which is the case per-brain roles exist for; Grace appears with no
//              grant at all, via the org-admin floor; Devon cannot see it.
//   Acme       org-visible, so every member is in at their own org role.
//   Northwind  a client brain someone shared with ME read-only: the Share control
//              disappears, because sharing needs admin ON THE BRAIN and my org
//              role there is only viewer.
let brainGrants: Record<string, Record<string, PreviewRole>> = {
	'your-org/personal-wiki': { 'u-me': 'admin', 'u-mira': 'viewer' },
	'acme-co/acme-wiki': {},
	'northwind/northwind-wiki': { 'u-me': 'viewer' }
};
// The orgs I belong to, which is NOT the same list as the orgs my brains are in.
// `org-empty` holds no brain at all, and that is the point: it cannot be derived from
// brainsFixture, so it is the case that proves the picker reads the server's org list
// (the `orgs` field on the brains payload) rather than deriving one. It is also the
// only org where "connect the first repo" can be exercised end to end. Mirrors
// listAccessibleOrgs on the server.
let orgsFixture = [
	{
		orgId: 'org-personal',
		orgLabel: 'Personal',
		owner: 'your-org',
		orgRole: 'owner' as PreviewRole
	},
	{ orgId: 'org-acme', orgLabel: 'Acme', owner: 'acme-co', orgRole: 'admin' as PreviewRole },
	{
		orgId: 'org-northwind',
		orgLabel: 'Northwind',
		owner: 'northwind',
		orgRole: 'viewer' as PreviewRole
	},
	{
		orgId: 'org-empty',
		orgLabel: 'Contoso Group',
		owner: 'contoso-io',
		orgRole: 'admin' as PreviewRole
	}
];

// Repos the "installation" can see that aren't brains yet — the connect_brain picker.
let connectableRepos = [
	{ id: 'acme-co/content-dist', owner: 'acme-co', repo: 'content-dist' },
	// Under the personal org, so the picker's step 1 (choose an org) has two live
	// branches rather than one that dead-ends in the empty state.
	{ id: 'your-org/notes-archive', owner: 'your-org', repo: 'notes-archive' },
	// Under the BRAINLESS org, so connecting a first repo into one is reachable here.
	{ id: 'contoso-io/field-guide', owner: 'contoso-io', repo: 'field-guide' }
];
let activeBrainId = brainsFixture[0].id;
// The active brain's content — used by the host chrome (initial render + page selector),
// which always shows the active brain. Inside handleTool use the per-call `pg` instead.
const activePages = () => pagesFor(activeBrainId);
// Preview: the Acme brain is "connected but not configured"; clicking Set up opens a
// (simulated, protected-repo) configure PR, flipping the row to "Review PR".
const pendingConfigPr = new Map<string, string>();
// My effective role on one brain, through the real rule.
function myBrainRole(b: (typeof brainsFixture)[number]): Role | null {
	return effectiveBrainRole({
		visibility: b.visibility,
		orgRole: b.orgRole,
		grant: brainGrants[b.id]?.[ME.user_id] ?? null
	});
}
function brainRows() {
	return brainsFixture.map((b) => {
		const role = myBrainRole(b) ?? 'viewer';
		return {
			...b,
			role: roleLabel(role),
			active: b.id === activeBrainId,
			// Org scope disconnects; brain scope shares. Deliberately different tests.
			canManage: b.orgRole === 'owner' || b.orgRole === 'admin',
			canShare: role === 'admin' || role === 'owner',
			// One row, not the whole Acme group — this previews the not-configured state,
			// and every row wearing it would read as an org-level problem.
			needsConfig: b.id === 'acme-co/acme-wiki',
			configPrUrl: pendingConfigPr.get(b.id)
		};
	});
}

// The sharing panel's payload for one brain: every org member the rule admits,
// labelled with HOW they got in. Mirrors listBrainAccess in src/lib/orgs.ts.
function accessResult(brainId: string, msg: string): CallToolResult {
	const b = brainsFixture.find((x) => x.id === brainId) ?? brainsFixture[0];
	const grants = brainGrants[b.id] ?? {};
	const access = orgMembers
		.map((m) => {
			const grant = grants[m.user_id] ?? null;
			const role = effectiveBrainRole({ visibility: b.visibility, orgRole: m.role, grant });
			if (!role) return null;
			return {
				user_id: m.user_id,
				email: m.email,
				name: m.name,
				role,
				via: grant ? 'grant' : b.visibility !== 'private' ? 'org' : 'org-admin',
				granted_at: grant ? '2026-06-01T00:00:00Z' : undefined
			};
		})
		.filter(Boolean);
	return {
		content: [{ type: 'text', text: msg }],
		structuredContent: {
			view: 'brain-access',
			access,
			visibility: b.visibility,
			activeBrain: brainMeta(b.id),
			me: { user_id: ME.user_id, role: myBrainRole(b) ?? 'viewer', orgRole: b.orgRole }
		}
	};
}
// Resolve a `brain` arg the way the server's matchBrain does (id, then label
// substring), so the Share control can target a non-active brain from the list.
function resolveBrainArg(arg: unknown): string | undefined {
	const q = String(arg ?? '')
		.trim()
		.toLowerCase();
	if (!q) return undefined;
	return brainsFixture.find((b) => b.id.toLowerCase() === q || b.label.toLowerCase().includes(q))
		?.id;
}
function brainsResult(msg: string, withView: boolean): CallToolResult {
	const sc: Record<string, unknown> = {
		brains: brainRows(),
		active: activeBrainId,
		// The orgs a brain can be added to, admin+ only, exactly as the server sends
		// them. The add-a-brain picker reads this rather than deriving orgs from the
		// brains above, which is the only way an org holding no brains can be offered.
		orgs: orgsFixture
			.filter((o) => roleAtLeast(o.orgRole, 'admin'))
			.map((o) => ({ orgId: o.orgId, orgLabel: o.orgLabel })),
		// What the server registered. On here so the harness previews the nav with
		// the Analytics row present; a real deployment sends false unless
		// USAGE_ANALYTICS is set.
		features: { analytics: true }
	};
	if (withView) sc.view = 'brains';
	return { content: [{ type: 'text', text: msg }], structuredContent: sc };
}
// {id,label} for a brain — the `activeBrain` shape every app-tool result carries so the
// app's switcher/cache tracks the resolved brain.
function brainMeta(id: string): { id: string; label: string } {
	const b = brainsFixture.find((x) => x.id === id);
	return { id, label: b?.label ?? id };
}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const errText = (t: string): CallToolResult => ({
	isError: true,
	content: [{ type: 'text', text: t }]
});

function stripFrontmatter(md: string): string {
	const m = md.match(/^---\n[\s\S]*?\n---\n?/);
	return m ? md.slice(m[0].length) : md;
}

// A page's display title (frontmatter title, else de-slugged filename) — a small
// stand-in for the server's titleOf, enough to preview the backlinks panel.
function titleOf(p: string, md: string): string {
	const fm = md.match(/^---\n([\s\S]*?)\n---/);
	const t = fm?.[1].match(/^title:\s*(.+)$/m)?.[1];
	if (t) return t.trim().replace(/^["']|["']$/g, '');
	return p.split('/').pop()!.replace(/\.md$/, '').replace(/-/g, ' ');
}

// Derived-views support: a ViewContext over a brain's in-memory pages — the same
// resolution the server builds from D1, computed from the fixtures instead. Lets
// the harness run the REAL views engine (renderViews) so okf-view pages (see
// wiki/orgs/acme-health.md in fixtures.json) render live, exactly like prod.
function viewCtxFor(pg: Record<string, string>): ViewContext {
	const pth = Object.keys(pg);
	const slugOf = (p: string) => p.split('/').pop()!.replace(/\.md$/, '');
	const bySlug = new Map(pth.map((p) => [slugOf(p), p]));
	const byTitle = new Map(pth.map((p) => [titleOf(p, pg[p]).toLowerCase(), p]));
	const edges: { source: string; target: string; kind: 'md' | 'wiki'; cnt: number }[] = [];
	for (const p of pth) {
		const body = stripFrontmatter(pg[p]);
		for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
			const href = m[1].split('#')[0].trim();
			if (/^(https?:|mailto:)/i.test(href) || !href.endsWith('.md')) continue;
			const resolved = resolveRelative(p, href);
			if (pg[resolved] !== undefined)
				edges.push({ source: p, target: resolved, kind: 'md', cnt: 1 });
		}
		for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
			const t = bySlug.get(slugify(m[1].trim())) ?? byTitle.get(m[1].trim().toLowerCase());
			if (t) edges.push({ source: p, target: t, kind: 'wiki', cnt: 1 });
		}
	}
	return {
		resolved: { pages: pth.map((p) => ({ path: p, title: titleOf(p, pg[p]) })), edges, broken: [] },
		fieldsFor: async (paths) => {
			const out = new Map<string, Map<string, string[]>>();
			for (const p of paths) {
				const { frontmatter } = parseFrontmatter(pg[p] ?? '');
				if (!frontmatter) continue;
				const fields = new Map<string, string[]>();
				for (const [k, v] of Object.entries(frontmatter)) {
					// Nested frontmatter is preserved verbatim but deliberately NOT indexed
					// on the server, so an okf-view filter cannot see inside it. Skipping
					// non-scalars here keeps the preview honest about that.
					if (typeof v === 'string') fields.set(k, [v]);
					else if (Array.isArray(v))
						fields.set(
							k,
							v.filter((x) => typeof x === 'string')
						);
				}
				out.set(p, fields);
			}
			return out;
		}
	};
}

// A page rendered for DISPLAY (view_page semantics): okf-view fences replaced by
// the live result computed from the fixtures. No-op for pages without views.
async function displayPage(pg: Record<string, string>, path: string): Promise<string> {
	const md = pg[path] ?? '';
	if (!hasViews(md)) return md;
	return (await renderViews(md, path, viewCtxFor(pg))).display;
}

// ---- the host's answer to every callback the app makes ----
async function handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	const path = String(args?.path ?? '');
	// Resolve WHICH brain's content this call touches (explicit `brain` arg, else the
	// active brain). pg is that brain's page map; pth its current paths. Mutations to
	// pg persist (it's the real brainContent object); pth is recomputed per call.
	const bid = contentBrainId(args);
	const pg = pagesFor(bid);
	const pth = Object.keys(pg);
	switch (name) {
		case 'read_page': {
			const md = pg[path];
			if (md === undefined) return errText(`"${path}" does not exist.`);
			// Mirror the server: agents (and the app's navigate path) get the fence
			// plus a freshly computed snapshot; the app unwraps it for display.
			if (!hasViews(md)) return text(md);
			return text((await renderViews(md, path, viewCtxFor(pg))).snapshotted);
		}
		case 'list_pages': {
			const prefix = String(args?.prefix ?? '');
			const listed = pth.filter((p) => p.startsWith(prefix));
			// Visible content pages carry titles; everything else (system files,
			// .gitkeep, source, the log) comes back as `hidden` for the eye toggle.
			const visible = listed.filter(isContentPage);
			const hiddenPaths = listed.filter((p) => !isContentPage(p));
			const r = text(visible.join('\n'));
			return {
				...r,
				structuredContent: {
					pages: visible.map((p) => ({ path: p, title: titleOf(p, pg[p]) })),
					hidden: hiddenPaths,
					// Mirrors the server: this is the app's OWN navigation channel and the
					// only tool that draws the whole tree, so its payload says whose tree it
					// is. Without it the trail's root crumb cannot name the brain when
					// nothing else has (see #cold).
					activeBrain: brainMeta(bid)
				}
			};
		}
		case 'create_folder': {
			const folder = String(args?.path ?? '').replace(/\/+$/, '');
			if (!folder) return errText('Give a folder path.');
			if (pth.some((p) => p === `${folder}/.gitkeep` || p.startsWith(`${folder}/`)))
				return text(`Folder "${folder}" already exists.`);
			pg[`${folder}/.gitkeep`] = '';
			return { ...text(`Created folder "${folder}".`), structuredContent: {} };
		}
		case 'move_folder': {
			const folder = String(args?.path ?? '').replace(/\/+$/, '');
			const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
			const nn = String(args?.new_name ?? '').trim();
			const dest = String(args?.new_path ?? (parent ? `${parent}/${nn}` : nn)).replace(/\/+$/, '');
			if (!dest) return errText('Give a new folder name.');
			let moved = 0;
			for (const p of pth) {
				if (p.startsWith(`${folder}/`)) {
					pg[`${dest}${p.slice(folder.length)}`] = pg[p];
					delete pg[p];
					moved++;
				}
			}
			if (!moved) return errText(`No folder "${folder}" found.`);
			return text(`Moved folder "${folder}" to ${dest}.`);
		}
		case 'delete_folder': {
			const folder = String(args?.path ?? '').replace(/\/+$/, '');
			let removed = 0;
			for (const p of pth) {
				if (p.startsWith(`${folder}/`)) {
					delete pg[p];
					removed++;
				}
			}
			if (!removed) return errText(`No folder "${folder}" found.`);
			return text(`Deleted folder "${folder}" (${removed} file(s)).`);
		}
		case 'search_pages': {
			const q = String(args?.query ?? '').toLowerCase();
			const hits: { path: string; line: number; text: string }[] = [];
			for (const p of pth) {
				stripFrontmatter(pg[p])
					.split('\n')
					.forEach((ln, i) => {
						if (q && ln.toLowerCase().includes(q))
							hits.push({ path: p, line: i + 1, text: ln.trim() });
					});
			}
			const r = text(`${hits.length} match(es) for "${args?.query}".`);
			return { ...r, structuredContent: { hits: hits.slice(0, 50) } };
		}
		case 'edit_page': {
			const md = pg[path];
			if (md === undefined) return errText(`"${path}" does not exist.`);
			// Mirror the server: the editor gets fences but not snapshot regions.
			const editable = stripSnapshots(md);
			return {
				content: [{ type: 'text', text: `Opened ${path} in the editor.\n\n${editable}` }],
				structuredContent: {
					view: 'edit',
					path,
					markdown: editable,
					sha: 'preview-sha',
					activeBrain: brainMeta(bid)
				}
			};
		}
		case 'write_page': {
			// One create-or-update tool (save_page/create_page were merged away). Preview-only:
			// mutates the in-memory copy so the round-trip feels real, nothing touches GitHub.
			const p = String(args?.path ?? 'wiki/untitled.md');
			const exists = pg[p] !== undefined;
			if (exists && args?.mode === 'create') return errText(`"${p}" already exists.`);
			const content = String(args?.content ?? '');
			if (exists) {
				// Keep the existing frontmatter, exactly like the server's body-only save.
				const fm = pg[p].match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? '';
				pg[p] = fm + content;
			} else {
				const title = String(args?.title ?? p.split('/').pop()!.replace(/\.md$/, ''));
				pg[p] = `---\ntitle: ${title}\nstatus: draft\n---\n\n${content}`;
			}
			// Mirror the server: snapshots regenerate as content lands in the file.
			if (hasViews(pg[p])) pg[p] = (await renderViews(pg[p], p, viewCtxFor(pg))).snapshotted;
			const r = text(`${exists ? 'Saved' : 'Created'} ${p} (preview only — no write to GitHub).`);
			return { ...r, structuredContent: { path: p, sha: 'preview-sha-2' } };
		}
		case 'move_page': {
			const src = path;
			const slugTitle = (s: string) =>
				s
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '');
			const dest = args?.new_path
				? String(args.new_path)
				: `${src.slice(0, src.lastIndexOf('/'))}/${slugTitle(String(args?.new_title ?? ''))}.md`;
			pg[dest] = pg[src];
			delete pg[src];
			return { ...text(`Moved ${src} → ${dest}.`), structuredContent: { path: dest } };
		}
		case 'delete_page': {
			delete pg[path];
			return text(`Deleted ${path}.`);
		}
		case 'view_activity': {
			// Fixtures have no git history, so synthesize a plausible feed (whole brain,
			// or one page when `path` is given) to preview the activity/audit view.
			const now = Date.now();
			const scopePath = args?.path ? String(args.path) : undefined;
			const seed: { author: string; login?: string; msg: string; path?: string; agoMs: number }[] =
				[
					{
						author: 'Ada Lovelace',
						login: 'octodev',
						msg: 'Edit Brand Voice (wiki/playbooks/brand-voice.md)',
						path: 'wiki/playbooks/brand-voice.md',
						agoMs: 2 * 3600e3
					},
					{
						author: 'Grace Hopper',
						msg: 'Edit Vision (wiki/concepts/vision.md)',
						path: 'wiki/concepts/vision.md',
						agoMs: 26 * 3600e3
					},
					{
						author: 'Ada Lovelace',
						login: 'octodev',
						msg: 'Create Open Questions (wiki/open-questions.md)',
						path: 'wiki/open-questions.md',
						agoMs: 3 * 86400e3
					},
					{ author: 'isomorphic-mind[bot]', msg: 'Scaffold brain', agoMs: 12 * 86400e3 }
				];
			const filtered = scopePath ? seed.filter((s) => s.path === scopePath) : seed;
			const entries = filtered.map((s, i) => ({
				sha: `deadbeef${i}${'0'.repeat(32)}`.slice(0, 40),
				shortSha: `deadbe${i}`,
				message: s.msg,
				path: s.path,
				authorName: s.author,
				authorLogin: s.login,
				date: new Date(now - s.agoMs).toISOString(),
				url: 'https://github.com/example/brain/commit/deadbeef'
			}));
			const r = text(`${entries.length} recent change(s).`);
			return { ...r, structuredContent: { view: 'activity', scope: { path: scopePath }, entries } };
		}
		case 'view_graph': {
			// Build a real link graph from the fixtures, mirroring the server's view_graph
			// (markdown links via resolveRelative, [[wikilinks]] via slug/title).
			const slugOf = (p: string) => p.split('/').pop()!.replace(/\.md$/, '');
			const bySlug = new Map(pth.map((p) => [slugOf(p), p]));
			const byTitle = new Map(pth.map((p) => [titleOf(p, pg[p]).toLowerCase(), p]));
			const edgeKeys = new Set<string>();
			const edges: { source: string; target: string }[] = [];
			const degree = new Map<string, number>();
			const addEdge = (s: string, t: string) => {
				if (s === t) return;
				const key = s < t ? `${s} ${t}` : `${t} ${s}`;
				if (edgeKeys.has(key)) return;
				edgeKeys.add(key);
				edges.push({ source: s, target: t });
				degree.set(s, (degree.get(s) ?? 0) + 1);
				degree.set(t, (degree.get(t) ?? 0) + 1);
			};
			for (const p of pth) {
				const body = stripFrontmatter(pg[p]);
				for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
					const href = m[1].split('#')[0].trim();
					if (/^(https?:|mailto:)/i.test(href) || !href.endsWith('.md')) continue;
					const resolved = resolveRelative(p, href);
					if (pg[resolved] !== undefined) addEdge(p, resolved);
				}
				for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
					const t = bySlug.get(slugify(m[1].trim())) ?? byTitle.get(m[1].trim().toLowerCase());
					if (t) addEdge(p, t);
				}
			}
			const nodes = pth.map((p) => ({
				id: p,
				title: titleOf(p, pg[p]),
				group: p.split('/').slice(0, -1).join('/'),
				degree: degree.get(p) ?? 0
			}));
			const focus = args?.path && pg[String(args.path)] ? String(args.path) : undefined;
			const r = text(`Brain graph: ${nodes.length} page(s), ${edges.length} link(s).`);
			return { ...r, structuredContent: { view: 'graph', nodes, edges, focus, truncated: false } };
		}
		case 'find_inbound_links': {
			const targetMd = pg[path];
			if (targetMd === undefined) return errText(`"${path}" does not exist.`);
			const targetTitle = titleOf(path, targetMd);
			const targetSlug = slugify(path.split('/').pop()!.replace(/\.md$/, ''));
			const refs: { path: string; title: string; mdCount: number; wikiCount: number }[] = [];
			for (const p of pth) {
				if (p === path) continue;
				const content = pg[p];
				let mdCount = 0;
				let wikiCount = 0;
				for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
					const tgt = m[1].split('#')[0].trim();
					if (tgt.endsWith('.md') && resolveRelative(p, tgt) === path) mdCount++;
				}
				for (const m of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
					const t = m[1].trim();
					if (slugify(t) === targetSlug || t.toLowerCase() === targetTitle.toLowerCase())
						wikiCount++;
				}
				if (mdCount + wikiCount > 0)
					refs.push({ path: p, title: titleOf(p, content), mdCount, wikiCount });
			}
			const r = text(`${refs.length} page(s) link to "${targetTitle}".`);
			return {
				...r,
				structuredContent: { target: { path, title: targetTitle }, refs, truncated: false }
			};
		}
		case 'analytics':
			return analyticsResult(Number(args?.days ?? 30));
		case 'members':
			return rosterResult(
				`${orgMembers.length} member(s), ${orgInvites.length} pending invite(s).`
			);
		case 'connected_accounts':
			return connectedSettingsResult(`${connectedAccounts.length} connected account(s).`);
		case 'link_identity': {
			const email = String(args?.email ?? '').trim();
			const url = 'https://mcp.isomorphic.sh/link/start?state=demo';
			return {
				content: [{ type: 'text', text: `Open this link${email ? ` for ${email}` : ''}: ${url}` }],
				structuredContent: { link: { url, email } }
			};
		}
		case 'unlink_identity': {
			const email = String(args?.email ?? '')
				.trim()
				.toLowerCase();
			const github = String(args?.github ?? '')
				.trim()
				.replace(/^@/, '')
				.toLowerCase();
			if (email)
				connectedAccounts = connectedAccounts.filter(
					(a) => !(a.kind === 'email' && (a.email ?? '').toLowerCase() === email)
				);
			else if (github)
				connectedAccounts = connectedAccounts.filter(
					(a) =>
						!(
							a.kind === 'github' &&
							(String(a.github_user_id) === github ||
								(a.github_login ?? '').toLowerCase() === github)
						)
				);
			return connectedResult('Unlinked.');
		}
		case 'invite_member': {
			const email = String(args?.email ?? '').trim();
			const role = String(args?.role ?? 'editor') as PreviewRole;
			if (orgMembers.some((m) => m.email.toLowerCase() === email.toLowerCase()))
				return errText(`${email} is already a member.`);
			orgInvites = [
				{
					invite_id: `inv-${Date.now()}`,
					email,
					role,
					invited_at: new Date().toISOString(),
					expires_at: ''
				},
				...orgInvites
			];
			return rosterResult(`Invited ${email} as ${role}.`);
		}
		case 'set_member_role': {
			const email = String(args?.email ?? '')
				.trim()
				.toLowerCase();
			const role = String(args?.role ?? '') as PreviewRole;
			orgMembers = orgMembers.map((m) => (m.email.toLowerCase() === email ? { ...m, role } : m));
			return rosterResult(`${args?.email} is now ${role}.`);
		}
		case 'remove_member': {
			const email = String(args?.email ?? '')
				.trim()
				.toLowerCase();
			const wasMember = orgMembers.some((m) => m.email.toLowerCase() === email);
			orgMembers = orgMembers.filter((m) => m.email.toLowerCase() !== email);
			orgInvites = orgInvites.filter((i) => i.email.toLowerCase() !== email);
			return rosterResult(
				wasMember ? `Removed ${args?.email}.` : `Revoked invite for ${args?.email}.`
			);
		}
		case 'brain_access': {
			const id = resolveBrainArg(args?.brain) ?? activeBrainId;
			const b = brainsFixture.find((x) => x.id === id);
			// STICKY, matching worker.ts: the sharing panel is a view OF a brain and the
			// trail lists it beside Files and Graph, so opening it for a named brain moves
			// the active brain with it. Without this the preview would show one brain's
			// audience under another brain's crumb.
			if (b && id !== activeBrainId) {
				activeBrainId = id;
				openPath = Object.keys(pagesFor(activeBrainId))[0] ?? openPath;
				rebuildSelector();
			}
			return accessResult(id, `Access for ${b?.label ?? id}.`);
		}
		case 'share_brain': {
			const id = resolveBrainArg(args?.brain) ?? activeBrainId;
			const b = brainsFixture.find((x) => x.id === id);
			if (!b) return errText(`No brain matching "${args?.brain}".`);
			if (!(myBrainRole(b) === 'admin' || myBrainRole(b) === 'owner'))
				return errText(`You need admin access on ${b.label} to change who can reach it.`);
			const notes: string[] = [];
			const visibility = args?.visibility ? String(args.visibility) : undefined;
			if (visibility && visibility !== b.visibility) {
				b.visibility = visibility;
				notes.push(
					visibility === 'org'
						? `"${b.label}" is now visible to everyone in the organization.`
						: `"${b.label}" is now private.`
				);
			}
			const email = args?.email ? String(args.email).trim() : '';
			if (email) {
				const m = orgMembers.find((x) => x.email.toLowerCase() === email.toLowerCase());
				if (!m) return errText(`${email} isn't a member of this organization.`);
				brainGrants[b.id] ??= {};
				const access = String(args?.access ?? 'editor');
				if (access === 'none') {
					if (m.user_id === ME.user_id) return errText("You can't revoke your own access.");
					delete brainGrants[b.id][m.user_id];
					notes.push(`Removed ${m.email} from "${b.label}".`);
				} else {
					brainGrants[b.id][m.user_id] = access as PreviewRole;
					notes.push(`${m.email} is now ${roleLabel(access as Role)} on "${b.label}".`);
				}
			}
			return accessResult(b.id, notes.join(' ') || 'Nothing changed.');
		}
		case 'brains':
			return brainsResult(`${brainsFixture.length} brains.`, true);
		case 'switch_brain': {
			const q = String(args?.brain ?? '').toLowerCase();
			const hit = brainsFixture.find(
				(b) => b.id.toLowerCase() === q || b.label.toLowerCase().includes(q)
			);
			if (!hit) return errText(`No brain matching "${args?.brain}".`);
			activeBrainId = hit.id;
			// Point the host chrome's page selector at the newly-active brain's pages.
			openPath = Object.keys(pagesFor(activeBrainId))[0] ?? openPath;
			rebuildSelector();
			return brainsResult(`Switched to ${hit.label}.`, true);
		}
		case 'create_brain': {
			// Scaffold a fresh (empty) named brain under the "personal" org and switch to it.
			const display = String(args?.name ?? '').trim() || 'New brain';
			const slug =
				display
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-+|-+$/g, '') || 'brain';
			let id = `your-org/${slug}`;
			for (let n = 2; brainsFixture.some((b) => b.id === id); n++) id = `your-org/${slug}-${n}`;
			brainsFixture = [
				...brainsFixture,
				{
					id,
					label: display,
					role: 'Owner',
					orgId: 'org-personal',
					orgLabel: 'Personal',
					orgRole: 'owner' as PreviewRole,
					// Private by default, with an admin grant for the creator (mirrors
					// create_brain in src/tools/brains.ts).
					visibility: 'private'
				}
			];
			brainGrants[id] = { [ME.user_id]: 'admin' };
			pagesFor(id); // empty content map for the new brain
			activeBrainId = id;
			openPath = '';
			rebuildSelector();
			return {
				content: [{ type: 'text', text: `Created "${display}" and switched to it.` }],
				structuredContent: {
					view: 'brains',
					brains: brainRows(),
					active: id,
					switched: true,
					createdId: id
				}
			};
		}
		case 'list_connectable_repos':
			return {
				content: [{ type: 'text', text: `${connectableRepos.length} connectable repos.` }],
				structuredContent: { repos: connectableRepos }
			};
		case 'connect_brain': {
			// Targeted by ORG, never by a brain inside it: an org with no brains has none
			// to name, and that is exactly the org a first repo is being connected into.
			// Falls back to the active brain's org, matching orgContext's default.
			const q = String(args?.org ?? '').toLowerCase();
			const activeOrgId = brainsFixture.find((b) => b.id === activeBrainId)?.orgId;
			const org =
				orgsFixture.find((o) => o.orgId.toLowerCase() === q || o.orgLabel.toLowerCase() === q) ??
				orgsFixture.find((o) => o.orgId === activeOrgId) ??
				orgsFixture[0];
			// An org owns the repos under its GitHub owner, so the picker is scoped the
			// way the real installation would be.
			const owner = org.owner;
			const candidates = connectableRepos.filter((x) => x.owner === owner);
			// NO `repo` ARG → return the connectable candidates instead of adopting. This
			// branch was missing, so the add-a-brain picker's first call fell through to
			// the adopt path below with an empty repo id and created a junk brain.
			if (!args?.repo)
				return {
					content: [
						{
							type: 'text',
							text: `${candidates.length} connectable repo${candidates.length === 1 ? '' : 's'} in ${org.orgLabel}.`
						}
					],
					structuredContent: { repos: candidates }
				};
			const r = String(args.repo);
			const hit = connectableRepos.find((x) => x.id === r || x.repo === r);
			const id = hit?.id ?? r;
			const label = (hit?.repo ?? r).replace(/[-_]+/g, ' ');
			brainsFixture = [
				...brainsFixture,
				{
					id,
					label,
					role: 'Admin',
					orgId: org.orgId,
					orgLabel: org.orgLabel,
					// Matches connect_brain in src/tools/brains.ts: adopting a repo the org
					// already owns is an org-wide act, so the brain lands ORG-VISIBLE. This
					// is the opposite default from create_brain, which is private.
					orgRole: 'admin' as PreviewRole,
					visibility: 'org'
				}
			];
			connectableRepos = connectableRepos.filter((x) => x.id !== id);
			return {
				content: [{ type: 'text', text: `Connected ${id} as a brain.` }],
				structuredContent: {
					view: 'brains',
					brains: brainRows(),
					active: activeBrainId,
					connectedId: id,
					needsConfig: false
				}
			};
		}
		case 'configure_brain': {
			const b = brainsFixture.find(
				(x) => x.id === String(args?.brain ?? activeBrainId) || x.orgId === 'org-acme'
			);
			const pr = 'https://github.com/acme-co/acme-handbook/pull/6';
			if (b) pendingConfigPr.set(b.id, pr);
			return {
				content: [{ type: 'text', text: `Setup proposed as a PR — review & merge: ${pr}` }],
				structuredContent: { prUrl: pr }
			};
		}
		case 'disconnect_brain': {
			const q = String(args?.brain ?? '').toLowerCase();
			const hit = brainsFixture.find(
				(b) => b.id.toLowerCase() === q || b.label.toLowerCase().includes(q)
			);
			if (!hit) return errText(`No brain matching "${args?.brain}".`);
			brainsFixture = brainsFixture.filter((b) => b.id !== hit.id);
			if (activeBrainId === hit.id) {
				activeBrainId = brainsFixture[0]?.id ?? '';
				openPath = Object.keys(pagesFor(activeBrainId))[0] ?? openPath;
				rebuildSelector();
			}
			return brainsResult(`Disconnected ${hit.label}.`, true);
		}
		case 'whoami':
			return {
				content: [
					{
						type: 'text',
						text: 'Authenticated as owner@example.com — owner of your-org/personal-wiki.'
					}
				],
				structuredContent: {
					email: 'owner@example.com',
					role: 'owner',
					org: 'your-org',
					activeBrain: { id: activeBrainId, label: 'Personal' }
				}
			};
		default:
			return errText(`This preview host doesn't implement "${name}".`);
	}
}

// ---- mount the real app in a sandboxed iframe ----
const iframe = document.createElement('iframe');
iframe.setAttribute('sandbox', 'allow-scripts'); // opaque origin, like a strict host sandbox
iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent';
document.getElementById('frame-slot')!.appendChild(iframe);

const currentTheme = () =>
	matchMedia('(prefers-color-scheme: dark)').matches ? ('dark' as const) : ('light' as const);

const bridge = new AppBridge(
	null,
	{ name: 'Local Preview Host', version: '0.1.0' },
	{ openLinks: {}, serverTools: {}, logging: {} }
);

bridge.oncalltool = async (params) =>
	handleTool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
bridge.onopenlink = async () => ({}); // no-op; links would open a tab in a real host
bridge.onloggingmessage = async () => ({});
// The app's autoResize reports content-height changes here; in inline mode we
// resize the card to fit (bounded), mirroring how claude.ai grows/shrinks an
// inline app. This makes `pnpm app:dev` a faithful preview of the inline behavior.
bridge.onsizechange = async ({ height }) => {
	applyContentHeight(height ?? undefined);
};

// Display-mode support: present the iframe the way a real host would. Inline = a
// bounded card in the message column; fullscreen = full-bleed below the host bar.
type DisplayMode = 'inline' | 'fullscreen' | 'pip';
const AVAILABLE: DisplayMode[] = ['inline', 'fullscreen', 'pip'];
// Mirror of the presented mode so onsizechange knows whether to content-fit.
let activeMode: DisplayMode = 'inline';
// A real host caps inline height and scrolls; mimic that so a huge tree can't make
// a runaway card. The .stage already has overflow:auto for the scroll fallback.
const INLINE_MAX_PX = 640;

// The app (autoResize) reports its content height; in inline mode we size the card
// to it (bounded), which is exactly how claude.ai grows/shrinks an inline app as
// its content changes. Fullscreen/pip keep their fixed window, so ignore it there.
function applyContentHeight(height?: number) {
	const slot = document.getElementById('frame-slot')!;
	if (activeMode !== 'inline') {
		slot.style.height = '';
		return;
	}
	if (height == null || !Number.isFinite(height)) return;
	slot.style.height = `${Math.min(Math.ceil(height), INLINE_MAX_PX)}px`;
}
// `?mode=pip` (etc.) forces the host to present a given mode regardless of what the
// app requests — handy for screenshotting each mode.
const forcedMode = new URLSearchParams(location.search).get('mode') as DisplayMode | null;
function presentMode(mode: DisplayMode) {
	activeMode = mode;
	const slot = document.getElementById('frame-slot')!;
	const stage = document.querySelector('.stage') as HTMLElement;
	// Reset any prior overrides (empty string falls back to index.html styles).
	stage.style.padding = '';
	for (const p of [
		'position',
		'right',
		'bottom',
		'width',
		'height',
		'maxWidth',
		'border',
		'borderRadius',
		'boxShadow',
		'background',
		'zIndex'
	] as const) {
		slot.style[p] = '';
	}
	if (mode === 'inline') {
		// Inline: align the card to the top and let it size to content (height driven
		// by onsizechange below). The APP now draws its own border/rounding in inline,
		// so strip the harness frame chrome — otherwise the preview shows a double edge
		// and misrepresents what the real host renders.
		stage.style.alignItems = 'flex-start';
		slot.style.border = 'none';
		slot.style.borderRadius = '0';
		slot.style.boxShadow = 'none';
		slot.style.background = 'transparent';
	} else {
		stage.style.alignItems = '';
	}
	if (mode === 'fullscreen') {
		stage.style.padding = '0';
		slot.style.maxWidth = 'none';
		slot.style.border = 'none';
		slot.style.borderRadius = '0';
		slot.style.boxShadow = 'none';
	} else if (mode === 'pip') {
		// Floating window over the conversation.
		slot.style.position = 'fixed';
		slot.style.right = '20px';
		slot.style.bottom = '20px';
		slot.style.width = '420px';
		slot.style.height = '560px';
		slot.style.maxWidth = 'none';
		slot.style.zIndex = '50';
		slot.style.boxShadow = '0 12px 48px rgba(0,0,0,0.5)';
	}
	document.getElementById('status')!.textContent = `connected · ${mode}`;
}
bridge.onrequestdisplaymode = async ({ mode }) => {
	const m = (forcedMode ?? mode) as DisplayMode;
	presentMode(m);
	// Echo the actual mode back to the app via host context (fires onhostcontextchanged).
	bridge.setHostContext({
		theme: currentTheme(),
		displayMode: m,
		availableDisplayModes: AVAILABLE
	});
	return { mode: m };
};

// Hash controls the test: `#edit` opens edit mode; `#edit=<path>` opens that page;
// `#browse` the file tree; `#activity` the change feed.
const [hashMode, hashPath] = location.hash.replace(/^#/, '').split('=');
const editMode = hashMode === 'edit';
const browseMode = hashMode === 'browse';
const activityMode = hashMode === 'activity';
const graphMode = hashMode === 'graph';
const membersMode = hashMode === 'members';
const analyticsMode = hashMode === 'analytics';
const brainsMode = hashMode === 'brains';
const settingsMode = hashMode === 'settings';
const connectedMode = hashMode === 'connected';
// `#access` previews the per-brain sharing panel for the active brain.
const accessMode = hashMode === 'access';
const browseEmptyMode = hashMode === 'browse-empty';
// `#nobrains` previews the first-touch "create your first brain" state: start with an
// empty brain set so the brains lookup routes the app to the create form.
const noBrainsMode = hashMode === 'nobrains';
// `#cold` delivers NO opening tool result, so the app self-boots (connectToHost opens
// the tree itself after 1200ms). A real host does this whenever the result is slower
// than the handshake or never replayed at all, and it is the one path where the app
// draws a brain's tree without a single app-tool payload to learn the brain from —
// so it is where the trail's root crumb and its brain picker have to stand on their
// own. Everything after the handshake still answers normally.
const coldMode = hashMode === 'cold';
if (noBrainsMode) {
	brainsFixture = [];
	activeBrainId = '';
}
if (hashPath && activePages()[decodeURIComponent(hashPath)])
	openPath = decodeURIComponent(hashPath);
bridge.oninitialized = async () => {
	// Present inline (or the forced mode) up front so the card content-fits from the
	// first paint, matching a real host — onsizechange then tracks content changes.
	const initialMode = forcedMode ?? 'inline';
	presentMode(initialMode);
	bridge.setHostContext({
		theme: currentTheme(),
		displayMode: initialMode,
		availableDisplayModes: AVAILABLE
	});
	// No opening result at all: the app is on its own from here (see coldMode).
	if (coldMode) {
		document.getElementById('status')!.textContent = 'connected · cold (no tool result)';
		return;
	}
	// announce the input, then deliver the result (sendToolInput once, then sendToolResult).
	const mode = brainsMode
		? 'brains'
		: accessMode
			? 'access'
			: analyticsMode
				? 'analytics'
				: membersMode
					? 'members'
					: graphMode
						? 'graph'
						: activityMode
							? 'activity'
							: browseMode
								? 'browse'
								: editMode
									? 'edit'
									: 'page';
	bridge.sendToolInput({
		arguments:
			browseMode ||
			activityMode ||
			graphMode ||
			membersMode ||
			analyticsMode ||
			brainsMode ||
			accessMode ||
			settingsMode ||
			connectedMode ||
			browseEmptyMode ||
			noBrainsMode
				? {}
				: { path: openPath }
	});
	if (browseEmptyMode) {
		// Preview the "adopted repo, no content configured" empty state + auto-configure.
		bridge.sendToolResult({
			content: [{ type: 'text', text: 'No markdown pages found.' }],
			structuredContent: {
				view: 'browse',
				paths: [],
				pages: [],
				needsConfig: true,
				activeBrain: { id: activeBrainId, label: 'Personal' }
			}
		});
	} else if (settingsMode) {
		// Client-only surface in prod (openSettings → whoami); here we deliver the
		// identity straight through onToolResult's view:'settings' route to preview it.
		const who = await handleTool('whoami', {});
		bridge.sendToolResult({
			content: who.content,
			structuredContent: {
				view: 'settings',
				...(who.structuredContent ?? {}),
				accounts: connectedAccounts
			}
		});
	} else if (connectedMode) {
		bridge.sendToolResult(await handleTool('connected_accounts', {}));
	} else if (brainsMode || noBrainsMode) {
		bridge.sendToolResult(await handleTool('brains', {}));
	} else if (membersMode) {
		bridge.sendToolResult(await handleTool('members', {}));
	} else if (analyticsMode) {
		bridge.sendToolResult(await handleTool('analytics', { days: Number(hashPath) || 30 }));
	} else if (accessMode) {
		bridge.sendToolResult(await handleTool('brain_access', {}));
	} else if (graphMode) {
		bridge.sendToolResult(await handleTool('view_graph', {}));
	} else if (activityMode) {
		bridge.sendToolResult(await handleTool('view_activity', {}));
	} else {
		const ap = activePages();
		const apth = Object.keys(ap);
		bridge.sendToolResult(
			browseMode
				? {
						content: [{ type: 'text', text: ap['wiki/index.md'] ?? '' }],
						structuredContent: {
							view: 'browse',
							paths: apth.filter(isContentPage),
							pages: apth.filter(isContentPage).map((p) => ({ path: p, title: titleOf(p, ap[p]) })),
							hidden: apth.filter((p) => !isContentPage(p)),
							activeBrain: brainMeta(activeBrainId)
						}
					}
				: editMode
					? {
							content: [{ type: 'text', text: stripSnapshots(ap[openPath]) }],
							structuredContent: {
								view: 'edit',
								path: openPath,
								markdown: stripSnapshots(ap[openPath]),
								sha: 'preview-sha',
								activeBrain: brainMeta(activeBrainId)
							}
						}
					: {
							content: [{ type: 'text', text: await displayPage(ap, openPath) }],
							structuredContent: {
								view: 'page',
								path: openPath,
								markdown: await displayPage(ap, openPath),
								activeBrain: brainMeta(activeBrainId)
							}
						}
		);
	}
	document.getElementById('status')!.textContent = `connected · ${mode}`;
};

// Start listening BEFORE the app can send its INITIALIZE. iframe.contentWindow
// is a WindowProxy that stays valid across the srcdoc navigation, so wiring the
// transport now (then loading the app) guarantees the host hears the handshake.
const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
bridge.connect(transport).then(
	() => {
		document.getElementById('status')!.textContent = 'transport connected · loading app…';
	},
	(e) => {
		document.getElementById('status')!.textContent = 'bridge error: ' + String(e);
	}
);
// Now load the real app bytes into the (already-listened-to) iframe.
iframe.srcdoc = BRAIN_APP_HTML;

// ---- host chrome: page selector + theme toggle (host-side, not the app) ----
const sel = document.getElementById('page-select') as HTMLSelectElement;
// Rebuild the selector from the ACTIVE brain's pages. Called on load and after a
// switch_brain (see handleTool) so the dev chrome's page list tracks the brain you're
// viewing instead of stranding you on the old brain's paths.
function rebuildSelector() {
	sel.replaceChildren();
	for (const p of Object.keys(activePages())) {
		const o = document.createElement('option');
		o.value = p;
		o.textContent = p.replace(/^wiki\//, '');
		if (p === openPath) o.selected = true;
		sel.appendChild(o);
	}
}
rebuildSelector();
sel.addEventListener('change', async () => {
	// Re-open the app cold at a new page, exactly as a host would on a new tool call.
	openPath = sel.value;
	const ap = activePages();
	const markdown = await displayPage(ap, openPath);
	bridge.sendToolInput({ arguments: { path: openPath } });
	bridge.sendToolResult({
		content: [{ type: 'text', text: markdown }],
		structuredContent: {
			view: 'page',
			path: openPath,
			markdown,
			activeBrain: brainMeta(activeBrainId)
		}
	});
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
	bridge.setHostContext({ theme: currentTheme() })
);
