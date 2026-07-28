// Manual end-to-end battery for the librarian write tools — covers the write_page
// create/update/publish surface, its non-destructive append/edits modes (partial
// edits that never send the rest of the page), and the index-driven page discovery the write path
// relies on (delete_page "still referenced" notes via backlinksTo; move_page link
// repointing via fetchInboundLinkersForPaths, for both a single page and a folder
// subtree — move_page/delete_page take a folder path with no .md).
//
// NOT wired into CI (see docs/roadmap.md test-harness "skip list" — no real-GitHub E2E
// in CI). Run it by hand when the write tools change:
//
//   pnpm exec tsx scripts/e2e-librarian.ts
//
// Requires `.dev.vars` (repo root, or DEV_VARS_PATH env var) with the platform
// App creds + PLATFORM_ORG / PLATFORM_INSTALLATION_ID. Creates a scratch brain
// repo `brain-librarian-e2e-*` on the platform org, drives the REAL MCP tool
// handlers against it through an in-memory client transport, and deletes the
// repo afterwards (success or failure). The content index runs on a real SQLite
// database via node:sqlite (Node 22+), shimmed to the D1 surface brain-index
// uses — so ensureFresh / loadResolvedGraph / backlinksTo run for real, exactly
// like prod. (Mirrors e2e-import.ts.)
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerLibrarianTools } from '../src/tools/librarian.ts';
import { loadCustomToolDefs, registerCustomTools } from '../src/tools/custom.ts';
import { installationOctokit } from '../src/lib/github.ts';
import { createAndScaffoldBrain } from '../src/lib/scaffold-core.ts';
import { loadBrainConfig } from '../src/lib/brain-config.ts';

// ---- env from .dev.vars (values may be quoted) ----
const devVarsPath = process.env.DEV_VARS_PATH ?? new URL('../.dev.vars', import.meta.url).pathname;
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
	{ appId: Number(devVars.GITHUB_APP_ID), privateKeyBase64: devVars.GITHUB_APP_PRIVATE_KEY_BASE64 },
	installationId
);

// ---- D1 shim over node:sqlite (only the surface brain-index uses) ----
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../src/db/index-schema.sql', import.meta.url), 'utf8'));
function shimStatement(sql: string, params: unknown[] = []) {
	return {
		bind: (...p: unknown[]) => shimStatement(sql, p),
		first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
		all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
		run: async () => {
			sqlite.prepare(sql).run(...(params as []));
			return { success: true };
		}
	};
}
const db = {
	prepare: (sql: string) => shimStatement(sql),
	batch: async (stmts: { run: () => Promise<unknown> }[]) => {
		for (const s of stmts) await s.run();
		return [];
	}
} as never;

// ---- scratch repo ----
const name = `brain-librarian-e2e-${Date.now().toString(36)}`;
console.log(`Creating scratch brain ${org}/${name} …`);
const brain = await createAndScaffoldBrain(octokit, {
	org,
	name,
	description: 'Librarian E2E test — safe to delete'
});
const repoArgs = { owner: brain.owner, repo: brain.name };
const brainId = `${brain.owner}/${brain.name}`;

// ---- in-memory MCP client wired to the real handlers, with a full context ----
const server = new McpServer({ name: 'librarian-e2e', version: '0.0.0' });
const getContext = async () => ({
	octokit,
	repoArgs,
	role: 'owner' as const,
	orgRole: 'owner' as const,
	config: await loadBrainConfig(octokit, repoArgs),
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
	const { data } = await octokit.rest.git.getRef({ ...repoArgs, ref: 'heads/main' });
	return data.object.sha;
}
async function fileText(path: string): Promise<string | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ ...repoArgs, path });
		if (Array.isArray(data) || (data as { type: string }).type !== 'file') return null;
		return Buffer.from((data as { content: string }).content, 'base64').toString('utf8');
	} catch {
		return null;
	}
}
async function assertOneCommit(label: string, before: string) {
	const data = await eventually(
		async () =>
			(await octokit.rest.git.getCommit({ ...repoArgs, commit_sha: await headSha() })).data,
		(d) => d.parents.length === 1 && d.parents[0].sha === before
	);
	check(
		`${label}: exactly one commit`,
		data.parents.length === 1 && data.parents[0].sha === before,
		`parent=${data.parents[0]?.sha?.slice(0, 7)} expected=${before.slice(0, 7)}`
	);
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
	let before = await settledHead();
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
	before = await settledHead();
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
	before = await settledHead();
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
	before = await settledHead();
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

	before = await settledHead();
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
	before = await settledHead();
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

	before = await settledHead();
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

	// The brain is still internally consistent after the move.
	r = await call('validate', {});
	check('validate clean after move_page (folder)', /no problems found/.test(r.text), r.text);

	// ══ move_page (single file): the .md path form still moves + repoints. ═════
	await waitInbound('wiki/work/alpha.md', 'wiki/notes/ref.md');
	before = await settledHead();
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
} finally {
	console.log(`\nDeleting scratch repo ${org}/${name} …`);
	try {
		await octokit.rest.repos.delete(repoArgs);
		console.log('Deleted.');
	} catch (err) {
		console.log(
			`Could not delete (${(err as { status?: number }).status}) — delete manually: https://github.com/${org}/${name}/settings`
		);
	}
	await client.close();
	await server.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
