// Manual end-to-end battery for the librarian write tools — covers the write_page
// create/update/publish surface, its non-destructive append/edits modes (partial
// edits that never send the rest of the page), and the index-driven page discovery the write path
// relies on (delete_page "still referenced" notes via backlinksTo; move_page link
// repointing via fetchInboundLinkersForPaths, for both a single page and a folder
// subtree — move_page/delete_page take a folder path with no .md).
//
// It also covers the ORG-scope tools that decide where a brain LANDS (`brains`,
// `connect_brain`), which resolve through orgContext / resolveOrgForPerson rather
// than tenantContext and were uncovered until 2026-08-10. The org rows are real, in
// the same D1 as the content index, and one of them deliberately holds NO brain:
// listAccessibleBrains cannot see such an org, which is what once made adopting a
// FIRST repo into a newly connected org impossible.
//
// TWO BACKENDS, ONE BATTERY. By default it runs against the fs + git BrainStore in a
// temporary directory: no network, no credentials, no scratch repo, so it runs in CI
// and a contributor can run it on a fresh clone. With --github it runs the identical
// assertions against a real scratch repo on the platform org, which is the only way
// to prove the GitHub adapter itself.
//
//   pnpm test:e2e                              (local, offline, in CI)
//   pnpm exec tsx scripts/e2e-librarian.ts --github   (real GitHub, by hand)
//
// The --github mode requires `.dev.vars` (repo root, or DEV_VARS_PATH) with the
// platform App creds + PLATFORM_ORG / PLATFORM_INSTALLATION_ID, creates a scratch
// brain repo `brain-librarian-e2e-*`, and deletes it afterwards (success or failure).
//
// The content index runs on a real SQLite database via node:sqlite in both modes,
// shimmed to the D1 surface, so ensureFresh / loadResolvedGraph / backlinksTo run for
// real exactly like prod. (Mirrors e2e-import.ts.)
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerLibrarianTools } from '../src/tools/librarian.ts';
import { registerBrainTools } from '../src/tools/brains.ts';
import {
	listAccessibleBrains,
	listAccessibleOrgs,
	resolveOrgForPerson,
	assertRole,
	type Role
} from '../src/lib/orgs.ts';
import { registerMediaTools } from '../src/tools/media.ts';
import { loadCustomToolDefs, registerCustomTools } from '../src/tools/custom.ts';
import { installationOctokit } from '../src/lib/github.ts';
import { createAndScaffoldBrain, buildScaffoldFiles } from '../src/lib/scaffold-core.ts';
import { loadBrainConfig } from '../src/lib/brain-config.ts';
import { githubStore, type BrainStore } from '../src/lib/brain-repo.ts';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';

const GITHUB_MODE = process.argv.includes('--github');

// ---- D1 over node:sqlite, the real migrations (src/local/d1-sqlite.ts) ----
const { db } = localD1();

// ---- the brain under test ----
let store: BrainStore;
let repoArgs: { owner: string; repo: string };
let brainId: string;
let name: string;
let cleanup: () => Promise<void>;
// The GitHub client for the three PLATFORM operations (create a repo, list an
// installation's repos, check a repo exists). These are GitHub-as-a-platform, not
// a brain as storage, so BrainStore deliberately cannot back them and the offline
// mode has to stand in for them the way it stands in for the repo itself.
let platformOctokit: never;
// A second repo, existing but not yet a brain: what connect_brain adopts.
let adoptRepo: string;
// Repos create_brain scaffolds during the run, deleted with the rest in --github mode.
const createdRepos: string[] = [];

if (GITHUB_MODE) {
	const devVarsPath =
		process.env.DEV_VARS_PATH ?? new URL('../.dev.vars', import.meta.url).pathname;
	const devVars: Record<string, string> = {};
	for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (!m) continue;
		devVars[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
	}
	const org = devVars.PLATFORM_ORG;
	const installationId = Number(devVars.PLATFORM_INSTALLATION_ID);
	if (!org || !installationId) throw new Error('PLATFORM_ORG / PLATFORM_INSTALLATION_ID missing');
	const octokit = await installationOctokit(
		{
			appId: Number(devVars.GITHUB_APP_ID),
			privateKeyBase64: devVars.GITHUB_APP_PRIVATE_KEY_BASE64
		},
		installationId
	);
	name = `brain-librarian-e2e-${Date.now().toString(36)}`;
	console.log(`Creating scratch brain ${org}/${name} …`);
	const brain = await createAndScaffoldBrain(octokit, {
		org,
		name,
		description: 'Librarian E2E test, safe to delete'
	});
	store = githubStore(octokit);
	repoArgs = { owner: brain.owner, repo: brain.name };
	brainId = `${brain.owner}/${brain.name}`;
	platformOctokit = octokit as never;
	// A real second repo for connect_brain to adopt. Scaffolded like the first so the
	// post-adopt config detection has actual content to look at.
	adoptRepo = `${name}-adopt`;
	console.log(`Creating scratch repo ${org}/${adoptRepo} …`);
	await createAndScaffoldBrain(octokit, {
		org,
		name: adoptRepo,
		description: 'Librarian E2E adopt target, safe to delete'
	});
	cleanup = async () => {
		for (const repo of [name, adoptRepo, ...createdRepos]) {
			console.log(`\nDeleting scratch repo ${org}/${repo} …`);
			try {
				await octokit.rest.repos.delete({ owner: org, repo });
				console.log('Deleted.');
			} catch (err) {
				console.log(
					`Could not delete (${(err as { status?: number }).status}), delete manually: https://github.com/${org}/${repo}/settings`
				);
			}
		}
	};
} else {
	const dir = await mkdtemp(join(tmpdir(), 'brain-librarian-e2e-'));
	name = basename(dir);
	console.log(`Creating scratch brain in ${dir} …`);
	await ensureGitRepo(dir, { name: 'E2E', email: 'e2e@localhost' });
	store = fsBrainStore({ dir, author: { name: 'E2E', email: 'e2e@localhost' } });
	repoArgs = { owner: 'local', repo: name };
	brainId = `local/${name}`;
	// The same scaffold the GitHub path gets, from the same pure builder, so both
	// backends start from a byte-identical brain.
	await store.commitFiles(repoArgs, {
		message: 'Scaffold brain',
		writes: buildScaffoldFiles()
	});
	cleanup = async () => {
		await rm(dir, { recursive: true, force: true });
	};
	// The offline stand-in for GitHub-as-a-platform. Narrow on purpose: it answers
	// only the two reads connect_brain makes, and answers them from a fixed set, so
	// "the installation can reach this repo" is a real branch with a real negative
	// case. What it CANNOT stand in for is the adapter itself, which is what
	// --github is for: there, post-adopt config detection runs against actual repo
	// content, and here it fails closed to needsConfig=false.
	adoptRepo = `${name}-adopt`;
	const reachable = new Set([name, adoptRepo]);
	platformOctokit = {
		rest: {
			repos: {
				get: async ({ repo }: { owner: string; repo: string }) => {
					if (reachable.has(repo)) return { data: { name: repo } };
					const err: Error & { status?: number } = new Error('Not Found');
					err.status = 404;
					throw err;
				}
			},
			apps: {
				listReposAccessibleToInstallation: async () => ({
					data: {
						repositories: [...reachable].map((repo) => ({
							name: repo,
							owner: { login: repoArgs.owner }
						}))
					}
				})
			}
		}
	} as never;
}

// ---- in-memory MCP client wired to the real handlers, with a full context ----
const server = new McpServer({ name: 'librarian-e2e', version: '0.0.0' });
const getContext = async () => ({
	store,
	repoArgs,
	role: 'owner' as const,
	orgRole: 'owner' as const,
	config: await loadBrainConfig(store, repoArgs),
	author: undefined,
	db,
	brainId,
	activeBrain: { id: brainId, label: name }
});
registerLibrarianTools(server, getContext);
registerMediaTools(server, getContext);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(clientTransport);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GitHub's refs/contents reads are eventually consistent for a short window
// after a write. Poll until a condition holds so the assertions test the tools,
// not the API's replication lag.
async function eventually<T>(
	fn: () => Promise<T>,
	pred: (v: T) => boolean,
	ms = 15000
): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T = await fn();
	while (!pred(last) && Date.now() < deadline) {
		await sleep(1500);
		last = await fn();
	}
	return last;
}

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${label}`);
	else {
		failures++;
		console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
	}
}
async function call(tool: string, args: Record<string, unknown>) {
	const res = (await client.callTool({ name: tool, arguments: args })) as {
		isError?: boolean;
		content: { type: string; text: string }[];
	};
	return { isError: !!res.isError, text: res.content.map((c) => c.text).join('\n') };
}
async function headSha(): Promise<string> {
	return (await store.getHead(repoArgs)).commitSha;
}
async function fileText(path: string): Promise<string | null> {
	return (await store.readFile(repoArgs, path))?.content ?? null;
}
// "The write landed as exactly ONE commit" is the atomic-bundle guarantee, and it
// has to be asked in a way BOTH backends can answer. Counting commits does that.
// Comparing revision identifiers would not: the fs backend's getHead reports a digest
// of the working tree (so an edit made outside our tools still invalidates the index)
// while its listCommits reports real git shas, and those are two different identifier
// spaces on purpose.
async function commitCount(): Promise<number> {
	return (await store.listCommits(repoArgs, { limit: 200 })).length;
}
async function assertOneCommit(label: string, before: number) {
	const n = await eventually(
		async () => (await commitCount()) - before,
		(v) => v === 1
	);
	check(`${label}: exactly one commit`, n === 1, `commits added = ${n}`);
}
async function settledHead(): Promise<string> {
	let prev = await headSha();
	for (let i = 0; i < 5; i++) {
		await sleep(1200);
		const next = await headSha();
		if (next === prev) return next;
		prev = next;
	}
	return prev;
}
// Poll find_inbound_links until it sees `linker` — proves the tree + content
// index are consistent for `target` before we run a destructive op that reads
// the same index. (find_inbound_links resolves via loadResolvedGraph, the same
// path delete_page / move_page discovery uses, so once it agrees, they will.)
async function waitInbound(target: string, linker: string) {
	const r = await eventually(
		() => call('find_inbound_links', { path: target }),
		(res) => res.text.includes(linker)
	);
	check(`index sees ${linker} → ${target}`, r.text.includes(linker), r.text);
}

try {
	// ── write_page (create): a new page, one bundled commit ──────────────────
	await settledHead();
	let before = await commitCount();
	let r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		title: 'Acme',
		description: 'Rocket-parts customer',
		content: '# Acme\n\nThey buy rockets.\n'
	});
	check('write_page (create) succeeds', !r.isError, r.text);
	check('write_page speaks wiki, not git', !/commit|sha|branch/i.test(r.text), r.text);
	await assertOneCommit('write_page create', before);

	// ── write_page mode guards: create refuses an existing path; update refuses
	//    a missing one; upsert (default) does either. ─────────────────────────
	r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		content: '# clobber\n',
		mode: 'create'
	});
	check(
		'write_page mode:create refuses an existing path',
		r.isError && /already exists/i.test(r.text),
		r.text
	);
	r = await call('write_page', {
		path: 'wiki/customers/ghost.md',
		content: '# x\n',
		mode: 'update'
	});
	check(
		'write_page mode:update refuses a missing path',
		r.isError && /does not exist/i.test(r.text),
		r.text
	);

	// ── write_page (metadata-only): omit content to publish — status flips to
	//    published and the body is untouched. (Absorbed the old publish_page.) ─
	await settledHead();
	before = await commitCount();
	r = await call('write_page', { path: 'wiki/customers/acme.md', status: 'published' });
	check('write_page (publish) succeeds', !r.isError, r.text);
	const acmePublished = await eventually(
		() => fileText('wiki/customers/acme.md'),
		(t) => !!t && /status:\s*published/.test(t)
	);
	check(
		'publish flipped status to published',
		/status:\s*published/.test(acmePublished ?? ''),
		acmePublished ?? ''
	);
	check(
		'publish left the body untouched',
		(acmePublished ?? '').includes('They buy rockets.'),
		acmePublished ?? ''
	);
	await assertOneCommit('write_page publish (metadata-only)', before);

	// ── OKF conformance, against real blobs ──────────────────────────────────
	//
	// `type` is OKF's one required field. It must land in the file, and lead the
	// frontmatter the way the spec's own examples do.
	await settledHead();
	before = await commitCount();
	r = await call('write_page', {
		path: 'wiki/vendors/swoogo.md',
		title: 'Swoogo',
		type: 'Vendor',
		content: '# Swoogo\n\nEvent registration platform.\n'
	});
	check('write_page accepts a type', !r.isError, r.text);
	const swoogo = await eventually(
		() => fileText('wiki/vendors/swoogo.md'),
		(t) => !!t && /type:/.test(t)
	);
	check('type: lands in frontmatter', /^type:\s*Vendor$/m.test(swoogo ?? ''), swoogo ?? '');
	check(
		'type: leads the frontmatter block',
		/^---\ntype:/.test(swoogo ?? ''),
		(swoogo ?? '').slice(0, 80)
	);

	// A type set on a later update must merge, not duplicate the key.
	r = await call('write_page', { path: 'wiki/vendors/swoogo.md', type: 'Event Platform' });
	check('write_page can retype an existing page', !r.isError, r.text);
	const retyped = await eventually(
		() => fileText('wiki/vendors/swoogo.md'),
		(t) => !!t && /Event Platform/.test(t)
	);
	check(
		'retype replaces rather than duplicating the key',
		(retyped ?? '').split('\n').filter((l) => /^type:/.test(l)).length === 1,
		retyped ?? ''
	);

	// Nested OKF frontmatter (v0.2 trust family) must survive a write. This is the
	// case that used to be silently destroyed: `generated:` collapsed to '' and
	// `sources:` lost every sub-key but the first.
	const nested = [
		'---',
		'type: Meeting Note',
		'title: Kickoff',
		'sources:',
		'  - resource: /source/kickoff.md',
		'    title: Kickoff transcript',
		'generated:',
		'  by: e2e',
		'  at: 2026-07-24T00:00:00Z',
		'---',
		'',
		'# Kickoff',
		'',
		'Notes.'
	].join('\n');
	r = await call('write_page', { path: 'wiki/notes/kickoff.md', content: nested });
	check('write_page accepts nested OKF frontmatter', !r.isError, r.text);
	// Re-save it (metadata-only) so the frontmatter goes through serialize again.
	r = await call('write_page', { path: 'wiki/notes/kickoff.md', status: 'published' });
	check('re-save of a nested-frontmatter page succeeds', !r.isError, r.text);
	const kickoff = await eventually(
		() => fileText('wiki/notes/kickoff.md'),
		(t) => !!t && /status:\s*published/.test(t)
	);
	check(
		'nested sources[].resource survives a re-save',
		/-\s+resource:\s*\/source\/kickoff\.md/.test(kickoff ?? ''),
		kickoff ?? ''
	);
	check(
		'nested sources[].title survives (the sub-key that used to be dropped)',
		/title:\s*Kickoff transcript/.test(kickoff ?? ''),
		kickoff ?? ''
	);
	check(
		'nested generated.by/at survive',
		/by:\s*e2e/.test(kickoff ?? '') && /at:\s*2026-07-24/.test(kickoff ?? ''),
		kickoff ?? ''
	);

	// H1 titling: a page with no `title:` is named by its heading, not its filename,
	// and a folder note is named by its FOLDER rather than "index".
	r = await call('write_page', {
		path: 'wiki/systems/wallabi-db.md',
		content: '# Wallabi Data Warehouse\n\nAnalytics store.\n'
	});
	check('write_page (no title) succeeds', !r.isError, r.text);
	await call('write_page', {
		path: 'wiki/systems/index.md',
		content: 'Everything we run.\n'
	});
	r = await eventually(
		() => call('find_inbound_links', { path: 'wiki/systems/wallabi-db.md' }),
		(x) => !x.isError
	);
	check('H1 titles the page (not the filename)', r.text.includes('Wallabi Data Warehouse'), r.text);
	r = await eventually(
		() => call('find_inbound_links', { path: 'wiki/systems/index.md' }),
		(x) => !x.isError
	);
	check(
		'folder note is titled by its folder, never "index"',
		r.text.includes('systems') && !/"index"/.test(r.text),
		r.text
	);

	// ── write_page (append / edits): change PART of a page without sending the
	//    rest of it. The point is that a caller who has never read the page can
	//    still edit it safely, so every check here is "the text I didn't name is
	//    still there". ─────────────────────────────────────────────────────────
	await settledHead();
	before = await commitCount();
	r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		append: '## Contacts\n\n- Wile E. Coyote'
	});
	check('write_page (append) succeeds', !r.isError, r.text);
	check('append reports what it added', /appended/i.test(r.text), r.text);
	const appended = await eventually(
		() => fileText('wiki/customers/acme.md'),
		(t) => !!t && t.includes('## Contacts')
	);
	check(
		'append kept the existing body',
		(appended ?? '').includes('They buy rockets.'),
		appended ?? ''
	);
	check('append kept frontmatter', /status:\s*published/.test(appended ?? ''), appended ?? '');
	check(
		'append landed at the end',
		(appended ?? '').trimEnd().endsWith('- Wile E. Coyote'),
		appended ?? ''
	);
	await assertOneCommit('write_page append', before);

	await settledHead();
	before = await commitCount();
	r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		edits: [{ find: 'They buy rockets.', replace: 'They buy rockets and boosters.' }]
	});
	check('write_page (edits) succeeds', !r.isError, r.text);
	check('edits report the replacement count', /1 replacement/i.test(r.text), r.text);
	const edited = await eventually(
		() => fileText('wiki/customers/acme.md'),
		(t) => !!t && t.includes('and boosters')
	);
	check(
		'edit replaced the anchored text',
		(edited ?? '').includes('They buy rockets and boosters.'),
		edited ?? ''
	);
	check(
		'edit left the appended section alone',
		(edited ?? '').includes('- Wile E. Coyote'),
		edited ?? ''
	);
	check('edit left frontmatter alone', /title:\s*Acme/.test(edited ?? ''), edited ?? '');
	await assertOneCommit('write_page edits', before);

	// An anchor that only matches FRONTMATTER must not match: edits operate on the
	// body, so metadata can't be rewritten behind the frontmatter merge's back.
	await settledHead();
	before = await commitCount();
	r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		edits: [{ find: 'Rocket-parts customer', replace: 'Rocket customer' }]
	});
	check(
		'edits refuse a frontmatter-only anchor',
		r.isError && /couldn't find/i.test(r.text),
		r.text
	);

	// Ambiguous anchor: refuse, and write NOTHING (not even the edits that matched).
	await call('write_page', {
		path: 'wiki/customers/acme.md',
		append: '- Wile E. Coyote (billing)'
	});
	const ambiguous = await call('write_page', {
		path: 'wiki/customers/acme.md',
		edits: [
			{ find: 'They buy rockets and boosters.', replace: 'They buy a lot.' },
			{ find: 'Coyote', replace: 'Coyote, Esq.' }
		]
	});
	check(
		'edits refuse an ambiguous anchor',
		ambiguous.isError && /2 times/.test(ambiguous.text),
		ambiguous.text
	);
	const afterAmbiguous = await fileText('wiki/customers/acme.md');
	check(
		'a refused batch writes nothing (earlier edit not applied)',
		(afterAmbiguous ?? '').includes('They buy rockets and boosters.') &&
			!(afterAmbiguous ?? '').includes('They buy a lot.'),
		afterAmbiguous ?? ''
	);

	// Argument guards.
	r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		content: '# Acme\n',
		append: 'more'
	});
	check('content + append is refused', r.isError && /not both/i.test(r.text), r.text);
	r = await call('write_page', { path: 'wiki/customers/ghost.md', append: 'more' });
	check('append to a missing page is refused', r.isError && /does not exist/i.test(r.text), r.text);

	// The destructive path announces its blast radius, so a clobber is visible.
	r = await call('write_page', {
		path: 'wiki/customers/acme.md',
		content: '# Acme\n\nThey buy rockets and boosters.\n'
	});
	check(
		'a whole-body replace says how much it replaced',
		!r.isError && /replaced the whole body \(was \d+ lines/.test(r.text),
		r.text
	);

	// ══ move_page (folder path): repoint inbound md links, keep intra-folder
	//    links, no dangle. A folder path (no .md) moves the whole subtree. ══════
	// A folder with an intra-folder link + an outside page linking in.
	await call('write_page', {
		path: 'wiki/proj/alpha.md',
		title: 'Alpha',
		content: '# Alpha\n\nPairs with [Beta](beta.md).\n'
	});
	await call('write_page', {
		path: 'wiki/proj/beta.md',
		title: 'Beta',
		content: '# Beta\n\nStandalone.\n'
	});
	await call('write_page', {
		path: 'wiki/notes/ref.md',
		title: 'Ref',
		content: '# Ref\n\nSee [Alpha](../proj/alpha.md).\n'
	});
	await waitInbound('wiki/proj/alpha.md', 'wiki/notes/ref.md');

	await settledHead();
	before = await commitCount();
	r = await call('move_page', { path: 'wiki/proj', new_path: 'wiki/work' });
	check('move_page (folder) succeeds', !r.isError, r.text);
	check('move_page (folder) reports a repoint', /1 page\(s\) were repointed/.test(r.text), r.text);
	await assertOneCommit('move_page folder (moved blobs + inbound repoint + log)', before);

	const oldAlpha = await eventually(
		() => fileText('wiki/proj/alpha.md'),
		(t) => t === null
	);
	check('old folder path gone', oldAlpha === null);
	const newAlpha = (await fileText('wiki/work/alpha.md'))!;
	check('moved page kept its intra-folder link', /\(beta\.md\)/.test(newAlpha), newAlpha);
	const refAfter = (await fileText('wiki/notes/ref.md'))!;
	check(
		'outside inbound link repointed to new path',
		refAfter.includes('(../work/alpha.md)'),
		refAfter
	);

	// ══ move_page (folder path) MERGING into a folder that already exists. ══════
	// The reported dead end (issue #14): every scaffolded folder carries a
	// .gitkeep, so the destination always already had one, and the move was
	// refused over a file the caller never wrote. Archiving into an existing
	// archive is exactly the case where the destination is never empty.
	await call('write_page', {
		path: 'wiki/todos/task-one.md',
		title: 'Task One',
		content: '# Task One\n\nOpen.\n'
	});
	await call('write_page', {
		path: 'wiki/archive/todos/old-task.md',
		title: 'Old Task',
		content: '# Old Task\n\nDone long ago.\n'
	});
	// Folder markers on BOTH sides, written raw: no tool creates a dotfile.
	await store.commitFiles(repoArgs, {
		message: 'scaffold folder markers',
		writes: [
			{ path: 'wiki/todos/.gitkeep', content: '' },
			{ path: 'wiki/archive/todos/.gitkeep', content: '' }
		]
	});
	await settledHead();

	before = await commitCount();
	r = await call('move_page', { path: 'wiki/todos', new_path: 'wiki/archive/todos' });
	check('move_page merges into an existing folder', !r.isError, r.text);
	check('merge is reported as a merge', /Merged into the existing/.test(r.text), r.text);
	await assertOneCommit('move_page folder merge', before);

	const mergedTask = await eventually(
		() => fileText('wiki/archive/todos/task-one.md'),
		(t) => t !== null
	);
	check('moved page landed in the existing folder', mergedTask !== null);
	check(
		'the folder that was already there kept its pages',
		(await fileText('wiki/archive/todos/old-task.md')) !== null
	);
	check(
		"destination's own folder marker survived",
		(await fileText('wiki/archive/todos/.gitkeep')) !== null
	);
	check('source folder is gone', (await fileText('wiki/todos/task-one.md')) === null);
	check("source's folder marker is gone", (await fileText('wiki/todos/.gitkeep')) === null);

	// A REAL collision still stops the move, and names what collided.
	await call('write_page', {
		path: 'wiki/inbox/old-task.md',
		title: 'Old Task',
		content: '# Old Task\n\nA different page with a colliding filename.\n'
	});
	await settledHead();
	r = await call('move_page', { path: 'wiki/inbox', new_path: 'wiki/archive/todos' });
	check('a real content collision still refuses', r.isError, r.text);
	check(
		'the refusal names the colliding path',
		/wiki\/archive\/todos\/old-task\.md/.test(r.text),
		r.text
	);

	// ══ move_page on a non-page FILE: addressable, not mistaken for a folder. ═══
	before = await commitCount();
	r = await call('move_page', {
		path: 'wiki/archive/todos/.gitkeep',
		new_path: 'wiki/inbox/.gitkeep'
	});
	check('move_page moves a dotfile', !r.isError, r.text);
	await assertOneCommit('move_page dotfile', before);
	check(
		'dotfile landed at its new path',
		(await eventually(
			() => fileText('wiki/inbox/.gitkeep'),
			(t) => t !== null
		)) !== null
	);
	r = await call('move_page', { path: 'wiki/nope/.gitkeep', new_path: 'wiki/inbox/x.gitkeep' });
	check('a missing file reports what was looked for', r.isError, r.text);
	check('no phantom "folder has no files"', !/it has no files/.test(r.text), r.text);

	// ══ delete_page on a non-page FILE: same routing, plus a reference check. ═══
	await store.commitFiles(repoArgs, {
		message: 'add an asset to delete',
		writes: [{ path: 'wiki/assets/logo.svg', content: '<svg/>\n' }]
	});
	await call('write_page', {
		path: 'wiki/brand.md',
		title: 'Brand',
		content: '# Brand\n\n![Logo](assets/logo.svg)\n'
	});
	await settledHead();

	r = await call('delete_page', { path: 'wiki/nope/.gitkeep' });
	check('delete_page: a missing file says what it looked for', r.isError, r.text);
	check('delete_page: no phantom "no folder found"', !/No folder/.test(r.text), r.text);

	before = await commitCount();
	r = await call('delete_page', { path: 'wiki/assets/logo.svg' });
	check('delete_page deletes a non-page file', !r.isError, r.text);
	check('delete_page warns that a page still embeds it', /wiki\/brand\.md/.test(r.text), r.text);
	await assertOneCommit('delete_page file', before);
	check(
		'the file is gone',
		(await eventually(
			() => fileText('wiki/assets/logo.svg'),
			(t) => t === null
		)) === null
	);

	// The brain is still internally consistent after the move.
	r = await call('validate', {});
	check('validate clean after move_page (folder)', /no broken links/.test(r.text), r.text);

	// ══ move_page (single file): the .md path form still moves + repoints. ═════
	await waitInbound('wiki/work/alpha.md', 'wiki/notes/ref.md');
	await settledHead();
	before = await commitCount();
	r = await call('move_page', { path: 'wiki/work/alpha.md', new_path: 'wiki/work/alpha-1.md' });
	check('move_page (file) succeeds', !r.isError, r.text);
	await assertOneCommit('move_page file (moved blob + inbound repoint + log)', before);
	const refAfterFile = await eventually(
		() => fileText('wiki/notes/ref.md'),
		(t) => !!t && t.includes('(../work/alpha-1.md)')
	);
	check(
		'file move repointed the outside inbound link',
		(refAfterFile ?? '').includes('(../work/alpha-1.md)'),
		refAfterFile ?? ''
	);

	// ══ delete_page: "still referenced" note counts BOTH md and [[wikilinks]] ══
	// Two linkers into acme: one relative-md, one wikilink (by title).
	await call('write_page', {
		path: 'wiki/people/jane.md',
		title: 'Jane',
		content: '# Jane\n\nWorks with [Acme](../customers/acme.md).\n'
	});
	await call('write_page', {
		path: 'wiki/people/bob.md',
		title: 'Bob',
		content: '# Bob\n\nAlso knows [[Acme]].\n'
	});
	await waitInbound('wiki/customers/acme.md', 'wiki/people/jane.md');
	await waitInbound('wiki/customers/acme.md', 'wiki/people/bob.md');

	r = await call('delete_page', { path: 'wiki/customers/acme.md' });
	check('delete_page succeeds', !r.isError, r.text);
	check(
		'delete_page reports 2 referencing pages',
		/2 page\(s\) still reference it/.test(r.text),
		r.text
	);
	check('delete_page lists the md linker (jane)', r.text.includes('wiki/people/jane.md'), r.text);
	check(
		'delete_page lists the wikilink linker (bob)',
		r.text.includes('wiki/people/bob.md'),
		r.text
	);

	// ══ delete_page (folder path): deletes the whole subtree; inbound note counts
	//    [[wikilinks]] into the folder. A folder path (no .md) is the subtree form. ══
	await call('write_page', {
		path: 'wiki/temp/temp-item.md',
		title: 'Temp Item',
		content: '# Temp Item\n\nEphemeral.\n'
	});
	await call('write_page', {
		path: 'wiki/keep/pointer.md',
		title: 'Pointer',
		content: '# Pointer\n\nRefers to [[Temp Item]].\n'
	});
	await waitInbound('wiki/temp/temp-item.md', 'wiki/keep/pointer.md');

	r = await call('delete_page', { path: 'wiki/temp' });
	check('delete_page (folder) succeeds', !r.isError, r.text);
	check(
		'delete_page (folder) reports the wikilink linker',
		/still link into it/.test(r.text) && r.text.includes('wiki/keep/pointer.md'),
		r.text
	);
	const goneItem = await eventually(
		() => fileText('wiki/temp/temp-item.md'),
		(t) => t === null
	);
	check('deleted folder subtree is gone', goneItem === null);

	// ══ frontmatter fields: write_page `fields` ══
	// The reported case (issue #14): a todo-per-page vault marking finished work
	// done. The invariant under test on every assertion here is that the BODY never
	// moves, because the whole point is not having to read the page first.
	const TODO_BODY = '# Ship the importer\n\nA body line that must survive every field write.\n';
	await call('write_page', {
		path: 'wiki/todos/alpha.md',
		title: 'Todo alpha',
		type: 'Todo',
		content: TODO_BODY
	});
	await settledHead();

	before = await commitCount();
	r = await call('write_page', {
		path: 'wiki/todos/alpha.md',
		fields: { done: '2026-08-10', owner: 'ana', priority: 2 }
	});
	check('write_page fields: succeeds with no content argument', !r.isError, r.text);
	check('write_page fields: names what it set', /set done, owner, priority/.test(r.text), r.text);
	await assertOneCommit('write_page fields', before);
	const alpha = await eventually(
		() => fileText('wiki/todos/alpha.md'),
		(t) => !!t && /done:/.test(t)
	);
	check(
		'write_page fields: key is on the page',
		/done:\s*2026-08-10/.test(alpha ?? ''),
		alpha ?? ''
	);
	check(
		'write_page fields: numbers land as scalars',
		/priority:\s*2/.test(alpha ?? ''),
		alpha ?? ''
	);
	check(
		'write_page fields: the body is untouched',
		(alpha ?? '').includes('A body line that must survive every field write.'),
		alpha ?? ''
	);
	check(
		'write_page fields: managed frontmatter still intact',
		/type:\s*Todo/.test(alpha ?? '') && /title:\s*Todo alpha/.test(alpha ?? ''),
		alpha ?? ''
	);

	r = await call('write_page', { path: 'wiki/todos/alpha.md', fields: { owner: null } });
	check(
		'write_page fields: null removes a key',
		!r.isError && /removed owner/.test(r.text),
		r.text
	);
	const alphaCut = await eventually(
		() => fileText('wiki/todos/alpha.md'),
		(t) => !!t && !/owner:/.test(t)
	);
	check('write_page fields: the key is gone from the file', !/owner:/.test(alphaCut ?? ''));
	check('write_page fields: ...and the rest stayed', /done:\s*2026-08-10/.test(alphaCut ?? ''));

	// The refusals. Each one exists so a caller cannot destroy something it has not read.
	r = await call('write_page', { path: 'wiki/todos/alpha.md', fields: { title: 'Renamed' } });
	check('write_page fields: refuses a managed key', r.isError, r.text);
	check('write_page fields: ...and points at the argument', /title" argument/.test(r.text), r.text);
	r = await call('write_page', { path: 'wiki/todos/alpha.md', fields: { 'due date': 'friday' } });
	check('write_page fields: refuses a key that would not read back', r.isError, r.text);

	// wiki/notes/kickoff.md carries the nested OKF sources:/generated: blocks.
	r = await call('write_page', { path: 'wiki/notes/kickoff.md', fields: { sources: 'clobber' } });
	check('write_page fields: refuses to flatten nested YAML', r.isError, r.text);
	r = await call('write_page', { path: 'wiki/notes/kickoff.md', fields: { reviewed: 'yes' } });
	check('write_page fields: writes alongside nested YAML', !r.isError, r.text);
	const kickoffAfter = await eventually(
		() => fileText('wiki/notes/kickoff.md'),
		(t) => !!t && /reviewed:\s*yes/.test(t)
	);
	check(
		'write_page fields: the nested block still round-trips',
		/-\s+resource:\s*\/source\/kickoff\.md/.test(kickoffAfter ?? '') &&
			/title:\s*Kickoff transcript/.test(kickoffAfter ?? ''),
		kickoffAfter ?? ''
	);

	// ══ custom tools: author a tool page, discover it via the index, invoke it ══
	// A tool page under tools/ becomes a `tool_<name>` MCP tool. Discovery is the
	// exact loadCustomToolDefs the Worker runs in buildServer; invocation runs the
	// bound read op against the real content index.
	// A dedicated searchable page with a unique term the bound op should find.
	await call('write_page', {
		path: 'wiki/kb/marker.md',
		title: 'Marker',
		content: '# Marker\n\nThe zorptastic sentinel value.\n'
	});
	r = await call('write_page', {
		path: 'wiki/tools/find-term.md',
		description: 'Search the brain for a term.',
		content:
			'Report the matches below.\n\n```tool\ninput: term (string) what to search for\nop: search_pages\narg: query = {{term}}\n```\n'
	});
	check('create tool page succeeds', !r.isError, r.text);
	check('create tool page nudges reconnect', /reconnect/i.test(r.text), r.text);
	await settledHead();

	const { defs, errors } = await loadCustomToolDefs(await getContext());
	check('discovers exactly one tool', defs.length === 1, JSON.stringify(errors));
	check('tool name is tool_find_term', defs[0]?.name === 'tool_find_term', defs[0]?.name);
	check('tool is a bound search_pages op', defs[0]?.op === 'search_pages');
	check(
		'validate reports no malformed tool pages',
		!/won't register/.test((await call('validate', {})).text)
	);

	// Register on a fresh server+client (a "reconnect") and drive the tool.
	const toolServer = new McpServer({ name: 'librarian-e2e-tools', version: '0.0.0' });
	registerCustomTools(toolServer, getContext, defs);
	const [toolCT, toolST] = InMemoryTransport.createLinkedPair();
	await toolServer.connect(toolST);
	const toolClient = new Client({ name: 'e2e-tools', version: '0.0.0' });
	await toolClient.connect(toolCT);
	const listed = await toolClient.listTools();
	check(
		'tool_find_term appears in the tool list after reconnect',
		listed.tools.some((t) => t.name === 'tool_find_term')
	);
	const inv = (await toolClient.callTool({
		name: 'tool_find_term',
		arguments: { term: 'zorptastic' }
	})) as { isError?: boolean; content: { type: string; text: string }[] };
	const invText = inv.content.map((c) => c.text).join('\n');
	check('tool runs its bound op against the brain', /wiki\/kb\/marker\.md/.test(invText), invText);
	check('tool prepends its instruction body', /Report the matches below\./.test(invText), invText);
	await toolClient.close();
	await toolServer.close();

	// ---- attachments: bytes have to survive a real commit ----
	//
	// This is the only place the binary path is exercised end to end. Everything
	// else about attachments is pure and covered by test:media; what cannot be
	// tested purely is whether a PNG comes back byte-identical after going through
	// createBlob -> tree -> commit -> read. The whole reason FileWrite grew an
	// `encoding` is that the inline-content path decodes as UTF-8 and would corrupt
	// these bytes silently, so a round-trip that compares base64 exactly is the
	// assertion that would have caught it.
	console.log('\nattachments');
	{
		// A 1x1 transparent PNG. Small, but real: it contains bytes that are not valid
		// UTF-8, which is precisely what a text write path mangles.
		const PNG_1PX =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
		const host = 'wiki/vendors/acme.md';
		await call('write_page', { path: host, content: '# Acme\n\nA vendor.\n', title: 'Acme' });

		const before = await commitCount();
		const attach = await call('attach_media', {
			page: host,
			filename: 'Acme Logo.png',
			mime_type: 'image/png',
			data: PNG_1PX,
			alt: 'Acme logo'
		});
		check('attach_media succeeds', !attach.isError, attach.text);

		const assetPath = 'wiki/vendors/assets/acme-logo.png';
		const stored = await store.readBinary(repoArgs, assetPath);
		check('the file is stored where it was placed', !!stored, assetPath);
		// The assertion this block exists for.
		check(
			'bytes survive the round trip unchanged',
			stored?.contentBase64 === PNG_1PX,
			`${stored?.contentBase64?.slice(0, 24)}… vs ${PNG_1PX.slice(0, 24)}…`
		);
		check('size is reported from the stored blob', stored?.size === 70, String(stored?.size));

		const hostText = (await fileText(host)) ?? '';
		check(
			'the page gained a relative markdown image link',
			hostText.includes('![Acme logo](assets/acme-logo.png)'),
			hostText
		);
		check('the upload landed as ONE commit', (await commitCount()) === before + 1);

		// read_media hands the model an actual image block, not a description of one.
		const raw = (await client.callTool({
			name: 'read_media',
			arguments: { path: assetPath }
		})) as {
			isError?: boolean;
			content: { type: string; data?: string; mimeType?: string }[];
			structuredContent?: { dataUri?: string; mimeType?: string };
		};
		const img = raw.content.find((c) => c.type === 'image');
		check('read_media returns an image content block', !!img, JSON.stringify(raw.content));
		check('with the same bytes it stored', img?.data === PNG_1PX);
		check('and the right mime type', img?.mimeType === 'image/png');
		// The bytes are for the APP, and only when it asks. A host puts
		// structuredContent in front of the model next to the content blocks, so
		// sending them unasked spends a second and larger copy of the image as text
		// beside the image block it can already see (issue #20).
		check(
			'and NO data URI by default, since the model already has the picture',
			raw.structuredContent?.dataUri === undefined,
			JSON.stringify(raw.structuredContent)
		);
		const forApp = (await client.callTool({
			name: 'read_media',
			arguments: { path: assetPath, include_data: true }
		})) as { structuredContent?: { dataUri?: string } };
		check(
			'include_data returns the data URI the app renders under the iframe CSP',
			forApp.structuredContent?.dataUri === `data:image/png;base64,${PNG_1PX}`
		);

		// find_inbound_links has to work on an ATTACHMENT, not just a page. It is what
		// the app's asset view calls to answer "which pages would lose this if I
		// deleted it", and the failure mode is quiet: an empty list looks like a
		// correct answer.
		//
		// The specific trap: readFile decodes a blob as UTF-8, and on a PNG that does
		// not return null, it returns mojibake — so an existence check written for
		// pages sails straight past and then titles the image from binary garbage.
		const links = await call('find_inbound_links', { path: assetPath });
		check('find_inbound_links works on an attachment', !links.isError, links.text);
		check('and names the page that shows it', links.text.includes(host), links.text);
		check(
			'and titles it by filename rather than from its bytes',
			links.text.includes('acme-logo.png') && !/[�]/.test(links.text),
			links.text
		);

		// Moving an attachment has to repoint what displays it. This is the payoff of
		// the assetEdges change: without it backlinksTo returns nothing here and the
		// link on the page silently rots.
		const moved = await call('move_page', {
			path: assetPath,
			new_path: 'wiki/vendors/assets/logo.png'
		});
		check('move_page moves an attachment', !moved.isError, moved.text);
		const afterMove = (await fileText(host)) ?? '';
		check(
			'and repoints the page that displays it',
			afterMove.includes('](assets/logo.png)') && !afterMove.includes('acme-logo.png'),
			afterMove
		);
		check(
			'the old path is gone',
			(await store.readBinary(repoArgs, assetPath)) === null,
			'old asset still present'
		);

		// And deleting one has to say who still shows it, since an image that vanishes
		// leaves a hole rather than a broken link anyone would notice. Asserted on the
		// page being NAMED rather than on the wording: the contract is that nothing
		// dangles silently, and pinning the sentence makes a reworded message look like
		// a regression.
		const del = await call('delete_page', { path: 'wiki/vendors/assets/logo.png' });
		check('delete_page deletes an attachment', !del.isError, del.text);
		check('and warns that a page still shows it', del.text.includes(host), del.text);
		check(
			'the file is actually gone',
			(await store.readBinary(repoArgs, 'wiki/vendors/assets/logo.png')) === null
		);

		// A folder path must still behave like a folder, not get caught by the asset branch.
		const badType = await call('attach_media', {
			page: host,
			filename: 'notes.txt',
			mime_type: 'text/plain',
			data: PNG_1PX
		});
		check('attach_media refuses an unsupported type', badType.isError, badType.text);

		// URL ingest, as far as it can be driven with no network: that the argument is
		// wired through to the guards at all, and that the guards refuse before any
		// request goes out. The fetch itself is covered branch by branch against an
		// injected stub in pnpm test:media.
		const noSource = await call('attach_media', { page: host, filename: 'a.png' });
		check('attach_media needs a url or data', noSource.isError, noSource.text);
		const bothSources = await call('attach_media', {
			page: host,
			filename: 'a.png',
			mime_type: 'image/png',
			data: PNG_1PX,
			url: 'https://example.com/a.png'
		});
		check('attach_media refuses url and data together', bothSources.isError, bothSources.text);
		const localUrl = await call('attach_media', { page: host, url: 'https://127.0.0.1/a.png' });
		check(
			'attach_media refuses a url pointing at a local address',
			localUrl.isError && /private address/i.test(localUrl.text),
			localUrl.text
		);
		const insecureUrl = await call('attach_media', { page: host, url: 'http://example.com/a.png' });
		check(
			'attach_media refuses a plain-http url',
			insecureUrl.isError && /https/i.test(insecureUrl.text),
			insecureUrl.text
		);

		// Storing must never write over a file that is already there. This is the one
		// failure mode with no visible symptom: the second upload succeeds, the path is
		// unchanged, so every page linking to it silently starts showing the other
		// picture and the transcript says "Stored" both times. Only the repo knows what
		// is already present, so the SERVER has to pick the free name and report it.
		//
		// A 1x1 RED png, so "which file is at this path" is answerable by comparing
		// bytes rather than by trusting the message.
		const PNG_RED =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
		const firstPath = 'wiki/vendors/assets/shared.png';
		await call('attach_media', {
			path: firstPath,
			filename: 'shared.png',
			mime_type: 'image/png',
			data: PNG_1PX
		});
		const clash = await call('attach_media', {
			path: firstPath,
			filename: 'shared.png',
			mime_type: 'image/png',
			data: PNG_RED
		});
		check('a second attach at a taken path still succeeds', !clash.isError, clash.text);
		check(
			'but lands at a NUMBERED path, not the one asked for',
			clash.text.includes('wiki/vendors/assets/shared-2.png'),
			clash.text
		);
		const original = await store.readBinary(repoArgs, firstPath);
		check(
			'the first file is untouched — its bytes, not the second upload',
			original?.contentBase64 === PNG_1PX,
			`${original?.contentBase64?.slice(0, 24)}…`
		);
		const variant = await store.readBinary(repoArgs, 'wiki/vendors/assets/shared-2.png');
		check('and the second file is stored alongside it', variant?.contentBase64 === PNG_RED);
		// The app inserts its link BEFORE uploading, so a rename it is not told about
		// leaves the page pointing at a name nothing occupies.
		const thirdAttach = (await client.callTool({
			name: 'attach_media',
			arguments: {
				path: firstPath,
				filename: 'shared.png',
				mime_type: 'image/png',
				data: PNG_RED
			}
		})) as { structuredContent?: { path?: string } };
		check(
			'the actual path comes back as data, not only as prose',
			thirdAttach.structuredContent?.path === 'wiki/vendors/assets/shared-3.png',
			JSON.stringify(thirdAttach.structuredContent)
		);
	}

	// ── org + brain tools: where a brain LANDS ───────────────────────────────
	// Everything above acts on a brain that already exists. These tools decide
	// which ORGANIZATION a brain is created in or adopted into, and they resolve
	// through a different path (orgContext / resolveOrgForPerson, not
	// tenantContext) that nothing else in this battery reaches.
	//
	// The org rows are real, in the same D1 the content index runs on, and the
	// decision runs through the real resolveOrgForPerson. `ORG_EMPTY` deliberately
	// holds NO brain: an org with none is invisible to listAccessibleBrains, which
	// is what used to make adopting a FIRST repo into a new org impossible.
	const USER = 'u-e2e';
	const ORG_MAIN = 'org-e2e-main';
	const ORG_EMPTY = 'org-e2e-empty';
	const run = (sql: string, ...binds: unknown[]) =>
		db
			.prepare(sql)
			.bind(...binds)
			.run();
	await run(
		`INSERT INTO app_users (user_id, email, name) VALUES (?1, ?2, ?3)`,
		USER,
		'e2e@example.com',
		'E2E'
	);
	await run(
		`INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at)
		 VALUES (?1, ?2, 'customer', 1, ?3, ?4, '2026-01-01')`,
		ORG_MAIN,
		'Main Org',
		repoArgs.owner,
		USER
	);
	await run(
		`INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at)
		 VALUES (?1, ?2, 'customer', 1, ?3, ?4, '2026-02-01')`,
		ORG_EMPTY,
		'Contoso Group',
		repoArgs.owner,
		USER
	);
	// A third org whose GitHub owner DIFFERS from the other two. Those two share one
	// deliberately, so connect_brain's candidate list can reach the adopt target, which
	// also means the owner cannot reveal which org was resolved. This one can:
	// create_brain names its org's owner on both the success and the failure path.
	const ORG_OTHER = 'org-e2e-other';
	await run(
		`INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at)
		 VALUES (?1, ?2, 'customer', 1, ?3, ?4, '2026-03-01')`,
		ORG_OTHER,
		'Third Party',
		'other-owner-org',
		USER
	);
	await run(
		`INSERT INTO memberships (org_id, user_id, role) VALUES (?1, ?2, 'owner')`,
		ORG_MAIN,
		USER
	);
	await run(
		`INSERT INTO memberships (org_id, user_id, role) VALUES (?1, ?2, 'owner')`,
		ORG_EMPTY,
		USER
	);
	await run(
		`INSERT INTO memberships (org_id, user_id, role) VALUES (?1, ?2, 'owner')`,
		ORG_OTHER,
		USER
	);
	await run(
		`INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, name, visibility, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'org', '2026-01-02')`,
		'b-e2e-main',
		ORG_MAIN,
		repoArgs.owner,
		repoArgs.repo,
		'Main'
	);

	let activeId = brainId;
	// Mirrors the Worker's orgContext minus the two things a test cannot own: minting
	// an installation token, and first-touch provisioning. The DECISION is the real
	// one, which is why it lives in resolveOrgForPerson rather than in the Worker.
	const orgContext = async (opts?: { requires?: Role; org?: string }) => {
		const picked = await resolveOrgForPerson(db, [USER], { org: opts?.org });
		if (!picked) throw new Error('You do not belong to any organization yet.');
		assertRole(picked.role, opts?.requires);
		return {
			octokit: platformOctokit,
			org: picked.org,
			role: picked.role,
			db,
			actorUserId: USER,
			author: undefined
		};
	};

	const brainServer = new McpServer({ name: 'librarian-e2e-brains', version: '0.0.0' });
	registerBrainTools(brainServer, {
		getContext,
		orgContext,
		listOrgs: () => listAccessibleOrgs(db, [USER]),
		listBrains: () => listAccessibleBrains(db, [USER]),
		activeBrainId: () => activeId,
		setActiveBrain: (id: string) => {
			activeId = id;
		},
		invalidateConfig: () => {},
		analyticsEnabled: false
	});
	const [brainCT, brainST] = InMemoryTransport.createLinkedPair();
	await brainServer.connect(brainST);
	const brainClient = new Client({ name: 'e2e-brains', version: '0.0.0' });
	await brainClient.connect(brainCT);
	const callBrain = async (tool: string, args: Record<string, unknown>) => {
		const res = (await brainClient.callTool({ name: tool, arguments: args })) as {
			isError?: boolean;
			content: { type: string; text: string }[];
			structuredContent?: Record<string, unknown>;
		};
		return {
			isError: !!res.isError,
			text: res.content.map((c) => c.text).join('\n'),
			sc: res.structuredContent ?? {}
		};
	};

	let br = await callBrain('brains', {});
	check('brains lists the brain under test', !br.isError && br.text.includes('Main'), br.text);
	const offeredOrgs = (br.sc.orgs as { orgId: string }[] | undefined) ?? [];
	check(
		'brains payload offers BOTH orgs, including the one with no brains',
		offeredOrgs.some((o) => o.orgId === ORG_MAIN) && offeredOrgs.some((o) => o.orgId === ORG_EMPTY),
		JSON.stringify(offeredOrgs)
	);

	// The picker: no `repo` lists what the org's installation can reach and has not
	// already been adopted. The brain under test is adopted, so it must not appear.
	br = await callBrain('connect_brain', { org: 'Contoso Group' });
	// Asserted on the structured ids, not the rendered text: the adopt repo's name has
	// the brain's name as a prefix, so a substring check passes no matter what.
	const candidates = ((br.sc.repos as { id: string }[] | undefined) ?? []).map((r) => r.id);
	check(
		'connect_brain with no repo lists connectable candidates',
		!br.isError && candidates.includes(`${repoArgs.owner}/${adoptRepo}`),
		JSON.stringify(candidates)
	);
	check(
		'...and excludes a repo that is already a brain',
		!candidates.includes(`${repoArgs.owner}/${repoArgs.repo}`),
		JSON.stringify(candidates)
	);

	// THE REGRESSION. Adopting the first repo into an org that holds none. Before the
	// org argument existed this call had no way to name ORG_EMPTY at all, because the
	// only handle was a brain already inside it.
	br = await callBrain('connect_brain', {
		repo: `${repoArgs.owner}/${adoptRepo}`,
		org: 'Contoso Group',
		name: 'Adopted'
	});
	check('connect_brain adopts into a brainless org', !br.isError, br.text);
	const adopted = (await db
		.prepare(`SELECT org_id, visibility, name FROM brains WHERE repo_name = ?1`)
		.bind(adoptRepo)
		.first()) as { org_id?: string; visibility?: string; name?: string } | null;
	check(
		'...writing the brains row into THAT org, not the default one',
		adopted?.org_id === ORG_EMPTY,
		`org_id = ${adopted?.org_id}`
	);
	check(
		'...org-visible, unlike create_brain’s private default',
		adopted?.visibility === 'org',
		`visibility = ${adopted?.visibility}`
	);
	check(
		'...under the caller’s chosen name',
		adopted?.name === 'Adopted',
		`name = ${adopted?.name}`
	);

	br = await callBrain('brains', {});
	check('the adopted brain now shows in the list', br.text.includes('Adopted'), br.text);

	// Guardrails.
	br = await callBrain('connect_brain', {
		repo: `${repoArgs.owner}/${adoptRepo}`,
		org: 'Contoso Group'
	});
	check(
		'connect_brain refuses a repo that is already a brain here',
		br.isError && /already a brain/i.test(br.text),
		br.text
	);
	br = await callBrain('connect_brain', {
		repo: `${repoArgs.owner}/definitely-not-a-real-repo`,
		org: 'Contoso Group'
	});
	check(
		'connect_brain refuses a repo the installation cannot reach',
		br.isError && /can't access/i.test(br.text),
		br.text
	);
	br = await callBrain('connect_brain', { repo: 'x/y', org: 'no-such-org' });
	check(
		'connect_brain refuses an org handle that matches nothing',
		br.isError && /No organization matching/i.test(br.text),
		br.text
	);

	// ── create_brain: the OTHER way a brain lands in an org ──────────────────
	// Scaffolding a fresh repo goes through the Git Data API, which the offline stand-in
	// cannot honestly fake, so the two modes assert different depths of the same thing.
	// Offline proves the ORG RESOLUTION reached the scaffold (the failure names the
	// resolved org's GitHub owner, and only the third org has a distinct one); --github
	// proves the whole act.
	if (GITHUB_MODE) {
		br = await callBrain('create_brain', { name: 'Created By E2E', org: 'Contoso Group' });
		check('create_brain scaffolds a new brain', !br.isError, br.text);
		const made = (await db
			.prepare(`SELECT brain_id, org_id, visibility, repo_name FROM brains WHERE name = ?1`)
			.bind('Created By E2E')
			.first()) as {
			brain_id?: string;
			org_id?: string;
			visibility?: string;
			repo_name?: string;
		} | null;
		if (made?.repo_name) createdRepos.push(made.repo_name);
		check(
			'...into the org the caller named, not the default one',
			made?.org_id === ORG_EMPTY,
			`org_id = ${made?.org_id}`
		);
		check(
			'...PRIVATE by default, the opposite of connect_brain',
			made?.visibility === 'private',
			`visibility = ${made?.visibility}`
		);
		const grant = (await db
			.prepare(`SELECT role FROM brain_memberships WHERE brain_id = ?1 AND user_id = ?2`)
			.bind(made?.brain_id ?? '', USER)
			.first()) as { role?: string } | null;
		check(
			'...with an explicit admin grant for its creator',
			grant?.role === 'admin',
			`grant = ${grant?.role}`
		);
		check(
			'...and it shows in the brain list',
			(await callBrain('brains', {})).text.includes('Created By E2E')
		);
	} else {
		br = await callBrain('create_brain', { name: 'Scratch', org: 'Third Party' });
		check(
			'create_brain resolves the NAMED org before scaffolding',
			br.isError && br.text.includes('other-owner-org'),
			br.text
		);
		check(
			'...and does not silently fall back to the default org',
			!br.text.includes(repoArgs.owner),
			br.text
		);
	}
	br = await callBrain('create_brain', { name: 'Nope', org: 'no-such-org' });
	check(
		'create_brain refuses an org handle that matches nothing',
		br.isError && /No organization matching/i.test(br.text),
		br.text
	);

	await brainClient.close();
	await brainServer.close();
} finally {
	await cleanup();
	await client.close();
	await server.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
