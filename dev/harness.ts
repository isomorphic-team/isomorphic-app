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
import { slugify, resolveRelative, parseFrontmatter, withFrontmatter } from '../src/lib/wiki.ts';
import { DEFAULT_BRAIN_CONFIG, isContentPath } from '../src/lib/brain-policy.ts';
import { classifyMdLink } from '../src/lib/links.ts';
import { uniqueAttachmentPath } from '../src/lib/media.ts';
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
import {
	personalPages,
	ACME_PAGES,
	NORTHWIND_PAGES,
	SAMPLE_PNG,
	PERSONAL_ASSET_PATH
} from './seed.ts';

// ---- the fixtures' clock ----
//
// `?now=<ISO>` freezes every date the fixtures produce: the analytics window and its
// day series, the activity feed's relative timestamps, and invite `invited_at`. Two
// things need this. Automated tests (`pnpm test:ui`) assert on rendered dates, and a
// visual baseline captured today has to still match tomorrow — with a live clock the
// analytics chart re-dates itself at every UTC midnight and every snapshot rots. And
// by hand it makes "open the analytics tab" reproducible rather than a moving target.
//
// Unset (the normal `pnpm app:dev` case) it stays live, so the preview still looks
// like today to a human poking at it.
const FROZEN_NOW = new URLSearchParams(location.search).get('now');
const FROZEN_MS = FROZEN_NOW ? Date.parse(FROZEN_NOW) : NaN;
if (FROZEN_NOW && Number.isNaN(FROZEN_MS))
	console.warn(`[harness] ignoring unparseable ?now=${FROZEN_NOW}`);
const nowMs = () => (Number.isNaN(FROZEN_MS) ? Date.now() : FROZEN_MS);
const nowDate = () => new Date(nowMs());
// Ids that must stay unique even when the clock does not move.
let seq = 0;

// Per-brain content. Previously a single shared `pages` map backed every brain, so
// switching brains (or a one-shot `brain:` arg) showed identical pages and you
// couldn't tell them apart. Now each brain has its OWN content: the Personal brain
// uses the rich shared fixtures; the team/client brains get small, obviously-distinct
// sets. Keyed by brain id (matches brainsFixture ids below).
// Shared with `pnpm web:dev`, which materializes the same pages onto disk for the
// local runtime. One seed, two hosts: see dev/seed.ts.
const PERSONAL_PAGES = personalPages();

// Mirror of the server's visible/hidden split (list_pages): visible = content
// pages; EVERYTHING else (system files, .gitkeep, source, the log) is hidden.
// The fixtures all use the default wiki/+raw/ layout, so the default config is
// the right policy here.
const isContentPage = (p: string) => p.endsWith('.md') && isContentPath(p, DEFAULT_BRAIN_CONFIG);
const brainContent: Record<string, Record<string, string>> = {
	'your-org/personal-wiki': PERSONAL_PAGES,
	'acme-co/acme-wiki': ACME_PAGES,
	'northwind/northwind-wiki': NORTHWIND_PAGES
};
// The content map for a brain (auto-vivify so a freshly connect_brain'd brain works).
function pagesFor(id: string): Record<string, string> {
	return (brainContent[id] ??= {});
}

// ---- attachments ----
//
// Stored per brain as base64, the same shape read_media returns, so the app's whole
// image path (hydrate -> data URI -> <img>) is exercised offline. Without this the
// preview could not show a picture at all: the iframe CSP allows no external origin,
// so there is nowhere else the bytes could come from.
//
// The bytes and the default brain's attachment path come from dev/seed.ts, so
// `pnpm web:dev` writes the same image to the same place on disk.
const brainAssets: Record<string, Record<string, { data: string; mimeType: string }>> = {
	// Referenced by the seeded links above. The default brain gets one so the preview
	// shows an image immediately; Acme gets one so switching brains proves attachments
	// are per-brain rather than global.
	'your-org/personal-wiki': {
		[PERSONAL_ASSET_PATH]: { data: SAMPLE_PNG, mimeType: 'image/png' }
	},
	'acme-co/acme-wiki': {
		'wiki/programs/assets/onboarding-flow.png': { data: SAMPLE_PNG, mimeType: 'image/png' }
	}
};
function assetsFor(id: string): Record<string, { data: string; mimeType: string }> {
	return (brainAssets[id] ??= {});
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
	const today = dayKey(nowDate());
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
	const to = dayKey(nowDate());
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
		invited_at: new Date(nowMs() - 2 * 86400e3).toISOString(),
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
// `switched` marks a result that CHANGED the active brain, exactly as switch_brain and
// create_brain do server-side. The app treats the brain a result names as authoritative
// over the connection's pointer, and this flag is how it tells a deliberate move from a
// plain listing (see pickShownBrain in app/core/store.ts) — so a harness that omits it
// previews a switch that does not switch.
function brainsResult(msg: string, withView: boolean, switched = false): CallToolResult {
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
		// `webBase` is what a deployment serving the web app sends (webBaseUrl in
		// src/lib/web-app.ts); it puts the "Open in browser" control in the header.
		features: { analytics: true, webBase: 'https://brain.example' }
	};
	if (withView) sc.view = 'brains';
	if (switched) sc.switched = true;
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

// A stand-in for the git blob sha the real store reports. Any function of the
// content will do, and being a function of the content is the whole property the
// viewer depends on: the same page reads back the same value, and a page that was
// written reads back a different one. Not a real hash and not trying to be.
function pageSha(md: string | undefined): string {
	if (md === undefined) return '';
	let h = 0;
	for (let i = 0; i < md.length; i++) h = (Math.imul(h, 31) + md.charCodeAt(i)) | 0;
	return `sha-${(h >>> 0).toString(16)}`;
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
	// Links to non-page FILES (attachments), kept apart from `edges` exactly as the
	// index keeps them. The harness used to drop them: its md-link loop skipped
	// anything not ending in .md, so an image was referenced by nobody here.
	const fileEdges: { source: string; target: string; kind: 'md' | 'wiki'; cnt: number }[] = [];
	for (const p of pth) {
		const body = stripFrontmatter(pg[p]);
		for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
			// classifyMdLink is the ONE rule (src/lib/links.ts). brain-index.ts's comment
			// says it lives there so the harness can resolve links exactly the way the
			// index does; this is the harness actually doing that, instead of carrying
			// the divergent copy that comment describes.
			const c = classifyMdLink(p, m[1], DEFAULT_BRAIN_CONFIG, (path) => pg[path] !== undefined);
			if (!c.target) continue;
			if (c.kind === 'page') edges.push({ source: p, target: c.target, kind: 'md', cnt: 1 });
			else if (c.kind === 'file')
				fileEdges.push({ source: p, target: c.target, kind: 'md', cnt: 1 });
		}
		for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
			const t = bySlug.get(slugify(m[1].trim())) ?? byTitle.get(m[1].trim().toLowerCase());
			if (t) edges.push({ source: p, target: t, kind: 'wiki', cnt: 1 });
		}
	}
	return {
		resolved: {
			pages: pth.map((p) => ({ path: p, title: titleOf(p, pg[p]) })),
			edges,
			fileEdges,
			broken: []
		},
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

// The app-initiated fetches `#loading` holds open. Each one is a screen that has a
// loading state of its own, which is the point: click a page, run a search, open the
// graph, and read the rotation each one draws.
const STALLED_IN_LOADING_MODE = new Set([
	'read_page',
	'read_media',
	'search_pages',
	'view_graph',
	'view_activity',
	'members',
	'analytics',
	'brain_access'
]);

// ---- the host's answer to every callback the app makes ----
async function handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	// `#loading`: the fetches the app starts on its own never answer, so the wait they
	// draw stays on screen. Only those, and only in this mode: list_pages and brains
	// still answer, because a loading line that names the brain, the page and the page
	// count is the thing worth looking at, and the app learns all three from them.
	if (loadingMode && STALLED_IN_LOADING_MODE.has(name))
		return new Promise<CallToolResult>(() => {});
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
			// Both `markdown` and `sha` mirror the server response.
			const body = hasViews(md) ? (await renderViews(md, path, viewCtxFor(pg))).snapshotted : md;
			return {
				...text(body),
				structuredContent: { path, markdown: body, sha: pageSha(md) }
			};
		}
		case 'read_media': {
			const asset = assetsFor(bid)[path];
			if (!asset) return errText(`No file at "${path}".`);
			const r = text(`${path} (${asset.mimeType})`);
			// The bytes are opt-in on the server (they are for the app, not the model),
			// so they are opt-in here. A harness that hands them over unasked would let
			// the app forget to ask and still work in dev.
			const includeData = args?.include_data === true;
			return {
				...r,
				structuredContent: {
					path,
					mimeType: asset.mimeType,
					size: Math.floor((asset.data.length * 3) / 4),
					...(includeData ? { dataUri: `data:${asset.mimeType};base64,${asset.data}` } : {})
				}
			};
		}
		case 'attach_media': {
			// Two shapes, same as the server. `page` stores the file AND appends a link
			// (the conversational path). `path` stores it and nothing else — which is what
			// the editor uses, because it has already inserted the image node itself and
			// the save writes the page; appending here would duplicate the link.
			const pagePath = String(args?.page ?? '');
			const explicitPath = String(args?.path ?? '');
			const filename = String(args?.filename ?? 'attachment');
			const mimeType = String(args?.mime_type ?? '');
			const data = String(args?.data ?? '');
			if (!pagePath && !explicitPath) return errText('Give a `page` or a `path`.');

			let target = explicitPath;
			if (!target) {
				const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : 'bin';
				const slug =
					filename
						.slice(0, filename.length - ext.length - 1)
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '-')
						.replace(/^-+|-+$/g, '') || 'attachment';
				const dir = pagePath.slice(0, pagePath.lastIndexOf('/'));
				target = `${dir}/assets/${slug}.${ext}`;
			}
			// Mirrors the server: never overwrite a file that is already there, number
			// the name instead, and report where it actually landed.
			const store = assetsFor(bid);
			target = uniqueAttachmentPath(target, (p) => p in store || pth.includes(p));
			if (!target) return errText('Every numbered variant of that name is taken.');
			store[target] = { data, mimeType };

			if (pagePath) {
				const md = pg[pagePath];
				if (md === undefined) return errText(`No page at "${pagePath}".`);
				const alt = String(args?.alt ?? filename);
				const rel = target.startsWith(`${pagePath.slice(0, pagePath.lastIndexOf('/'))}/`)
					? target.slice(pagePath.lastIndexOf('/') + 1)
					: target;
				pg[pagePath] = `${md.replace(/\n*$/, '')}\n\n![${alt}](${rel})\n`;
			}
			return {
				...text(`Stored ${target}. The change was logged.`),
				structuredContent: { path: target, mimeType }
			};
		}
		case 'list_pages': {
			const prefix = String(args?.prefix ?? '');
			const listed = pth.filter((p) => p.startsWith(prefix));
			// Visible content pages carry titles; everything else (system files,
			// .gitkeep, source, the log) comes back as `hidden` for the eye toggle.
			const visible = listed.filter(isContentPage);
			const hiddenPaths = listed.filter((p) => !isContentPage(p));
			// Attachments live in their own map here (they are bytes, not markdown), so
			// they have to be folded in explicitly — the server gets both from one tree
			// walk. Reported as `assets`, never as `hidden`: they are content.
			const assetPaths = Object.keys(assetsFor(bid))
				.filter((p) => p.startsWith(prefix))
				.sort();
			const r = text(visible.join('\n'));
			return {
				...r,
				structuredContent: {
					pages: visible.map((p) => ({ path: p, title: titleOf(p, pg[p]) })),
					assets: assetPaths,
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
			// Mirrors the server: `scope: "all"` reaches every brain the caller can see and
			// every hit names its brain, with the brain the call resolved leading. The
			// default is that one brain, so an ordinary search stays where it was.
			const wide = args?.scope === 'all';
			const targets = wide
				? [bid, ...brainsFixture.map((b) => b.id).filter((id) => id !== bid)]
				: [bid];
			const hits: {
				path: string;
				line: number;
				text: string;
				brain: string;
				brainLabel: string;
			}[] = [];
			for (const id of targets) {
				const label = brainsFixture.find((b) => b.id === id)?.label ?? id;
				const pages = pagesFor(id);
				for (const p of Object.keys(pages)) {
					stripFrontmatter(pages[p])
						.split('\n')
						.forEach((ln, i) => {
							if (q && ln.toLowerCase().includes(q))
								hits.push({ path: p, line: i + 1, text: ln.trim(), brain: id, brainLabel: label });
						});
				}
			}
			const r = text(`${hits.length} match(es) for "${args?.query}".`);
			return {
				...r,
				structuredContent: { hits: hits.slice(0, 50), scope: wide ? 'all' : 'brain' }
			};
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
				const parsed = parseFrontmatter(pg[p]);
				if (args?.content !== undefined) {
					// Keep the existing frontmatter, exactly like the server's body-only save.
					const fm = pg[p].match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? '';
					pg[p] = fm + content;
				} else {
					// Property-panel writes carry metadata only. Mirror the server enough for
					// the app to reload and observe the field it just changed.
					const fm = { ...(parsed.frontmatter ?? {}) };
					for (const key of ['title', 'type', 'description', 'status'] as const) {
						if (typeof args?.[key] === 'string') fm[key] = args[key];
					}
					pg[p] = withFrontmatter(fm, parsed.body);
				}
			} else {
				const title = String(args?.title ?? p.split('/').pop()!.replace(/\.md$/, ''));
				pg[p] = `---\ntitle: ${title}\n---\n\n${content}`;
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
			const now = nowMs();
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
			// Two kinds of target. A PAGE is looked up in the page map and titled from its
			// content; an ATTACHMENT lives in the asset map and is titled by its filename.
			// Missing that split made the asset view report "no page shows this file" for
			// an image that was plainly on a page, because the lookup errored before any
			// scanning happened.
			const asset = assetsFor(bid)[path];
			const targetMd = pg[path];
			if (targetMd === undefined && !asset) return errText(`"${path}" does not exist.`);
			const targetTitle = asset ? (path.split('/').pop() ?? path) : titleOf(path, targetMd);
			const targetSlug = slugify(path.split('/').pop()!.replace(/\.md$/, ''));
			const refs: { path: string; title: string; mdCount: number; wikiCount: number }[] = [];
			for (const p of pth) {
				if (p === path) continue;
				const content = pg[p];
				let mdCount = 0;
				let wikiCount = 0;
				// The REAL classification rule, imported rather than approximated. This
				// scan used to be a hand-written regex that only counted `.md` targets,
				// so the preview reported "no page shows this file" for an image that was
				// plainly on a page — a divergence from prod that manufactured a bug
				// rather than revealing one. classifyMdLink is what the content index
				// itself calls; the harness only supplies the page set.
				for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
					const c = classifyMdLink(p, m[1], DEFAULT_BRAIN_CONFIG, (q) => q in pg);
					if ((c.kind === 'page' || c.kind === 'file') && c.target === path) mdCount++;
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
					// Seq, not the clock: a frozen `?now=` would collide two invites on one id.
					invite_id: `inv-${++seq}`,
					email,
					role,
					invited_at: nowDate().toISOString(),
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
			return brainsResult(`Switched to ${hit.label}.`, true, true);
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

bridge.oncalltool = async (params) => {
	// Every tool the app calls itself, in order, for tests that assert on what it did
	// NOT ask for (see `#pending-input`: an app waiting for a result it knows is coming
	// must not fetch the tree). Nothing in the preview reads this.
	((window as unknown as { __toolCalls?: string[] }).__toolCalls ??= []).push(params.name);
	// The slow-result routes need the app's OWN tree fetch to still be in flight when
	// the opening result lands — that overlap is the whole scenario, and an instant
	// answer here would close it (see slowResultMode).
	if ((slowResultMode || pendingInputMode) && params.name === 'list_pages')
		await new Promise((r) => setTimeout(r, SLOW_LIST_MS));
	return handleTool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
};
// No tab opens here; the request is recorded where a test can read it, since which
// URL the app asked the host to open is the whole assertion for "Open in browser".
const openedLinks: string[] = [];
(window as unknown as { __openedLinks: string[] }).__openedLinks = openedLinks;
bridge.onopenlink = async (req) => {
	openedLinks.push(req.url);
	return {};
};
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
	// ONLY inline is content-sized. fullscreen and pip own a fixed window that
	// presentMode already set, and presentMode clears `height` on every mode change,
	// so there is nothing for this function to clean up.
	//
	// This used to clear the height here instead of returning, which undid pip's 560px
	// on the first size-changed notification the app sent: the floating window then
	// grew to content height from its `bottom: 20px` anchor and ran off the top of the
	// viewport. Caught by the pip visual baseline the first time it was generated.
	if (activeMode !== 'inline') return;
	if (height == null || !Number.isFinite(height)) return;
	const slot = document.getElementById('frame-slot')!;
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
// `#loading` opens the tree too (see loadingMode): the wait it exists to show is only
// worth looking at once the app knows where it is.
const browseMode = hashMode === 'browse' || hashMode === 'loading';
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
// `#other-brain` is issue #26: the MODEL opened a brain by name (browse_brain /
// view_page with `brain:`), so the opening result is about that brain while the
// connection's active-brain pointer — which the app re-reads through `brains` on every
// open — still answers with the previous one. The harness deliberately does NOT move
// its own pointer here, because the real one lags for the same reason: it is written by
// the request that opened the widget and read by the next one.
const otherBrainMode = hashMode === 'other-brain';
// `#slow-result` and `#pending-input` are the opposite of #cold: a result IS coming, it
// is just slower than the app's self-boot deadline. A host announces a tool call when it
// STARTS and delivers the result when the tool FINISHES, and view_page on a large brain
// (cold Worker, index catch-up) routinely takes longer than 1200ms.
//
//   #slow-result    the host says nothing until the result lands, so the app self-boots
//                   into the tree and its list_pages is still in flight when the page
//                   arrives. The result names ANOTHER brain, the way a `brain:`-targeted
//                   view_page does, so the stale answer is about the wrong brain too.
//   #pending-input  the host announces the call first (sendToolInput), which is the
//                   app's signal that a result is coming and it should keep waiting.
const slowResultMode = hashMode === 'slow-result';
const pendingInputMode = hashMode === 'pending-input';
// `#loading` announces a call and never answers it, so the loading view stays up and can
// actually be read. It is the one view with no other way in: every other mode's stub
// answers in milliseconds, and the rotating status line it draws does not begin until
// 2.4s, so nothing else here shows more than its first frame. (`#pending-input` above is
// the closest and still resolves at 1.8s.) The app gives up on a promised result after
// 30s and opens the tree, which is the behavior under test at the far end of the wait.
const loadingMode = hashMode === 'loading';
// Past the app's 1200ms deadline, with the tree fetch that deadline kicks off answering
// after the page — so the page is on screen when the stale tree lands.
const SLOW_RESULT_MS = 1800;
const SLOW_LIST_MS = 1600;
// A brain that is NOT the active one, with content of its own to tell them apart.
const OTHER_BRAIN = 'northwind/northwind-wiki';
// One of its pages, so `#slow-result`'s opening result is unmistakably about the brain
// the model named rather than the one the connection's pointer still holds.
const OTHER_BRAIN_PAGE = 'wiki/facilities/headquarters.md';
// `#stale` is issue #29's second case: somebody else edited the page after the widget
// rendered it. The opening result is sent from the content as it was, and the stored
// page is then changed, so the widget is holding a render the brain has moved past
// with nothing on screen saying so. Refreshing is the only way to find out, which is
// the whole point of the control.
//
// The edit lands AFTER the opening result rather than before, because the order is
// the scenario: a render that was correct when it was taken and is not any more.
const staleMode = hashMode === 'stale';
function editPageBehindTheWidget() {
	const pages = activePages();
	const md = pages[openPath];
	if (md === undefined) return;
	pages[openPath] = `${md}\n\nAdded by somebody else while you were reading.\n`;
}
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
	// A result that is slower than the app's self-boot deadline (see slowResultMode).
	// `#pending-input` announces the call first; `#slow-result` says nothing at all,
	// which is the harder case and the one that used to lose the page.
	if (slowResultMode || pendingInputMode) {
		const brain = slowResultMode ? OTHER_BRAIN : activeBrainId;
		const path = slowResultMode ? OTHER_BRAIN_PAGE : openPath;
		if (pendingInputMode) bridge.sendToolInput({ arguments: { path } });
		document.getElementById('status')!.textContent = `connected · ${hashMode} (result pending)`;
		setTimeout(async () => {
			const markdown = await displayPage(pagesFor(brain), path);
			bridge.sendToolResult({
				content: [{ type: 'text', text: markdown }],
				structuredContent: {
					view: 'page',
					path,
					markdown,
					sha: pageSha(pagesFor(brain)[path]),
					activeBrain: brainMeta(brain)
				}
			});
			document.getElementById('status')!.textContent = `connected · ${hashMode}`;
		}, SLOW_RESULT_MS);
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
			noBrainsMode ||
			otherBrainMode
				? {}
				: { path: openPath }
	});
	if (otherBrainMode) {
		// browse_brain's payload for the NAMED brain, pointer left where it was.
		const other = pagesFor(OTHER_BRAIN);
		const paths = Object.keys(other).filter(isContentPage);
		bridge.sendToolResult({
			content: [{ type: 'text', text: `Opened Northwind in the viewer: ${paths.length} page(s).` }],
			structuredContent: {
				view: 'browse',
				paths,
				pages: paths.map((p) => ({ path: p, title: titleOf(p, other[p]) })),
				assets: [],
				hidden: [],
				activeBrain: brainMeta(OTHER_BRAIN)
			}
		});
	} else if (browseEmptyMode) {
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
							assets: Object.keys(assetsFor(activeBrainId)).sort(),
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
								sha: pageSha(ap[openPath]),
								activeBrain: brainMeta(activeBrainId)
							}
						}
		);
	}
	if (staleMode) editPageBehindTheWidget();
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
			sha: pageSha(activePages()[openPath]),
			activeBrain: brainMeta(activeBrainId)
		}
	});
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
	bridge.setHostContext({ theme: currentTheme() })
);
