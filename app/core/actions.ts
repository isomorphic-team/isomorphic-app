// Async data + navigation actions, the server-context parsers, and the central
// tool-result router (handleToolResult). Everything here builds View *data objects*
// and drives the store; nothing here renders (no components), so the view layer can
// import freely without a cycle.

import type { CallToolResult } from '@modelcontextprotocol/client';
import { renderMarkdown } from '../../src/lib/render.ts';
import {
	resolveRelative,
	buildWikilinkIndex,
	resolveWikilink as resolveWikilinkPath
} from '../../src/lib/wiki.ts';
import { mediaTypeOf } from '../../src/lib/media.ts';
import {
	firstText,
	structuredOf,
	payloadOf,
	isNoBrain,
	parseToolView,
	parseListPages,
	answersFor,
	parseReadPage,
	parseEdit,
	parseAsset,
	parseSearchHits,
	parseActivity,
	parseGraph,
	parseMembers,
	parseBrainAccess,
	parseAnalytics,
	parseAccounts,
	parseIdentity,
	parseBrains,
	derivedOrgTargets,
	type Payload
} from '../../src/lib/tool-payloads.ts';
import type { View, Hit, BrainRow, OrgTarget, BrowseData } from './types.ts';
import { openLink, callTool } from './host.ts';
import { analyticsDays, type WebTarget } from './host-web.ts';
import { isFolderNoteName, refreshOutcome } from './util.ts';
import {
	show,
	history,
	currentView,
	brainArgs,
	browseCache,
	setBrowseCache,
	activeBrain,
	setActiveBrain,
	pickShownBrain,
	brainList,
	setBrainList,
	orgList,
	setOrgList,
	setFeatures,
	applyPolicy,
	applyBrainContext,
	editDirty,
	setEditDirty,
	bump
} from './store.ts';
import { toast, askConfirm } from './toast.tsx';

// LEAVING AN OPEN EDITOR. Every destination in the app abandons an in-progress edit.
// The controls stay live while editing (hiding them protected nothing, since the trail
// beside them still navigated), and this is the guard instead. It is a no-op unless there
// is an editor open that has actually been typed in, which is why the nav surfaces can
// route every click through it without asking anyone a question they do not need.
//
// It clears the flag on a YES: the caller is about to navigate, and the session it was
// protecting is over. A NO leaves the flag set and the caller does nothing.
async function confirmLeaveEdit(): Promise<boolean> {
	if (currentView.kind !== 'edit' || !editDirty) return true;
	const ok = await askConfirm({
		title: 'Discard your changes?',
		body: 'This page has edits that have not been saved.',
		confirmLabel: 'Discard'
	});
	if (ok) setEditDirty(false);
	return ok;
}

/**
 * Wrap a navigation click so it asks before abandoning an unsaved edit. Returns a
 * handler, so a call site reads `onClick={guardNav(() => openBrowse())}` — the guard
 * belongs at the point a PERSON chose to go somewhere, not inside the openers, which
 * are also called by the tool-result router on the model's behalf.
 */
function guardNav(fn: () => void): () => void {
	return () => {
		void confirmLeaveEdit().then((ok) => {
			if (ok) fn();
		});
	};
}

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
	const sc = structuredOf(result);
	// Brain FIRST: adopting a different brain drops what was cached for the old one,
	// including its path policy, so applying this result's policy before that would
	// hand the new brain the wiki/ default (see setActiveBrain in the store).
	applyBrainContext(sc);
	applyPolicy(sc);
	// Learn the brain list, the org list and the server's features once per open.
	void ensureBrainList();
	// Which screen a payload opens is decided in the lib (parseToolView); this is only
	// the wiring from that answer into the store.
	const v = parseToolView(sc);
	switch (v.kind) {
		case 'browse':
			// browse_brain carries the tree while it is small; otherwise the app fetches
			// it with list_pages (openBrowse). Seeding the cache from a delivered tree
			// means later folder lookups and tree opens need no round-trip of their own.
			if (v.tree) {
				setBrowseCache(v.tree);
				browseFetchedAt = Date.now();
				show({ kind: 'browse', ...v.tree }, { push: false });
			} else openBrowse();
			return;
		case 'edit': {
			const { kind, ...edit } = v;
			show({ kind, ...edit, fetchedAt: Date.now() }, { push: false });
			return;
		}
		case 'brains': {
			const bv = brainsViewFromSc(sc);
			// Zero brains (the Manage brains screen on a fresh account) opens the
			// create-your-first-brain state instead of an empty list.
			if (bv.kind === 'brains' && bv.brains.length === 0)
				show({ kind: 'add-brain', orgs: [], first: true }, { push: false });
			else show(bv, { push: false });
			return;
		}
		case 'page': {
			const { kind, ...page } = v;
			show({ kind, ...page, fetchedAt: Date.now() }, { push: false });
			return;
		}
		default:
			show(v, { push: false });
	}
}

// Build a brains View from a tool result (brains / switch_brain / create_brain /
// connect_brain). Also refreshes the cached brain list and the shown brain, so the
// trail stays in sync.
//
// Only a result that CHANGED the brain overrides the brain the widget is showing. A
// plain list does not, and neither does connect_brain, which adopts a repo without
// moving anyone into it (the app switches afterwards, through switch_brain). See
// pickShownBrain. Two ways to know: the caller asked for the switch itself, or the
// result says `switched` (switch_brain / create_brain), which is the only signal
// available when the MODEL made the call and the widget is just rendering it.
function brainsViewFromSc(sc: Payload, switched = false): View {
	const p = parseBrains(sc);
	const deliberate = switched || p.switched;
	if (p.orgs) setOrgList(p.orgs);
	if (p.brains.length) {
		setBrainList(p.brains);
		const picked = pickShownBrain(p.brains, p.active, deliberate);
		if (picked) setActiveBrain(picked);
	}
	// The list highlights the brain the widget is IN, so the checkmark and the crumb
	// above it can never name two different brains.
	return { kind: 'brains', brains: p.brains, active: activeBrain?.id ?? p.active ?? '' };
}

// Fetch the caller's brain list once (idempotent), with the org list and the server's
// features riding the same call.
//
// UNKNOWN IS NOT ZERO. `null` means "we haven't found out yet"; `[]` means "we asked
// and there are none", and `[]` is what labels the trail "No brain" and opens Add a
// brain in its first-brain form. Anything that can't answer the question must leave the list null, or someone
// sitting inside a brain gets told they have none.
let brainListPromise: Promise<void> | null = null;
function ensureBrainList(): Promise<void> {
	if (brainList !== null) return Promise.resolve();
	if (brainListPromise) return brainListPromise;
	brainListPromise = (async () => {
		try {
			const res = await callTool('brains', {});
			// A failed call is a RESULT carrying isError; payloadOf refuses it. Without
			// that the empty payload read as a successful "zero brains".
			const sc = payloadOf(res);
			if (!Array.isArray(sc.brains)) throw new Error('brains: no list in the result');
			const p = parseBrains(sc);
			setBrainList(p.brains);
			// Which orgs a brain can be added to, and which optional server surfaces
			// exist (the org Analytics tab, and `webBase` for "Open in browser"). Both
			// ride this call because it is the one the app always makes on open.
			if (p.orgs) setOrgList(p.orgs);
			setFeatures(p.features);
			// NOT a brain change: this call asks what brains exist, and it runs on every
			// open, including the open that a `brain:`-targeted view_page or
			// browse_brain just aimed at a specific brain. Adopting its `active` here
			// would point the whole widget back at the pointer's brain.
			const picked = pickShownBrain(p.brains, p.active, false);
			if (picked) setActiveBrain(picked);
			bump();
		} catch {
			// Stay unknown: the trail keeps its neutral label rather than claiming you
			// have no brains. Drop the memo so the next view retries instead of the
			// whole session being stuck on one unlucky call.
			brainListPromise = null;
		}
	})();
	return brainListPromise;
}

// Move the active brain WITHOUT deciding where to land. switchBrain lands on the file
// tree; a search hit lands on the page it named. Both go through brainsViewFromSc,
// because adopting a brain is what drops the previous one's file tree and path policy
// (setActiveBrain in the store) and no path into a brain may skip that seam.
async function adoptBrain(id: string): Promise<void> {
	const res = await callTool('switch_brain', { brain: id });
	brainsViewFromSc(payloadOf(res), true);
}

// Switch the active brain, then land on its file tree. Selecting the already-active
// brain just (re)opens its files.
async function switchBrain(id: string) {
	if (activeBrain?.id === id) {
		openBrowse();
		return;
	}
	show({
		kind: 'loading',
		label: 'Switching brain…',
		task: 'switch',
		subject: brainList?.find((b) => b.id === id)?.label
	});
	try {
		await adoptBrain(id);
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

// The orgs a caller can add a brain to: the list the `brains` payload carried, else
// the derivation from the brains they can manage, which is the fallback for a server
// that predates the `orgs` field (an older Worker against a newer bundle).
function manageableOrgs(brains: BrainRow[]): OrgTarget[] {
	return orgList ?? derivedOrgTargets(brains);
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
// comes from: creating and connecting are one intent, so there is one opener.
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
function finishAddBrain(sc: Payload, connectedId: string) {
	const fresh = brainsViewFromSc(sc);
	dropStale('brains');
	show(fresh, { push: false });
	switchBrain(connectedId);
}

// Leave the invite flow for the roster, with the new invite already on it (the
// mutation returns the fresh roster). Same stack discipline as finishAddBrain: a
// completed flow must not sit in history, or Back re-opens a form for something the
// user has already done.
function finishInvite(sc: Payload) {
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
	show(
		{ kind: 'loading', label: 'Creating brain…', task: 'create', subject: trimmed },
		{ push: false }
	);
	try {
		const res = await callTool('create_brain', { name: trimmed });
		const fresh = brainsViewFromSc(payloadOf(res), true);
		refreshStale('brains', fresh); // ...and if that screen was the brains list, it is now stale
		openBrowse(); // the new brain's (empty) tree — the switch already dropped the old one's
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't create the brain.",
			detail: String(e),
			retry: () => openAddBrain()
		});
	}
}

// Open the brains view (the trail's brain glyph lands here).
async function openBrains() {
	show({ kind: 'loading', label: 'Loading brains…', task: 'brains' });
	try {
		const res = await callTool('brains', {});
		show(brainsViewFromSc(payloadOf(res)));
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load brains.",
			detail: String(e),
			retry: openBrains
		});
	}
}

// The roster as a View (members, and every mutation, which all return the fresh roster).
function membersViewFromSc(sc: Payload): View {
	return { kind: 'members', ...parseMembers(sc) };
}

// The sharing panel as a View (brain_access, and every share_brain mutation).
function brainAccessViewFromSc(sc: Payload): View {
	return { kind: 'brain-access', ...parseBrainAccess(sc) };
}

// Open the sharing panel for a brain: who can reach it, and at what level.
// `brain` targets a specific one (the Share control in the brains list); omitted,
// it acts on the active brain.
async function openBrainAccess(brain?: string) {
	show({ kind: 'loading', label: 'Loading sharing…', task: 'sharing' });
	try {
		const result = await callTool('brain_access', brain ? { brain } : {});
		show(brainAccessViewFromSc(payloadOf(result)));
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
function refreshBrainAccess(sc: Payload) {
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
function finishShareBrain(sc: Payload) {
	const fresh = brainAccessViewFromSc(sc);
	dropStale('brain-access');
	show(fresh, { push: false });
}

// One page's current content, plus the blob sha it is a render OF. The sha is what
// lets a later fetch answer "is this still what the branch holds", which nothing in
// the app could ask before: a render carried its text and no notion of which version
// the text was.
async function fetchPage(path: string): Promise<{ markdown: string; sha: string }> {
	return parseReadPage(await callTool('read_page', { path, ...brainArgs() }));
}

// Build a page view from freshly fetched content. Every page render is stamped with
// the moment it was fetched, so the viewer can say how old it is rather than
// presenting a snapshot as though it were live.
function pageView(path: string, page: { markdown: string; sha: string }): View {
	return { kind: 'page', path, markdown: page.markdown, sha: page.sha, fetchedAt: Date.now() };
}

async function fetchPageIndex(): Promise<{ path: string; title: string }[]> {
	const data = browseCache ?? (await fetchPaths());
	return data.paths.map((path) => ({ path, title: data.titleByPath[path] ?? '' }));
}

// What to CALL a path when a human is reading it: the cached tree's title if the tree
// is warm, else the filename. Only used to name the thing in a loading line, so a cold
// cache degrades to the filename rather than costing a fetch. The point of the line is
// that it is free.
function baseName(path: string): string {
	return path.split('/').pop()?.replace(/\.md$/i, '') ?? path;
}
function pageLabel(path: string): string {
	const name = baseName(path);
	// A FOLDER NOTE is its folder (FOLDER_NOTE_NAMES), so it is called by the folder's
	// name. `pageTitle` on the server already resolves it that way, but a title reaching
	// us as the literal "index" is exactly what that rule exists to prevent, and it is
	// the most-clicked path in the tree: "Turning to index…" is worse than saying nothing.
	if (isFolderNoteName(`${name}.md`)) return path.split('/').slice(-2, -1)[0] || name;
	return browseCache?.titleByPath[path]?.trim() || name;
}

// ---------- navigation ----------

// Open whatever a `/b/...` URL names. ONE dispatcher, used by both the cold boot
// and the Back/Forward handler, because those two answering the same URL
// differently is the bug the single-parser rule exists to prevent — and it would
// show up only as "Back goes somewhere odd", which nobody reports precisely.
//
// None of these needs a `push: false`. The browser has already moved to this URL,
// so the view they produce serializes back to the URL that is already in the bar,
// and `syncAddressBar` writes nothing when those are equal. The intermediate
// loading views are skipped there too, so nothing lands in the history stack.
function openWebTarget(t: WebTarget): void {
	if (t.path) return void navigateTo(t.path);
	// Tokens come from WEB_TOOL_ROUTING, so this switch and the URL builder cannot
	// name a destination differently.
	switch (t.view) {
		case 'search':
			return void (t.arg ? runSearch(t.arg) : openSearch());
		case 'graph':
			return void openGraph(t.arg);
		case 'activity':
			return void openActivity(t.arg);
		case 'access':
			return void openBrainAccess();
		case 'members':
			return void openMembers();
		case 'analytics':
			return void openAnalytics(analyticsDays(t.arg));
		// No view, so the tree, whose argument is the folder to reveal.
		default:
			return void openBrowse(t.arg);
	}
}

// `push` is forwarded to the final `show`, which is what decides whether the web
// host adds a browser history entry. It is false when the browser has already
// moved and we are catching up to it (the popstate handler), where pushing would
// re-add the entry the user just left.
async function navigateTo(path: string, { push = true } = {}) {
	show({ kind: 'loading', label: `Loading ${path}…`, task: 'page', subject: pageLabel(path) });
	try {
		show(pageView(path, await fetchPage(path)), { push });
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

// Re-fetch the page on screen and swap it in place.
//
// The viewer had no way to do this at all: a render was a snapshot of a page that
// keeps moving, with no control to reload it and nothing recording how old it was
// (issue #29). The reader could only reopen the page from the conversation, which
// costs a round trip and still gives no way to tell current from stale.
//
// Deliberately quiet. No loading state, because the content already on screen is a
// better thing to look at during the fetch than a spinner, and a failure leaves the
// stale render up rather than blanking a page over a refresh blip. The toast is
// where the answer goes, including when the answer is "nothing moved" — a refresh
// that repaints identical bytes and says nothing is indistinguishable from one that
// silently failed, which is the confusion this control exists to end.
async function refreshPage() {
	const before = currentView;
	if (before.kind !== 'page') return;
	try {
		const fresh = await fetchPage(before.path);
		// An await is long enough for the reader to navigate away; repainting the page
		// they left would be worse than not refreshing at all.
		if (currentView.kind !== 'page' || currentView.path !== before.path) return;
		show(pageView(before.path, fresh), { push: false });
		const outcome = refreshOutcome(before.sha, fresh.sha);
		toast(
			outcome === 'updated'
				? 'Updated to the latest version'
				: outcome === 'current'
					? 'Already up to date'
					: 'Refreshed'
		);
	} catch (e) {
		toast(`Couldn't refresh: ${e}`, true);
	}
}

// Open one attachment on its own. The counterpart to navigateTo for files that are
// not pages: same shape (loading -> view -> error with retry), different tool.
//
// It exists because assets became browsable. A tree row you can see but not open is
// worse than one that was never listed, so making them visible obliged us to give
// them somewhere to go.
async function openAsset(path: string) {
	show({ kind: 'loading', label: `Loading ${path}…`, task: 'asset', subject: baseName(path) });
	try {
		// include_data: the asset view IS the bytes. See app/core/media.ts on why the
		// default is off.
		const res = await callTool('read_media', { path, include_data: true, ...brainArgs() });
		show({ kind: 'asset', path, ...parseAsset(payloadOf(res)) });
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

// How long a cached tree is trusted without a background re-check. Only external
// writes (an agent editing the brain while the widget is open) can age it — our own
// CRUD refreshes it directly — so this is about freshness, not correctness.
const BROWSE_STALE_MS = 15_000;
let browseFetchedAt = 0;

// One list_pages call → the whole tree payload, memoized in the store. Every tree
// open after the first is instant; the caller decides whether to revalidate.
async function fetchPaths(): Promise<BrowseData> {
	// No prefix: the whole brain, index-backed, carrying titles. parseListPages refuses
	// an error result; before it did, a failed call was cached as an empty tree.
	const result = await callTool('list_pages', { ...brainArgs() });
	const data = parseListPages(result);
	const sc = structuredOf(result);
	// This is a WIDGET-initiated call, so it never passes through handleToolResult:
	// name the brain and apply the path policy here or the tree keeps whatever the last
	// host-initiated result left behind (a different brain's, or the wiki/ default).
	// Naming the brain also keeps the trail's root crumb honest: this call can be the
	// FIRST thing the app does (the self-boot in connectToHost, when no tool result
	// opened the widget), in which case nothing else has said which brain the tree
	// belongs to and the crumb would name a view instead of a brain. Brain before
	// policy, for the reason in handleToolResult.
	//
	// Only if it is still an answer to the question we asked (answersFor): a stale
	// self-boot answer adopted here is issue #26's shape reached through the back door.
	if (answersFor(sc, activeBrain?.id)) {
		applyBrainContext(sc);
		applyPolicy(sc);
		setBrowseCache(data);
		browseFetchedAt = Date.now();
	}
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
	show({ kind: 'loading', label: 'Loading files…', task: 'files' });
	// The view this call is standing on. A cold tree fetch is the app's slowest open,
	// and the one it makes UNATTENDED (the self-boot in connectToHost), so it is the one
	// most likely to be overtaken: the host can deliver the opening tool result at any
	// point while list_pages is in flight. Whatever landed meanwhile is a real answer to
	// a real request — showing the tree on top of it is what made a slow view_page flash
	// its page and then fall back to the file tree. Same guard revalidateBrowse uses.
	const opened = currentView;
	try {
		const data = await fetchPaths();
		if (currentView !== opened) return;
		show({ kind: 'browse', ...data, focus });
	} catch (e) {
		if (currentView !== opened) return;
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

// A breadcrumb click on a folder: ALWAYS the tree, revealed at that folder.
//
// Not the folder's note when it has one: a crumb that opens a page for one folder and
// the tree for its neighbour, decided by a fact the trail never shows, cannot be aimed.
// The tree is the answer that is always available and always the same, and it does not
// hide the note: a folder with one shows it as that folder's own row, one press away.
// The file TREE keeps opening folder notes on a folder click (views/Browse.tsx), which
// is a different question — there you are already looking at the structure, so the note
// is the thing you cannot see yet.
function openFolder(prefix: string) {
	return openBrowse(prefix.replace(/\/+$/, ''));
}

// Open the activity/audit feed — whole brain, or one page's history when `path`
// is given. Drives the same view the view_activity tool opens.
async function openActivity(path?: string) {
	show({
		kind: 'loading',
		label: 'Loading recent changes…',
		task: 'activity',
		subject: path ? pageLabel(path) : undefined
	});
	try {
		const result = await callTool('view_activity', { ...(path ? { path } : {}), ...brainArgs() });
		show({ kind: 'activity', ...parseActivity(payloadOf(result)) });
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
	show({ kind: 'loading', label: 'Loading members…', task: 'members' });
	try {
		const result = await callTool('members', {});
		show(membersViewFromSc(payloadOf(result)));
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
	show({ kind: 'loading', label: 'Loading analytics…', task: 'analytics' });
	try {
		const result = await callTool('analytics', { ...(days ? { days } : {}) });
		show({ kind: 'analytics', ...parseAnalytics(payloadOf(result)) });
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't load analytics.",
			detail: String(e),
			retry: () => openAnalytics(days)
		});
	}
}

// Re-render the roster in place from a mutation's returned structuredContent (every
// member mutation returns the fresh roster), without pushing a history entry.
function refreshMembers(sc: Payload) {
	show(membersViewFromSc(sc), { push: false });
}

// The user's own settings: the signed-in identity card (via whoami) with the person's
// connected accounts (via `connected_accounts`) folded in beneath it, on one page.
// Connected accounts is a per-person concern that may reject on a single-tenant
// connection, so its failure is tolerated (the card still shows).
async function openSettings() {
	show({ kind: 'loading', label: 'Loading…', task: 'settings' });
	try {
		const [who, conn] = await Promise.all([
			callTool('whoami', {}),
			callTool('connected_accounts', {}).catch(() => null)
		]);
		const identity = parseIdentity(payloadOf(who));
		const accounts = conn && !conn.isError ? parseAccounts(structuredOf(conn)) : [];
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
	show({
		kind: 'loading',
		label: 'Building the graph…',
		task: 'graph',
		subject: focus ? pageLabel(focus) : undefined
	});
	try {
		const result = await callTool('view_graph', {
			...(focus ? { path: focus } : {}),
			...brainArgs()
		});
		show({ kind: 'graph', ...parseGraph(payloadOf(result)) });
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

// Arrive at the search PAGE, empty. The field lives on the view (SearchView), so this
// is an ordinary destination like Files or Graph rather than a control that opens a
// widget: press it, you are somewhere, and the rail lights.
function openSearch() {
	show({ kind: 'search', query: '', hits: [] });
}

// The rail's ⋯, which is a PLACE rather than a popover. It holds the destinations that
// are not this brain (your organization, your account), and it is a page for the reason
// every other treatment failed: the rail is top-anchored, so ⋯ sits ~145px down however
// tall the card is, and anything hanging off it is bounded by the room left underneath.
// A popover, a flyout rail and a labelled expanding rail all hit that wall on a 170px
// inline card. A page owns the content area and scrolls, at every card size, forever.
//
// Display mode is deliberately NOT here. It is a window control, not a place, and
// putting it on a page would mean navigating away from what you are reading in order to
// go fullscreen, then landing on this screen instead of your content. It lives at the
// right end of the top bar (main.tsx).
function openMore() {
	show({ kind: 'more' });
}

// `scope` is opt-in and never ambient: the box searches the brain you are in, and
// widening is a second, deliberate click (SearchView's footer). An ordinary search
// keeps an ordinary blast radius, which matters because the leak here is
// conversational — one client's material surfacing in another client's window.
async function runSearch(query: string, scope?: 'all') {
	if (!query.trim()) return;
	show({ kind: 'loading', label: `Searching for “${query}”…`, task: 'search', subject: query });
	try {
		const result = await callTool('search_pages', {
			query,
			...(scope ? { scope } : {}),
			...brainArgs()
		});
		// payloadOf refuses an error result. Before it did, an error rendered as "No
		// matches", a different and more misleading answer than "search failed".
		show({ kind: 'search', query, scope, hits: parseSearchHits(payloadOf(result)) });
	} catch (e) {
		show({
			kind: 'error',
			headline: 'Search failed.',
			detail: String(e),
			retry: () => runSearch(query, scope)
		});
	}
}

// Open a search hit. A fan-out result can name a brain other than the one you are in,
// so the switch has to land BEFORE the fetch.
async function openHit(hit: Hit) {
	if (!hit.brain || hit.brain === activeBrain?.id) return navigateTo(hit.path);
	show({
		kind: 'loading',
		label: `Loading ${hit.path}…`,
		task: 'page',
		subject: pageLabel(hit.path)
	});
	try {
		await adoptBrain(hit.brain);
	} catch (e) {
		show({
			kind: 'error',
			headline: "Couldn't open that brain.",
			detail: String(e),
			retry: () => openHit(hit)
		});
		return;
	}
	await navigateTo(hit.path);
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
		show({ kind: 'edit', ...parseEdit(structuredOf(result), path), fetchedAt: Date.now() });
	} catch (e) {
		toast(`Couldn't open editor: ${e}`, true);
	}
}

// Same resolver the server uses (src/lib/wiki.ts), over the page list the tree
// already holds — so a link the viewer refuses to open is one validate reports too,
// rather than the two disagreeing about what [[Weekly Sync]] means.
async function resolveWikilink(target: string): Promise<string | null> {
	const pages = await fetchPageIndex();
	return resolveWikilinkPath(buildWikilinkIndex(pages), target) ?? null;
}

// ---------- markdown rendering (viewer) ----------

// Rendering lives in `src/lib/render.ts` so the Worker produces the same HTML.
// The app's defaults are the ones baked in there: a `[[wikilink]]` becomes the
// `#wikilink=` sentinel `onProseClick` resolves below, and an image keeps its
// repo-relative `src` for `media.ts` to swap for a data URI after render.

// Delegated link handling for rendered markdown.
function onProseClick(fromPath: string) {
	return async (e: MouseEvent) => {
		// An attachment shown on the page opens on its own. Two ways to arrive here and
		// both were dead ends before: an embedded image is a bare <img> with no anchor
		// at all (`![](…)` produces no link), and a markdown link to a non-page file
		// fell through the `.md` branch below. So a picture was reachable from the file
		// tree but not from the page displaying it, which is the opposite of how anyone
		// navigates.
		const img = (e.target as HTMLElement).closest('img[data-asset-path]');
		// Unless the author wrapped it in a link themselves (`[![alt](img.png)](page.md)`),
		// in which case their link wins and the anchor branches below handle it.
		if (img && !img.closest('a')) {
			e.preventDefault();
			return openAsset(img.getAttribute('data-asset-path')!);
		}
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
			openLink(href);
		} else if (href.endsWith('.md') || href.includes('.md#')) {
			e.preventDefault();
			navigateTo(resolveRelative(fromPath, href));
		} else if (mediaTypeOf(resolveRelative(fromPath, href))) {
			// A link to an attachment — a PDF, or an image linked rather than embedded.
			e.preventDefault();
			openAsset(resolveRelative(fromPath, href));
		}
	};
}

export {
	handleToolResult,
	openWebTarget,
	confirmLeaveEdit,
	guardNav,
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
	pageView,
	refreshPage,
	navigateTo,
	openAsset,
	fetchPaths,
	openBrowse,
	openFolder,
	openActivity,
	openMembers,
	openAnalytics,
	refreshMembers,
	openSettings,
	openGraph,
	refreshBrowse,
	openSearch,
	openMore,
	runSearch,
	openHit,
	openEditor,
	resolveWikilink,
	renderMarkdown,
	onProseClick
};
