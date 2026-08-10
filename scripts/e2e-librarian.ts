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
		for (const repo of [name, adoptRepo]) {
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

	await brainClient.close();
	await brainServer.close();
} finally {
	await cleanup();
	await client.close();
	await server.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
