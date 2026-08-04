// The local runtime: MCP over a git repository on disk, in Node, with no accounts.
//
//   pnpm try ~/notes
//
// The third program in this repo, alongside the bootstrap server and the Worker. It
// exists because the Worker cannot do this: workerd has no filesystem. What it is NOT
// is a port. The Worker-shaped things it has to supply are three stubs and one real
// adapter:
//
//   env.PLATFORM_DB   -> node:sqlite, shimmed to D1     (src/local/d1-sqlite.ts)
//   env.OAUTH_KV      -> not needed; there is one brain and one user
//   ctx.waitUntil     -> not needed; nothing is deferred
//   OAuth props       -> one local user, named from git config
//   octokit           -> the fs + git BrainStore          (src/local/brain-store-fs.ts)
//
// The transport needs no substitute at all: WebStandardStreamableHTTPServerTransport
// speaks web-standard Request/Response, which Node has, and @hono/node-server bridges
// the two.
//
// WHAT IS DELIBERATELY ABSENT. There is no org model, so no members, invitations,
// brain sharing, connected accounts, org onboarding, or brain switching: with one
// brain and one person those tools can only reject, and an advertised tool costs
// context in every conversation. Same rule as FEEDBACK_REPO, and the same rule
// `hasOrgModel` applies in the Worker. There is also no auth: the server binds to
// loopback only, and anything reachable by other people belongs on the Worker.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { registerCoreTools } from './tools/core.ts';
import { registerLibrarianTools, type BrainContext } from './tools/librarian.ts';
import { registerImportTools } from './tools/importer.ts';
import { registerBrainApp } from './tools/apps.ts';
import { loadCustomToolDefs, registerCustomTools } from './tools/custom.ts';
import { loadBrainConfig } from './lib/brain-config.ts';
import { SERVER_INSTRUCTIONS } from './lib/server-instructions.ts';
import { ensureGitRepo, fsBrainStore } from './local/brain-store-fs.ts';
import { localD1 } from './local/d1-sqlite.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const dir = resolve(args[0] ?? process.cwd());
const port = Number(process.env.PORT ?? 8788);

// Read the operator's git identity so commits are attributed to them rather than to
// a placeholder. Their own repo, their own name on the history.
function gitIdentity(): { name: string; email: string } {
	const read = (key: string, fallback: string) => {
		try {
			return execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim() || fallback;
		} catch {
			return fallback;
		}
	};
	return {
		name: read('user.name', 'Local User'),
		email: read('user.email', 'local@localhost')
	};
}

const author = gitIdentity();
await ensureGitRepo(dir, author);

const store = fsBrainStore({ dir, author });
const repoArgs = { owner: 'local', repo: basename(dir) };
const brainId = `local/${basename(dir)}`;

// The content index is kept next to the brain rather than in memory: rebuilding the
// index of a large vault on every launch is slow and buys nothing.
const stateDir = resolve(dir, '.isomorphic');
mkdirSync(stateDir, { recursive: true });
const { db } = localD1(resolve(stateDir, 'index.sqlite'));

// One brain, one user, full rights. `role` and `orgRole` both report owner for the
// same reason the Worker's single-tenant path does: there is nobody else to be.
async function getContext(): Promise<BrainContext> {
	return {
		store,
		repoArgs,
		role: 'owner',
		orgRole: 'owner',
		config: await loadBrainConfig(store, repoArgs),
		author,
		db,
		brainId,
		activeBrain: { id: brainId, label: basename(dir) }
	};
}

// Brain-authored tools (pages under tools/). Discovered once at startup rather than
// per request: this process serves one brain, and a new tool page needs a reconnect
// to reach the host anyway (the transport cannot push tools/list_changed).
const custom = await loadCustomToolDefs(await getContext()).catch(() => ({ defs: [], errors: [] }));

// ONE SERVER PER REQUEST, like the Worker. An McpServer binds to a single transport,
// so reusing one across requests answers the first call and then 500s on every one
// after it. Registration is cheap; the index and the git repo hold the state.
function buildServer(): McpServer {
	const server = new McpServer(
		{ name: 'isomorphic-local', title: `Isomorphic (${basename(dir)})`, version: '0.1.0' },
		{ instructions: SERVER_INSTRUCTIONS }
	);

	registerCoreTools(server, getContext);
	registerLibrarianTools(server, getContext);
	registerImportTools(server, getContext);
	registerBrainApp(server, getContext);
	registerCustomTools(server, getContext, custom.defs);

	// The claude.ai compatibility shim, for the same reason worker.ts carries it: SDK
	// 1.29 stamps `execution` on every registration and claude.ai's client-side
	// validation rejects the unfamiliar field.
	const registered = (
		server as unknown as { _registeredTools: Record<string, { execution?: unknown }> }
	)._registeredTools;
	for (const tool of Object.values(registered)) tool.execution = undefined;
	return server;
}

const app = new Hono();
app.post('/mcp', async (c) => {
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await buildServer().connect(transport);
	return transport.handleRequest(c.req.raw);
});
// Same 405 as the Worker: the stateless transport offers no server-to-server stream,
// and answering GET makes compliant clients retry forever.
app.all('/mcp', (c) => c.text('Method Not Allowed', 405, { Allow: 'POST' }));

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
	const toolCount = Object.keys(
		(buildServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
	).length;
	console.log(`\nIsomorphic local: ${basename(dir)}`);
	console.log(`  brain:  ${dir}`);
	console.log(
		`  tools:  ${toolCount}${custom.defs.length ? ` (${custom.defs.length} brain-authored)` : ''}`
	);
	console.log(`  commits as: ${author.name} <${author.email}>\n`);
	console.log(`Connect a local MCP host:`);
	console.log(`  claude mcp add --transport http isomorphic-local http://127.0.0.1:${port}/mcp\n`);
});
