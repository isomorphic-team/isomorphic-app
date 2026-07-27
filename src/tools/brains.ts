// Brain selection tools — the multi-brain surface.
//
// One connection can reach several brains (your personal brain, team brains, a
// client brain). `brains` both opens the interactive switcher in the Isomorphic app
// (which also drives the nav's brain switcher) AND returns the list as text, so the
// user can see them and the model can reason over "what can I reach?". `switch_brain`
// makes one active, so the user can just tell Claude "switch to my Acme brain."
//
// Targeting model (see tenantContext in worker.ts): a bare tool call acts on the
// connection's ACTIVE brain; any tool may also take a `brain` arg to one-shot a
// different one. `switch_brain` changes the active brain (persisted in agent state).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import { BRAIN_APP_URI } from './apps.ts';
import {
	type TenantOpts,
	type AccessibleBrain,
	type OrgScope,
	type Role,
	brainLabel,
	countByOrg,
	matchBrain,
	roleLabel,
	roleAtLeast,
	createBrain,
	deleteBrain,
	getBrainByRepo
} from '../lib/orgs.ts';
import { createAndScaffoldBrain } from '../lib/scaffold-core.ts';
import {
	resetIndex,
	detectNeedsConfig,
	ensureFresh,
	listIndexedPages
} from '../lib/brain-index.ts';
import { CONFIG_PATH, DEFAULT_BRAIN_CONFIG } from '../lib/brain-config.ts';
import { getHead, commitOrPR, findOpenConfigPr } from '../lib/brain-repo.ts';

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

// One row per brain for the UI / text: stable id, human label (disambiguated when an
// org has several brains), the caller's role in it, and whether it's active.
interface BrainRow {
	id: string;
	label: string;
	role: string;
	active: boolean;
	canManage: boolean; // caller is admin+ in this brain's org (can disconnect it)
	orgId: string; // so the UI can group brains by org and target adds per-org
	orgLabel: string;
	needsConfig?: boolean; // adopted repo with no content under its roots — offer "Set up"
	configPrUrl?: string; // a "configure" PR is open (protected repo) — show pending
}
// A friendly org name — platform (personal) orgs are email-named, so show "Personal".
function orgDisplay(b: AccessibleBrain): string {
	if (b.org_model === 'platform') return 'Personal';
	return b.org_name?.trim() || b.repo_owner;
}
function brainRows(brains: AccessibleBrain[], activeId: string | undefined): BrainRow[] {
	const counts = countByOrg(brains);
	return brains.map((b) => ({
		id: b.id,
		label: brainLabel(b, (counts.get(b.org_id) ?? 0) > 1),
		role: roleLabel(b.role),
		active: b.id === activeId,
		canManage: roleAtLeast(b.role, 'admin'),
		orgId: b.org_id,
		orgLabel: orgDisplay(b)
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
// with no .isomorphic.json. Resolves that brain's own context so it works for any brain
// the caller manages, not just the active one. Cheap for configured brains (the index
// has pages → returns before the tree scan); best-effort (never throws).
async function detectRowSetup(
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	brainId: string
): Promise<{ needsConfig: boolean; configPrUrl?: string }> {
	try {
		const c = await getContext({ requires: 'admin', brain: brainId });
		await ensureFresh(c.db, c.octokit, c.repoArgs, c.brainId, c.config);
		const pages = await listIndexedPages(c.db, c.brainId);
		if (pages.length > 0) return { needsConfig: false };
		if (!(await detectNeedsConfig(c.octokit, c.repoArgs, c.config))) return { needsConfig: false };
		// Misconfigured — is a "configure" PR already open (protected repo)?
		const configPrUrl = await findOpenConfigPr(c.octokit, c.repoArgs);
		return { needsConfig: true, configPrUrl };
	} catch {
		return { needsConfig: false };
	}
}

export function registerBrainTools(
	server: McpServer,
	deps: {
		getContext: (opts?: TenantOpts) => Promise<BrainContext>;
		orgContext: (opts?: { requires?: Role }) => Promise<OrgScope>;
		listBrains: () => Promise<AccessibleBrain[]>;
		activeBrainId: () => string | undefined;
		setActiveBrain: (id: string) => void;
		invalidateConfig: (owner: string, repo: string) => void;
	}
) {
	const { getContext, orgContext, listBrains, activeBrainId, setActiveBrain, invalidateConfig } =
		deps;

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
			inputSchema: {
				brain: z.string().describe('Which brain to activate — a name/label or owner/repo id.')
			}
		},
		async ({ brain }) => {
			await getContext(); // ensure the caller is resolved/authorized
			const brains = await listBrains();
			if (brains.length === 0) return fail('You have no brains to switch between.');
			const m = matchBrain(brains, brain);
			if (!m.brain) {
				const counts = countByOrg(brains);
				const names = (m.candidates ?? brains).map((b) =>
					brainLabel(b, (counts.get(b.org_id) ?? 0) > 1)
				);
				return fail(
					m.candidates
						? `"${brain}" matches multiple brains: ${names.join(', ')}. Be more specific.`
						: `No brain matching "${brain}". You have access to: ${names.join(', ')}.`
				);
			}
			setActiveBrain(m.brain.id);
			const rows = brainRows(brains, m.brain.id);
			const label = rows.find((r) => r.id === m.brain!.id)?.label ?? m.brain.id;
			return {
				content: [
					{ type: 'text' as const, text: `Switched to ${label}. Tools now act on it by default.` }
				],
				structuredContent: { view: 'brains', brains: rows, active: m.brain.id, switched: true }
			};
		}
	);

	// ---------- brains (switcher: interactive widget + data) ----------
	// One tool, both modes: renders the inline brain switcher for the user (selecting
	// one switches to it) AND returns the list as text the model can reason over. Also
	// resolves the org first so a freshly-invited user's brain shows on first open.
	registerAppTool(
		server,
		'brains',
		{
			title: 'Your brains',
			description:
				"The knowledge bases (brains) this user can access — personal, team, and client — with the user's role in each and the active one highlighted. Shown inline as the interactive Isomorphic switcher (selecting one switches to it) AND returned as text you can reason over. Use to answer 'what brains do I have?', to let the user see or switch brains, or when YOU need the list as data before switching. Most tools act on the active brain; pass `brain` to any tool to target another, or switch_brain to change the active one.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: BRAIN_APP_URI } }
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
					const s = await detectRowSetup(getContext, r.id);
					r.needsConfig = s.needsConfig;
					r.configPrUrl = s.configPrUrl;
				})
			);
			return {
				content: [{ type: 'text' as const, text: rowsText(rows) }],
				structuredContent: { view: 'brains', brains: rows, active }
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
				'Create a NEW, empty knowledge base ("brain") with a name the user chooses, and switch to it. Use whenever the user wants to START a new brain / knowledge base / wiki — including their very first one. This SCAFFOLDS a fresh repo; it is different from connect_brain (which adopts an existing GitHub repo). Any editor can create a brain.',
			inputSchema: {
				name: z
					.string()
					.describe('A name for the new brain, e.g. "Personal", "Project Atlas", "Team Wiki".')
			}
		},
		async ({ name }) => {
			// Org-scope + role gate. Rejects the legacy github/static single-tenant paths
			// ("product accounts only") and callers below `editor`.
			let ctx: OrgScope;
			try {
				ctx = await orgContext({ requires: 'editor' });
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
					created = await createAndScaffoldBrain(ctx.octokit, {
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

			await createBrain(ctx.db, {
				brain_id: brainIdFor(created.owner, created.name),
				org_id: ctx.org.org_id,
				repo_owner: created.owner,
				repo_name: created.name,
				name: display,
				created_by: ctx.actorUserId
				// visibility left at the 'org' default — per-brain access is a later phase.
			});

			const id = `${created.owner}/${created.name}`;
			setActiveBrain(id); // land the caller in the new brain
			const rows = brainRows(await listBrains(), id);
			return {
				content: [{ type: 'text' as const, text: `Created "${display}" and switched to it.` }],
				structuredContent: {
					view: 'brains',
					brains: rows,
					active: id,
					switched: true,
					createdId: id
				}
			};
		}
	);

	// ---------- connect_brain (admin+) ----------
	// Adopt a repo as a brain. Called with no `repo`, it lists the connectable
	// candidates instead (repos under the org's App installation that aren't brains
	// yet) — the picker the app shows before the user chooses one to adopt.
	server.registerTool(
		'connect_brain',
		{
			title: 'Connect a repo as a brain',
			description:
				"Adopt an existing GitHub repository as a brain in an organization you admin, so it appears in the switcher (the brains tool). The repo must be under the org's GitHub owner and covered by the org's Isomorphic App installation. Call with no `repo` to list the repos that can become brains (candidates the installation can reach that aren't brains yet). Adds to the active org by default; pass `brain` (any brain in the target org) to add to a different org. Admin only.",
			inputSchema: {
				repo: z
					.string()
					.optional()
					.describe(
						'The repo to adopt — "owner/name", or just "name" (defaults to the org’s GitHub owner). Omit to list the repos that can become brains.'
					),
				brain: z
					.string()
					.optional()
					.describe(
						'Any brain in the target org, to pick which org to add to. Defaults to the active org.'
					)
			}
		},
		async ({ repo, brain }) => {
			const ctx = await getContext({ requires: 'admin', brain });
			if (!ctx.orgId) return fail('Brain management is only available for organization accounts.');

			// No repo → list the connectable candidates (repos the org's installation can
			// reach that aren't brains yet). This is the picker for the connect flow.
			if (repo === undefined) {
				const brains = await listBrains();
				const taken = new Set(brains.map((b) => b.id.toLowerCase()));
				const res = await ctx.octokit.rest.apps.listReposAccessibleToInstallation({
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

			const parts = repo.includes('/') ? repo.split('/') : [ctx.repoArgs.owner, repo];
			const owner = parts[0].trim();
			const name = (parts[1] ?? '').trim();
			if (!owner || !name) return fail(`"${repo}" is not a valid repository.`);

			// The org's installation must actually reach the repo, or we'd write a dead row.
			try {
				await ctx.octokit.rest.repos.get({ owner, repo: name });
			} catch (e) {
				const status = (e as { status?: number })?.status;
				if (status === 404 || status === 403) {
					return fail(
						`The organization's Isomorphic App installation can't access ${owner}/${name}. Add the repo to the installation on GitHub (org Settings → GitHub Apps → Isomorphic → Configure), then try again.`
					);
				}
				throw e;
			}

			const existing = await getBrainByRepo(ctx.db, owner, name);
			if (existing) {
				return fail(
					existing.org_id === ctx.orgId
						? `${owner}/${name} is already a brain here.`
						: `${owner}/${name} is already connected to another organization.`
				);
			}

			await createBrain(ctx.db, {
				brain_id: brainIdFor(owner, name),
				org_id: ctx.orgId,
				repo_owner: owner,
				repo_name: name
			});

			// Guard: an adopted repo whose content isn't under the default layout would
			// connect but show no pages. Detect it now so the app can offer to configure.
			const connectedId = `${owner}/${name}`;
			const needsConfig = await detectNeedsConfig(
				ctx.octokit,
				{ owner, repo: name },
				DEFAULT_BRAIN_CONFIG
			).catch(() => false);

			const rows = brainRows(await listBrains(), ctx.activeBrain.id);
			const text = needsConfig
				? `Connected ${connectedId}, but its content isn't under the default layout, so no pages show yet. Open it and choose Auto-configure (or run configure_brain) to index it.`
				: `Connected ${connectedId} as a brain.`;
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: {
					view: 'brains',
					brains: rows,
					active: ctx.activeBrain.id,
					connectedId,
					needsConfig
				}
			};
		}
	);

	// ---------- configure_brain (admin+) ----------
	// Writes a .isomorphic.json so an adopted repo's content is indexed. The fix for the
	// "connected but no pages" case: defaults to contentRoots ["."] (whole repo), which
	// also means new folders are picked up automatically as the repo grows.
	server.registerTool(
		'configure_brain',
		{
			title: 'Configure a brain’s content layout',
			description:
				"Set up an adopted repo so its pages appear — writes a .isomorphic.json describing where its content lives. Use when a connected brain shows no pages because its markdown isn't under the default 'wiki/' layout. Defaults to indexing the whole repo. Admin only.",
			inputSchema: {
				brain: z
					.string()
					.optional()
					.describe('Which brain to configure. Defaults to the active brain.'),
				content_roots: z
					.array(z.string())
					.optional()
					.describe('Folders that hold content, e.g. ["docs/"]. Default ["."] = the whole repo.')
			}
		},
		async ({ brain, content_roots }) => {
			const ctx = await getContext({ requires: 'admin', brain });

			// Don't open a second PR if a configure PR is already pending (protected repo).
			const pending = await findOpenConfigPr(ctx.octokit, ctx.repoArgs);
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
			const head = await getHead(ctx.octokit, ctx.repoArgs);
			const outcome = await commitOrPR(ctx.octokit, ctx.repoArgs, {
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
						text: `Configured — now indexing ${roots.join(', ')}. The brain’s pages will appear.`
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
			inputSchema: {
				brain: z.string().describe('Which brain to disconnect (name/handle or owner/repo id).')
			}
		},
		async ({ brain }) => {
			const ctx = await getContext();
			const all = await listBrains();
			const m = matchBrain(all, brain);
			if (!m.brain) {
				const counts = countByOrg(all);
				const names = (m.candidates ?? all).map((b) =>
					brainLabel(b, (counts.get(b.org_id) ?? 0) > 1)
				);
				return fail(
					m.candidates
						? `"${brain}" matches multiple brains: ${names.join(', ')}. Be more specific.`
						: `No brain matching "${brain}".`
				);
			}
			const target = m.brain;
			if (!roleAtLeast(target.role, 'admin')) {
				return fail(`You need admin access to disconnect ${brainLabel(target)}.`);
			}
			if (all.filter((b) => b.org_id === target.org_id).length <= 1) {
				return fail(`Can’t disconnect the organization’s only brain.`);
			}
			await deleteBrain(ctx.db, target.brain_id);
			// If we removed the active brain, fall the active pointer back to a survivor.
			if (target.id === ctx.activeBrain.id) {
				const survivor = all.find((b) => b.id !== target.id);
				if (survivor) setActiveBrain(survivor.id);
			}
			const rows = brainRows(await listBrains(), ctx.activeBrain.id);
			return {
				content: [{ type: 'text' as const, text: `Disconnected ${brainLabel(target)}.` }],
				structuredContent: { view: 'brains', brains: rows, active: ctx.activeBrain.id }
			};
		}
	);
}
