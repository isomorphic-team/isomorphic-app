// The local runtime: MCP over a git repository on disk, in Node, with no accounts.
//
//   pnpm try ~/notes
//
// The third program in this repo, alongside the bootstrap server and the Worker, which
// cannot serve a folder because workerd has no filesystem. What it supplies in place of
// the Worker's bindings:
//
//   env.PLATFORM_DB   -> node:sqlite, shimmed to D1   (src/local/d1-sqlite.ts)
//   env.OAUTH_KV      -> not needed; one brain, one user
//   ctx.waitUntil     -> not needed; nothing is deferred
//   OAuth props       -> one local user, named from git config
//   octokit           -> the fs + git BrainStore       (src/local/brain-store-fs.ts)
//
// The transport needs no substitute: WebStandardStreamableHTTPServerTransport speaks
// web-standard Request/Response and @hono/node-server bridges it to node's http server.
//
// No org model, so no members, invitations, brain sharing, connected accounts, org
// onboarding, or brain switching: with one brain and one person those tools can only
// reject. The Worker applies the same rule via `hasOrgModel`. No auth either; it binds
// to loopback.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { registerCoreTools } from './tools/core.ts';
import { registerMediaTools } from './tools/media.ts';
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

// The operator's git identity, so commits are attributed to them.
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

// The content index is kept next to the brain rather than in memory, so a large vault
// is not reindexed on every launch.
const stateDir = resolve(dir, '.isomorphic');
mkdirSync(stateDir, { recursive: true });
const { db } = localD1(resolve(stateDir, 'index.sqlite'));

// One brain, one user, full rights. Both roles report owner, as the Worker's
// single-tenant path does.
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

// One server per request, like the Worker. An McpServer binds to a single transport, so
// a reused one answers the first call and 500s on every one after.
function buildServer(): McpServer {
	const server = new McpServer(
		{ name: 'isomorphic-local', title: `Isomorphic (${basename(dir)})`, version: '0.1.0' },
		{ instructions: SERVER_INSTRUCTIONS }
	);

	registerCoreTools(server, getContext);
	registerMediaTools(server, getContext);
	registerLibrarianTools(server, getContext);
	registerImportTools(server, getContext);
	registerBrainApp(server, getContext);
	registerCustomTools(server, getContext, custom.defs);

	// The claude.ai compatibility shim, as in worker.ts: SDK 1.29 stamps `execution` on
	// every registration and claude.ai's client-side validation rejects the field.
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
// Same 405 as the Worker: the stateless transport offers no server-to-client stream,
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
