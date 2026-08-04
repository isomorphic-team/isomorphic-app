// MCP server for the brain.
//
// Cloudflare Worker exposing read + write tools over the Streamable
// HTTP MCP transport. Backed by the same GitHub App credentials the bootstrap
// persisted to .dev.vars / Worker secrets. Tool list is registered in
// `IsomorphicMindMcp.init()` below.
//
// Auth model:
//   - Selected by `AUTH_MODE` env var.
//   - `static` (legacy): single bearer token in the `Authorization` header.
//   - `oauth`: OAuth 2.1 via `@cloudflare/workers-oauth-provider`, with GitHub
//     OAuth as the upstream identity. MCP clients discover us via
//     `/.well-known/oauth-authorization-server`, register dynamically at
//     `/register`, hit `/authorize`, and receive tokens at `/token`. Per-user
//     identity flows in via `props` and is read from `ctx.props` in the
//     stateless MCP handler (`mcpApiHandler` -> `McpSession`).
//
// Multi-tenant brain routing:
//   - In `oauth` mode, each request resolves the brain repo + installation
//     per-tenant from `PLATFORM_DB.tenants`, keyed by the OAuth-bound
//     `gh_user_id`. See `src/lib/tenants.ts` and `tenantContext()`.
//   - In `static` mode (legacy), falls back to global `BRAIN_REPO_*` env vars.
//     Dies in phase 3 cutover.
//
// Storage model:
//   - The MCP transport is stateless (per-request McpServer + web-standard
//     transport); no Durable Object. Active brain lives in OAUTH_KV per user.
//   - OAUTH_KV stores OAuth provider state (registered clients, grants,
//     access/refresh tokens) and our pending-auth nonces during the GitHub
//     round-trip.
//   - PLATFORM_DB (D1) holds tenant rows mapping `gh_user_id` → installation
//     and brain repo. Schema in `src/db/schema.sql`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { installationOctokit, tokenOctokit, type AppCreds } from './lib/github.ts';
import { githubStore, type BrainStore } from './lib/brain-repo.ts';
import { getTenantByUserId, NoTenantError } from './lib/tenants.ts';
import { provisionBrainForUser, provisionOrgForUser } from './lib/provision.ts';
import {
	getAppUser,
	assertRole,
	listAccessibleBrains,
	linkedUserIds,
	getAppUserByGithubUserId,
	getMembershipWithOrg,
	matchBrain,
	brainLabel,
	brainLabelQualified,
	type AccessibleBrain,
	type Org,
	type OrgScope,
	type Role,
	type TenantOpts
} from './lib/orgs.ts';
import type { CommitAuthor } from './lib/brain-repo.ts';
import { ensureFresh, listIndexedPages, detectNeedsConfig } from './lib/brain-index.ts';
import { tryRenderViews } from './lib/views.ts';
import { githubHandler } from './oauth/github-handler.ts';
import { authHandler } from './oauth/auth-handler.ts';
import { base64ToUtf8 } from './lib/wiki.ts';
import { registerLibrarianTools } from './tools/librarian.ts';
import { registerImportTools } from './tools/importer.ts';
import { registerBrainApp } from './tools/apps.ts';
import { registerMemberTools } from './tools/members.ts';
import { registerBrainAccessTools } from './tools/brain-access.ts';
import { registerConnectedAccountTools } from './tools/connected-accounts.ts';
import { registerBrainTools } from './tools/brains.ts';
import { registerOrgOnboardingTools } from './tools/org-onboarding.ts';
import { registerFeedbackTools } from './tools/feedback.ts';
import { registerAnalyticsTools } from './tools/analytics.ts';
import { recordUsage } from './lib/usage-store.ts';
import { dayKey, countedCall } from './lib/usage.ts';
import { loadCustomToolDefs, registerCustomTools, type CustomToolLoad } from './tools/custom.ts';
import { resolveInstallationOrg, connectCustomerOrg } from './lib/org-connect.ts';
import {
	loadBrainConfig,
	isContentPath,
	listHiddenPaths,
	pathPolicyOf,
	type BrainConfig
} from './lib/brain-config.ts';

interface Env {
	// Auth mode selector
	AUTH_MODE: 'static' | 'oauth';

	// Static-mode bearer (legacy single-tenant). Optional — read only when
	// AUTH_MODE=static, which dies in phase 3 cutover.
	MCP_BEARER_TOKEN?: string;

	// OAuth-mode storage + GitHub upstream creds. OAUTH_PROVIDER is injected at
	// runtime by the OAuthProvider wrapper; we type it for consumer code.
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	GITHUB_APP_CLIENT_ID: string;
	GITHUB_APP_CLIENT_SECRET: string;

	// Platform GitHub App auth. App ID + PEM are required (used to mint
	// installation tokens for any tenant). The single GITHUB_APP_INSTALLATION_ID
	// env var is static-mode-only — OAuth mode reads installation_id per-tenant
	// from PLATFORM_DB.
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY_BASE64: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	// Single-tenant alternative to the App entirely (AUTH_MODE=static): a plain
	// access token for the one brain repo. Set this and the App credentials above
	// are not read at all, which is what makes local development and one-person
	// self-hosting cheap. Ignored in oauth mode, which mints a token per tenant.
	GITHUB_TOKEN?: string;
	// The App's URL slug (e.g. "isomorphic-mind"), from bootstrap. Used to build
	// the install URL for the self-serve connect_github_org flow. Not a secret.
	GITHUB_APP_SLUG?: string;

	// Platform provisioning (oauth mode). The admin installs the platform App
	// ONCE on a single org; bootstrap records the org login and that
	// installation's id here. On a user's first authenticated request the Worker
	// auto-creates their brain under this org via this installation — so readers
	// and creators never install anything or see GitHub. Captured at admin setup.
	PLATFORM_ORG: string;
	PLATFORM_INSTALLATION_ID: string;
	// "true" enables auto-provisioning on first use. When off, an unknown user
	// gets a NoTenantError instead of a freshly minted brain.
	AUTO_PROVISION: string;

	// Identity provider for the OAuth `/authorize` upstream (oauth mode only).
	// `github` (default) uses GitHub OAuth (github-handler) — every user needs a
	// GitHub account. `authjs` uses Auth.js (email magic-link / SSO, auth-handler)
	// so members/readers never need GitHub. See docs/design/org-roles-permissions.md.
	IDENTITY_MODE?: 'github' | 'authjs';
	// Auth.js config, used only when IDENTITY_MODE=authjs. AUTH_SECRET signs
	// sessions; AUTH_RESEND_KEY + AUTH_EMAIL_FROM drive magic-link email via
	// Resend (magic-link stays inert until AUTH_RESEND_KEY is set).
	AUTH_SECRET?: string;
	AUTH_RESEND_KEY?: string;
	AUTH_EMAIL_FROM?: string;

	// Public origin of the deployed Worker (e.g. https://brain.example.com). Used by
	// the connected-accounts tools to build the /link/start verification URL — a tool
	// handler has no request URL to derive it from.
	PUBLIC_BASE_URL?: string;

	// Static-mode legacy single-tenant brain target. OAuth resolves per-request
	// from PLATFORM_DB keyed by gh_user_id.
	BRAIN_REPO_OWNER?: string;
	BRAIN_REPO_NAME?: string;

	// Multi-tenant routing table (gh_user_id → installation_id, brain_owner,
	// brain_repo). Schema in `src/db/schema.sql`.
	PLATFORM_DB: D1Database;

	// Product feedback (submit_feedback). FEEDBACK_REPO is the "owner/repo" of the
	// tracker that receives reports; FEEDBACK_TOKEN is a separate narrowly scoped
	// credential (Issues: write on that repo only), deliberately NOT the platform
	// App, which has no `issues` permission and must not gain one. Both unset means
	// the tool is not registered. See src/tools/feedback.ts.
	FEEDBACK_REPO?: string;
	FEEDBACK_TOKEN?: string;

	// Usage analytics. ON in any config generated by `pnpm setup:config` (the
	// default there is "true"); set it to "false" to disable. Every tool call then
	// bumps a per-day counter in `usage_daily` (migration 0006) and the org-scope
	// `analytics` tool is registered; disabled, neither happens and the table is
	// never written.
	//
	// Compared with `=== 'true'` rather than `!== 'false'` on purpose: a config that
	// does not mention the key at all (hand-written, or predating this) records
	// nothing, so the only way to start collecting is a config that says so.
	// See src/lib/usage.ts and src/tools/analytics.ts.
	USAGE_ANALYTICS?: string;
}

// Identity surfaced via OAuth `props` (read from `ctx.props`). Empty in static mode.
interface McpProps extends Record<string, unknown> {
	// GitHub identity — set on the legacy `github` IDENTITY_MODE path.
	gh_user_id?: number;
	gh_login?: string;
	// Product-native identity — set on the `authjs` IDENTITY_MODE path, where
	// the user authenticates via Auth.js and may have no GitHub account.
	user_id?: string;
	email?: string;
	org_id?: string | null;
	role?: string | null;
}

function appCreds(env: Env): AppCreds {
	return {
		appId: Number(env.GITHUB_APP_ID),
		privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY_BASE64
	};
}

function repoArgs(env: Env) {
	return { owner: env.BRAIN_REPO_OWNER, repo: env.BRAIN_REPO_NAME };
}

// Thrown by brain-scope resolution when the caller has an org but no brain yet
// (Phase 8: brains are created explicitly, not auto-provisioned). Brain-scope tools
// let it propagate — the MCP layer surfaces the message — so the user is told to
// create one; org-scope tools (create_brain, brains list) never hit this path.
class NoBrainError extends Error {
	constructor() {
		super(
			"You don't have a brain yet. Create one with the Add a brain button, or ask me to create a brain (e.g. “create a brain called Personal”)."
		);
		this.name = 'NoBrainError';
	}
}

interface TenantContext {
	octokit: Awaited<ReturnType<typeof installationOctokit>>;
	// The brain's storage, bound to that octokit. Every content read and write goes
	// through this rather than the client above, which is what lets a non-GitHub
	// backend serve the same tools. See src/lib/brain-repo.ts.
	store: BrainStore;
	repoArgs: { owner: string; repo: string };
	// The caller's role ON THE RESOLVED BRAIN (effectiveBrainRole: an explicit
	// grant, org visibility, or the org-admin floor: whichever is highest). Read
	// tools ignore it; write/configure/share tools gate on it. The GitHub/static
	// legacy paths report 'owner' (full access).
	role: Role;
	// The caller's role in the resolved brain's ORG. Distinct from `role`: org
	// membership governs managing people and adding/removing brains, brain access
	// governs the content. Tools that manage the ORG must gate on this one
	// (TenantOpts.requiresOrg), or a brain admin could edit the org roster.
	orgRole: Role;
	// The resolved org's id + the acting user's id — set only on the product-native
	// (authjs) path, where an org table row exists. The member-management tools need
	// them to scope the roster and enforce self-guards; undefined on the legacy
	// github/static single-tenant paths (those tools reject with "org accounts only").
	orgId?: string;
	actorUserId?: string;
	// The brain's content-shape config (.isomorphic.json, or defaults when absent).
	// Tells the tools which paths are editable content / immutable source / the log.
	config: BrainConfig;
	// Who to attribute commits to (the acting human). Undefined on the static
	// legacy path, where there's no signed-in user — writes stay App-authored.
	author?: CommitAuthor;
	// The platform D1 database + this brain's index key ("owner/repo"), for the
	// content index that backs search / graph / backlinks / validate
	// (src/lib/brain-index.ts). Set on every path — brainId is derived from the
	// resolved repo, so it's universal across identity modes.
	db: D1Database;
	brainId: string;
	// The brain this call resolved to (id + display label), for the app's nav switcher
	// to show which brain is active. Same id as brainId; label is human-facing.
	activeBrain: { id: string; label: string };
}

// Durable-Object state (persisted to the agent's SQLite, survives hibernation).
// Server-level guidance sent to the host at initialize and read by the model as
// "how to use this connector." This is the main lever for getting the brain — and
// especially the in-client viewer — invoked at the right moments, since it applies
// across the whole connector rather than one tool at a time. Keep it short and
// behavioral; per-tool nuance lives in each tool's own description.
const SERVER_INSTRUCTIONS = `Isomorphic is the user's "brain": a personal or team knowledge base (a GitHub-backed wiki) that can be searched, read, edited, and — importantly — VIEWED inside Claude via the Isomorphic app.

When to reach for it:
- Answer from the brain first for anything specific to this user or their org — their notes, projects, people, decisions, customers. Prefer search_pages / read_page over general knowledge for company- or user-specific questions.
- OPEN THE VIEWER, don't just paste text. Whenever the user wants to look at, explore, or "see" a page, and whenever you cite or reference a specific brain page in an answer, call view_page(path) for that page (or browse_brain for the whole brain). These render the page inside Claude in the Isomorphic app so the user can click through it — far better than a wall of pasted markdown. Treat "I mentioned this page" as a cue to open it.
- Use read_page (not view_page) only when YOU need the raw content to reason over it; use view_page when the goal is for the USER to see it.
- For "what changed", "who edited this", or reviewing recent activity, call view_activity — it opens an audit feed of recent changes (who / what / when); pass a path for one page's history.
- For anything about MEMBERS / the team / the organization's people / org roles / invites, call members. It opens the interactive roster inline (with invite + role controls for admins) and also returns the roster as data, so use it both when the user wants to see or manage people and when YOU need the roster to reason over (e.g. before a role change).
- ACCESS IS PER BRAIN, and it is a DIFFERENT question from org membership. A new brain is PRIVATE to whoever created it: being in the organization does not mean you can open it. So for "who can see / who has access to / who is this brain shared with", call brain_access (it opens the sharing panel inline and returns the list as data); to share one, change what someone can do in it, revoke them, or make it private vs visible to the whole organization, call share_brain. Use members + set_member_role for someone's ORGANIZATION role, and brain_access + share_brain for access to a PARTICULAR brain. Sharing only works for people already in the organization, so invite_member first if they have no account.
- The user may have MULTIPLE brains (personal, team, client). Tools act on the ACTIVE brain by default; call brains to show/switch them, switch_brain to change the active one, or pass \`brain\` to any tool (a name/handle like "acme" or "team wiki") to target a different brain. Opening a brain in the app — view_page / browse_brain / edit_page on a \`brain\` — makes it the ACTIVE brain (the user is now looking at it, and the in-client viewer follows it), so subsequent bare calls stay on it. A one-shot data read (read_page / search_pages with \`brain\`) does NOT change the active brain. If a request could mean a different brain than the active one, target it with \`brain\` or ask which brain. An org admin can adopt another repo as a brain with connect_brain (call it with no repo to see the eligible repos) and remove one with disconnect_brain.
- FOLDER NOTES: a folder's overview page must be named \`index.md\` (\`README.md\` is also accepted on older vaults). A page at \`<folder>/index.md\` IS the folder: the app opens it when you click the folder, and okf-view directory listings link folders through it. Any other name (\`overview.md\`, \`vendors.md\`, \`about.md\`) is just a loose page sitting next to its siblings. So when you create a folder of related pages, or the user asks for an overview/index/landing page for a folder, write \`<folder>/index.md\`; and when you find an overview-shaped page under some other name, offer to move_page it to \`index.md\`.
- ONE PAGE = ONE CONCEPT. These brains follow the Open Knowledge Format: anything other pages should be able to link to — a person, vendor, system, event series, project, decision — is its own \`.md\` file with a \`type:\` in its frontmatter. When you are about to write a list of named things as headings or bullets inside one page, stop and write a page per thing instead, then link to them from the parent. A folder note (\`index.md\`) LISTS what is in its folder; it never holds the folder's content inline. The tell that you got this wrong: a reader cannot link to the thing you just wrote, and search cannot return it as a result.
- MATCH THE BRAIN YOU ARE IN. Before adding to an existing folder, look at a sibling page (read_page) and follow what is already there — the same \`type:\` values, the same frontmatter keys, the same granularity. A brain that gives every vendor its own file and then gets one page holding twelve events is worse off than either convention applied consistently. When restructuring, run validate afterwards: it reports structure drift as advisory notes.
- EDIT PART OF A PAGE, don't rewrite it. write_page's \`content\` REPLACES the whole body, so it destroys anything you haven't read. To change part of a page use \`edits\` (exact find/replace, each anchor matching once) or \`append\`: they touch only what you name, need no prior read, and fail loudly rather than guessing. If you do pass \`content\` for an existing page you didn't just write, call read_page first.
- Write only when asked. Edits to a protected brain open a pull request that merges automatically once checks pass; tell the user the change is on its way rather than exposing git mechanics.
- FEEDBACK ABOUT ISOMORPHIC ITSELF goes to the maintainers with submit_feedback. When the user says something here is broken, confusing, or missing, or asks for a feature, offer to send it rather than only sympathizing. It files a public issue on the project's tracker and needs no GitHub account from them. The first call posts nothing: show them the exact title and body it returns, then call again with \`confirm: true\`. Never file one without the user having seen the text, and never put a token, key, or their private content in it. (Feedback about their own CONTENT is a normal page edit, not this.)
- The brain IS a GitHub repo, and every write tool (write_page, move_page, etc.) already commits to it — that is the only save path; there is no separate "push to GitHub" step. So if the user asks you to push, commit, sync, or save to GitHub, the write tools ARE how you do it (and if you already edited, it is already pushed). Never tell the user you cannot push or commit to GitHub.`;

// Per-request MCP session. The transport is now STATELESS (a fresh server +
// transport per POST, response on the same request), so this replaces the old
// long-lived McpAgent Durable Object. It carries the request env, the decrypted
// OAuth token props (identity), and the ExecutionContext, and holds all the
// tenant/brain resolution and tool registration that used to live on the DO.
// Nothing here is persisted between requests except the active brain, which now
// lives in KV keyed by user (see loadActiveBrain / setActiveBrain).
class McpSession {
	readonly env: Env;
	readonly props: McpProps | undefined;
	readonly ctx: ExecutionContext;

	constructor(env: Env, props: McpProps | undefined, ctx: ExecutionContext) {
		this.env = env;
		this.props = props;
		this.ctx = ctx;
	}

	// The connection's active brain. Preloaded once per request from KV
	// (loadActiveBrain) so the many synchronous readers below keep working, and
	// written back fire-and-forget on change. This used to be per-connection DO
	// state; it is now per-USER (KV key) preference, which is the intended
	// semantic change of the stateless move.
	private _activeBrainId?: string;

	private userKey(): string {
		return (
			this.props?.user_id ??
			(this.props?.gh_user_id != null ? 'gh:' + this.props.gh_user_id : 'anon')
		);
	}

	async loadActiveBrain(): Promise<void> {
		this._activeBrainId =
			(await this.env.OAUTH_KV.get('active_brain:' + this.userKey())) ?? undefined;
	}

	// User-defined tools discovered from the active brain's `tools/` folder,
	// loaded once per request (loadCustomTools) before buildServer registers them.
	// Empty until then and whenever the caller has no brain / static mode.
	private _customTools: CustomToolLoad = { defs: [], errors: [] };

	// Resolve the active brain and discover its custom tools so buildServer can
	// register them into the per-request tool list. Fail-open: any resolution
	// problem (no brain yet, static mode, index hiccup) just means no custom tools
	// this request — it must never block the built-in tools from listing.
	async loadCustomTools(): Promise<void> {
		try {
			this._customTools = await loadCustomToolDefs(await this.tenantContext());
		} catch {
			this._customTools = { defs: [], errors: [] };
		}
	}

	get activeBrainId(): string | undefined {
		return this._activeBrainId;
	}

	private setActiveBrain(id: string): void {
		this._activeBrainId = id;
		this.ctx.waitUntil(this.env.OAUTH_KV.put('active_brain:' + this.userKey(), id));
	}

	// The org (and brain, if any) the last resolution in this request landed on.
	//
	// Usage recording needs to know WHICH org and brain a call touched, and only
	// the resolver knows: the org follows the resolved brain, and a `brain` arg
	// one-shots a different one, so neither the token props nor the active-brain
	// pointer is authoritative. The recording wrapper in buildServer reads this
	// after the handler returns. Undefined means the call resolved no org (the
	// legacy single-tenant paths, or a failure before resolution), and nothing is
	// recorded for it.
	private _resolvedScope?: { orgId: string; brainId: string };

	private noteScope(orgId: string | undefined, brainId?: string): void {
		if (orgId) this._resolvedScope = { orgId, brainId: brainId ?? '' };
	}

	/** Whether this deployment records usage at all. Off unless explicitly enabled. */
	private usageEnabled(): boolean {
		return this.env.USAGE_ANALYTICS === 'true';
	}

	// Bump one per-day counter for a finished tool call. Fire-and-forget through
	// waitUntil (the result has already gone back to the host) and swallowing its
	// own failures: a counter is the least important thing this Worker does, and a
	// D1 hiccup must never turn into a failed read_page. Under-counting is fine.
	//
	// Records nothing without BOTH a product identity and a resolved org, so the
	// legacy single-tenant paths and calls that failed before resolution write no
	// rows rather than writing anonymous ones.
	private recordCall(tool: string, ok: boolean): void {
		if (!this.usageEnabled()) return;
		const userId = this.props?.user_id;
		const scope = this._resolvedScope;
		if (!userId || !scope) return;
		this.ctx.waitUntil(
			recordUsage(this.env.PLATFORM_DB, {
				day: dayKey(new Date()),
				orgId: scope.orgId,
				brainId: scope.brainId,
				userId,
				tool,
				ok
			}).catch(() => {})
		);
	}

	// Persist the resolved brain as active when a tool opts into stickiness (the
	// in-client view tools do — see TenantOpts.sticky). Guarded on an actual change so
	// a read of the already-active brain doesn't churn the KV write. This is what collapses
	// the two "current brain" pointers into one: viewing/editing a brain in the widget
	// moves the connection's active brain, so the model's subsequent bare calls and the
	// widget's own bare actions all target the brain the user is looking at.
	private maybeStick(brainId: string, opts?: TenantOpts): void {
		if (opts?.sticky && brainId !== this.activeBrainId) this.setActiveBrain(brainId);
	}

	// The set of user ids that make up the CALLER as a person: the signed-in user plus
	// every identity linked to it via app_users.person_id (identity-linking). Every
	// accessible-brains query below unions across these ids, so a person reaches all
	// their brains from any linked email — this is the single seam the linking work
	// plugs into (see linkedUserIds in lib/orgs.ts).
	private async personUserIds(userId: string): Promise<string[]> {
		return linkedUserIds(this.env.PLATFORM_DB, userId);
	}

	// All brains the current caller can reach (authjs path). Used by the brain tools
	// (brains / switch_brain) and the switcher.
	private async listAccessibleBrainsForCaller(): Promise<AccessibleBrain[]> {
		if (!this.props?.user_id) return [];
		return listAccessibleBrains(this.env.PLATFORM_DB, await this.personUserIds(this.props.user_id));
	}

	// Per-repo brain config, cached for this Durable Object's lifetime — config
	// changes rarely and the DO recycles, so a request-time read on first touch
	// (then memoized) avoids a GitHub round-trip on every tool call.
	private configCache = new Map<string, BrainConfig>();

	private async loadConfig(
		store: BrainStore,
		repoArgs: { owner: string; repo: string }
	): Promise<BrainConfig> {
		const key = `${repoArgs.owner}/${repoArgs.repo}`;
		const cached = this.configCache.get(key);
		if (cached) return cached;
		const cfg = await loadBrainConfig(store, repoArgs);
		this.configCache.set(key, cfg);
		return cfg;
	}

	// Drop a repo's memoized config so the next tenantContext re-reads .isomorphic.json.
	// Called after configure_brain writes/changes it, or the DO would keep serving the
	// stale (default) config for this connection's lifetime.
	private invalidateConfig(owner: string, repo: string): void {
		this.configCache.delete(`${owner}/${repo}`);
	}

	// Resolve the per-request tenant context. In OAuth mode, the brain repo
	// and installation are looked up from PLATFORM_DB keyed by the OAuth-bound
	// gh_user_id; an unknown user is auto-provisioned a brain on the platform
	// org (when AUTO_PROVISION is on). In static mode, falls back to the global
	// env vars (single-tenant legacy path; dies in phase 3 cutover).
	private async tenantContext(opts?: TenantOpts): Promise<TenantContext> {
		const env = this.env;
		if (env.AUTH_MODE === 'oauth') {
			// Product-native identity (IDENTITY_MODE=authjs): resolve org → role →
			// brain from the app-level tables. This is the member-facing path where
			// the user may have no GitHub account.
			if (this.props?.user_id) {
				const ctx = await this.resolveProductContext(
					this.props.user_id,
					this.props.email ?? '',
					opts?.brain
				);
				assertRole(ctx.role, opts?.requires);
				assertRole(ctx.orgRole, opts?.requiresOrg);
				this.maybeStick(ctx.activeBrain.id, opts);
				return ctx;
			}
			// GitHub identity (legacy/admin path): the flat, gh_user_id-keyed tenants
			// table. GitHub-connected users are treated as owners (full access).
			const ghUserId = this.props?.gh_user_id;
			if (!ghUserId) {
				throw new Error(
					'OAuth mode but no identity in props — token carried neither user_id (authjs) nor gh_user_id (github).'
				);
			}
			// Identity-linking bridge: if this GitHub id is linked to a product identity
			// (github_links → app_user), resolve through the PERSON model so the GitHub
			// connection reaches the full union of the person's brains (+ multi-brain
			// selection + member/connected-accounts tools), exactly like the authjs path.
			// Guarded on the person actually having accessible brains, so a linked-but-
			// org-less id falls through rather than getting auto-provisioned a junk brain.
			const linked = await getAppUserByGithubUserId(env.PLATFORM_DB, ghUserId);
			if (linked) {
				const brains = await listAccessibleBrains(
					env.PLATFORM_DB,
					await this.personUserIds(linked.user_id)
				);
				if (brains.length > 0) {
					const ctx = await this.resolveProductContext(linked.user_id, linked.email, opts?.brain);
					assertRole(ctx.role, opts?.requires);
					assertRole(ctx.orgRole, opts?.requiresOrg);
					this.maybeStick(ctx.activeBrain.id, opts);
					return ctx;
				}
			}
			let tenant = await getTenantByUserId(env.PLATFORM_DB, ghUserId);
			if (!tenant) {
				tenant = await this.autoProvision(ghUserId);
			}
			if (tenant.suspended_at) {
				throw new Error(
					`Tenant ${ghUserId} is suspended (App uninstalled or permissions revoked). Re-install to continue.`
				);
			}
			// Single-tenant legacy identity: one human, one brain, no org model: so
			// both scopes report 'owner'.
			assertRole('owner', opts?.requires);
			assertRole('owner', opts?.requiresOrg);
			const octokit = await installationOctokit(appCreds(env), tenant.installation_id);
			const repoArgs = { owner: tenant.brain_owner, repo: tenant.brain_repo };
			// GitHub identity: attribute to their account via GitHub's canonical
			// noreply address (<id>+<login>@users.noreply.github.com), which links the
			// commit to their profile without exposing a private email.
			const login = this.props?.gh_login;
			const author: CommitAuthor | undefined = login
				? { name: login, email: `${ghUserId}+${login}@users.noreply.github.com` }
				: undefined;
			return {
				octokit,
				store: githubStore(octokit),
				repoArgs,
				role: 'owner',
				orgRole: 'owner',
				config: await this.loadConfig(githubStore(octokit), repoArgs),
				author,
				db: env.PLATFORM_DB,
				brainId: `${repoArgs.owner}/${repoArgs.repo}`,
				activeBrain: { id: `${repoArgs.owner}/${repoArgs.repo}`, label: repoArgs.repo }
			};
		}
		// Single-tenant path: one human, one brain, no org model. Two ways to reach
		// the repo, and GITHUB_TOKEN wins because it is the cheaper one to set up.
		//
		//   GITHUB_TOKEN         a plain access token (a fine-grained PAT with Contents
		//                        + Pull requests write is enough). No GitHub App, no
		//                        organization, no manifest flow, no installation id.
		//                        This is the documented path for local development and
		//                        for a single self-hoster. Commits are attributed to
		//                        whoever owns the token, which for one user is what
		//                        you want.
		//   App installation     the original path, still supported: the platform App
		//                        plus GITHUB_APP_INSTALLATION_ID. Required if you want
		//                        App-authored commits or an org-owned installation.
		//
		// Both need BRAIN_REPO_OWNER/NAME, since there is no tenant table to resolve.
		const owner = env.BRAIN_REPO_OWNER;
		const repo = env.BRAIN_REPO_NAME;
		if (!owner || !repo) {
			throw new Error(
				'AUTH_MODE=static requires BRAIN_REPO_OWNER and BRAIN_REPO_NAME (which brain to serve), plus either GITHUB_TOKEN (simplest) or GITHUB_APP_INSTALLATION_ID with the platform App credentials. Run `pnpm doctor` to see what is missing.'
			);
		}
		const installationId = env.GITHUB_APP_INSTALLATION_ID;
		if (!env.GITHUB_TOKEN && !installationId) {
			throw new Error(
				'AUTH_MODE=static needs a way to reach GitHub: set GITHUB_TOKEN (a fine-grained PAT with Contents and Pull requests write on the brain repo), or set GITHUB_APP_INSTALLATION_ID and the platform App credentials. Run `pnpm doctor` to see what is missing.'
			);
		}
		assertRole('owner', opts?.requires);
		assertRole('owner', opts?.requiresOrg);
		const octokit = env.GITHUB_TOKEN
			? tokenOctokit(env.GITHUB_TOKEN)
			: await installationOctokit(appCreds(env), Number(installationId));
		const repoArgs = { owner, repo };
		return {
			octokit,
			store: githubStore(octokit),
			repoArgs,
			role: 'owner',
			orgRole: 'owner',
			config: await this.loadConfig(githubStore(octokit), repoArgs),
			db: env.PLATFORM_DB,
			brainId: `${repoArgs.owner}/${repoArgs.repo}`,
			activeBrain: { id: `${repoArgs.owner}/${repoArgs.repo}`, label: repoArgs.repo }
		};
	}

	// Product-identity resolution: person → accessible brains → the CHOSEN brain →
	// { octokit (that brain's org install), role in that brain, attribution }. The brain
	// is picked by (1) the explicit `brainArg` handle, else (2) the connection's active
	// brain, else (3) the default (oldest). Auto-provisions a personal brain on first
	// touch (when AUTO_PROVISION is on) so a signed-in member with no brain still lands
	// somewhere working.
	private async resolveProductContext(
		userId: string,
		email: string,
		brainArg?: string
	): Promise<TenantContext> {
		const env = this.env;
		const brains = await listAccessibleBrains(env.PLATFORM_DB, await this.personUserIds(userId));

		let target: AccessibleBrain;
		if (brains.length === 0) {
			// First touch: ensure the personal org exists (org-only — no brain is
			// auto-created anymore). If it has no brain yet, signal the "create a brain"
			// state; an invite path that lands them in an org WITH a brain uses it.
			const p = await this.autoProvisionOrg(userId, email);
			if (p.org.suspended_at) {
				throw new Error(`Org ${p.org.org_id} is suspended. Contact your admin.`);
			}
			if (!p.brain) throw new NoBrainError();
			// provisionOrgForUser only ever hands back a brain this user can reach
			// (getDefaultBrainForUser applies the same rule), so the effective brain
			// role here is their org role: there is no grant on a brain they just
			// arrived at, and an unreachable one would have come back null.
			target = {
				id: `${p.brain.repo_owner}/${p.brain.repo_name}`,
				brain_id: p.brain.brain_id,
				org_id: p.org.org_id,
				org_name: p.org.name,
				org_model: p.org.model,
				installation_id: p.org.installation_id,
				repo_owner: p.brain.repo_owner,
				repo_name: p.brain.repo_name,
				name: p.brain.name,
				role: p.role,
				org_role: p.role,
				visibility: p.brain.visibility
			};
		} else {
			if (brainArg) {
				const m = matchBrain(brains, brainArg);
				if (!m.brain) {
					const names = (m.candidates ?? brains).map(brainLabelQualified);
					throw new Error(
						m.candidates
							? `"${brainArg}" matches multiple brains: ${names.join(', ')}. Be more specific.`
							: `No brain matching "${brainArg}". You have access to: ${names.join(', ')}.`
					);
				}
				target = m.brain;
			} else {
				// Active brain if it's still accessible; otherwise the default (oldest).
				const active = this.activeBrainId
					? brains.find((b) => b.id === this.activeBrainId)
					: undefined;
				target = active ?? brains[0];
			}
		}

		const octokit = await installationOctokit(appCreds(env), target.installation_id);
		const repoArgs = { owner: target.repo_owner, repo: target.repo_name };
		// Attribute commits to the human. Prefer the app_users row (authoritative
		// name + verified email); fall back to the token email. A member with no
		// GitHub account still gets legible authorship — GitHub just won't link it
		// to a profile unless the email matches a verified GitHub email.
		const user = await getAppUser(env.PLATFORM_DB, userId);
		const authorEmail = (user?.email || email).trim();
		const authorName = (user?.name || authorEmail).trim();
		const author: CommitAuthor | undefined = authorEmail
			? { name: authorName, email: authorEmail }
			: undefined;
		this.noteScope(target.org_id, target.id);
		return {
			octokit,
			store: githubStore(octokit),
			repoArgs,
			role: target.role,
			orgRole: target.org_role,
			orgId: target.org_id,
			actorUserId: userId,
			config: await this.loadConfig(githubStore(octokit), repoArgs),
			author,
			db: env.PLATFORM_DB,
			brainId: target.id,
			activeBrain: { id: target.id, label: brainLabel(target) }
		};
	}

	// Product-identity analog of autoProvision(): first-touch org+brain for an
	// Auth.js user with no membership. Gated by AUTO_PROVISION.
	private async autoProvisionOrg(userId: string, email: string) {
		const env = this.env;
		if (env.AUTO_PROVISION !== 'true') {
			throw new Error(
				`No org configured for ${email} and AUTO_PROVISION is off. An admin must invite you.`
			);
		}
		if (!env.PLATFORM_ORG || !env.PLATFORM_INSTALLATION_ID) {
			throw new Error(
				'AUTO_PROVISION is on but PLATFORM_ORG / PLATFORM_INSTALLATION_ID are not configured. ' +
					'Run admin setup (pnpm bootstrap) to install the platform App on an org.'
			);
		}
		const installationId = Number(env.PLATFORM_INSTALLATION_ID);
		const octokit = await installationOctokit(appCreds(env), installationId);
		return provisionOrgForUser({
			octokit,
			db: env.PLATFORM_DB,
			user: { user_id: userId, email, name: null },
			org: env.PLATFORM_ORG,
			installationId
		});
	}

	// Org-scope resolution (no brain): the caller's org + role + an installation token,
	// for actions that must work BEFORE the user has a brain — chiefly create_brain and
	// the "you have no brains yet" state. Authjs-only; the legacy github/static paths
	// have no org row and are rejected (mirrors the member tools' "org accounts only").
	// Ensures the personal org exists on first touch (org-only provision).
	private async orgContext(opts?: { requires?: Role }): Promise<OrgScope> {
		const env = this.env;
		if (env.AUTH_MODE !== 'oauth' || !this.props?.user_id) {
			throw new Error(
				'This action is only available for product (email/SSO) accounts, not this connection.'
			);
		}
		const userId = this.props.user_id;
		const email = this.props.email ?? '';
		let membership = await getMembershipWithOrg(env.PLATFORM_DB, userId);
		if (!membership) {
			// First touch with no org yet — create the personal org (org-only).
			const p = await this.autoProvisionOrg(userId, email);
			membership = { role: p.role, org: p.org };
		}
		if (membership.org.suspended_at) {
			throw new Error(`Org ${membership.org.org_id} is suspended. Contact your admin.`);
		}
		assertRole(membership.role, opts?.requires);
		const octokit = await installationOctokit(appCreds(env), membership.org.installation_id);
		const user = await getAppUser(env.PLATFORM_DB, userId);
		const authorEmail = (user?.email || email).trim();
		const author: CommitAuthor | undefined = authorEmail
			? { name: (user?.name || authorEmail).trim(), email: authorEmail }
			: undefined;
		// Org scope resolves no brain, so usage rows for these calls carry ''.
		this.noteScope(membership.org.org_id);
		return {
			octokit,
			org: membership.org,
			role: membership.role,
			db: env.PLATFORM_DB,
			actorUserId: userId,
			author
		};
	}

	// First-touch provisioning: an authenticated user with no tenant row gets a
	// brain created under the platform org via the platform installation. This is
	// what lets readers/creators skip GitHub entirely — they signed in, and the
	// brain materializes. Gated by AUTO_PROVISION so the platform can be locked
	// to invite-only by flipping it off.
	private async autoProvision(ghUserId: number) {
		const env = this.env;
		if (env.AUTO_PROVISION !== 'true') {
			throw new NoTenantError(ghUserId);
		}
		if (!env.PLATFORM_ORG || !env.PLATFORM_INSTALLATION_ID) {
			throw new Error(
				'AUTO_PROVISION is on but PLATFORM_ORG / PLATFORM_INSTALLATION_ID are not configured. ' +
					'Run admin setup (pnpm bootstrap) to install the platform App on an org.'
			);
		}
		const installationId = Number(env.PLATFORM_INSTALLATION_ID);
		const octokit = await installationOctokit(appCreds(env), installationId);
		return provisionBrainForUser({
			octokit,
			db: env.PLATFORM_DB,
			ghUserId,
			ghLogin: this.props?.gh_login ?? null,
			org: env.PLATFORM_ORG,
			installationId
		});
	}

	// Wrap ONE registered tool's handler so its call is counted after it finishes.
	//
	// Why here and not in each tool: this is the only place that sees every tool by
	// name at once, first-party and brain-authored alike, and the only place a new
	// tool cannot forget to opt in. It rides the loop that already rewrites every
	// registration for the claude.ai `execution` shim.
	//
	// Three properties this has to keep:
	//   • The result is untouched. The wrapper returns exactly what the handler
	//     returned, and rethrows exactly what it threw.
	//   • An MCP error result counts as an error. A handler that returns
	//     `{ isError: true }` did not throw, and counting it as a success would hide
	//     precisely the tools that are failing people.
	//   • The scope is this call's. `_resolvedScope` is cleared first, so a call that
	//     never resolves an org records nothing rather than borrowing the org that
	//     the previous call in the same request resolved.
	//
	// THE FIELD IS `handler`, NOT `callback`. SDK 1.29's RegisteredTool stores the
	// function as `handler`; this wrapped `callback` first, which is undefined there,
	// so it threw on the .bind() and would have taken down every request the moment
	// USAGE_ANALYTICS was switched on. Nothing caught it: the cast below defeats
	// typechecking, and with the flag off the line never ran. `pnpm test:usage` now
	// pins this field name against the installed SDK.
	private instrument(name: string, tool: { handler: (...args: never[]) => unknown }): void {
		tool.handler = countedCall(tool.handler.bind(tool), {
			// Per-call, so a handler that never resolves an org records nothing rather
			// than inheriting the org the previous call in this request resolved.
			before: () => {
				this._resolvedScope = undefined;
			},
			after: (ok) => this.recordCall(name, ok)
		}) as typeof tool.handler;
	}

	// Build the MCP server for this request: instantiate McpServer and register
	// every tool exactly as the old McpAgent.init() did. Called once per request
	// by mcpApiHandler, then connected to a fresh stateless transport.
	buildServer(): McpServer {
		const env = this.env;
		const server = new McpServer(
			{ name: 'isomorphic-mind', title: 'Isomorphic', version: '0.1.0' },
			{ instructions: SERVER_INSTRUCTIONS }
		);

		// ---------- whoami ----------
		// Phase 1 OAuth canary. Returns the GitHub identity carried in `props`
		// (populated by the OAuth flow's `completeAuthorization`). In static
		// mode there are no props, so this returns a placeholder — useful as a
		// quick signal of which auth path served the request.
		server.registerTool(
			'whoami',
			{
				title: 'Identify the current user',
				annotations: { readOnlyHint: true },
				description:
					'Return the GitHub identity of the authenticated user (OAuth mode). In static-bearer mode, returns a placeholder.',
				inputSchema: {}
			},
			async () => {
				// Product-native identity (authjs): report the email + resolved org role.
				// structuredContent mirrors the text so the app's "Your settings" identity
				// card can render without a second round-trip (see SettingsView in app/).
				if (this.props?.user_id) {
					const email = this.props?.email ?? 'unknown';
					let roleNote = '';
					const identity: Record<string, unknown> = { email };
					try {
						const { role, repoArgs, activeBrain } = await this.tenantContext();
						roleNote = ` — ${role} of ${repoArgs.owner}/${repoArgs.repo}`;
						identity.role = role;
						identity.org = repoArgs.owner;
						identity.activeBrain = activeBrain;
					} catch {
						// Resolution/provisioning not complete; still report the identity.
					}
					return {
						content: [{ type: 'text', text: `Authenticated as ${email}${roleNote}.` }],
						structuredContent: identity
					};
				}
				// GitHub identity (legacy/admin path).
				const login = this.props?.gh_login;
				const userId = this.props?.gh_user_id;
				// If this GitHub id is linked to a product identity, report the resolved
				// person (email/role/org/activeBrain) so the settings card shows the union.
				if (userId) {
					try {
						const linked = await getAppUserByGithubUserId(this.env.PLATFORM_DB, userId);
						if (linked) {
							const { role, repoArgs, activeBrain } = await this.tenantContext();
							return {
								content: [
									{
										type: 'text',
										text: `Authenticated as @${login ?? linked.email} — ${role} of ${repoArgs.owner}/${repoArgs.repo}.`
									}
								],
								structuredContent: {
									email: linked.email,
									login,
									role,
									org: repoArgs.owner,
									activeBrain
								}
							};
						}
					} catch {
						// Not linked / resolution incomplete — fall through to the plain report.
					}
				}
				if (login) {
					return {
						content: [
							{
								type: 'text',
								text: `Authenticated as @${login} (gh_user_id ${userId}).`
							}
						],
						structuredContent: { login, org: userId ? String(userId) : undefined }
					};
				}
				return {
					content: [{ type: 'text', text: 'No OAuth identity (static-bearer mode).' }],
					structuredContent: {}
				};
			}
		);

		// ---------- list_pages ----------
		server.registerTool(
			'list_pages',
			{
				title: 'List brain pages',
				annotations: { readOnlyHint: true },
				description:
					"List markdown pages in the brain. With no prefix, returns the brain's editable content (per its .isomorphic.json roots); pass a prefix to filter to a subtree. Paths are relative to the repo root.",
				inputSchema: {
					prefix: z
						.string()
						.optional()
						.describe('Path prefix to filter on (e.g. "wiki/" or "internal/frameworks/")'),
					brain: z
						.string()
						.optional()
						.describe('Which brain to target (name/handle). Defaults to the active brain.')
				}
			},
			async ({ prefix, brain }) => {
				const { store, repoArgs, config, db, brainId } = await this.tenantContext({ brain });

				// No prefix = "the brain's editable content", which is exactly what the
				// index holds — serve it from there (instant) and attach each page's title
				// in structuredContent so the app's file tree can label files by title.
				if (!prefix) {
					await ensureFresh(db, store, repoArgs, brainId, config);
					const pages = await listIndexedPages(db, brainId);
					// Everything that's NOT a content page (system files, .gitkeep markers,
					// source, the log): the app shows these only when "show hidden" is on.
					const hidden = await listHiddenPaths(store, repoArgs, config);
					// Empty could mean a fresh brain OR an adopted repo whose content isn't under
					// the configured roots — flag the latter so the app can offer to auto-configure.
					// Only content-AREA files count as "something to show" here: the hidden list
					// now includes system files that exist in any repo.
					const needsConfig =
						pages.length === 0 &&
						!hidden.some((p) => isContentPath(p, config)) &&
						(await detectNeedsConfig(store, repoArgs, config));
					return {
						content: [
							{
								type: 'text' as const,
								text:
									pages.length === 0
										? 'No markdown pages found.'
										: pages.map((p) => p.path).join('\n')
							}
						],
						// The app builds its file tree from THIS result after a brain switch
						// (the switcher calls switch_brain, then re-fetches with list_pages),
						// so the path policy has to ride along — otherwise the tree paints the
						// new brain with the previous brain's roles: every folder outside the
						// stale content root reads as hidden and every page reads as locked.
						structuredContent: { pages, hidden, needsConfig, config: pathPolicyOf(config) }
					};
				}

				// A prefix can target anything (including non-content like raw/), which the
				// index doesn't hold, so keep the live tree walk for that case.
				const head = await store.getHead(repoArgs);
				const paths = (await store.listTree(repoArgs, head))
					.map((e) => e.path)
					.filter((p) => p.startsWith(prefix))
					.sort();

				return {
					content: [
						{
							type: 'text' as const,
							text:
								paths.length === 0 ? `No markdown pages found under "${prefix}".` : paths.join('\n')
						}
					]
				};
			}
		);

		// ---------- read_page ----------
		server.registerTool(
			'read_page',
			{
				title: 'Read a brain page',
				annotations: { readOnlyHint: true },
				// Deliberately verbose and self-naming. This tool is the one an agent
				// looks for by name mid-task ("I need read_page"), and a terse
				// one-liner made it lose tool-search ranking to view_page, whose
				// description talked about read_page more than this one did. The
				// read-before-you-replace rule lives here too, at the point of need.
				description:
					"Read a page: read_page returns the page's raw markdown source (frontmatter and body) as text, fetched from the brain repo. Use it whenever you need a page's contents to reason over, quote, or edit. Read a page before any write_page call that passes `content`, since that replaces the whole body and would destroy text you have not seen (to change only part of a page, prefer write_page's non-destructive `append` / `edits` arguments, which need no prior read). This returns text to you and does not show anything to the user: use view_page when the goal is for the USER to see the page.",
				inputSchema: {
					path: z.string().describe('Path relative to the repo root, e.g. "AGENTS.md"'),
					brain: z
						.string()
						.optional()
						.describe('Which brain to target (name/handle). Defaults to the active brain.')
				}
			},
			async ({ path, brain }) => {
				const { store, repoArgs, db, brainId, config } = await this.tenantContext({ brain });
				const file = await store.readFile(repoArgs, path);
				if (!file) {
					return {
						isError: true,
						content: [{ type: 'text', text: `"${path}" is not a file.` }]
					};
				}
				const text = file.content;
				// Derived views: agents get the okf-view fence PLUS a freshly computed
				// rendering beneath it — the current data without losing sight of the
				// directive (so they don't hand-edit derived content). Falls back to
				// the raw file if computing fails.
				const views = await tryRenderViews(text, path, { db, store, repoArgs, brainId, config });
				return { content: [{ type: 'text', text: views?.snapshotted ?? text }] };
			}
		);

		// ---------- librarian suite ----------
		// write_page / move_page / delete_page / find_inbound_links / validate /
		// search_pages. write_page creates or updates (and publishes via
		// status: 'published', and backs the editor's sha-guarded save); move_page /
		// delete_page also take a folder path to move or delete a whole subtree. All
		// writes are atomic bundles (page + changelog, plus any repointed links, in one
		// commit) and all responses speak in wiki terms, never git terms. See
		// src/tools/librarian.ts.
		registerLibrarianTools(server, (opts) => this.tenantContext(opts));

		// ---------- bulk import (derived-views PRD Phase 3) ----------
		// sync_records: non-destructive upsert-by-key from an external source.
		// See src/tools/importer.ts + src/lib/brain-import.ts.
		registerImportTools(server, (opts) => this.tenantContext(opts));

		// ---------- brain app (MCP Apps / SEP-1865) ----------
		// The in-client viewer/editor: a ui:// HTML resource + view_page /
		// browse_brain / edit_page (saving via the librarian's write_page).
		// UI-capable hosts render the app
		// in a sandboxed iframe; others get the plain-text fallback blocks.
		// See src/tools/apps.ts and app/.
		//
		// `sticky: true` — opening/browsing/editing a brain through the widget makes it
		// the connection's ACTIVE brain, so the file tree, Edit button policy, and the
		// model's subsequent bare calls all track the brain the user is looking at. Without
		// this, a one-shot `brain:` view left the persisted active brain behind, so the
		// widget showed one brain while its own bare actions hit another.
		registerBrainApp(server, (opts) => this.tenantContext({ ...opts, sticky: true }));

		// Is there an org model at all? Single-tenant deployments (AUTH_MODE=static,
		// whether reaching GitHub through a token or an App installation) have one
		// human and one brain, and no `orgs` / `memberships` / `brain_memberships`
		// rows for anything to resolve against. The tools below therefore cannot
		// answer, and they should not appear rather than appear and reject: an
		// advertised tool costs context in every conversation and a refusal reads to
		// the model as a permissions problem it should work around. Same rule as
		// FEEDBACK_REPO (unset means submit_feedback is never registered).
		const hasOrgModel = env.AUTH_MODE === 'oauth';

		// ---------- member management ----------
		// The org-admin roster surface: members (the interactive roster + data) plus
		// invite_member / set_member_role / remove_member. Reads are open to any member;
		// mutations require admin+, with owner as the lockout-proof anchor. See
		// src/tools/members.ts.
		if (hasOrgModel) registerMemberTools(server, (opts) => this.tenantContext(opts));

		// ---------- brain sharing (per-brain access) ----------
		// The brain-scope sibling of the member tools: members moves the ORG roster,
		// these move who can reach ONE brain. See src/tools/brain-access.ts.
		// `sticky: true`, for the same reason registerBrainApp is: the sharing panel is an
		// in-client view OF a brain, and the app's trail treats it as a peer of the file
		// tree and the graph. Opening it for a named brain (the Share control in the
		// brains list) therefore has to move the active brain with it, or the widget shows
		// one brain's audience under another brain's name and its own bare follow-up calls
		// hit the wrong one.
		registerBrainAccessTools(server, (opts) => this.tenantContext({ ...opts, sticky: true }));

		// ---------- connected accounts (identity linking) ----------
		// The per-person "Your settings → Connected accounts" surface: connected_accounts
		// (the interactive panel + data) plus link_identity / unlink_identity.
		// Links a person's emails + GitHub logins so any of them reaches
		// the union of their brains; verified via magic-link. See src/tools/connected-accounts.ts.
		if (hasOrgModel)
			registerConnectedAccountTools(server, (opts) => this.tenantContext(opts), this.env);

		// ---------- org onboarding (self-serve Model-B connect) ----------
		// connect_github_org returns a GitHub App install URL carrying a KV-stashed
		// state; /github/install-callback resolves the install and writes the customer
		// org + owner membership. The runtime analog of `pnpm onboard-org`. See
		// src/tools/org-onboarding.ts and src/lib/org-connect.ts.
		if (hasOrgModel) registerOrgOnboardingTools(server, (opts) => this.orgContext(opts), this.env);

		// ---------- usage analytics ----------
		// The org's Analytics tab, reading the per-day counters the wrapper at the
		// bottom of this method writes. Registered only when USAGE_ANALYTICS is on,
		// for the same reason submit_feedback is gated on FEEDBACK_REPO: with
		// recording off there is nothing to report, and a tool that can only answer
		// "zero" is worse than a tool that is not there. See src/tools/analytics.ts.
		if (this.usageEnabled()) {
			registerAnalyticsTools(server, (opts) => this.tenantContext(opts));
		}

		// ---------- product feedback ----------
		// submit_feedback files a bug/idea on the project's own PUBLIC tracker via a
		// separate narrowly scoped credential (never the platform App). Registered
		// only when FEEDBACK_REPO is configured.
		//
		// Identity is read straight off the token props and the active brain, NOT via
		// tenantContext: it must not throw. A user who cannot resolve a brain (no
		// brain yet, a broken install, static mode with no signed-in user) is
		// precisely the user with something to report, so the one tool that reports it
		// cannot be the one tool that depends on resolution succeeding.
		registerFeedbackTools(
			server,
			() => ({
				userId: this.props?.user_id,
				email: this.props?.email,
				ghLogin: this.props?.gh_login,
				orgId: this.props?.org_id ?? undefined,
				brainId: this.activeBrainId
			}),
			this.env
		);

		// ---------- brain selection (multi-brain) ----------
		// brains (the interactive switcher + data) + switch_brain. A bare tool call
		// acts on the active brain; switch_brain changes it (persisted
		// in agent state); any tool's `brain` arg one-shots another. See src/tools/brains.ts.
		//
		// Registered in single-tenant mode too, unlike the org tools above: the app's
		// nav calls `brains` on every open and learns which destinations exist from
		// the `features` on its payload, so removing it blinds the widget rather than
		// simplifying it. With no signed-in user the brain list is simply empty
		// (listAccessibleBrainsForCaller returns [] without touching the org tables),
		// which is an honest answer rather than a failure.
		registerBrainTools(server, {
			getContext: (opts) => this.tenantContext(opts),
			orgContext: (opts) => this.orgContext(opts),
			listBrains: () => this.listAccessibleBrainsForCaller(),
			activeBrainId: () => this.activeBrainId,
			setActiveBrain: (id) => this.setActiveBrain(id),
			invalidateConfig: (owner, repo) => this.invalidateConfig(owner, repo),
			analyticsEnabled: this.usageEnabled()
		});

		// ---------- user-defined tools (brain-tools) ----------
		// One MCP tool per tool page under the active brain's tools/ folder, discovered
		// in loadCustomTools() before this method runs. Registered last so a custom tool
		// can never shadow a first-party one (name collisions are rejected at parse time
		// via the tool_ prefix anyway). Read-only: prompt / bound-op / view. See
		// src/tools/custom.ts and src/lib/custom-tools.ts.
		registerCustomTools(server, (opts) => this.tenantContext(opts), this._customTools.defs);

		// ---------- claude.ai compatibility shim ----------
		// SDK 1.29 stamps `execution: { taskSupport: 'forbidden' }` (MCP tasks
		// spec, 2025-11-25) on every registered tool and emits it in tools/list.
		// claude.ai web's client-side validation rejects the unfamiliar field and
		// marks the whole connector "unable to reach" — new sessions then never
		// even hit the server (observed 2026-07-06: refresh returned 200s, no
		// traffic afterwards). Strip it from every registration; we don't use
		// tasks. Remove once claude.ai tolerates the field.
		const registered = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ execution?: unknown; handler: (...args: never[]) => unknown }
				>;
			}
		)._registeredTools;
		for (const [name, tool] of Object.entries(registered)) {
			tool.execution = undefined;
			if (this.usageEnabled()) this.instrument(name, tool);
		}

		return server;
	}
}

// The stateless MCP api handler. The OAuth provider (and the static-bearer
// fallback) call this with the authenticated token props on `ctx.props`. It
// builds a fresh McpServer + stateless Streamable-HTTP transport per request and
// answers on the same POST (enableJsonResponse, no SSE, no session id).
const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Stateless transport: only POST carries JSON-RPC requests. Clients also open
		// a GET /mcp for the OPTIONAL server->client SSE stream; we don't offer one
		// (no server push in the request/response model), and handing GET to the SDK
		// transport on Workers hangs the request (the runtime kills it as "will never
		// generate a response"), so the client retries every second. Return 405 per
		// the MCP spec so the client cleanly falls back to POST-only. DELETE (session
		// teardown) is likewise moot with no session.
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
		}
		const props = (ctx as ExecutionContext & { props?: McpProps }).props;
		const session = new McpSession(env, props, ctx);
		await session.loadActiveBrain();
		await session.loadCustomTools();
		const server = session.buildServer();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	}
};

// ---------- Worker entry ----------

// OAuthProvider wraps the entire request lifecycle:
//   - `/.well-known/oauth-authorization-server` (RFC 8414) and
//     `/.well-known/oauth-protected-resource` (RFC 9728) are auto-served.
//   - `/token` and `/register` are implemented internally.
//   - `/authorize` is delegated to `githubHandler` (our OAuth UI / GitHub bridge).
//   - Requests under `apiRoute` (`/mcp`) require a valid access token; on
//     success, the request is forwarded to `mcpApiHandler` with `ctx.props`
//     populated from the grant.
//
// Endpoints are paths (not full URLs); the provider derives full URLs from
// `request.url.origin` for metadata responses. Path-only matching also keeps
// internal routing host-agnostic.
// Chooses the upstream identity handler at request time — env isn't available at
// module load, so we can't pick the handler when constructing OAuthProvider.
// `authjs` routes to Auth.js (product-native identity, no GitHub for members);
// anything else falls back to the GitHub bridge.
const identityHandler = {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		if (env.IDENTITY_MODE === 'authjs') {
			return authHandler.fetch(request, env);
		}
		return githubHandler.fetch(request, env);
	}
};

const oauthProvider = new OAuthProvider<Env>({
	apiRoute: '/mcp',
	apiHandler: mcpApiHandler,
	defaultHandler: identityHandler,
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/token',
	clientRegistrationEndpoint: '/register'
});

// Friendly confirmation page for the GitHub App Setup URL (post-install redirect).
function installedPage(url: URL): Response {
	const action = url.searchParams.get('setup_action') ?? 'install';
	const installationId = url.searchParams.get('installation_id') ?? '';
	const verb = action === 'update' ? 'updated' : 'installed';
	const idLine = installationId
		? `<p class="meta">Installation ID <code>${installationId}</code></p>`
		: '';
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Isomorphic — ${verb}</title>
<style>
  :root { color-scheme: light dark; --bg:#0e0e11; --fg:#e9e9ee; --muted:#9a9aa4; --card:#17171b; --border:#2a2a30; --accent:#7c86ff; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f5f7; --fg:#1c1c22; --muted:#6b6b73; --card:#ffffff; --border:#e2e2e6; --accent:#5560ea; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 460px; width: 100%; background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,.15); }
  .badge { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center;
    background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); font-size: 22px; }
  h1 { font-size: 20px; margin: 18px 0 8px; letter-spacing: -0.01em; }
  p { margin: 8px 0; color: var(--muted); }
  p.lead { color: var(--fg); }
  .meta { font-size: 13px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: color-mix(in srgb, var(--fg) 8%, transparent);
    padding: 1px 6px; border-radius: 6px; font-size: 12.5px; }
  ol { margin: 14px 0 0; padding-left: 20px; color: var(--muted); }
  li { margin: 4px 0; }
</style>
</head>
<body>
  <main class="card">
    <div class="badge">✓</div>
    <h1>Isomorphic ${verb}</h1>
    <p class="lead">The Isomorphic app now has access to the repositories you selected.</p>
    ${idLine}
    <ol>
      <li>Your workspace admin finishes connecting this install to your team.</li>
      <li>Members sign in at <code>${escapeHtml(url.host)}</code> from Claude — no GitHub account needed.</li>
    </ol>
    <p class="meta">You can close this tab.</p>
  </main>
</body>
</html>`;
	return new Response(html, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});
}

// Minimal HTML escape for interpolated GitHub logins (constrained charset, but
// belt-and-suspenders). Reuses installedPage's CSS via the same card markup.
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// A confirmation card in the same visual style as installedPage, for the
// connect-org outcomes (success / personal-account caveat / error).
function cardPage(badge: string, heading: string, bodyHtml: string): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Isomorphic — ${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light dark; --bg:#0e0e11; --fg:#e9e9ee; --muted:#9a9aa4; --card:#17171b; --border:#2a2a30; --accent:#7c86ff; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f5f7; --fg:#1c1c22; --muted:#6b6b73; --card:#ffffff; --border:#e2e2e6; --accent:#5560ea; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 460px; width: 100%; background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,.15); }
  .badge { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center;
    background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); font-size: 22px; }
  h1 { font-size: 20px; margin: 18px 0 8px; letter-spacing: -0.01em; }
  p { margin: 8px 0; color: var(--fg); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: color-mix(in srgb, var(--fg) 8%, transparent);
    padding: 1px 6px; border-radius: 6px; font-size: 12.5px; }
  .meta { font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
  <main class="card">
    <div class="badge">${badge}</div>
    <h1>${escapeHtml(heading)}</h1>
    ${bodyHtml}
    <p class="meta">You can close this tab.</p>
  </main>
</body>
</html>`;
	return new Response(html, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});
}

function connectedOrgPage(result: {
	created: boolean;
	orgLogin: string;
	installOnUser: boolean;
}): Response {
	const verb = result.created ? 'connected' : 'reconnected';
	const lead = result.installOnUser
		? `Isomorphic is installed on <code>${escapeHtml(result.orgLogin)}</code>, but that's a personal account. New brains need a GitHub organization; you can still adopt existing repos there with <code>connect_brain</code>.`
		: `Isomorphic is ${verb} to <code>${escapeHtml(result.orgLogin)}</code> and you're its owner here.`;
	return cardPage(
		'✓',
		`Organization ${verb}`,
		`<p>${lead}</p><p>Back in Claude, run <code>connect_brain</code> to adopt a repository as your first brain.</p>`
	);
}

// Resolve a self-serve install → customer org + owner membership. Unknown/expired
// state falls back to the generic confirmation (no identity to attribute).
async function handleOrgConnectCallback(
	url: URL,
	state: string,
	installationId: number,
	env: Env
): Promise<Response> {
	const raw = await env.OAUTH_KV.get(`pending_org_connect:${state}`);
	if (!raw) return installedPage(url);
	let pending: { user_id: string; email: string | null };
	try {
		pending = JSON.parse(raw);
	} catch {
		return installedPage(url);
	}
	try {
		const org = await resolveInstallationOrg(appCreds(env), installationId);
		const result = await connectCustomerOrg(env.PLATFORM_DB, {
			userId: pending.user_id,
			installationId,
			orgLogin: org.orgLogin,
			accountType: org.accountType
		});
		await env.OAUTH_KV.delete(`pending_org_connect:${state}`);
		return connectedOrgPage(result);
	} catch (err) {
		return cardPage(
			'⚠',
			'Couldn’t finish connecting',
			`<p>The app installed, but we couldn’t link it to your account: ${escapeHtml(
				err instanceof Error ? err.message : String(err)
			)}.</p><p>Try <code>connect_github_org</code> again from Claude.</p>`
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check, no auth — useful for poking the deploy.
		if (url.pathname === '/health') {
			return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
		}

		// GitHub App post-install redirect (the App's Setup URL). GitHub sends the
		// admin here after they install/update the App on an org, with
		// ?installation_id=…&setup_action=…. The old manifest pointed this at the
		// local bootstrap server (localhost:3000) → a 404 for anyone installing in
		// prod. Serve a friendly confirmation instead; onboarding itself is
		// admin-driven (seed), so this page just confirms + surfaces the id.
		if (url.pathname === '/github/install-callback') {
			// Self-serve connect_github_org completion carries a `state` we stashed in
			// KV; without it (e.g. a direct Marketplace install) fall back to the
			// generic confirmation page.
			const state = url.searchParams.get('state');
			const installationId = Number(url.searchParams.get('installation_id') ?? '');
			if (state && installationId) {
				return handleOrgConnectCallback(url, state, installationId, env);
			}
			return installedPage(url);
		}

		if (env.AUTH_MODE === 'oauth') {
			return oauthProvider.fetch(request, env, ctx);
		}

		// Static-bearer fallback. Single token; the legacy single-tenant path.
		// MCP_BEARER_TOKEN was removed from `.dev.vars` when OAuth mode became
		// the active path — return a clear 503 instead of silently letting
		// `Bearer undefined` through if static mode is selected without it.
		if (!env.MCP_BEARER_TOKEN) {
			return new Response(
				'AUTH_MODE=static requires MCP_BEARER_TOKEN. Switch AUTH_MODE=oauth or set the secret.',
				{ status: 503 }
			);
		}
		const auth = request.headers.get('Authorization');
		if (!auth || auth !== `Bearer ${env.MCP_BEARER_TOKEN}`) {
			return new Response('Unauthorized', { status: 401 });
		}
		return mcpApiHandler.fetch(request, env, ctx);
	}
} satisfies ExportedHandler<Env>;
