// Async data + navigation actions, the server-context parsers, and the central
// tool-result router (handleToolResult). Everything here builds View *data objects*
// and drives the store; nothing here renders (no components), so the view layer can
// import freely without a cycle.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { marked } from 'marked';
import { slugify, resolveRelative } from '../../src/lib/wiki.ts';
import type {
	View,
	Hit,
	ActivityEntry,
	GraphNode,
	GraphLink,
	Member,
	Invite,
	MemberSelf,
	BrainAccessEntry,
	BrainAccessSelf,
	MemberRole,
	BrainRow,
	OrgTarget,
	ConnectedAccount,
	Identity,
	BrowseData,
	UsageWindow,
	UsageTotals,
	UsagePoint,
	UsagePerson,
	UsageBrain
} from './types.ts';
import { app, callTool, firstText } from './host.ts';
import { FOLDER_NOTE_NAMES } from './util.ts';
import {
	show,
	history,
	currentView,
	brainArgs,
	browseCache,
	setBrowseCache,
	activeBrain,
	setActiveBrain,
	brainList,
	setBrainList,
	setFeatures,
	applyPolicy,
	resetPolicy,
	applyBrainContext,
	bump
} from './store.ts';
import { toast } from './toast.tsx';

// The central tool-result router: the host feeds every opening tool result here via
// app.ontoolresult (wired in main.tsx).
function handleToolResult(result: CallToolResult) {
	if (result.isError) {
		const detail = firstText(result);
		// A brain-scope tool opened against a user with no brain yet → offer to create one.
		if (isNoBrain(detail)) {
			void ensureBrainList();
			openAddBrain();
			return;
		}
		show({
			kind: 'error',
			headline: 'The tool that opened this view failed.',
			detail
		});
		return;
	}
	const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
	applyPolicy(sc);
	applyBrainContext(sc);
	// Learn the brain list once, lazily, so the switcher knows whether to appear.
	void ensureBrainList();
	const view = typeof sc.view === 'string' ? sc.view : 'page';
	if (view === 'browse') {
		// browse_brain → file tree. Prefer paths delivered in the result; otherwise
		// fetch them via list_pages (openBrowse). Text fallback still carries the index.
		const paths = Array.isArray(sc.paths) ? (sc.paths as string[]) : null;
		if (paths) {
			// Seed the cache from the delivered payload — it's the same list_pages shape,
			// so later folder lookups and tree opens need no round-trip of their own.
			const data: BrowseData = {
				paths,
				titleByPath: pagesToTitleMap(sc.pages),
				assets: Array.isArray(sc.assets) ? (sc.assets as string[]) : [],
				hidden: Array.isArray(sc.hidden) ? (sc.hidden as string[]) : [],
				needsConfig: !!sc.needsConfig
			};
			setBrowseCache(data);
			browseFetchedAt = Date.now();
			show({ kind: 'browse', ...data }, { push: false });
		} else openBrowse();
	} else if (view === 'edit')
		show(
			{
				kind: 'edit',
				path: String(sc.path ?? ''),
				markdown: String(sc.markdown ?? ''),
				sha: String(sc.sha ?? '')
			},
			{ push: false }
		);
	else if (view === 'activity')
		show(
			{
				kind: 'activity',
				entries: Array.isArray(sc.entries) ? (sc.entries as ActivityEntry[]) : [],
				scopePath: (sc.scope as { path?: string } | undefined)?.path
			},
			{ push: false }
		);
	else if (view === 'graph')
		show(
			{
				kind: 'graph',
				nodes: Array.isArray(sc.nodes) ? (sc.nodes as GraphNode[]) : [],
				links: Array.isArray(sc.edges) ? (sc.edges as GraphLink[]) : [],
				focus: typeof sc.focus === 'string' ? sc.focus : undefined,
				truncated: !!sc.truncated
			},
			{ push: false }
		);
	else if (view === 'members') show(membersViewFromSc(sc), { push: false });
	else if (view === 'analytics') show(analyticsViewFromSc(sc), { push: false });
	else if (view === 'brain-access') show(brainAccessViewFromSc(sc), { push: false });
	else if (view === 'brains') {
		const bv = brainsViewFromSc(sc);
		// Zero brains (e.g. view_brains on a fresh account) → the create-your-first-brain
		// state instead of an empty list.
		if (bv.kind === 'brains' && bv.brains.length === 0)
			show({ kind: 'add-brain', orgs: [], first: true }, { push: false });
		else show(bv, { push: false });
	}
	// Settings and the connected-accounts widget resolve to the SAME page — the
	// identity card with connected accounts folded in beneath it.
	else if (view === 'settings' || view === 'connected_accounts')
		show(
			{ kind: 'settings', identity: parseIdentity(sc), accounts: parseAccounts(sc) },
			{ push: false }
		);
	else
		show(
			{ kind: 'page', path: String(sc.path ?? ''), markdown: String(sc.markdown ?? '') },
			{ push: false }
		);
}

// Build a brains View from a tool result (view_brains / switch_brain). Also refreshes
// the cached brain list + active brain so the header switcher stays in sync.
function brainsViewFromSc(sc: Record<string, unknown>): View {
	const brains = Array.isArray(sc.brains) ? (sc.brains as BrainRow[]) : [];
	const active = String(sc.active ?? activeBrain?.id ?? '');
	if (brains.length) {
		setBrainList(brains);
		const a = brains.find((b) => b.id === active);
		if (a) setActiveBrain({ id: a.id, label: a.label });
	}
	return { kind: 'brains', brains, active };
}

// Fetch the caller's brain list once (idempotent). The switcher only appears when
// there are 2+ brains, so this is what tells the header whether to render it.
//
// UNKNOWN IS NOT ZERO. `null` means "we haven't found out yet"; `[]` means "we asked
// and there are none" — and `[]` is what makes the header offer to create your first
// brain. Anything that can't answer the question must leave the list null, or someone
// sitting inside a brain gets told they have none.
let brainListPromise: Promise<void> | null = null;
function ensureBrainList(): Promise<void> {
	if (brainList !== null) return Promise.resolve();
	if (brainListPromise) return brainListPromise;
	brainListPromise = (async () => {
		try {
			const res = await callTool('brains', {});
			// A failed tool call comes back as a RESULT carrying isError — it does NOT throw.
			// Without this check the empty payload silently read as a successful "zero brains".
			if (res.isError) throw new Error(firstText(res));
			const sc = (res.structuredContent ?? {}) as {
				brains?: BrainRow[];
				active?: string;
				features?: { analytics?: boolean };
			};
			if (!Array.isArray(sc.brains)) throw new Error('brains: no list in the result');
			setBrainList(sc.brains);
			// Which optional server surfaces exist (today: the org Analytics tab). Rides
			// this call because it is the one the app always makes on open.
			setFeatures(sc.features);
			const a = sc.brains.find((b) => b.id === (sc.active ?? activeBrain?.id));
			if (a) setActiveBrain({ id: a.id, label: a.label });
			bump();
		} catch {
			// Stay unknown: the header keeps its neutral Files button rather than claiming
			// you have no brains. Drop the memo so the next view retries instead of the
			// whole session being stuck on one unlucky call.
			brainListPromise = null;
		}
	})();
	return brainListPromise;
}

// Switch the active brain, then land on its file tree. Selecting the already-active
// brain just (re)opens its files — so the switcher doubles as the Files action.
async function switchBrain(id: string) {
	if (activeBrain?.id === id) {
		openBrowse();
		return;
	}
	show({ kind: 'loading', label: 'Switching brain…' });
	try {
		const res = await callTool('switch_brain', { brain: id });
		if (res.isError) throw new Error(firstText(res));
		brainsViewFromSc((res.structuredContent ?? {}) as Record<string, unknown>);
		setBrowseCache(null); // the file tree belongs to the old brain
		resetPolicy(); // and so does its path policy — list_pages delivers the new one
		openBrowse();
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't switch brain.",
			detail: String(e),
			retry: () => switchBrain(id)
		});
	}
}

// Does an error message signal the "no brain yet" state? Brain-scope tools throw a
// NoBrainError server-side (worker.ts) when the caller has an org but no brain — we
// route those to the create-a-brain flow instead of showing a raw error.
function isNoBrain(s: string): boolean {
	return /don.?t have a brain yet/i.test(s);
}

// The orgs a caller can add a brain to: deduped from the brains they already admin.
// Derived from the brains list rather than the ACTIVE brain, so sitting in a brain
// you only view doesn't hide an org you own. Shared by the brains view's action gate
// and by the add-brain flow itself, which must agree on "can you add" or the header
// offers a button that opens an empty picker.
function manageableOrgs(brains: BrainRow[]): OrgTarget[] {
	const out: OrgTarget[] = [];
	const seen = new Set<string>();
	for (const b of brains) {
		if (!b.canManage || !b.orgId || seen.has(b.orgId)) continue;
		seen.add(b.orgId);
		out.push({ orgId: b.orgId, orgLabel: b.orgLabel ?? b.label, brainId: b.id });
	}
	return out;
}

// ---------- flows ----------
//
// Every add-shaped action in the app opens as its own PUSHED VIEW: add a brain,
// create a brain, invite a member, connect an account. The card is already a bounded
// box in the conversation, so a flow that needs room takes the whole card rather than
// floating a dialog inside it — the reasoning, and the shared shell, are in
// app/ui/Flow.tsx. Openers are grouped here because they are the entry points, and a
// header action calls one directly (there is no composer to register at mount time).
//
// Each flow exits through goBack(), falling back to the screen it belongs to when
// there is no history (a flow reached straight from a tool result).

// The ONE entry point for getting a brain into this workspace, whichever source it
// comes from. There used to be two (openCreateBrain from the switcher and the empty
// state, openAddBrain from the brains list), which is what put "New brain" and "Add a
// brain" in front of the user as if they were different intents.
//
// Both arguments are derived when omitted, so every call site is just openAddBrain().
// `first` (no brains yet) tunes the copy and drops the source chooser: there is
// nothing to connect to before you have a brain to resolve an org from.
function openAddBrain(opts: { orgs?: OrgTarget[]; first?: boolean } = {}) {
	show({
		kind: 'add-brain',
		orgs: opts.orgs ?? manageableOrgs(brainList ?? []),
		first: opts.first ?? (brainList?.length ?? 0) === 0
	});
}

function openInviteMember() {
	show({ kind: 'invite-member' });
}

function openConnectAccount() {
	show({ kind: 'connect-account' });
}

// Leave the add-brain flow for the brain it just connected.
//
// A COMPLETED flow does not belong in the back stack: pressing Back from the new
// brain should show the brains list with the new brain in it, not re-open the picker
// that would offer to connect the repo a second time. So the stale brains list that
// opened the flow is dropped and replaced by the refreshed one from this result,
// which switchBrain then pushes on its way out.
function finishAddBrain(sc: Record<string, unknown>, connectedId: string) {
	const fresh = brainsViewFromSc(sc);
	dropStale('brains');
	show(fresh, { push: false });
	switchBrain(connectedId);
}

// Leave the invite flow for the roster, with the new invite already on it (the
// mutation returns the fresh roster). Same stack discipline as finishAddBrain: a
// completed flow must not sit in history, or Back re-opens a form for something the
// user has already done.
function finishInvite(sc: Record<string, unknown>) {
	const fresh = membersViewFromSc(sc);
	dropStale('members');
	show(fresh, { push: false });
}

// A completed flow must not sit in the back stack, and the screen it was opened from
// is usually STALE the moment it finishes (a brain added, an invite sent). Both
// helpers touch only the TOP of the stack and only when it is the expected screen, so
// a flow reached some other way never eats someone else's history entry.
function dropStale(kind: View['kind']) {
	if (history.at(-1)?.kind === kind) history.pop();
}
function refreshStale(kind: View['kind'], fresh: View) {
	if (history.at(-1)?.kind === kind) history[history.length - 1] = fresh;
}

// Create a new named brain, then land on its (empty) file tree. The tool scaffolds a
// fresh repo, switches the active brain server-side, and returns the refreshed brains
// list — so we refresh the cache and open the new brain just like a switch.
async function submitCreateBrain(name: string) {
	const trimmed = name.trim();
	if (!trimmed) return;
	// push:false — a completed flow must not enter the back stack, so the screen that
	// opened it stays on top and Back from the new brain lands there, not on a form
	// offering to create the brain that now exists.
	show({ kind: 'loading', label: 'Creating brain…' }, { push: false });
	try {
		const res = await callTool('create_brain', { name: trimmed });
		if (res.isError) throw new Error(firstText(res));
		const fresh = brainsViewFromSc((res.structuredContent ?? {}) as Record<string, unknown>);
		refreshStale('brains', fresh); // ...and if that screen was the brains list, it is now stale
		setBrowseCache(null);
		resetPolicy();
		openBrowse();
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't create the brain.",
			detail: String(e),
			retry: () => openAddBrain()
		});
	}
}

// Open the full brains view (the bi-modal counterpart to the header switcher).
async function openBrains() {
	show({ kind: 'loading', label: 'Loading brains…' });
	try {
		const res = await callTool('brains', {});
		if (res.isError) throw new Error(firstText(res));
		show(brainsViewFromSc((res.structuredContent ?? {}) as Record<string, unknown>));
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load brains.",
			detail: String(e),
			retry: openBrains
		});
	}
}

// Build a members View from a tool result's structuredContent (view_members /
// list_members / any mutation, which all return the fresh roster).
function membersViewFromSc(sc: Record<string, unknown>): View {
	const me = (sc.me ?? {}) as Partial<MemberSelf>;
	return {
		kind: 'members',
		members: Array.isArray(sc.members) ? (sc.members as Member[]) : [],
		invites: Array.isArray(sc.invites) ? (sc.invites as Invite[]) : [],
		me: { user_id: String(me.user_id ?? ''), role: (me.role as MemberRole) ?? 'viewer' }
	};
}

// Build a brain-access View from a tool result's structuredContent (brain_access
// and every share_brain mutation return the fresh access list).
function brainAccessViewFromSc(sc: Record<string, unknown>): View {
	const me = (sc.me ?? {}) as Partial<BrainAccessSelf>;
	const active = (sc.activeBrain ?? {}) as { id?: string; label?: string };
	return {
		kind: 'brain-access',
		access: Array.isArray(sc.access) ? (sc.access as BrainAccessEntry[]) : [],
		visibility: typeof sc.visibility === 'string' ? sc.visibility : 'org',
		// Carried so the panel and its share flow keep acting on the brain the user
		// opened, not on whatever happens to be active: the Share control in the
		// brains list can target a brain that is not the current one, and `brain` has
		// to ride on every subsequent call for it to stay there.
		brainId: String(active.id ?? ''),
		brainLabel: String(active.label ?? 'this brain'),
		me: {
			user_id: String(me.user_id ?? ''),
			role: (me.role as MemberSelf['role']) ?? 'viewer',
			orgRole: (me.orgRole as MemberSelf['role']) ?? 'viewer'
		}
	};
}

// Open the sharing panel for a brain: who can reach it, and at what level.
// `brain` targets a specific one (the Share control in the brains list); omitted,
// it acts on the active brain.
async function openBrainAccess(brain?: string) {
	show({ kind: 'loading', label: 'Loading sharing…' });
	try {
		const result = await callTool('brain_access', brain ? { brain } : {});
		if (result.isError) throw new Error(firstText(result));
		show(brainAccessViewFromSc((result.structuredContent ?? {}) as Record<string, unknown>));
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load sharing.",
			detail: String(e),
			retry: () => openBrainAccess(brain)
		});
	}
}

// Re-render the sharing panel in place from a mutation's structuredContent, without
// pushing a history entry (mirrors refreshMembers).
function refreshBrainAccess(sc: Record<string, unknown>) {
	show(brainAccessViewFromSc(sc), { push: false });
}

// Share this brain with someone new. A pushed flow rather than a row on the panel,
// for the same reason inviting is: every add-shaped action in the app opens one
// (app/ui/Flow.tsx), and the extra room is what lets the picked level say what it
// actually grants.
function openShareBrain(brainId: string, brainLabel: string) {
	show({ kind: 'share-brain', brainId, brainLabel });
}

// Leave the share flow for the refreshed panel, the new person already on it. Same
// stack discipline as finishInvite: a completed flow must not sit in history, or
// Back re-opens a form for something already done.
function finishShareBrain(sc: Record<string, unknown>) {
	const fresh = brainAccessViewFromSc(sc);
	dropStale('brain-access');
	show(fresh, { push: false });
}

async function fetchPage(path: string): Promise<string> {
	const result = await callTool('read_page', { path, ...brainArgs() });
	if (result.isError) throw new Error(firstText(result));
	return firstText(result);
}

async function fetchPageList(): Promise<string[]> {
	return (browseCache ?? (await fetchPaths())).paths;
}

// ---------- navigation ----------

async function navigateTo(path: string) {
	show({ kind: 'loading', label: `Loading ${path}…` });
	try {
		show({ kind: 'page', path, markdown: await fetchPage(path) });
	} catch (e) {
		if (isNoBrain(String(e))) return openAddBrain();
		show({
			kind: 'error',
			headline: `Couldn't load ${path}`,
			detail: String(e),
			retry: () => navigateTo(path)
		});
	}
}

// Open one attachment on its own. The counterpart to navigateTo for files that are
// not pages: same shape (loading -> view -> error with retry), different tool.
//
// It exists because assets became browsable. A tree row you can see but not open is
// worse than one that was never listed, so making them visible obliged us to give
// them somewhere to go.
async function openAsset(path: string) {
	show({ kind: 'loading', label: `Loading ${path}…` });
	try {
		const res = await callTool('read_media', { path, ...brainArgs() });
		if (res.isError) throw new Error(firstText(res));
		const sc = (res.structuredContent ?? {}) as {
			mimeType?: string;
			size?: number;
			dataUri?: string;
		};
		show({
			kind: 'asset',
			path,
			mimeType: sc.mimeType ?? '',
			size: typeof sc.size === 'number' ? sc.size : 0,
			dataUri: sc.dataUri ?? ''
		});
	} catch (e) {
		if (isNoBrain(String(e))) return openAddBrain();
		show({
			kind: 'error',
			headline: `Couldn't load ${path}`,
			detail: String(e),
			retry: () => openAsset(path)
		});
	}
}

// Build a path→title lookup from a tool's structuredContent.pages (see list_pages /
// browse_brain, which serve titles from the content index). Tolerant of a missing or
// malformed field so the tree still renders (falling back to filenames).
function pagesToTitleMap(pages: unknown): Record<string, string> {
	const map: Record<string, string> = {};
	if (Array.isArray(pages)) {
		for (const p of pages) {
			if (p && typeof p.path === 'string' && typeof p.title === 'string') map[p.path] = p.title;
		}
	}
	return map;
}

// How long a cached tree is trusted without a background re-check. Only external
// writes (an agent editing the brain while the widget is open) can age it — our own
// CRUD refreshes it directly — so this is about freshness, not correctness.
const BROWSE_STALE_MS = 15_000;
let browseFetchedAt = 0;

// One list_pages call → the whole tree payload, memoized in the store. Every tree
// open after the first is instant; the caller decides whether to revalidate.
async function fetchPaths(): Promise<BrowseData> {
	const result = await callTool('list_pages', { ...brainArgs() }); // no prefix → the whole brain (index-backed, carries titles)
	const sc = (result.structuredContent ?? {}) as Record<string, unknown> & {
		pages?: unknown;
		hidden?: unknown;
		needsConfig?: boolean;
	};
	// This is a WIDGET-initiated call, so it never passes through handleToolResult —
	// apply the path policy here or the tree keeps whatever policy the last
	// host-initiated result left behind (a different brain's, or the wiki/ default).
	applyPolicy(sc);
	const paths = firstText(result)
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.endsWith('.md'));
	const data: BrowseData = {
		paths,
		titleByPath: pagesToTitleMap(sc.pages),
		assets: Array.isArray(sc.assets) ? (sc.assets as string[]) : [],
		hidden: Array.isArray(sc.hidden) ? (sc.hidden as string[]) : [],
		needsConfig: !!sc.needsConfig
	};
	setBrowseCache(data);
	browseFetchedAt = Date.now();
	return data;
}

// Open the file tree, optionally REVEALED at `focus` (a folder path): the tree mounts
// with that folder's ancestors expanded and the row scrolled into view, so landing here
// from a breadcrumb never dumps you at a collapsed root with no sense of place.
//
// A warm cache renders immediately and revalidates in the background — the tree is the
// app's most-revisited view, and a spinner in front of a list we already have is the
// bulk of the "clicking a breadcrumb takes too long" feeling.
async function openBrowse(focus?: string) {
	if (browseCache) {
		show({ kind: 'browse', ...browseCache, focus });
		void revalidateBrowse();
		return;
	}
	show({ kind: 'loading', label: 'Loading files…' });
	try {
		show({ kind: 'browse', ...(await fetchPaths()), focus });
	} catch (e) {
		if (isNoBrain(String(e))) return openAddBrain();
		show({
			kind: 'error',
			headline: "Couldn't load the file tree.",
			detail: String(e),
			retry: () => openBrowse(focus)
		});
	}
}

// Refresh a cache-rendered tree in place. Silent by design: it only repaints if the
// user is still looking at the tree, and a failure leaves the cached one alone.
async function revalidateBrowse() {
	if (Date.now() - browseFetchedAt < BROWSE_STALE_MS) return;
	const before = currentView;
	try {
		const data = await fetchPaths();
		if (currentView !== before || currentView.kind !== 'browse') return;
		show({ kind: 'browse', ...data, focus: currentView.focus }, { push: false });
	} catch {
		// keep the cached tree — it's what the user is already reading
	}
}

// A nav/breadcrumb click on a folder: open its folder note (<folder>/index.md) when it
// has one — the same page the file tree opens for that folder — else open the tree
// REVEALED at that folder. A note-less folder used to fall back to the bare root tree,
// which read as "the breadcrumb sent me somewhere else entirely".
async function openFolder(prefix: string) {
	const base = prefix.replace(/\/+$/, '');
	try {
		// Only a cold cache costs a round-trip — say so rather than hanging silently.
		if (!browseCache) show({ kind: 'loading', label: `Opening ${base.split('/').pop()}…` });
		const list = await fetchPageList();
		// index.md preferred, README.md fallback (see FOLDER_NOTE_NAMES).
		const note = FOLDER_NOTE_NAMES.map((n) => `${base}/${n}`).find((p) => list.includes(p));
		if (note) return navigateTo(note);
	} catch {
		// no page list — the tree is always a safe destination
	}
	return openBrowse(base);
}

// Open the activity/audit feed — whole brain, or one page's history when `path`
// is given. Drives the same view the view_activity tool opens.
async function openActivity(path?: string) {
	show({ kind: 'loading', label: 'Loading recent changes…' });
	try {
		const result = await callTool('view_activity', { ...(path ? { path } : {}), ...brainArgs() });
		if (result.isError) throw new Error(firstText(result));
		const sc = (result.structuredContent ?? {}) as {
			entries?: ActivityEntry[];
			scope?: { path?: string };
		};
		show({ kind: 'activity', entries: sc.entries ?? [], scopePath: sc.scope?.path });
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load recent changes.",
			detail: String(e),
			retry: () => openActivity(path)
		});
	}
}

// Open the org roster — members + pending invites. Drives the same view the
// `members` tool opens; mutations (invite / role / remove) refresh through
// refreshMembers below.
async function openMembers() {
	show({ kind: 'loading', label: 'Loading members…' });
	try {
		const result = await callTool('members', {});
		if (result.isError) throw new Error(firstText(result));
		show(membersViewFromSc((result.structuredContent ?? {}) as Record<string, unknown>));
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load members.",
			detail: String(e),
			retry: openMembers
		});
	}
}

// Open the org's usage analytics. Org-scope like Members: the numbers are the same
// from whichever brain you happen to be in, so this deliberately does NOT pass
// brainArgs() and lets the server resolve the org off the active brain.
async function openAnalytics(days?: number) {
	show({ kind: 'loading', label: 'Loading analytics…' });
	try {
		const result = await callTool('analytics', { ...(days ? { days } : {}) });
		if (result.isError) throw new Error(firstText(result));
		show(analyticsViewFromSc((result.structuredContent ?? {}) as Record<string, unknown>));
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load analytics.",
			detail: String(e),
			retry: () => openAnalytics(days)
		});
	}
}

// The analytics payload as a view. `people` arrives empty for non-admins (the server
// withholds it rather than trusting the widget to hide it), and `canSeePeople` is what
// tells the view whether an empty list means "withheld" or "nobody here".
function analyticsViewFromSc(sc: Record<string, unknown>): View {
	return {
		kind: 'analytics',
		orgName: typeof sc.orgName === 'string' ? sc.orgName : 'your organization',
		window: sc.window as UsageWindow,
		totals: sc.totals as UsageTotals,
		series: Array.isArray(sc.series) ? (sc.series as UsagePoint[]) : [],
		people: Array.isArray(sc.people) ? (sc.people as UsagePerson[]) : [],
		brains: Array.isArray(sc.brains) ? (sc.brains as UsageBrain[]) : [],
		canSeePeople: !!sc.canSeePeople,
		truncated: !!sc.truncated,
		footnote: typeof sc.footnote === 'string' ? sc.footnote : ''
	};
}

// Re-render the roster in place from a mutation's returned structuredContent (every
// member mutation returns the fresh roster), without pushing a history entry.
function refreshMembers(sc: Record<string, unknown>) {
	show(membersViewFromSc(sc), { push: false });
}

// Pull the connected-accounts roster out of a tool result (`connected_accounts` /
// unlink_identity both carry the fresh `accounts` array).
function parseAccounts(sc: Record<string, unknown>): ConnectedAccount[] {
	return Array.isArray(sc.accounts) ? (sc.accounts as ConnectedAccount[]) : [];
}

// Read the whoami payload into the app's Identity shape (shared by the live openSettings
// path and the dev harness, which routes a view:'settings' result through onToolResult).
function parseIdentity(sc: Record<string, unknown>): Identity {
	const ab = sc.activeBrain as { label?: string } | undefined;
	return {
		email: typeof sc.email === 'string' ? sc.email : undefined,
		login: typeof sc.login === 'string' ? sc.login : undefined,
		role: typeof sc.role === 'string' ? sc.role : undefined,
		org: typeof sc.org === 'string' ? sc.org : undefined,
		activeBrainLabel: typeof ab?.label === 'string' ? ab.label : undefined
	};
}

// The user's own settings: the signed-in identity card (via whoami) with the person's
// connected accounts (via `connected_accounts`) folded in beneath it, on one page.
// Connected accounts is a per-person concern that may reject on a single-tenant
// connection, so its failure is tolerated (the card still shows).
async function openSettings() {
	show({ kind: 'loading', label: 'Loading…' });
	try {
		const [who, conn] = await Promise.all([
			callTool('whoami', {}),
			callTool('connected_accounts', {}).catch(() => null)
		]);
		if (who.isError) throw new Error(firstText(who));
		const identity = parseIdentity((who.structuredContent ?? {}) as Record<string, unknown>);
		const accounts =
			conn && !conn.isError
				? parseAccounts((conn.structuredContent ?? {}) as Record<string, unknown>)
				: [];
		show({ kind: 'settings', identity, accounts });
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load settings.",
			detail: String(e),
			retry: openSettings
		});
	}
}

// Open the link graph — the whole brain as nodes + edges. `focus` centers and
// highlights one page. Drives the same view the view_graph tool opens.
async function openGraph(focus?: string) {
	show({ kind: 'loading', label: 'Building the graph…' });
	try {
		const result = await callTool('view_graph', {
			...(focus ? { path: focus } : {}),
			...brainArgs()
		});
		if (result.isError) throw new Error(firstText(result));
		const sc = (result.structuredContent ?? {}) as {
			nodes?: GraphNode[];
			edges?: GraphLink[];
			focus?: string;
			truncated?: boolean;
		};
		show({
			kind: 'graph',
			nodes: sc.nodes ?? [],
			links: sc.edges ?? [],
			focus: sc.focus,
			truncated: !!sc.truncated
		});
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't build the graph.",
			detail: String(e),
			retry: () => openGraph(focus)
		});
	}
}

// Refresh the tree in place after a CRUD op — no loading flash. Keeps whatever folder
// the view was revealed at, so a rename/delete doesn't collapse you back to the root.
async function refreshBrowse() {
	const focus = currentView.kind === 'browse' ? currentView.focus : undefined;
	try {
		show({ kind: 'browse', ...(await fetchPaths()), focus }, { push: false });
	} catch (e) {
		toast(`Couldn't refresh: ${e}`, true);
	}
}

async function runSearch(query: string) {
	if (!query.trim()) return;
	show({ kind: 'loading', label: `Searching for “${query}”…` });
	try {
		const result = await callTool('search_pages', { query, ...brainArgs() });
		const sc = (result.structuredContent ?? {}) as { hits?: Hit[] };
		show({ kind: 'search', query, hits: sc.hits ?? [] });
	} catch (e) {
		show({
			kind: 'error',
			headline: 'Search failed.',
			detail: String(e),
			retry: () => runSearch(query)
		});
	}
}

async function openEditor(path: string) {
	// Don't flash a loading state — keep the current view (page/tree) on screen until
	// the editor is ready, then swap straight to it. The loading view has no path, so
	// showing it here made the breadcrumb blink "Files" and the body flash a spinner.
	try {
		const result = await callTool('edit_page', { path, ...brainArgs() });
		if (result.isError) {
			toast(firstText(result), true);
			await navigateTo(path);
			return;
		}
		const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
		show({
			kind: 'edit',
			path: String(sc.path ?? path),
			markdown: String(sc.markdown ?? ''),
			sha: String(sc.sha ?? '')
		});
	} catch (e) {
		toast(`Couldn't open editor: ${e}`, true);
	}
}

async function resolveWikilink(target: string): Promise<string | null> {
	const slug = slugify(target);
	const pages = await fetchPageList();
	return pages.find((p) => p.split('/').pop()!.replace(/\.md$/, '') === slug) ?? null;
}

// ---------- markdown rendering (viewer) ----------

function renderMarkdown(body: string): string {
	const withWikilinks = body.replace(
		/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
		(_m, target: string, label?: string) =>
			`[${(label || target).trim()}](#wikilink=${encodeURIComponent(target.trim())})`
	);
	const html = marked.parse(withWikilinks, { async: false }) as string;
	// marked emits a literal space between a task-list checkbox and its label
	// (`<input type="checkbox"> Text`). Drop it so the gap is governed purely by CSS
	// (`margin-right`), matching the editor's flex `gap` exactly — otherwise the viewer
	// reads 0.4em + a space and the box-to-text spacing visibly shifts between modes.
	return html.replace(/(<input\b[^>]*\btype="checkbox"[^>]*>) /g, '$1');
}

// Delegated link handling for rendered markdown.
function onProseClick(fromPath: string) {
	return async (e: MouseEvent) => {
		const a = (e.target as HTMLElement).closest('a');
		if (!a) return;
		const href = a.getAttribute('href') ?? '';
		if (href.startsWith('#wikilink=')) {
			e.preventDefault();
			const target = decodeURIComponent(href.slice('#wikilink='.length));
			const path = await resolveWikilink(target);
			if (path) navigateTo(path);
			else toast(`No page found for [[${target}]]`, true);
		} else if (/^https?:/i.test(href)) {
			e.preventDefault();
			app.openLink({ url: href });
		} else if (href.endsWith('.md') || href.includes('.md#')) {
			e.preventDefault();
			navigateTo(resolveRelative(fromPath, href));
		}
	};
}

export {
	handleToolResult,
	brainsViewFromSc,
	ensureBrainList,
	switchBrain,
	isNoBrain,
	submitCreateBrain,
	manageableOrgs,
	openAddBrain,
	finishAddBrain,
	openInviteMember,
	finishInvite,
	openConnectAccount,
	openBrains,
	membersViewFromSc,
	brainAccessViewFromSc,
	openBrainAccess,
	refreshBrainAccess,
	openShareBrain,
	finishShareBrain,
	fetchPage,
	fetchPageList,
	navigateTo,
	openAsset,
	pagesToTitleMap,
	fetchPaths,
	openBrowse,
	openFolder,
	openActivity,
	openMembers,
	openAnalytics,
	refreshMembers,
	parseAccounts,
	parseIdentity,
	openSettings,
	openGraph,
	refreshBrowse,
	runSearch,
	openEditor,
	resolveWikilink,
	renderMarkdown,
	onProseClick
};
