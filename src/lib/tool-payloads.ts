// The wire contract between the Worker's tools and the widget, read from the widget's
// side. Every tool result the app renders passes through one of these parsers, so the
// answer to "what does the app do with a field the server did not send" is in one
// place and pinned by `pnpm test:payloads`.
//
// Pure and SDK-free. The result type is structural (`ToolResultLike`) rather than the
// SDK's `CallToolResult`, so the parsers can be tested without a client and the app
// bundle does not pull the SDK's types into `src/lib/`.
//
// Two rules every parser follows:
//   - A missing or malformed field degrades to an empty value (an empty list, an empty
//     string, `undefined`), never to a throw: a payload that is mostly right still
//     renders. The element types are trusted as sent; only the envelope is checked.
//   - An `isError` result is refused before any field is read (`payloadOf`). A failed
//     call comes back as a RESULT carrying `isError`, not as a rejection, and parsing
//     its empty payload reads as a successful empty answer: "zero brains", "no pages",
//     "no matches". `fetchPaths` did exactly that and cached an empty tree for a failed
//     list_pages.

// ---------- payload element types ----------
// Mirrors of what the tools put in structuredContent. `app/core/types.ts` re-exports
// them, so the app imports one vocabulary.

/** The signed-in user, as reported by the whoami tool. All optional: static-bearer mode has no identity. */
export interface Identity {
	email?: string;
	login?: string;
	role?: string;
	org?: string;
	activeBrainLabel?: string;
}

export interface Hit {
	path: string;
	line: number;
	text: string;
	// Set when the search spanned brains (scope: 'all'). Opening a hit from another brain
	// has to switch first, because navigateTo resolves its path against the ACTIVE brain.
	brain?: string;
	brainLabel?: string;
}

/** The file-tree payload (one list_pages call, or an inline browse_brain result). */
export interface BrowseData {
	paths: string[];
	titleByPath: Record<string, string>;
	// Attachments (images, PDFs). Listed apart from `hidden` because they are content
	// someone deliberately added, not repo plumbing.
	assets: string[];
	hidden: string[];
	needsConfig: boolean;
}

/** One change in the activity feed (view_activity in src/tools/apps.ts). */
export interface ActivityEntry {
	sha: string;
	shortSha: string;
	message: string;
	path?: string;
	authorName: string;
	authorLogin?: string;
	date: string;
	url: string;
}

/** Graph view payload (view_graph in src/tools/apps.ts). Nodes are pages; links are deduped undirected references. */
export interface GraphNode {
	id: string;
	title: string;
	group: string;
	degree: number;
}
export interface GraphLink {
	source: string;
	target: string;
}

/** Org roster payload (src/tools/members.ts). Roles are the DB tokens. */
export type MemberRole = 'viewer' | 'editor' | 'admin' | 'owner';
export interface Member {
	user_id: string;
	email: string;
	name: string | null;
	github_login: string | null;
	role: MemberRole;
	added_at: string;
}
export interface Invite {
	invite_id: string;
	email: string;
	role: MemberRole;
	invited_at: string;
	expires_at: string;
}
export interface MemberSelf {
	user_id: string;
	role: MemberRole;
}

// Usage analytics (the `analytics` tool). Produced by summarize() in src/lib/usage.ts.
export interface UsageWindow {
	from: string;
	to: string;
	days: number;
}
export interface UsageTotals {
	activeUsers: number;
	members: number;
	reads: number;
	writes: number;
	admin: number;
	calls: number;
	errors: number;
}
export interface UsagePoint {
	day: string;
	reads: number;
	writes: number;
}
export interface UsagePerson {
	user_id: string;
	name: string | null;
	email: string | null;
	role: string | null;
	reads: number;
	writes: number;
	admin: number;
	lastActive: string | null;
	/** Activity from someone no longer on the roster. */
	former: boolean;
}
export interface UsageBrain {
	brain_id: string;
	label: string;
	reads: number;
	writes: number;
	people: number;
	lastActive: string | null;
}

/** A brain the user can reach (src/tools/brains.ts). Drives the nav switcher. */
export interface BrainRow {
	id: string;
	label: string;
	role: string;
	active: boolean;
	canManage?: boolean; // caller is admin+ in this brain's ORG (can disconnect it)
	canShare?: boolean; // caller is admin+ ON THIS BRAIN (can change who reaches it)
	visibility?: string; // 'org' | 'private': drives the Private badge
	orgId?: string; // so the UI can target adds per-org, independent of the active brain
	orgLabel?: string;
	needsConfig?: boolean; // adopted repo with no content under its roots: offer "Set up"
	configPrUrl?: string; // a configure PR is pending (protected repo): show "Review PR"
	// Readable, never writable, by anyone including the org's admins. The role the row
	// carries is already capped to viewer; this is the flag the cap came from.
	readOnly?: boolean;
}

/** An org the caller can add a brain to, identified by its own id: the org waiting for its FIRST repo holds no brain to name it with. */
export interface OrgTarget {
	orgId: string;
	orgLabel: string;
}

/** Per-brain access payload (src/tools/brain-access.ts). `role` is the caller's role ON THIS BRAIN; `via` says how they got it. */
export interface BrainAccessEntry {
	user_id: string;
	email: string;
	name: string | null;
	role: MemberRole;
	// 'guest' is a grant held by someone outside the organization.
	via: 'grant' | 'org' | 'org-admin' | 'guest';
	granted_at?: string;
}
/** The caller in both scopes at once. `orgRole` is null for a guest. */
export interface BrainAccessSelf {
	user_id: string;
	role: MemberRole;
	orgRole: MemberRole | null;
}

/** One entry in the "Connected accounts" roster (src/tools/connected-accounts.ts). */
export interface ConnectedAccount {
	kind: 'email' | 'github';
	is_self: boolean;
	user_id?: string;
	email?: string;
	name?: string | null;
	github_user_id?: number;
	github_login?: string | null;
}

/** Which optional server surfaces exist. Rides the `brains` payload because that is the call the app always makes on open. */
export interface ServerFeatures {
	analytics?: boolean;
	/** Anyone besides the operator can sign in, so the people and sharing tools exist. */
	people?: boolean;
	webBase?: string;
}

// ---------- the result envelope ----------

/** The part of an MCP tool result the app reads. Structurally compatible with the SDK's CallToolResult. */
export interface ToolResultLike {
	isError?: boolean;
	content?: ReadonlyArray<{ type: string; text?: unknown }>;
	structuredContent?: unknown;
}

export type Payload = Record<string, unknown>;

export function firstText(result: ToolResultLike): string {
	const block = (result.content ?? []).find((b) => b.type === 'text');
	return block && 'text' in block ? String(block.text) : '';
}

/** The structured payload, or an empty one. Never throws: the caller has already decided what an error means. */
export function structuredOf(result: ToolResultLike): Payload {
	const sc = result.structuredContent;
	return sc && typeof sc === 'object' && !Array.isArray(sc) ? (sc as Payload) : {};
}

/** The structured payload of a SUCCESSFUL result. An `isError` result throws its text. */
export function payloadOf(result: ToolResultLike): Payload {
	if (result.isError) throw new Error(firstText(result));
	return structuredOf(result);
}

/** Does an error message signal the "no brain yet" state? Brain-scope tools throw NoBrainError server-side for a caller with an org but no brain. */
export function isNoBrain(s: string): boolean {
	return /don.?t have a brain yet/i.test(s);
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}
function list<T>(v: unknown): T[] {
	return Array.isArray(v) ? (v as T[]) : [];
}
function obj(v: unknown): Payload {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {};
}

// ---------- the tree ----------

/** path -> title from a `pages` field. Tolerant of a missing or malformed field so the tree still renders under filenames. */
export function pagesToTitleMap(pages: unknown): Record<string, string> {
	const map: Record<string, string> = {};
	for (const p of list<Payload>(pages)) {
		if (p && typeof p.path === 'string' && typeof p.title === 'string') map[p.path] = p.title;
	}
	return map;
}

/**
 * The tree carried by a payload, or null when it carries none.
 *
 * list_pages sends `pages` (path + title per page) and no `paths`; browse_brain sends
 * `paths` and `pages` while the tree fits in the result, and neither when it does
 * not, which is when the app fetches the tree itself. `paths` wins where both exist,
 * else it is derived from `pages` in order.
 */
export function parseTree(sc: Payload): BrowseData | null {
	const pages = list<Payload>(sc.pages);
	const paths = Array.isArray(sc.paths)
		? list<string>(sc.paths)
		: Array.isArray(sc.pages)
			? pages.map((p) => str(p?.path)).filter((p): p is string => p !== undefined)
			: null;
	if (paths === null) return null;
	return {
		paths,
		titleByPath: pagesToTitleMap(sc.pages),
		assets: list<string>(sc.assets),
		hidden: list<string>(sc.hidden),
		needsConfig: !!sc.needsConfig
	};
}

/** A list_pages result as the tree. Throws on an error result, and on a result with no page list, rather than answering "empty brain". */
export function parseListPages(result: ToolResultLike): BrowseData {
	const tree = parseTree(payloadOf(result));
	if (!tree) throw new Error('list_pages: no page list in the result');
	return tree;
}

/**
 * Is this payload still an answer to the question the widget asked?
 *
 * A self-boot fetch goes out with no brain named, so it answers about the
 * connection's brain, and an opening result can land while it is in flight and name
 * a different one. Adopting the stale answer would rename the crumb, reset the path
 * policy, and cache another brain's page list behind the page on screen. A payload
 * that names no brain, or a widget that has none yet, is always accepted.
 */
export function answersFor(sc: Payload, activeBrainId: string | undefined): boolean {
	const answered = str(obj(sc.activeBrain).id);
	return !activeBrainId || !answered || answered === activeBrainId;
}

// ---------- pages ----------

export interface PageContent {
	path: string;
	markdown: string;
	/** The blob sha the markdown is a render of. Absent when the server sent none. */
	sha?: string;
}

export function parsePage(sc: Payload): PageContent {
	return { path: str(sc.path) ?? '', markdown: str(sc.markdown) ?? '', sha: str(sc.sha) };
}

/** The editor's payload. The editor needs a sha to save against, so a missing one is '' rather than absent, and the path the caller asked for stands in when the server names none. */
export function parseEdit(sc: Payload, fallbackPath = ''): Required<PageContent> {
	const page = parsePage(sc);
	return { path: page.path || fallbackPath, markdown: page.markdown, sha: page.sha ?? '' };
}

/** read_page: the page is the text block; the sha rides in structuredContent. */
export function parseReadPage(result: ToolResultLike): { markdown: string; sha: string } {
	const sc = payloadOf(result);
	return { markdown: firstText(result), sha: str(sc.sha) ?? '' };
}

export function parseAsset(sc: Payload): { mimeType: string; size: number; dataUri: string } {
	return {
		mimeType: str(sc.mimeType) ?? '',
		size: typeof sc.size === 'number' ? sc.size : 0,
		dataUri: str(sc.dataUri) ?? ''
	};
}

export function parseSearchHits(sc: Payload): Hit[] {
	return list<Hit>(sc.hits);
}

// ---------- views ----------

export function parseActivity(sc: Payload): { entries: ActivityEntry[]; scopePath?: string } {
	return { entries: list<ActivityEntry>(sc.entries), scopePath: str(obj(sc.scope).path) };
}

export function parseGraph(sc: Payload): {
	nodes: GraphNode[];
	links: GraphLink[];
	focus?: string;
	truncated: boolean;
} {
	return {
		nodes: list<GraphNode>(sc.nodes),
		links: list<GraphLink>(sc.edges),
		focus: str(sc.focus),
		truncated: !!sc.truncated
	};
}

export function parseMembers(sc: Payload): {
	members: Member[];
	invites: Invite[];
	me: MemberSelf;
} {
	const me = obj(sc.me);
	return {
		members: list<Member>(sc.members),
		invites: list<Invite>(sc.invites),
		me: { user_id: str(me.user_id) ?? '', role: (str(me.role) as MemberRole) ?? 'viewer' }
	};
}

export function parseBrainAccess(sc: Payload): {
	access: BrainAccessEntry[];
	invites: Invite[];
	visibility: string;
	brainId: string;
	brainLabel: string;
	me: BrainAccessSelf;
} {
	const me = obj(sc.me);
	const active = obj(sc.activeBrain);
	return {
		access: list<BrainAccessEntry>(sc.access),
		invites: list<Invite>(sc.invites),
		visibility: str(sc.visibility) ?? 'org',
		// Carried so the panel and its share flow keep acting on the brain the user
		// opened, not on whatever happens to be active: the Share control in the brains
		// list can target a brain that is not the current one.
		brainId: str(active.id) ?? '',
		brainLabel: str(active.label) ?? 'this brain',
		me: {
			user_id: str(me.user_id) ?? '',
			role: (str(me.role) as MemberRole) ?? 'viewer',
			// Null for a guest: the server sends it as null, and 'viewer' would be a lie.
			orgRole: me.orgRole ? (str(me.orgRole) as MemberRole) : null
		}
	};
}

const EMPTY_WINDOW: UsageWindow = { from: '', to: '', days: 0 };
const EMPTY_TOTALS: UsageTotals = {
	activeUsers: 0,
	members: 0,
	reads: 0,
	writes: 0,
	admin: 0,
	calls: 0,
	errors: 0
};

/** The analytics payload. `people` arrives empty for non-admins (the server withholds it), and `canSeePeople` says whether that means "withheld" or "nobody here". */
export function parseAnalytics(sc: Payload): {
	orgName: string;
	window: UsageWindow;
	totals: UsageTotals;
	series: UsagePoint[];
	people: UsagePerson[];
	brains: UsageBrain[];
	canSeePeople: boolean;
	truncated: boolean;
	footnote: string;
} {
	return {
		orgName: str(sc.orgName) ?? 'your organization',
		window: sc.window && typeof sc.window === 'object' ? (sc.window as UsageWindow) : EMPTY_WINDOW,
		totals: sc.totals && typeof sc.totals === 'object' ? (sc.totals as UsageTotals) : EMPTY_TOTALS,
		series: list<UsagePoint>(sc.series),
		people: list<UsagePerson>(sc.people),
		brains: list<UsageBrain>(sc.brains),
		canSeePeople: !!sc.canSeePeople,
		truncated: !!sc.truncated,
		footnote: str(sc.footnote) ?? ''
	};
}

export function parseAccounts(sc: Payload): ConnectedAccount[] {
	return list<ConnectedAccount>(sc.accounts);
}

export function parseIdentity(sc: Payload): Identity {
	return {
		email: str(sc.email),
		login: str(sc.login),
		role: str(sc.role),
		org: str(sc.org),
		activeBrainLabel: str(obj(sc.activeBrain).label)
	};
}

// ---------- brains ----------

export interface BrainsPayload {
	brains: BrainRow[];
	active?: string;
	/** The result moved the caller into a brain (switch_brain, create_brain). A plain list and connect_brain do not. */
	switched: boolean;
	/** The orgs a brain can be added to. `undefined` when the server sent none (an older Worker), `[]` when it answered "none". */
	orgs?: OrgTarget[];
	features?: ServerFeatures;
}

/** The `orgs` field. Absent and empty are different answers: the app falls back to a derivation only for absent. */
export function parseOrgs(sc: Payload): OrgTarget[] | undefined {
	if (!Array.isArray(sc.orgs)) return undefined;
	return list<Payload>(sc.orgs)
		.filter((o) => o && typeof o.orgId === 'string')
		.map((o) => ({ orgId: String(o.orgId), orgLabel: String(o.orgLabel ?? o.orgId) }));
}

export function parseBrains(sc: Payload): BrainsPayload {
	const features =
		sc.features && typeof sc.features === 'object' ? (sc.features as ServerFeatures) : undefined;
	return {
		brains: list<BrainRow>(sc.brains),
		active: sc.active ? String(sc.active) : undefined,
		switched: !!sc.switched,
		orgs: parseOrgs(sc),
		features
	};
}

/**
 * The orgs a caller can add a brain to, derived from the brains they can manage.
 *
 * The fallback for a server that predates the `orgs` field. It cannot see an org
 * holding no brain yet, which is precisely the org someone is trying to connect a
 * first repo into; that is why the server now sends the list.
 */
export function derivedOrgTargets(brains: BrainRow[]): OrgTarget[] {
	const out: OrgTarget[] = [];
	const seen = new Set<string>();
	for (const b of brains) {
		if (!b.canManage || !b.orgId || seen.has(b.orgId)) continue;
		seen.add(b.orgId);
		out.push({ orgId: b.orgId, orgLabel: b.orgLabel ?? b.label });
	}
	return out;
}

// ---------- the router ----------

/** What an opening tool result asks the widget to show, keyed on the payload's `view` token. */
export type ToolView =
	| { kind: 'browse'; tree: BrowseData | null }
	| ({ kind: 'edit' } & Required<PageContent>)
	| ({ kind: 'activity' } & ReturnType<typeof parseActivity>)
	| ({ kind: 'graph' } & ReturnType<typeof parseGraph>)
	| ({ kind: 'members' } & ReturnType<typeof parseMembers>)
	| ({ kind: 'analytics' } & ReturnType<typeof parseAnalytics>)
	| ({ kind: 'brain-access' } & ReturnType<typeof parseBrainAccess>)
	| ({ kind: 'brains' } & BrainsPayload)
	| { kind: 'settings'; identity: Identity; accounts: ConnectedAccount[] }
	| ({ kind: 'page' } & PageContent);

/**
 * Route a successful opening result to a screen. A payload with no `view`, or one
 * this bundle does not know, is a page: every content tool's result carries a page,
 * and a newer server's unknown view degrades to showing its content rather than an
 * error.
 */
export function parseToolView(sc: Payload): ToolView {
	switch (str(sc.view) ?? 'page') {
		case 'browse':
			return { kind: 'browse', tree: parseTree(sc) };
		case 'edit':
			return { kind: 'edit', ...parseEdit(sc) };
		case 'activity':
			return { kind: 'activity', ...parseActivity(sc) };
		case 'graph':
			return { kind: 'graph', ...parseGraph(sc) };
		case 'members':
			return { kind: 'members', ...parseMembers(sc) };
		case 'analytics':
			return { kind: 'analytics', ...parseAnalytics(sc) };
		case 'brain-access':
			return { kind: 'brain-access', ...parseBrainAccess(sc) };
		case 'brains':
			return { kind: 'brains', ...parseBrains(sc) };
		// Settings and the connected-accounts widget resolve to the SAME screen: the
		// identity card with connected accounts folded in beneath it.
		case 'settings':
		case 'connected_accounts':
			return { kind: 'settings', identity: parseIdentity(sc), accounts: parseAccounts(sc) };
		default:
			return { kind: 'page', ...parsePage(sc) };
	}
}
