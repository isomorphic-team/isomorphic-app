// MCP server for the brain.
//
// Cloudflare Worker exposing read + write tools over the Streamable HTTP MCP
// transport. Tools are registered per request in `McpSession.buildServer()`.
//
// Auth model (`AUTH_MODE`):
//   - `static`: single bearer token in the `Authorization` header. One person, one
//     brain: the supported self-hosting path. Nobody else signs in.
//   - `oauth`: OAuth 2.1 via `@cloudflare/workers-oauth-provider`. MCP clients
//     discover us via `/.well-known/oauth-authorization-server`, register at
//     `/register`, hit `/authorize`, and receive tokens at `/token`. The human
//     sign-in behind `/authorize` is Auth.js (email magic link, no GitHub account
//     needed). Identity flows in via `props` on `ctx.props`.
//
// Brain routing: ONE path for both modes. The caller is a person (the signed-in
// user, or in static mode the operator row `src/lib/static-tenant.ts` writes from
// config) -> memberships / grants -> the chosen brain row -> that brain's storage
// binding. See `tenantContext()` and `resolveProductContext()`. The modes differ
// only in whether anyone else can sign in, which decides whether the people and
// sharing tools are registered (`multiUser` in buildServer).
//
// Storage model:
//   - The MCP transport is stateless (per-request McpServer + web-standard
//     transport). The active brain lives in OAUTH_KV per user.
//   - OAUTH_KV stores OAuth provider state (registered clients, grants,
//     access/refresh tokens) and pending-auth nonces for the sign-in round trip.
//   - PLATFORM_DB (D1) holds the org model, the content index, and usage
//     counters. Schema is `migrations/`.

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import { registeredTools, wrapToolHandler } from './lib/registered-tools.ts';
import { serveMcp, serverOptions } from './lib/mcp-serve.ts';
import type { IdentityWire } from './lib/tool-payloads.ts';
import { z } from 'zod';
import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { installationOctokit, tokenOctokit, staticAuth, type AppCreds } from './lib/github.ts';
import { githubStore, commitAuthorFor, type BrainStore } from './lib/brain-repo.ts';
import { platformInstall, provisionOrgForUser } from './lib/provision.ts';
import { ensureStaticTenant, STATIC_USER_ID } from './lib/static-tenant.ts';
import { credentialFor } from './lib/storage-connections.ts';
import { claimPendingInvites } from './lib/invites.ts';
import {
	getAppUser,
	assertRole,
	listAccessibleBrains,
	linkedUserIds,
	listAccessibleOrgs,
	resolveOrgForPerson,
	chooseBrain,
	isActiveBrain,
	brainRefs,
	brainLabel,
	type AccessibleBrain,
	type Org,
	type OrgScope,
	type Role,
	type TenantOpts
} from './lib/orgs.ts';
import type { CommitAuthor } from './lib/brain-repo.ts';
import { authHandler } from './oauth/auth-handler.ts';
import { getAuthSession } from './auth/config.ts';
import { BRAIN_APP_HTML } from './lib/app-bundle.generated.ts';
import { WEB_ROUTE_PREFIX, checkWebMcpRequest, claimsWebMcp, webBaseUrl } from './lib/web-app.ts';
import { WEB_APP_HEADERS, signInRedirect, webShell } from './lib/web-shell.ts';
import { registerLibrarianTools } from './tools/librarian.ts';
import { registerImportTools } from './tools/importer.ts';
import { registerBrainApp } from './tools/apps.ts';
import { SERVER_INSTRUCTIONS } from './lib/server-instructions.ts';
import { registerCoreTools } from './tools/core.ts';
import { registerMediaTools } from './tools/media.ts';
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
import { loadBrainConfig, type BrainConfig } from './lib/brain-config.ts';
import {
	peekJsonRpc,
	needsBrainPreamble,
	jsonRpcError,
	describeRequest
} from './lib/mcp-preamble.ts';

interface Env {
	// Auth mode selector
	AUTH_MODE: 'static' | 'oauth';

	// Static-mode bearer (single-tenant self-hosting). Read only when
	// AUTH_MODE=static.
	MCP_BEARER_TOKEN?: string;

	// OAuth-mode storage. OAUTH_PROVIDER is injected at runtime by the
	// OAuthProvider wrapper; we type it for consumer code.
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;

	// Platform GitHub App auth. App ID + PEM are required (used to mint
	// installation tokens for any tenant). The single GITHUB_APP_INSTALLATION_ID
	// env var is static-mode-only: OAuth mode reads installation_id per brain
	// (or per legacy tenant row) from PLATFORM_DB.
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY_BASE64: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	// Single-tenant alternative to the App entirely (AUTH_MODE=static): a plain
	// access token for the one brain repo. Set this and the App credentials above
	// are not read at all, which is what makes local development and one-person
	// self-hosting cheap. Ignored in oauth mode, which mints a token per tenant.
	GITHUB_TOKEN?: string;
	// The App's URL slug (e.g. "my-brain-app"), from bootstrap. Used to build
	// the install URL for create_org's GitHub path (`github: true`). Not a secret.
	GITHUB_APP_SLUG?: string;

	// Platform provisioning (oauth mode). The admin installs the platform App
	// ONCE on a single org; bootstrap records the org login and that
	// installation's id here. A first-touch authjs user gets a personal org backed
	// by this installation (org only: brains are created explicitly with
	// create_brain). On the legacy github identity path, a first-touch user gets a
	// brain repo created under this org. Captured at admin setup.
	PLATFORM_ORG: string;
	PLATFORM_INSTALLATION_ID: string;
	// "true" enables first-touch provisioning and create_org's hosted orgs (which
	// also mint under the platform installation). When off, a person nobody invited
	// is turned away. Pending invitations are claimed either way.
	AUTO_PROVISION: string;

	// The OAuth `/authorize` upstream is Auth.js (email magic-link, auth-handler).
	// `authjs` is the only accepted value, and unset means it. `github` (GitHub
	// OAuth into a per-user `tenants` row) was removed on 2026-09-23; a deployment
	// still setting it is told so at /authorize rather than failing obscurely.
	IDENTITY_MODE?: string;
	// Auth.js config (oauth mode). AUTH_SECRET signs
	// sessions; AUTH_RESEND_KEY + AUTH_EMAIL_FROM drive magic-link email via
	// Resend (magic-link stays inert until AUTH_RESEND_KEY is set).
	AUTH_SECRET?: string;
	AUTH_RESEND_KEY?: string;
	AUTH_EMAIL_FROM?: string;

	// Public origin of the deployed Worker (e.g. https://brain.example.com). Used by
	// the connected-accounts tools to build the /link/start verification URL — a tool
	// handler has no request URL to derive it from.
	PUBLIC_BASE_URL?: string;

	// Static-mode brain target (the one repo). OAuth mode resolves the brain per
	// request from PLATFORM_DB.
	BRAIN_REPO_OWNER?: string;
	BRAIN_REPO_NAME?: string;

	// The platform database: org model (orgs, memberships, brains, grants,
	// invitations, storage connections), the content index, and usage counters.
	// Schema is `migrations/`.
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
	// Compared with `=== 'true'` rather than `!== 'false'`: a config that does not
	// mention the key records nothing, so collecting starts only when a config says so.
	// See src/lib/usage.ts and src/tools/analytics.ts.
	USAGE_ANALYTICS?: string;
}

// Identity surfaced via OAuth `props` (read from `ctx.props`). Empty in static mode.
interface McpProps extends Record<string, unknown> {
	// The Auth.js identity: the user may have no GitHub account.
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

// Thrown by brain-scope resolution when the caller has an org but no brain yet
// (brains are created explicitly, never auto-provisioned on this path). Brain-scope
// tools let it propagate, so the MCP layer surfaces the message and the user is told
// to create one; org-scope tools (create_brain, brains list) never hit this path.
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
	// tools ignore it; write/configure/share tools gate on it. The single-tenant
	// paths (github tenant row, static) report 'owner' (full access).
	role: Role;
	// The caller's role in the resolved brain's ORG. Distinct from `role`: org
	// membership governs managing people and adding/removing brains, brain access
	// governs the content. Tools that manage the ORG must gate on this one
	// (TenantOpts.requiresOrg), or a brain admin could edit the org roster.
	// Null when the caller holds no membership in the org that owns the resolved brain.
	// Every gate reading this treats null as "not a member", never as "no gate".
	orgRole: Role | null;
	// The resolved org's id + the acting user's id, set only when resolution went
	// through the org model (authjs, or a linked GitHub id). The member-management
	// tools need them to scope the roster and enforce self-guards; undefined on the
	// single-tenant paths (github tenant row, static) (those tools reject with "org accounts only").
	orgId?: string;
	actorUserId?: string;
	// The brain's content-shape config (.isomorphic.json, or defaults when absent).
	// Tells the tools which paths are editable content / immutable source / the log.
	config: BrainConfig;
	// Who to attribute commits to (the acting human). Undefined on the static
	// path, where there's no signed-in user: writes stay App- or token-authored.
	author?: CommitAuthor;
	// The platform D1 database + this brain's primary key (`brains.brain_id`), which
	// keys the content index (src/lib/brain-index.ts), the write-retry ledger and
	// usage. Never shown to a person and never changed by a move or rename.
	db: D1Database;
	brainId: string;
	// The brain this call resolved to, as the handle tools and the app pass around
	// (`id`) plus its display label.
	activeBrain: { id: string; label: string };
}

// Per-request MCP session. The transport is stateless (a fresh server + transport
// per POST, response on the same request). This carries the request env, the
// decrypted OAuth token props (identity), and the ExecutionContext, and holds all
// the tenant/brain resolution and tool registration. Nothing here persists between
// requests except the active brain, which lives in KV keyed by user (see
// loadActiveBrain / setActiveBrain). Server-level guidance (SERVER_INSTRUCTIONS)
// lives in src/lib/server-instructions.ts, shared with the local runtime.
class McpSession {
	readonly env: Env;
	readonly props: McpProps | undefined;
	readonly ctx: ExecutionContext;

	constructor(env: Env, props: McpProps | undefined, ctx: ExecutionContext) {
		this.env = env;
		this.props = props;
		this.ctx = ctx;
	}

	// The caller's active brain. Preloaded once per request from KV
	// (loadActiveBrain) so the synchronous readers below work, and written back on
	// change (awaited, see setActiveBrain). It is a per-USER preference, not
	// per-conversation.
	private _activeBrainId?: string;

	// One invite claim per request, however many times a person is resolved.
	private invitesClaimed = false;

	private userKey(): string {
		return this.props?.user_id ?? (this.env.AUTH_MODE === 'static' ? STATIC_USER_ID : 'anon');
	}

	// Who is calling, as an app_users id. The signed-in person in oauth mode. In
	// static mode, the operator row, written from config on first use (once per
	// request): the same org model, with one member.
	private _staticCaller?: Promise<string>;
	private async callerUserId(): Promise<string | undefined> {
		if (this.env.AUTH_MODE !== 'static') return this.props?.user_id;
		this._staticCaller ??= (async () => {
			const auth = staticAuth(this.env);
			const { userId } = await ensureStaticTenant(this.env.PLATFORM_DB, {
				owner: auth.owner,
				repo: auth.repo,
				credential:
					auth.kind === 'token'
						? { kind: 'token' }
						: { kind: 'installation', installationId: auth.installationId }
			});
			return userId;
		})();
		return this._staticCaller;
	}

	// The pointer holds a `brain_id` (a pointer written before brains were keyed by
	// id holds "owner/repo"; isActiveBrain reads both). Fail-open, like
	// loadCustomTools: a KV read that throws leaves the pointer
	// unresolved, so the request falls back to the caller's default brain. This runs
	// in the preamble outside any handler, where a throw would fail the whole request
	// over a pointer that is only a preference.
	async loadActiveBrain(): Promise<void> {
		try {
			this._activeBrainId =
				(await this.env.OAUTH_KV.get('active_brain:' + this.userKey())) ?? undefined;
		} catch {
			this._activeBrainId = undefined;
		}
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

	// AWAITED, not waitUntil. The pointer's next reader is usually the very next
	// request (the widget fetches its brain list the moment it opens, and the model's
	// next bare call resolves through this key), and a fire-and-forget write may not
	// have started by then, so the read would return the previous brain. Failure is
	// swallowed: a KV blip must not turn a successful read into an error; the pointer
	// just doesn't move. (KV is still eventually consistent across locations, so the
	// app treats the brain a RESULT names as authoritative over this pointer — see
	// pickShownBrain in app/core/store.ts.)
	private async setActiveBrain(id: string): Promise<void> {
		this._activeBrainId = id;
		await this.env.OAUTH_KV.put('active_brain:' + this.userKey(), id).catch(() => {});
	}

	// The org (and brain, if any) the last resolution in this request landed on.
	//
	// Usage recording needs to know WHICH org and brain a call touched, and only
	// the resolver knows: the org follows the resolved brain, and a `brain` arg
	// one-shots a different one, so neither the token props nor the active-brain
	// pointer is authoritative. The recording wrapper in buildServer reads this
	// after the handler returns. Undefined means the call resolved no org (the
	// single-tenant paths, or a failure before resolution), and nothing is
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
	// single-tenant paths and calls that failed before resolution write no
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

	// The set of user ids that make up the CALLER as a person: the signed-in user plus
	// every identity linked to it via app_users.person_id (identity-linking). Every
	// accessible-brains query below unions across these ids, so a person reaches all
	// their brains from any linked email — this is the single seam the linking work
	// plugs into (see linkedUserIds in lib/orgs.ts).
	private async personUserIds(userId: string): Promise<string[]> {
		const ids = await linkedUserIds(this.env.PLATFORM_DB, userId);
		await this.claimInvites(ids);
		return ids;
	}

	// Join any org (or brain) this person has been invited to, once per request,
	// before anything reads their memberships. It lives here rather than in
	// provisioning because provisioning is only reached by a person with no brain
	// anywhere, so an invitation to a SECOND org would never be claimed. Claiming is
	// a no-op SELECT when there is nothing pending, which is almost always.
	//
	// Fail-open: an invite that cannot be claimed must not break a session that
	// was working without it. The invitation stays pending and the next request
	// tries again.
	private async claimInvites(userIds: string[]): Promise<void> {
		if (this.invitesClaimed) return;
		this.invitesClaimed = true;
		try {
			const claimed = await claimPendingInvites(this.env.PLATFORM_DB, userIds);
			for (const c of claimed) {
				if (c.joins) console.log(`[invites] ${c.user_id} joined org ${c.org_id} as ${c.role}`);
			}
		} catch (err) {
			console.warn(`[invites] claim failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// The org holding the connection's active brain. Lets an org-scope action default
	// to where the user is already working instead of to whichever org sorts first.
	// Called lazily by resolveOrgForPerson, which skips it when it cannot matter.
	private async activeBrainOrgId(): Promise<string | undefined> {
		if (!this.activeBrainId) return undefined;
		const brains = await this.listAccessibleBrainsForCaller();
		return brains.find((b) => isActiveBrain(b, this.activeBrainId))?.org_id;
	}

	// All brains the current caller can reach. Used by the brain tools (brains /
	// switch_brain) and the switcher.
	private async listAccessibleBrainsForCaller(): Promise<AccessibleBrain[]> {
		const userId = await this.callerUserId();
		if (!userId) return [];
		return listAccessibleBrains(this.env.PLATFORM_DB, await this.personUserIds(userId));
	}

	// Where the web app is served, or undefined on a deployment without one.
	private webBase(): string | undefined {
		return webBaseUrl({
			authMode: this.env.AUTH_MODE,
			publicBaseUrl: this.env.PUBLIC_BASE_URL
		});
	}

	// Per-repo brain config, memoized for this request so several resolutions in
	// one call (a tool plus custom-tool discovery) read .isomorphic.json once.
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
	// Called after configure_brain writes/changes it, or the rest of this request
	// would keep serving the stale (default) config.
	private invalidateConfig(owner: string, repo: string): void {
		this.configCache.delete(`${owner}/${repo}`);
	}

	// Resolve the per-request tenant context. One path for every deployment: the
	// caller (signed in, or the static operator) through the org model to the chosen
	// brain, whose storage binding says which credential reads it.
	private async tenantContext(opts?: TenantOpts): Promise<TenantContext> {
		const userId = await this.callerUserId();
		if (!userId) {
			throw new Error('No signed-in identity on this connection: sign in again and retry.');
		}
		const ctx = await this.resolveProductContext(userId, this.props?.email ?? '', opts?.brain);
		assertRole(ctx.role, opts?.requires);
		assertRole(ctx.orgRole, opts?.requiresOrg);
		return ctx;
	}

	// Product-identity resolution: person → accessible brains → the CHOSEN brain →
	// { octokit (that brain's storage credential), role in that brain, attribution }.
	// The brain is picked by (1) the explicit `brainArg` handle, else (2) the caller's
	// active brain, else (3) the default (oldest). A person with no reachable brain
	// goes through first-touch org provisioning (claiming invitations, and minting a
	// personal org when AUTO_PROVISION is on); no brain is created here, so they get
	// NoBrainError unless an invitation landed them somewhere with one.
	private async resolveProductContext(
		userId: string,
		email: string,
		brainArg?: string
	): Promise<TenantContext> {
		const env = this.env;
		const brains = await listAccessibleBrains(env.PLATFORM_DB, await this.personUserIds(userId));

		let target: AccessibleBrain;
		if (brains.length === 0 && env.AUTH_MODE === 'static') {
			// ensureStaticTenant wrote the brain this caller reaches, so an empty list
			// is a broken row set, not a first-touch person to provision.
			throw new NoBrainError();
		} else if (brains.length === 0) {
			// First touch: ensure the personal org exists (org only, no brain). If it
			// has no brain yet, signal the "create a brain" state; an invite path that
			// lands them in an org WITH a brain uses it.
			const p = await this.autoProvisionOrg(userId, email);
			if (p.org.suspended_at) {
				throw new Error(`Org ${p.org.org_id} is suspended. Contact your admin.`);
			}
			if (!p.brain) throw new NoBrainError();
			// provisionOrgForUser only ever hands back a brain this user can reach, and
			// it just wrote the membership that makes it reachable, so the same query
			// that found nothing a moment ago now finds it. Re-listing rather than
			// assembling the row from `p` keeps ONE source for the brain's role and,
			// above all, its credential: the storage binding, not the org's install.
			const now = await listAccessibleBrains(env.PLATFORM_DB, await this.personUserIds(userId));
			const found = now.find((b) => b.brain_id === p.brain!.brain_id);
			if (!found) throw new NoBrainError();
			target = found;
		} else {
			// Named brain, else the one the caller is working in, else the oldest.
			target = chooseBrain(brains, { brain: brainArg, activeBrainId: this.activeBrainId });
		}

		const credential = credentialFor(target);
		const octokit =
			credential.kind === 'token'
				? tokenOctokit(requireToken(env))
				: await installationOctokit(appCreds(env), credential.installationId);
		const repoArgs = { owner: target.repo_owner, repo: target.repo_name };
		// Attribute commits to the human. Prefer the app_users row (authoritative
		// name + verified email); fall back to the token email. A member with no
		// GitHub account still gets legible authorship — GitHub just won't link it
		// to a profile unless the email matches a verified GitHub email.
		//
		// Static mode has no signed-in human, only the operator row, whose address is
		// a placeholder: no author, so commits are attributed to the token's owner or
		// the App, as they always were there.
		const author =
			env.AUTH_MODE === 'static'
				? undefined
				: commitAuthorFor(await getAppUser(env.PLATFORM_DB, userId), email);
		this.noteScope(target.org_id, target.brain_id);
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
			...brainRefs(target)
		};
	}

	// Product-identity analog of autoProvision(): first-touch org for an Auth.js
	// user with no membership. AUTO_PROVISION governs MINTING a personal org, and
	// is passed down rather than checked here, because the same call also claims a
	// pending invitation and an invite-only deployment must still honour those.
	// Touches no GitHub: no brain is created on this path.
	private async autoProvisionOrg(userId: string, email: string) {
		const env = this.env;
		const autoProvision = env.AUTO_PROVISION === 'true';
		// Only read when it is going to be used: joining by invitation mints nothing
		// and so needs neither value, which is what lets an invite-only deployment
		// run with no platform org configured at all.
		const platform = autoProvision ? platformInstall(env) : undefined;
		return provisionOrgForUser({
			db: env.PLATFORM_DB,
			user: { user_id: userId, email, name: null },
			org: platform?.org,
			installationId: platform?.installationId,
			autoProvision
		});
	}

	// Org-scope resolution (no brain): the caller's org + role + an installation token,
	// for actions that must work BEFORE the user has a brain, chiefly create_brain and
	// the "you have no brains yet" state. Authjs-only; the legacy github/static paths
	// have no org row and are rejected (mirrors the member tools' "org accounts only").
	// Ensures the personal org exists on first touch (org-only provision).
	private async orgContext(opts?: { requires?: Role; org?: string }): Promise<OrgScope> {
		const env = this.env;
		if (env.AUTH_MODE !== 'oauth' || !this.props?.user_id) {
			throw new Error(
				'This action is only available for product (email/SSO) accounts, not this connection.'
			);
		}
		const userId = this.props.user_id;
		const email = this.props.email ?? '';
		// The PERSON's orgs, not the signed-in id's, so a membership held under a linked
		// email is reachable here exactly as it is for every brain query. The selection
		// lives in orgs.ts so a test can drive it against a real database (see
		// resolveOrgForPerson). Null means no membership anywhere, the one case that
		// provisions.
		const personIds = await this.personUserIds(userId);
		const picked = await resolveOrgForPerson(env.PLATFORM_DB, personIds, {
			org: opts?.org,
			activeOrgId: () => this.activeBrainOrgId()
		});
		let membership: { role: Role; org: Org };
		if (picked) {
			membership = picked;
		} else {
			// First touch with no org at all: create the personal org (org-only).
			const p = await this.autoProvisionOrg(userId, email);
			membership = { role: p.role, org: p.org };
			if (membership.org.suspended_at) {
				throw new Error(`Org ${membership.org.org_id} is suspended. Contact your admin.`);
			}
		}
		assertRole(membership.role, opts?.requires);
		const octokit = await installationOctokit(appCreds(env), membership.org.installation_id);
		const author = commitAuthorFor(await getAppUser(env.PLATFORM_DB, userId), email);
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

	// Wrap ONE registered tool's handler so its call is counted after it finishes.
	//
	// Why here and not in each tool: this is the only place that sees every tool by
	// name at once, first-party and brain-authored alike, and the only place a new
	// tool cannot forget to opt in.
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
	// The replacement goes through `wrapToolHandler`, because SDK 2 ignores an
	// assignment to `tool.handler`. `pnpm test:usage` drives a real dispatch through
	// that helper.
	private instrument(name: string, tool: RegisteredTool): void {
		wrapToolHandler(tool, (handler) =>
			countedCall(handler, {
				// Per-call, so a handler that never resolves an org records nothing rather
				// than inheriting the org the previous call in this request resolved.
				before: () => {
					this._resolvedScope = undefined;
				},
				after: (ok) => this.recordCall(name, ok)
			})
		);
	}

	// Build the MCP server for this request: instantiate McpServer and register
	// every tool. Called once per request by mcpApiHandler, then served statelessly.
	buildServer(): McpServer {
		const env = this.env;
		const server = new McpServer(
			{ name: 'isomorphic-mind', title: 'Isomorphic', version: '0.1.0' },
			serverOptions(SERVER_INSTRUCTIONS)
		);

		// ---------- whoami ----------
		// The signed-in identity, read from the token `props`, plus the caller's role on
		// the resolved brain when resolution succeeds. Per identity path:
		//   authjs            email, role, the brain's repo owner, activeBrain
		//   github, linked    the same, plus the GitHub login
		//   github, unlinked  the GitHub login and numeric id
		//   static            no identity; says so
		// The app's "Your settings" identity card renders the structuredContent.
		server.registerTool(
			'whoami',
			{
				title: 'Identify the current user',
				annotations: { readOnlyHint: true },
				description:
					'Identify the current user: whoami reports who is signed in to this connection. Returns their email and, when a brain resolves, their role on the active brain and which brain that is. On a single-user deployment, which has no sign-in, says so.',
				inputSchema: z.object({})
			},
			async () => {
				// Product-native identity (authjs): report the email + role on the resolved brain.
				// structuredContent mirrors the text so the app's "Your settings" identity
				// card can render without a second round-trip (see SettingsView in app/).
				if (this.props?.user_id) {
					const email = this.props?.email ?? 'unknown';
					let roleNote = '';
					const identity: IdentityWire = { email };
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
				// Static mode: nobody signs in. The caller is the deployment's operator,
				// who owns its one brain.
				// Answered from the rows alone, not a resolved context: that reads the
				// brain's config from GitHub, and a bad token must not turn "who am I"
				// into "nobody".
				if (this.env.AUTH_MODE === 'static') {
					try {
						const [b] = await this.listAccessibleBrainsForCaller();
						if (b) {
							const activeBrain = { id: b.id, label: brainLabel(b) };
							return {
								content: [
									{
										type: 'text',
										text: `Single-user deployment with no sign-in: you are its operator, ${b.role} of ${activeBrain.label}.`
									}
								],
								structuredContent: { role: b.role, activeBrain } satisfies IdentityWire
							};
						}
					} catch (err) {
						const why = err instanceof Error ? err.message : String(err);
						return {
							content: [
								{
									type: 'text',
									text: `Single-user deployment with no sign-in, misconfigured: ${why}`
								}
							],
							structuredContent: {}
						};
					}
				}
				return {
					content: [{ type: 'text', text: 'No signed-in identity on this connection.' }],
					structuredContent: {}
				};
			}
		);

		// ---------- list_pages + read_page ----------
		// Defined in src/tools/core.ts so the local Node runtime registers the same
		// two tools from the same source rather than a second copy.
		registerCoreTools(server, (opts) => this.tenantContext(opts));
		registerMediaTools(server, (opts) => this.tenantContext(opts));

		// ---------- librarian suite ----------
		// write_page / move_page / delete_page / find_inbound_links / validate /
		// search_pages. write_page creates or updates (including optional OKF lifecycle
		// status, and backs the editor's sha-guarded save); move_page /
		// delete_page also take a folder path to move or delete a whole subtree. All
		// writes are atomic bundles (page + changelog, plus any repointed links, in one
		// commit) and all responses speak in wiki terms, never git terms. See
		// src/tools/librarian.ts.
		// `listBrains` is what lets search_pages fan out over every brain the caller can
		// reach (scope: "all"). It is the SAME dep the brain tools take below, deliberately:
		// the accessible set is one question with one answer, and a second way of computing
		// it would eventually disagree with the switcher about which brains exist.
		registerLibrarianTools(server, (opts) => this.tenantContext(opts), {
			listBrains: () => this.listAccessibleBrainsForCaller()
		});

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
		// Opening a brain in the widget does NOT move the active brain. Every widget-
		// initiated call names its brain explicitly (brainArgs in app/core/store.ts) and
		// the crumb follows the brain the RESULT names (pickShownBrain), so a one-shot
		// `brain:` view is self-contained. The pointer is per-USER, not per-conversation,
		// so moving it from a view would retarget every other open conversation's bare
		// calls as a side effect of looking at something.
		registerBrainApp(server, (opts) => this.tenantContext(opts), {
			webBaseUrl: this.webBase()
		});

		// Whether anyone besides the operator can sign in. Every deployment runs the
		// org model (a static one has one org, one member, one brain: see
		// src/lib/static-tenant.ts), so this is the ONE capability that differs. With
		// nobody else to invite, share with, or count, the people and sharing tools
		// can only refuse, so they are not registered: an advertised tool costs context
		// in every conversation, and a refusal reads to the model as a permissions
		// problem to work around. Same rule as FEEDBACK_REPO. The app learns the same
		// fact from `features.people` on the brains payload, so it never offers a
		// destination whose tool is absent.
		const multiUser = env.AUTH_MODE === 'oauth';

		// ---------- member management ----------
		// The org-admin roster surface: members (the interactive roster + data) plus
		// invite_member / set_member_role / remove_member. Reads are open to any member;
		// mutations require admin+, with owner as the lockout-proof anchor. See
		// src/tools/members.ts.
		if (multiUser) registerMemberTools(server, (opts) => this.tenantContext(opts));

		// ---------- brain sharing (per-brain access) ----------
		// The brain-scope sibling of the member tools: members moves the ORG roster,
		// these move who can reach ONE brain. See src/tools/brain-access.ts. Its result
		// carries `activeBrain`, so the Share control in the brains list opens the panel
		// under the named brain's crumb without moving the pointer (see registerBrainApp).
		if (multiUser)
			registerBrainAccessTools(server, (opts) => this.tenantContext(opts), {
				webBaseUrl: this.webBase()
			});

		// ---------- connected accounts (identity linking) ----------
		// The per-person "Your settings → Connected accounts" surface: connected_accounts
		// (the interactive panel + data) plus link_identity / unlink_identity.
		// Links a person's emails + GitHub logins so any of them reaches
		// the union of their brains; verified via magic-link. See src/tools/connected-accounts.ts.
		if (multiUser)
			registerConnectedAccountTools(server, (opts) => this.tenantContext(opts), this.env);

		// ---------- creating an org ----------
		// create_org makes a hosted org on the spot, or (github: true) returns a GitHub
		// App install URL carrying a KV-stashed state, which /github/install-callback
		// turns into a customer org. See src/tools/org-onboarding.ts and
		// src/lib/org-connect.ts.
		if (multiUser)
			registerOrgOnboardingTools(
				server,
				(opts) => this.orgContext(opts),
				async () =>
					this.props?.user_id
						? listAccessibleOrgs(this.env.PLATFORM_DB, await this.personUserIds(this.props.user_id))
						: [],
				this.env
			);

		// ---------- usage analytics ----------
		// The org's Analytics tab, reading the per-day counters the wrapper at the
		// bottom of this method writes. Registered only when USAGE_ANALYTICS is on,
		// for the same reason submit_feedback is gated on FEEDBACK_REPO: with
		// recording off there is nothing to report, and a tool that can only answer
		// "zero" is worse than a tool that is not there. See src/tools/analytics.ts.
		//
		// Also gated on multiUser: the tab answers "who in the organization is using
		// its brains", which on a single-user deployment has one possible answer.
		if (this.usageEnabled() && multiUser) {
			registerAnalyticsTools(server, (opts) => this.tenantContext(opts));
		}

		// ---------- product feedback ----------
		// submit_feedback files a bug/idea on the project's own PUBLIC tracker via a
		// separate narrowly scoped credential (never the platform App). Registered
		// only when FEEDBACK_REPO is configured.
		//
		// Identity is read straight off the token props and the active brain, NOT via
		// tenantContext, which can throw: a user who cannot resolve a brain is the
		// user most likely to have something to report.
		registerFeedbackTools(
			server,
			() => ({
				userId: this.props?.user_id,
				email: this.props?.email,
				orgId: this.props?.org_id ?? undefined,
				brainId: this.activeBrainId
			}),
			this.env
		);

		// ---------- brain selection (multi-brain) ----------
		// brains (the list, as data) + switch_brain. A bare tool call acts on the active
		// brain; switch_brain changes it (persisted in KV, per user); any tool's `brain`
		// arg one-shots another. See src/tools/brains.ts.
		//
		// `brains` and `configure_brain` are registered on every deployment: the app's
		// nav calls `brains` on every open and learns which destinations exist from the
		// `features` on its payload. The tools that add, move, remove or switch between
		// brains need somewhere else for a brain to be, so they follow multiUser.
		registerBrainTools(server, {
			multiUser,
			getContext: (opts) => this.tenantContext(opts),
			orgContext: (opts) => this.orgContext(opts),
			listOrgs: async () =>
				this.props?.user_id
					? listAccessibleOrgs(this.env.PLATFORM_DB, await this.personUserIds(this.props.user_id))
					: [],
			listBrains: () => this.listAccessibleBrainsForCaller(),
			activeBrainId: () => this.activeBrainId,
			setActiveBrain: (id) => this.setActiveBrain(id),
			invalidateConfig: (owner, repo) => this.invalidateConfig(owner, repo),
			analyticsEnabled: this.usageEnabled(),
			db: this.env.PLATFORM_DB,
			webBaseUrl: this.webBase()
		});

		// ---------- user-defined tools (brain-tools) ----------
		// One MCP tool per tool page under the active brain's tools/ folder, discovered
		// in loadCustomTools() before this method runs. Registered last so a custom tool
		// can never shadow a first-party one (name collisions are rejected at parse time
		// via the tool_ prefix anyway). Read-only: prompt / bound-op / view. See
		// src/tools/custom.ts and src/lib/custom-tools.ts.
		registerCustomTools(server, (opts) => this.tenantContext(opts), this._customTools.defs);

		// ---------- usage counting ----------
		// Every registration, first-party and brain-authored, is wrapped here.
		if (this.usageEnabled()) {
			for (const [name, tool] of Object.entries(registeredTools(server))) {
				this.instrument(name, tool);
			}
		}

		return server;
	}
}

// The stateless MCP api handler. The OAuth provider (and the static-bearer
// fallback) call this with the authenticated token props on `ctx.props`. It
// builds a fresh McpServer per request and answers on the same POST with JSON,
// no SSE and no session id, in either protocol era (`serveMcp`).
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
		// Read the body ONCE and hand the same bytes to the transport in a fresh
		// Request. Two things need it before the SDK does: deciding whether this
		// request needs a brain resolved at all, and knowing the request id so a
		// failure can still be answered.
		const raw = await request.text();
		const peek = peekJsonRpc(raw);
		// Past this, a call is at risk of being cut off upstream before it answers.
		const SLOW_REQUEST_MS = 5_000;
		const forwarded = new Request(request, { body: raw });

		const props = (ctx as ExecutionContext & { props?: McpProps }).props;
		const session = new McpSession(env, props, ctx);
		try {
			// `initialize`, `ping` and notifications are answered from the static tool
			// surface, so they skip the KV read, the tenant resolution, the
			// installation-token mint and the index freshness check that discovering a
			// brain's own `tools/` pages costs. The handshake is the request a user
			// cannot retry past.
			if (needsBrainPreamble(peek)) {
				await session.loadActiveBrain();
				await session.loadCustomTools();
			}
			const server = session.buildServer();
			const started = Date.now();
			// Either protocol era; see src/lib/mcp-serve.ts.
			const { response: res, era, error } = await serveMcp(forwarded, server);
			const ms = Date.now() - started;
			// Refusals and slow calls, which are the two things that reach a user as a
			// bare gateway error from Anthropic's edge: a call the Worker answers in 17s
			// is one the edge gave up on at ~15s, and only this line says which it was.
			// A refusal names the message shape (key names only) and the SDK's reason.
			if (res.status >= 400 || ms > SLOW_REQUEST_MS) {
				console.warn(describeRequest(peek, { status: res.status, ms, era, error }));
			}
			return res;
		} catch (err) {
			// Nothing above this point was inside a tool handler, so the SDK's own
			// error mapping never saw it and `workers-oauth-provider` does not catch
			// either: an uncaught throw leaves no response, which upstream reports as a
			// bare gateway error. Answer with the reason and the ray id instead.
			const ray = request.headers.get('cf-ray');
			const message = err instanceof Error ? err.message : String(err);
			const body = jsonRpcError(
				peek.id,
				`Isomorphic could not serve this request: ${message}`,
				ray
			);
			// A JSON-RPC error object IS a successful transport exchange, so 200 is the
			// honest status when we know which request to attribute it to, and it is
			// the one that reaches the user as our message rather than as the host's
			// generic transport failure. With no id there is no valid reply to make.
			return new Response(body, {
				status: peek.id === null ? 500 : 200,
				headers: { 'content-type': 'application/json' }
			});
		}
	}
};

// The token a `github-token` storage connection names. The row references the
// secret and never holds it (see src/lib/static-tenant.ts), so it is read here.
function requireToken(env: Env): string {
	const token = env.GITHUB_TOKEN?.trim();
	if (!token) {
		throw new Error(
			'This brain is stored through GITHUB_TOKEN, which is not set on this deployment.'
		);
	}
	return token;
}

// ---------- Worker entry ----------

// OAuthProvider wraps the entire request lifecycle:
//   - `/.well-known/oauth-authorization-server` (RFC 8414) and
//     `/.well-known/oauth-protected-resource` (RFC 9728) are auto-served.
//   - `/token` and `/register` are implemented internally.
//   - `/authorize` is delegated to `identityHandler`: the Auth.js sign-in.
//   - Requests under `apiRoute` (`/mcp`) require a valid access token; on
//     success, the request is forwarded to `mcpApiHandler` with `ctx.props`
//     populated from the grant.
//
// Endpoints are paths (not full URLs); the provider derives full URLs from
// `request.url.origin` for metadata responses. Path-only matching also keeps
// internal routing host-agnostic.
// The upstream sign-in behind `/authorize`. Auth.js is the only one. A deployment
// still configured for the removed GitHub sign-in (IDENTITY_MODE=github) is told
// what changed, rather than dropped into an Auth.js flow it has no secrets for.
const identityHandler = {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const mode = env.IDENTITY_MODE?.trim();
		if (mode && mode !== 'authjs') {
			return new Response(
				`IDENTITY_MODE=${mode} is not supported. GitHub sign-in was removed: set IDENTITY_MODE=authjs ` +
					'(email sign-in; see docs/self-hosting.md), or AUTH_MODE=static for a single-user deployment.',
				{ status: 501, headers: { 'content-type': 'text/plain; charset=utf-8' } }
			);
		}
		return authHandler.fetch(request, env);
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
	let pending: { user_id: string; email: string | null; name?: string | null };
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
			accountType: org.accountType,
			name: pending.name
		});
		await env.OAUTH_KV.delete(`pending_org_connect:${state}`);
		return connectedOrgPage(result);
	} catch (err) {
		return cardPage(
			'⚠',
			'Couldn’t finish connecting',
			`<p>The app installed, but we couldn’t link it to your account: ${escapeHtml(
				err instanceof Error ? err.message : String(err)
			)}.</p><p>Try <code>create_org</code> with <code>github: true</code> again from Claude.</p>`
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
		// installer here with ?installation_id=…&setup_action=…. (The manifest
		// registers the local bootstrap server's route for first setup; a deployed
		// App's Setup URL points here.)
		if (url.pathname === '/github/install-callback') {
			// Self-serve create_org (github: true) carries a `state` we stashed in KV,
			// and completes into a customer org + owner membership. Without one (a
			// direct install, or an operator onboarding via `pnpm onboard-org`) the
			// page just confirms and surfaces the installation id.
			const state = url.searchParams.get('state');
			const installationId = Number(url.searchParams.get('installation_id') ?? '');
			if (state && installationId) {
				return handleOrgConnectCallback(url, state, installationId, env);
			}
			return installedPage(url);
		}

		// ---------- the web app ----------
		//
		// Both routes sit AHEAD of the OAuth provider, like /health and the
		// install callback, because the provider owns `/mcp` and would reject a
		// cookie-authenticated call before it ever reached the handler.
		//
		// oauth only: the cookie session is what Auth.js issues, and a static
		// deployment has no sign-in and so no browser session to read.
		if (env.AUTH_MODE === 'oauth') {
			// The shell. Serving the same bundle the MCP App resource serves, with
			// a flag telling it which host it is running in.
			if (
				url.pathname === WEB_ROUTE_PREFIX.slice(0, -1) ||
				url.pathname.startsWith(WEB_ROUTE_PREFIX)
			) {
				const session = await getAuthSession(request, env);
				if (!session?.user?.id) {
					return Response.redirect(
						new URL(signInRedirect(url.pathname, url.search), url.origin).toString(),
						302
					);
				}
				return new Response(webShell(BRAIN_APP_HTML), { headers: { ...WEB_APP_HEADERS } });
			}

			// The web app's tool calls. Same handler, same session, same
			// authorization: only the credential differs, so `props` is built from
			// the Auth.js session exactly as the OAuth path builds it from a token.
			//
			// Claimed only when the request carries a cookie. One with neither a
			// cookie nor a Bearer token is an MCP host making first contact, and it
			// falls through to the provider for the `WWW-Authenticate` challenge it
			// needs (see `claimsWebMcp`).
			if (
				url.pathname === '/mcp' &&
				claimsWebMcp({
					hasAuthorization: request.headers.has('authorization'),
					hasCookie: request.headers.has('cookie')
				})
			) {
				const verdict = checkWebMcpRequest({
					method: request.method,
					selfOrigin: url.origin,
					origin: request.headers.get('origin'),
					fetchSite: request.headers.get('sec-fetch-site'),
					contentType: request.headers.get('content-type'),
					hasAuthorization: false
				});
				if (!verdict.ok) {
					return new Response(verdict.message, { status: verdict.status });
				}
				const session = await getAuthSession(request, env);
				if (!session?.user?.id) {
					// The app turns this into a sign-in redirect. A body is not much
					// use to it, but the status is.
					return new Response('Not signed in', { status: 401 });
				}
				const props: McpProps = { user_id: session.user.id, email: session.user.email };
				// `mcpApiHandler` reads identity off `ctx.props`. Bind rather than
				// spread: an ExecutionContext's methods need their own `this`.
				const webCtx = {
					waitUntil: ctx.waitUntil.bind(ctx),
					passThroughOnException: ctx.passThroughOnException.bind(ctx),
					props
				} as unknown as ExecutionContext;
				return mcpApiHandler.fetch(request, env, webCtx);
			}
		}

		if (env.AUTH_MODE === 'oauth') {
			return oauthProvider.fetch(request, env, ctx);
		}

		// Static bearer: single token, the single-tenant self-hosting path. Refuse
		// with a clear 503 when the token is unset rather than letting
		// `Bearer undefined` through.
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
