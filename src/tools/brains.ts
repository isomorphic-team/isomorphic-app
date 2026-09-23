// Brain selection tools — the multi-brain surface.
//
// One connection can reach several brains (your personal brain, team brains, a
// client brain). `brains` returns the list as data: text the model reasons over, and
// the `structuredContent` the app's nav switcher reads on every open. It opens no
// widget. It carried `_meta.ui` until 2026-09-15, and the model's most common reason
// to call it is "which brains exist?", so nearly every such lookup put a brain list
// in the chat that nobody had asked to see. The interactive list lives inside the app
// (the nav switcher and the Manage brains destination), reached through any view
// tool. `switch_brain` makes one active, so the user can just tell Claude "switch to
// my Acme brain."
//
// Targeting model (see tenantContext in worker.ts): a bare tool call acts on the
// caller's ACTIVE brain; any tool may also take a `brain` arg to one-shot a different
// one. Only switch_brain / create_brain / disconnect_brain move the active brain.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Octokit } from 'octokit';
import type { D1Database } from '@cloudflare/workers-types';
import type { BrainContext } from './librarian.ts';
import {
	type TenantOpts,
	type AccessibleBrain,
	type AccessibleOrg,
	type OrgScope,
	type Role,
	brainLabel,
	brainLabelQualified,
	orgDisplay,
	orgLabel,
	matchBrain,
	roleLabel,
	roleAtLeast,
	createBrain,
	deleteBrain,
	deleteBrainGrants,
	setBrainGrant,
	setBrainName,
	getBrainByRepo,
	getOrgById,
	activeAfterDisconnect
} from '../lib/orgs.ts';
import { createAndScaffoldBrain } from '../lib/scaffold-core.ts';
import {
	ensureOrgConnection,
	getConnection,
	orgAdministersConnection
} from '../lib/storage-connections.ts';
import {
	countPendingBrainInvites,
	describeMove,
	loadMovePeople,
	moveBrain,
	planBrainMove
} from '../lib/brain-move.ts';
import { githubStore } from '../lib/brain-repo.ts';
import {
	resetIndex,
	detectNeedsConfig,
	ensureFresh,
	hasIndexedPages,
	listIndexedPages
} from '../lib/brain-index.ts';
import { CONFIG_PATH, DEFAULT_BRAIN_CONFIG } from '../lib/brain-config.ts';
import { fail } from './shared.ts';
import type { BrainsWire } from '../lib/tool-payloads.ts';

// The GitHub client, for the three operations in this file that are GitHub as a
// platform rather than a brain as storage: create a repository, list the repos an
// installation can reach, check a repo exists before connecting it. None touches a
// brain's content, so none belongs on BrainStore.
//
// Every caller is an org-model tool, and a deployment with no GitHub client has no org
// model and does not register them (`hasOrgModel` in worker.ts).
function githubClient(ctx: { octokit?: Octokit }): Octokit {
	if (!ctx.octokit) {
		throw new Error('This action needs a GitHub-backed deployment (no GitHub client configured).');
	}
	return ctx.octokit;
}

// One row per brain for the UI / text: stable id, human label (disambiguated when an
// org has several brains), the caller's role in it, and whether it's active.
interface BrainRow {
	id: string;
	label: string;
	role: string;
	active: boolean;
	canManage: boolean; // caller is admin+ in this brain's ORG (can disconnect it)
	canShare: boolean; // caller is admin+ ON THIS BRAIN (can change who reaches it)
	visibility: string; // 'org' | 'private': drives the shared/private badge
	orgId: string; // so the UI can group brains by org and target adds per-org
	orgLabel: string;
	// Readable, never writable, by anyone including the admins of the org holding it.
	readOnly?: boolean;
	needsConfig?: boolean; // adopted repo with no content under its roots — offer "Set up"
	configPrUrl?: string; // a "configure" PR is open (protected repo) — show pending
}
// A friendly org name — platform (personal) orgs are email-named, so show "Personal".
function brainRows(brains: AccessibleBrain[], activeId: string | undefined): BrainRow[] {
	return brains.map((b) => ({
		id: b.id,
		label: brainLabel(b),
		role: roleLabel(b.role),
		active: b.id === activeId,
		// Two different powers, two different scopes: disconnecting a brain removes
		// it from the ORG (org admin), sharing it changes who reaches its content
		// (brain admin). Someone can hold either without the other.
		canManage: !!b.org_role && roleAtLeast(b.org_role, 'admin'),
		canShare: roleAtLeast(b.role, 'admin'),
		visibility: b.visibility,
		orgId: b.org_id,
		orgLabel: orgDisplay(b),
		...(b.read_only ? { readOnly: true } : {})
	}));
}

// Slug a brain_id (PK) from owner/repo — unique across orgs adopting same-named repos.
function brainIdFor(owner: string, repo: string): string {
	return `brain-${`${owner}-${repo}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')}`;
}

function rowsText(rows: BrainRow[]): string {
	if (rows.length === 0) return 'No brains available.';
	return `Your brains (${rows.length}):\n${rows
		.map((r) => `- ${r.label} — ${r.role}${r.active ? ' (active)' : ''}`)
		.join('\n')}`;
}

// Whether one brain is "connected but not configured" — empty of content and adopted
// with no .isomorphic.json. Best-effort (never throws).
//
// A CONFIGURED BRAIN MUST COST NOTHING HERE. This runs for every brain the caller
// manages, on every `brains` call, and the widget makes that call on every open.
// The first version resolved each brain's context (an installation-token mint and a
// config read, both GitHub) and then ran `ensureFresh` (a `getHead` per brain, plus
// an inline reindex for any brain whose branch had moved) BEFORE asking the index
// whether the brain had pages — so the "cheap for configured brains" it promised
// never happened. On an account with several brains that was a 17-second call;
// Anthropic's edge gives up at about 15 and reports a bare 502 (issues #50, #85),
// the widget's `ensureBrainList` swallows the failure, and everything that rides on
// the payload (the brain list, `features`, the Open-in-browser control) is missing
// for that open. Now: one indexed row answers it, with no context, no token and no
// network. Only a brain with an EMPTY index pays for freshness and the tree scan,
// because that is the one case where "no pages" might mean "not indexed yet".
async function detectRowSetup(
	db: D1Database,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	brainId: string
): Promise<{ needsConfig: boolean; configPrUrl?: string }> {
	try {
		if (await hasIndexedPages(db, brainId)) return { needsConfig: false };
		const c = await getContext({ requires: 'admin', brain: brainId });
		await ensureFresh(c.db, c.store, c.repoArgs, c.brainId, c.config);
		const pages = await listIndexedPages(c.db, c.brainId);
		if (pages.length > 0) return { needsConfig: false };
		if (!(await detectNeedsConfig(c.store, c.repoArgs, c.config))) return { needsConfig: false };
		// Misconfigured — is a "configure" PR already open (protected repo)?
		const configPrUrl = await c.store.findOpenConfigPr(c.repoArgs);
		return { needsConfig: true, configPrUrl };
	} catch {
		return { needsConfig: false };
	}
}

export function registerBrainTools(
	server: McpServer,
	deps: {
		getContext: (opts?: TenantOpts) => Promise<BrainContext>;
		orgContext: (opts?: { requires?: Role; org?: string }) => Promise<OrgScope>;
		// Every org the caller belongs to, brainless ones included. Separate from
		// listBrains because that cannot represent an org with nothing in it yet.
		listOrgs: () => Promise<AccessibleOrg[]>;
		listBrains: () => Promise<AccessibleBrain[]>;
		activeBrainId: () => string | undefined;
		// Awaited: the pointer is read back by the caller's NEXT request (the app fetches
		// its brain list the moment a widget opens), so a write still in flight answers
		// with the previous brain. See setActiveBrain in worker.ts.
		setActiveBrain: (id: string) => Promise<void>;
		invalidateConfig: (owner: string, repo: string) => void;
		// Whether this deployment registered the org `analytics` tool (USAGE_ANALYTICS).
		// Rides on this payload because the app fetches the brain list on every open
		// (ensureBrainList) and has no other way to ask what the server registered: a
		// widget cannot list tools. The nav gates its Analytics row on this, so a
		// deployment with usage recording off never shows a destination whose click
		// would come back "unknown tool".
		analyticsEnabled: boolean;
		// The platform database, for the one read `brains` makes per brain without
		// resolving that brain's context: whether its index holds any page.
		db: D1Database;
		// The origin the WEB APP is served from (`webBaseUrl` in src/lib/web-app.ts),
		// or undefined when this deployment has none. Same vehicle and same reason as
		// `analyticsEnabled`: the widget cannot ask the server what it serves, and a
		// control that offers a link into a route that is not mounted is worse than
		// no control. The widget builds the page's own URL from this with
		// `webPathFor`, so the grammar stays in one place.
		webBaseUrl?: string;
	}
) {
	const {
		getContext,
		orgContext,
		listBrains,
		listOrgs,
		activeBrainId,
		setActiveBrain,
		invalidateConfig,
		analyticsEnabled,
		db,
		webBaseUrl
	} = deps;
	const features = { analytics: analyticsEnabled, ...(webBaseUrl ? { webBase: webBaseUrl } : {}) };

	// The orgs the app's "add a brain" flow may target: the ones the caller can
	// actually adopt into (connect_brain is admin+). Sent with the brains list because
	// the widget cannot derive it. A brainless org has no brain row to derive it from,
	// and that is the only org where the answer matters.
	const manageableOrgs = async () =>
		(await listOrgs())
			.filter((o) => roleAtLeast(o.role, 'admin'))
			.map((o) => ({ orgId: o.org.org_id, orgLabel: orgLabel(o.org) }));

	// GitHub returns 422 when a repo with that name already exists on the org — used to
	// pick the next free `name-N` slug when creating a brain.
	const isAlreadyExists = (err: unknown): boolean =>
		typeof err === 'object' && err !== null && (err as { status?: number }).status === 422;
	// Slug a display name into a repo-safe base (lowercase, dashed).
	const slugName = (s: string): string =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');

	// ---------- switch_brain (action) ----------
	server.registerTool(
		'switch_brain',
		{
			title: 'Switch the active brain',
			description:
				"Make a brain the active one, so subsequent tool calls act on it by default. Accepts a name/handle (fuzzy-matched against your brains, e.g. 'acme', 'team wiki', or an owner/repo id). Use when the user wants to work in a different brain for a while; for a one-off, pass `brain` to a single tool instead.",
			inputSchema: z.object({
				brain: z.string().describe('Which brain to activate — a name/label or owner/repo id.')
			})
		},
		async ({ brain }) => {
			await getContext(); // ensure the caller is resolved/authorized
			const brains = await listBrains();
			if (brains.length === 0) return fail('You have no brains to switch between.');
			const m = matchBrain(brains, brain);
			if (!m.brain) {
				const names = (m.candidates ?? brains).map(brainLabelQualified);
				return fail(
					m.candidates
						? `"${brain}" matches multiple brains: ${names.join(', ')}. Be more specific.`
						: `No brain matching "${brain}". You have access to: ${names.join(', ')}.`
				);
			}
			await setActiveBrain(m.brain.id);
			const rows = brainRows(brains, m.brain.id);
			const label = rows.find((r) => r.id === m.brain!.id)?.label ?? m.brain.id;
			return {
				content: [
					{ type: 'text' as const, text: `Switched to ${label}. Tools now act on it by default.` }
				],
				structuredContent: {
					view: 'brains',
					brains: rows,
					active: m.brain.id,
					switched: true,
					features
				} satisfies BrainsWire
			};
		}
	);

	// ---------- brains (the list, as data) ----------
	// Text for the model and structuredContent for the app's switcher, which calls it
	// on every open. Also resolves the org first so a freshly-invited user's brain
	// shows on first open.
	//
	// Deliberately NOT a widget tool (no `_meta.ui`): see the header. The app still
	// calls it from inside the widget, where a plain tool result is exactly what the
	// switcher needs.
	server.registerTool(
		'brains',
		{
			title: 'Your brains',
			description:
				"The knowledge bases (brains) this user can access — personal, team, and client — with the user's role in each and the active one marked. Returns the list as text; opens nothing in the chat. Use to answer 'what brains do I have?' or when YOU need the list before targeting one. Most tools act on the active brain; pass `brain` to any tool to target another, or switch_brain to change the active one. To let the user pick visually, open a brain with browse_brain: the app's nav has the switcher.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true }
		},
		async () => {
			// Org-scope: works with zero brains (renders the empty "create your first
			// brain" state in the app), so it never resolves a BRAIN — but it resolves the
			// ORG first so a freshly-invited user's invite is consumed and their brain
			// shows on the first open. Errors are swallowed for single-tenant /
			// non-product connections.
			try {
				await orgContext();
			} catch {
				/* single-tenant path, suspended, or not-yet-provisionable — just list. */
			}
			const brains = await listBrains();
			const active = activeBrainId();
			const rows = brainRows(brains, active);
			// Flag misconfigured brains so the list can offer "Set up" without the user
			// switching into each one. Only the ones they manage (others can't configure).
			await Promise.all(
				rows.map(async (r) => {
					if (!r.canManage) return;
					const s = await detectRowSetup(db, getContext, r.id);
					r.needsConfig = s.needsConfig;
					r.configPrUrl = s.configPrUrl;
				})
			);
			return {
				content: [{ type: 'text' as const, text: rowsText(rows) }],
				structuredContent: {
					view: 'brains',
					brains: rows,
					active,
					features,
					// A failed lookup is left OUT, not sent as []. An empty list is a real
					// answer ("nowhere to add a brain") and suppresses the app's fallback,
					// which derives the orgs from the brains it can manage.
					orgs: await manageableOrgs().catch(() => undefined)
				} satisfies BrainsWire
			};
		}
	);

	// ---------- create_brain (editor+) ----------
	// Stand up a NEW, empty brain (scaffolds a fresh repo) — distinct from connect_brain,
	// which adopts an EXISTING repo. Org-scope: works even when the caller has no brain
	// yet (the "create your first brain" path). Any editor+ in the org can create one.
	server.registerTool(
		'create_brain',
		{
			title: 'Create a new brain',
			description:
				'Create a NEW, empty knowledge base ("brain") with a name the user chooses, and switch to it. Use whenever the user wants to START a new brain / knowledge base / wiki, including their very first one. This SCAFFOLDS a fresh repo; it is different from connect_brain (which adopts an existing GitHub repo). Any editor can create a brain. The new brain is PRIVATE to its creator: use share_brain afterwards to give teammates access, or to make it visible to the whole organization.',
			inputSchema: z.object({
				name: z
					.string()
					.describe('A name for the new brain, e.g. "Personal", "Project Atlas", "Team Wiki".'),
				// Without this the org was whatever resolution happened to pick first, and a
				// person in two orgs had no way to say which, including no way to put a brain
				// in an org that holds none yet, since every other handle is a brain.
				org: z
					.string()
					.optional()
					.describe(
						'Which organization to create it in, by name or GitHub owner. Defaults to the organization of the brain you are in.'
					)
			})
		},
		async ({ name, org }) => {
			// Org-scope + role gate. Rejects the legacy github/static single-tenant paths
			// ("product accounts only") and callers below `editor`.
			let ctx: OrgScope;
			try {
				ctx = await orgContext({ requires: 'editor', org });
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
			const display = name.trim();
			if (!display) return fail('Please give the brain a name.');

			const owner = ctx.org.brain_owner;
			const base = slugName(display) || 'brain';
			// Scaffold a fresh repo; on a name collision (repo already exists, brain or not)
			// try the next `base-N` slug. repo_name is the immutable slug; `display` is the name.
			let repo = base;
			let created: Awaited<ReturnType<typeof createAndScaffoldBrain>>;
			for (let attempt = 1; ; attempt++) {
				try {
					created = await createAndScaffoldBrain(githubClient(ctx), {
						org: owner,
						name: repo,
						description: `${display} — Isomorphic brain`
					});
					break;
				} catch (err) {
					if (isAlreadyExists(err) && attempt < 25) {
						repo = `${base}-${attempt + 1}`;
						continue;
					}
					return fail(
						`Couldn't create the brain repo under ${owner}: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// PRIVATE BY DEFAULT. A brain you just made is yours until you share it,
			// in a shared org, defaulting to org-visible published everyone's drafts to
			// the whole team the moment they were created. The creator gets an explicit
			// admin grant in the same breath, because in a personal org they are the
			// only member and would otherwise be relying on the org-admin floor alone;
			// the explicit row is also what makes them show on the brain's Share list.
			const newBrainId = brainIdFor(created.owner, created.name);
			await createBrain(ctx.db, {
				brain_id: newBrainId,
				org_id: ctx.org.org_id,
				repo_owner: created.owner,
				repo_name: created.name,
				name: display,
				created_by: ctx.actorUserId,
				visibility: 'private',
				storage_connection_id: await ensureOrgConnection(ctx.db, ctx.org)
			});
			if (ctx.actorUserId) {
				await setBrainGrant(ctx.db, {
					brain_id: newBrainId,
					user_id: ctx.actorUserId,
					role: 'admin',
					granted_by: ctx.actorUserId
				});
			}

			const id = `${created.owner}/${created.name}`;
			await setActiveBrain(id); // land the caller in the new brain
			const rows = brainRows(await listBrains(), id);
			return {
				content: [
					{
						type: 'text' as const,
						text: `Created "${display}" and switched to it. It's private to you: share it with share_brain, or make it visible to your whole organization.`
					}
				],
				structuredContent: {
					view: 'brains',
					brains: rows,
					active: id,
					switched: true,
					createdId: id
				} satisfies BrainsWire
			};
		}
	);

	// ---------- connect_brain (org admin) ----------
	// Put a brain in an organization. Three shapes, one question ("which brain goes in
	// which org"), one gate family (org admin):
	//   - no `repo`: list the repos the org's installation can reach that are not
	//     brains yet, the picker the app shows before adopting;
	//   - a repo that is not a brain yet: ADOPT it;
	//   - a brain the caller can see in ANOTHER org: MOVE it there. A move touches no
	//     storage (the brain keeps its binding, docs/design/storage-and-tenancy.md),
	//     so it previews until `confirm: true`.
	// The description says "move" in its own words, so a model hunting for a way to
	// move a brain finds this tool.
	server.registerTool(
		'connect_brain',
		{
			title: 'Connect a brain to an organization: adopt a repo, or move a brain',
			description:
				"Put a brain in an organization you admin. Two uses. ADOPT: pass a GitHub repository that is not a brain yet (it must be under the org's GitHub owner and covered by the org's Isomorphic App installation); call with no `repo` to list the repos that can become brains. MOVE: pass an existing brain (by name or owner/repo) and the `org` to move it to; this changes which organization owns the brain, and so who reaches it through org membership, but never where it is stored, and grants, links and history come with it. A move is two calls: without `confirm: true` it changes nothing and returns a preview naming everyone whose access changes. Adding needs organization admin in the destination; moving also needs it in the brain's current organization. An adopted brain is PRIVATE to whoever connected it, exactly like create_brain: use share_brain afterwards to give teammates access. To rename a brain, use configure_brain.",
			inputSchema: z.object({
				repo: z
					.string()
					.optional()
					.describe(
						'The repo to adopt ("owner/name", or just "name" under the org’s GitHub owner), or an existing brain to move (its name or owner/repo). Omit to list the repos that can become brains.'
					),
				name: z
					.string()
					.optional()
					.describe(
						'What to call the brain in the switcher, e.g. "Editorial". Defaults to the repo name for an adopted repo; a moved brain keeps its name unless this is given.'
					),
				// Replaces the old `brain` argument, which named the target org by naming a
				// brain already in it. That could never reach an org holding no brains, which
				// is exactly the org waiting for its first repo: the chicken-and-egg that
				// made a freshly connected GitHub org impossible to adopt anything into.
				org: z
					.string()
					.optional()
					.describe(
						'Which organization to put it in, by name or GitHub owner. Defaults to the organization of the brain you are in.'
					),
				confirm: z
					.boolean()
					.optional()
					.describe(
						'Required to actually MOVE an existing brain. Without it a move only returns the preview, and nothing is written. Not needed to adopt a repo.'
					)
			})
		},
		async ({ repo, org, name: displayName, confirm }) => {
			// ORG-scope: putting a brain in an organization gates on the org role and
			// resolves through orgContext. Gating on the brain role would let someone
			// merely shared a brain as admin add to, or take from, the whole org.
			let ctx: OrgScope;
			try {
				ctx = await orgContext({ requires: 'admin', org });
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}

			// An existing brain the caller can see, named EXACTLY (id, repo name, or its
			// name). Exact rather than matchBrain's substring fallback: a substring hit
			// would turn "adopt the repo called wiki" into "move client-wiki".
			if (repo !== undefined) {
				const q = repo.trim().toLowerCase();
				const hits = (await listBrains()).filter(
					(b) =>
						b.id.toLowerCase() === q ||
						b.repo_name.toLowerCase() === q ||
						brainLabel(b).toLowerCase() === q
				);
				if (hits.length > 1) {
					return fail(
						`"${repo}" names several brains: ${hits.map(brainLabelQualified).join(', ')}. Pass its owner/repo id.`
					);
				}
				if (hits.length === 1) {
					const target = hits[0];
					if (target.org_id === ctx.org.org_id) {
						return fail(
							`${brainLabel(target)} is already a brain in ${orgLabel(ctx.org)}. To rename it, use configure_brain.`
						);
					}
					return await moveInto(ctx, target, { confirm: !!confirm, name: displayName });
				}
			}

			// Everything below ADOPTS, which lists or reads repositories through the
			// org's connection: only the org that administers it may. A personal or
			// hosted org's connection is the platform's shared account, where every
			// other org's brains live, so adopting through it would let any admin claim
			// a repository some other org's brain left behind. (Moving a brain INTO a
			// hosted org, above, reads nothing through its connection.)
			if (!(await orgAdministersConnection(ctx.db, ctx.org))) {
				return fail(
					`${orgLabel(ctx.org)} stores its brains on Isomorphic's hosted storage, which has no repositories of its own to adopt. Use create_brain to start a new brain here, move an existing brain in by naming it, or use create_org with github: true to connect your own GitHub organization.`
				);
			}
			const orgId = ctx.org.org_id;

			// No repo → list the connectable candidates (repos the org's installation can
			// reach that aren't brains yet). This is the picker for the connect flow.
			if (repo === undefined) {
				const brains = await listBrains();
				const taken = new Set(brains.map((b) => b.id.toLowerCase()));
				const res = await githubClient(ctx).rest.apps.listReposAccessibleToInstallation({
					per_page: 100
				});
				const repos = (res.data.repositories ?? [])
					.map((r) => ({ owner: r.owner.login, repo: r.name, id: `${r.owner.login}/${r.name}` }))
					.filter((r) => !taken.has(r.id.toLowerCase()));
				const text = repos.length
					? `Connectable repos:\n${repos.map((r) => `- ${r.id}`).join('\n')}`
					: 'No unconnected repos in this org’s installation.';
				return { content: [{ type: 'text' as const, text }], structuredContent: { repos } };
			}

			const parts = repo.includes('/') ? repo.split('/') : [ctx.org.brain_owner, repo];
			const owner = parts[0].trim();
			const name = (parts[1] ?? '').trim();
			if (!owner || !name) return fail(`"${repo}" is not a valid repository.`);

			// The org's installation must actually reach the repo, or we'd write a dead row.
			try {
				await githubClient(ctx).rest.repos.get({ owner, repo: name });
			} catch (e) {
				const status = (e as { status?: number })?.status;
				if (status === 404 || status === 403) {
					return fail(
						`The organization's Isomorphic App installation can't access ${owner}/${name}. Add the repo to the installation on GitHub (org Settings → GitHub Apps → Isomorphic → Configure), then try again.`
					);
				}
				throw e;
			}

			// A brain the caller cannot see. Moving it would need admin in the org that
			// holds it, which they evidently are not, so this stays a refusal.
			const existing = await getBrainByRepo(ctx.db, owner, name);
			if (existing) {
				return fail(
					existing.org_id === orgId
						? `${owner}/${name} is already a brain here.`
						: `${owner}/${name} is already connected to another organization.`
				);
			}

			// PRIVATE BY DEFAULT, the same as create_brain (issue #93). This used to
			// default to org-wide on the reasoning that adopting is an admin act on a
			// repo the org already owns. In practice the two tools produce the same
			// object with opposite defaults, and the adopted repo tends to be the
			// substantive one: a private GitHub repo came back readable by every org
			// member, with nothing in the response saying so. Widening on request costs
			// a share_brain call; widening silently is a disclosure. The adopter gets
			// the same explicit admin grant the creator does, so they show on the
			// brain's Share list rather than relying on the org-admin floor alone.
			const newBrainId = brainIdFor(owner, name);
			await createBrain(ctx.db, {
				brain_id: newBrainId,
				org_id: orgId,
				repo_owner: owner,
				repo_name: name,
				name: displayName?.trim() || null,
				created_by: ctx.actorUserId,
				visibility: 'private',
				storage_connection_id: await ensureOrgConnection(ctx.db, ctx.org)
			});
			if (ctx.actorUserId) {
				await setBrainGrant(ctx.db, {
					brain_id: newBrainId,
					user_id: ctx.actorUserId,
					role: 'admin',
					granted_by: ctx.actorUserId
				});
			}

			// Guard: an adopted repo whose content isn't under the default layout would
			// connect but show no pages. Detect it now so the app can offer to configure.
			// The store is built from the org's installation client rather than taken off
			// the context: org scope resolves no brain, so it carries no store of its own.
			const connectedId = `${owner}/${name}`;
			const needsConfig = await detectNeedsConfig(
				githubStore(githubClient(ctx)),
				{ owner, repo: name },
				DEFAULT_BRAIN_CONFIG
			).catch(() => false);

			const rows = brainRows(await listBrains(), activeBrainId());
			// Visibility is said in the sentence, not left as one field in the brains
			// array: that field is the one a reader skims past, and the consequence of
			// missing it is who can read the repo.
			const visibilityNote =
				'It is private to you: share it with share_brain, or make it visible to your whole organization.';
			const text = needsConfig
				? `Connected ${connectedId}, but its content isn't under the default layout, so no pages show yet. Open it and choose Auto-configure (or run configure_brain) to index it. ${visibilityNote}`
				: `Connected ${connectedId} as a brain. ${visibilityNote}`;
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: {
					view: 'brains',
					brains: rows,
					active: activeBrainId(),
					connectedId,
					needsConfig
				} satisfies BrainsWire
			};
		}
	);

	// connect_brain's MOVE: an existing brain into `dest`, which the caller already
	// holds admin in (orgContext checked it). Taking a brain out of its current org is
	// that org's admin's call, like disconnect_brain, so it needs admin there too.
	// Admin in the destination also means the caller keeps access afterwards, through
	// the org-admin floor.
	async function moveInto(
		dest: OrgScope,
		target: AccessibleBrain,
		opts: { confirm: boolean; name?: string }
	) {
		const label = brainLabel(target);
		if (!target.org_role || !roleAtLeast(target.org_role, 'admin')) {
			return fail(`You need organization admin access to move ${label} out of its organization.`);
		}
		const newName = opts.name?.trim() || undefined;
		const source = await getOrgById(dest.db, target.org_id);
		if (!source) return fail('The brain’s current organization could not be found.');
		const from = orgLabel(source);
		const to = orgLabel(dest.org);

		// The connection the brain is read through today: its binding, or for a brain
		// written before bindings existed, its org's. That one keeps reading it.
		const sourceConnectionId =
			target.storage_connection_id ?? (await ensureOrgConnection(dest.db, source));
		const conn = await getConnection(dest.db, sourceConnectionId);
		const storageAccount =
			conn && conn.owner_org_id === null
				? 'Isomorphic hosted storage'
				: `${target.storage_account} on GitHub`;

		if (!opts.confirm) {
			const changes = planBrainMove({
				visibility: target.visibility,
				readOnly: !!target.read_only,
				people: await loadMovePeople(dest.db, {
					brainId: target.brain_id,
					fromOrgId: target.org_id,
					toOrgId: dest.org.org_id
				})
			});
			const text = describeMove({
				brain: newName ?? label,
				from,
				to,
				storageAccount,
				changes,
				pendingInvites: await countPendingBrainInvites(dest.db, target.brain_id)
			});
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: { moved: false, from, to, changes }
			};
		}

		await moveBrain(dest.db, {
			brainId: target.brain_id,
			toOrgId: dest.org.org_id,
			sourceConnectionId
		});
		if (newName) await setBrainName(dest.db, target.brain_id, newName);
		const rows = brainRows(await listBrains(), activeBrainId());
		return {
			content: [
				{
					type: 'text' as const,
					text: `Moved ${newName ?? label} from ${from} to ${to}. It is still stored in ${storageAccount}.`
				}
			],
			structuredContent: {
				view: 'brains',
				brains: rows,
				active: activeBrainId(),
				moved: true,
				from,
				to
			} satisfies BrainsWire
		};
	}

	// ---------- configure_brain (brain admin) ----------
	// A brain's own settings: its NAME, and the .isomorphic.json that says where its
	// content lives. Both are brain-scope and gated at brain admin, which is why rename
	// lives here rather than beside the org-scope move in connect_brain. A call with
	// only `name` renames and never touches the repository.
	//
	// The config half is the fix for the "connected but no pages" case: defaults to
	// contentRoots ["."] (whole repo), which also means new folders are picked up
	// automatically as the repo grows.
	server.registerTool(
		'configure_brain',
		{
			title: 'Configure a brain: rename it, or set its content layout',
			description:
				"A brain's own settings. RENAME: pass `name` alone to change what the brain is called; nothing in its repository changes. CONTENT LAYOUT: set up an adopted repo so its pages appear, by writing a .isomorphic.json describing where its content lives; use when a connected brain shows no pages because its markdown isn't under the default 'wiki/' layout. Defaults to indexing the whole repo. If the repo already has a .isomorphic.json, this refuses and shows the current one; pass `overwrite: true` to replace it deliberately. Needs admin on the brain. To move a brain to another organization, use connect_brain.",
			inputSchema: z.object({
				brain: z
					.string()
					.optional()
					.describe('Which brain to configure. Defaults to the active brain.'),
				name: z
					.string()
					.optional()
					.describe('A new display name for the brain, e.g. "Wholesale Desk".'),
				content_roots: z
					.array(z.string())
					.optional()
					.describe('Folders that hold content, e.g. ["docs/"]. Default ["."] = the whole repo.'),
				overwrite: z
					.boolean()
					.optional()
					.describe(
						'Replace an existing .isomorphic.json. Without this, a repo that already has one is left alone and its current config is shown.'
					)
			})
		},
		async ({ brain, name, content_roots, overwrite }) => {
			const ctx = await getContext({ requires: 'admin', brain });

			let renamed = '';
			if (name !== undefined) {
				const newName = name.trim();
				if (!newName) return fail('A brain’s name cannot be empty.');
				const target = (await listBrains()).find((b) => b.id === ctx.brainId);
				if (!target) return fail('That brain could not be resolved.');
				await setBrainName(ctx.db, target.brain_id, newName);
				renamed = `Renamed ${brainLabel(target)} to "${newName}".`;
				// A rename alone is the whole call: the layout is only written when asked for.
				if (content_roots === undefined && overwrite === undefined) {
					const rows = brainRows(await listBrains(), activeBrainId());
					return {
						content: [{ type: 'text' as const, text: renamed }],
						structuredContent: {
							view: 'brains',
							brains: rows,
							active: activeBrainId()
						} satisfies BrainsWire
					};
				}
			}

			// A config that exists is a decision somebody made (issue #94). Overwriting
			// it with a whole-repo default was one call away, and that call is the one
			// the "needs setup" flag recommends, so a wrong flag turned into a broader
			// index that pulled raw source files into the content set. Show what is
			// there and require the replacement to be asked for by name.
			const current = await ctx.store.readFile(ctx.repoArgs, CONFIG_PATH);
			if (current && !overwrite) {
				return fail(
					`${renamed ? `${renamed} ` : ''}This brain already has a ${CONFIG_PATH}, so nothing was written. Its current contents:\n\n${current.content.trim()}\n\nPass overwrite: true to replace it.`
				);
			}

			// Don't open a second PR if a configure PR is already pending (protected repo).
			const pending = await ctx.store.findOpenConfigPr(ctx.repoArgs);
			if (pending) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `Setup is already proposed for this brain — review and merge it: ${pending}`
						}
					],
					structuredContent: { prUrl: pending }
				};
			}

			const roots = content_roots?.length ? content_roots : ['.'];
			const body =
				JSON.stringify({ paths: Object.fromEntries(roots.map((r) => [r, 'content'])) }, null, 2) +
				'\n';
			const head = await ctx.store.getHead(ctx.repoArgs, ctx.config.defaultBranch);
			const outcome = await ctx.store.commitOrPR(ctx.repoArgs, {
				writeMode: ctx.config.writeMode,
				defaultBranch: ctx.config.defaultBranch,
				author: ctx.author,
				autoMerge: ctx.config.autoMerge,
				mergeMethod: ctx.config.mergeMethod,
				message: 'Configure Isomorphic brain (.isomorphic.json)',
				writes: [{ path: CONFIG_PATH, content: body }],
				head,
				branchPrefix: 'isomorphic/configure',
				prTitle: 'Configure Isomorphic brain',
				prBody: 'Adds .isomorphic.json so Isomorphic indexes this repo’s content.'
			});

			// If the change didn't land on the default branch yet (PR mode), the config
			// isn't live — don't disturb the cache/index; it takes effect on merge.
			if (outcome.prUrl && !outcome.merged) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `This brain’s default branch is protected, so setup is proposed as a PR — review and merge it and the pages appear automatically: ${outcome.prUrl}`
						}
					],
					structuredContent: { prUrl: outcome.prUrl }
				};
			}

			// Live now → drop the cached (default) config and rebuild the index against the
			// new roots (a config change needs a FULL rebuild — content blobs are unchanged,
			// so an incremental reindex wouldn't pick up the newly in-scope pages).
			invalidateConfig(ctx.repoArgs.owner, ctx.repoArgs.repo);
			await resetIndex(ctx.db, ctx.brainId);
			return {
				content: [
					{
						type: 'text' as const,
						text: `${renamed ? `${renamed} ` : ''}Configured — now indexing ${roots.join(', ')}. The brain’s pages will appear.`
					}
				],
				structuredContent: { configured: true }
			};
		}
	);

	// ---------- disconnect_brain (admin+) ----------
	server.registerTool(
		'disconnect_brain',
		{
			title: 'Disconnect a brain',
			description:
				'Remove a brain from its organization — it stops appearing in the switcher. The GitHub repo and its content are untouched. Admin only; you can’t remove an org’s only brain.',
			inputSchema: z.object({
				brain: z.string().describe('Which brain to disconnect (name/handle or owner/repo id).')
			})
		},
		async ({ brain }) => {
			const ctx = await getContext();
			const all = await listBrains();
			const m = matchBrain(all, brain);
			if (!m.brain) {
				const names = (m.candidates ?? all).map(brainLabelQualified);
				return fail(
					m.candidates
						? `"${brain}" matches multiple brains: ${names.join(', ')}. Be more specific.`
						: `No brain matching "${brain}".`
				);
			}
			const target = m.brain;
			// ORG-scope, like connect_brain: removing a brain from the org is an org
			// admin's call, not something brain-admin-by-share confers.
			if (!target.org_role || !roleAtLeast(target.org_role, 'admin')) {
				return fail(`You need organization admin access to disconnect ${brainLabel(target)}.`);
			}
			if (all.filter((b) => b.org_id === target.org_id).length <= 1) {
				return fail(`Can’t disconnect the organization’s only brain.`);
			}
			// Drop the access grants with the brain, or they outlive it and silently
			// re-attach if the same repo is adopted again later under the same id.
			await deleteBrainGrants(ctx.db, target.brain_id);
			await deleteBrain(ctx.db, target.brain_id);
			// If we removed the active brain, fall the active pointer back to a survivor,
			// and report THAT as active. Reporting ctx.activeBrain here named the brain
			// just deleted, so the refreshed list marked no row active.
			const active = activeAfterDisconnect(
				ctx.activeBrain.id,
				target.id,
				all.map((b) => b.id)
			);
			if (active !== ctx.activeBrain.id && active) await setActiveBrain(active);
			const rows = brainRows(await listBrains(), active);
			return {
				content: [{ type: 'text' as const, text: `Disconnected ${brainLabel(target)}.` }],
				structuredContent: { view: 'brains', brains: rows, active } satisfies BrainsWire
			};
		}
	);
}
