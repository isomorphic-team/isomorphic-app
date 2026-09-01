// The local runtime: MCP over a git repository on disk, in Node, with no accounts.
//
//   pnpm try ~/notes
//   pnpm try ~/notes ~/team-wiki        (several brains; the first is the default)
//
// The third program in this repo, alongside the bootstrap server and the Worker, which
// cannot serve a folder because workerd has no filesystem. What it supplies in place of
// the Worker's bindings:
//
//   env.PLATFORM_DB   -> node:sqlite, shimmed to D1   (src/local/d1-sqlite.ts)
//   env.OAUTH_KV      -> not needed; no active-brain pointer, the first folder is it
//   ctx.waitUntil     -> not needed; nothing is deferred
//   OAuth props       -> one local user, named from git config
//   octokit           -> the fs + git BrainStore       (src/local/brain-store-fs.ts)
//
// The transport needs no substitute: WebStandardStreamableHTTPServerTransport speaks
// web-standard Request/Response and @hono/node-server bridges it to node's http server.
//
// No org model, so no members, invitations, brain sharing, connected accounts or org
// onboarding: with one person those tools can only reject, and the Worker applies the
// same rule via `hasOrgModel`. `brains` / `switch_brain` are absent for the same
// reason (they resolve through the org tables), so a caller SELECTS a brain with the
// `brain` argument every tool already takes rather than by switching into one. No auth
// either; it binds to loopback.
//
// TWO HOSTS reach it, as they reach the Worker. An MCP host connects to `/mcp`, and a
// browser opens `/b/local/<folder>`: the same app bundle the Worker serves as the
// `ui://` resource and at `/b/`, over the same `/mcp`. The web pieces are the shared
// ones in src/lib/web-app.ts (the shell, its headers, the CSRF gate), so what a
// browser exercises here is production code with the brain and the identity swapped
// out, not a harness of it. Nothing sits between the browser and this process: no
// proxy, no second port, and the shell and the tools come up together.

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
import {
	WEB_APP_HEADERS,
	WEB_ROUTE_PREFIX,
	checkWebMcpRequest,
	webPathFor,
	webShell
} from './lib/web-app.ts';
import { statSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
// Every positional argument is a brain. One is the old behaviour exactly.
const dirs = (args.length ? args : [process.cwd()]).map((a) => resolve(a));
const dir = dirs[0];
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

// MORE THAN ONE BRAIN, because a single-brain runtime cannot exercise the question
// "did that call reach the brain it named".
//
// Every folder on the command line is a brain, keyed `local/<folder>` exactly as one
// folder always was, so `pnpm try <folder>` is unchanged and `pnpm try a b c` is the
// new shape. The first is the default, standing in for the connection's active-brain
// pointer, which this runtime has no equivalent of.
//
// This is what made the web app's brain-targeting defect invisible: `getContext` took
// no arguments at all and closed over one store, so a call naming any brain got the
// only one there was, and a URL pointing at another brain looked like it worked.
interface LocalBrain {
	dir: string;
	store: ReturnType<typeof fsBrainStore>;
	repoArgs: { owner: string; repo: string };
	brainId: string;
	label: string;
	db: ReturnType<typeof localD1>['db'];
}

const brains = new Map<string, LocalBrain>();
for (const d of dirs) {
	await ensureGitRepo(d, author);
	// The index lives next to its own brain, so two brains never share one, and a
	// large vault is not reindexed on every launch.
	const stateDir = resolve(d, '.isomorphic');
	mkdirSync(stateDir, { recursive: true });
	const label = basename(d);
	brains.set(`local/${label}`, {
		dir: d,
		store: fsBrainStore({ dir: d, author }),
		repoArgs: { owner: 'local', repo: label },
		brainId: `local/${label}`,
		label,
		db: localD1(resolve(stateDir, 'index.sqlite')).db
	});
}
const defaultBrainId = [...brains.keys()][0];

// Resolve the caller's `brain` handle the way the Worker's `matchBrain` does in
// spirit: the canonical id, else the repo name, else a unique case-insensitive
// substring. Deliberately THROWS on a miss rather than falling back to the default —
// silently serving another brain is the whole bug this multi-brain support exists to
// catch, and a runtime that hides it would be worse than one brain.
function resolveBrain(handle?: string): LocalBrain {
	if (!handle) return brains.get(defaultBrainId)!;
	const exact = brains.get(handle) ?? [...brains.values()].find((b) => b.label === handle);
	if (exact) return exact;
	const hits = [...brains.values()].filter((b) =>
		b.brainId.toLowerCase().includes(handle.toLowerCase())
	);
	if (hits.length === 1) return hits[0];
	const known = [...brains.keys()].join(', ');
	throw new Error(
		hits.length > 1
			? `"${handle}" matches several brains: ${hits.map((b) => b.brainId).join(', ')}.`
			: `No brain matching "${handle}". This runtime serves: ${known}.`
	);
}

// One user, full rights. Both roles report owner, as the Worker's single-tenant path
// does. `opts.brain` is honoured, which is the whole point: the Worker's getContext
// has always received it, and this one used to take no arguments at all.
async function getContext(opts?: { brain?: string }): Promise<BrainContext> {
	const b = resolveBrain(opts?.brain);
	return {
		store: b.store,
		repoArgs: b.repoArgs,
		role: 'owner',
		orgRole: 'owner',
		config: await loadBrainConfig(b.store, b.repoArgs),
		author,
		db: b.db,
		brainId: b.brainId,
		activeBrain: { id: b.brainId, label: b.label }
	};
}

// Brain-authored tools (pages under tools/), from the DEFAULT brain. Discovered once
// at startup rather than per request, since a new tool page needs a reconnect to reach
// the host anyway (the transport cannot push tools/list_changed). Only the default
// brain's are registered, which is a known limitation of this runtime rather than of
// the tool layer: the Worker rediscovers them per request, per brain.
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
	// The same gate the Worker puts in front of its cookie path, on EVERY request
	// here, because there is no credential to tell a browser from an MCP host: the
	// browser sends no cookie (no auth) and the host sends no token (no provider).
	// Every rule is one an MCP client satisfies anyway (a JSON POST with no
	// cross-origin marker), and running it means the shell in a browser goes through
	// exactly what production would refuse it for. `hasAuthorization` is false by
	// construction: that rule says "the OAuth provider owns this request", and there
	// is no provider here for a token to belong to.
	const verdict = checkWebMcpRequest({
		method: c.req.method,
		selfOrigin: new URL(c.req.url).origin,
		origin: c.req.header('origin') ?? null,
		fetchSite: c.req.header('sec-fetch-site') ?? null,
		contentType: c.req.header('content-type') ?? null,
		hasAuthorization: false
	});
	if (!verdict.ok) return c.text(verdict.message, verdict.status as 403);
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

// ---------- the web app ----------

// The generated bundle, re-imported when its file changes, so `pnpm gen:app` in
// another terminal shows up on the next reload rather than being pinned to whatever
// was on disk at launch. Keyed on mtime; the import cache never serves a stale one.
const BUNDLE = new URL('./lib/app-bundle.generated.ts', import.meta.url);
async function bundleHtml(): Promise<string> {
	const stamp = statSync(BUNDLE).mtimeMs;
	const mod = (await import(`${BUNDLE.href}?v=${stamp}`)) as { BRAIN_APP_HTML: string };
	return mod.BRAIN_APP_HTML;
}

// The shell, exactly as the Worker serves it, minus the session check: the Worker
// redirects a signed-out visitor to sign in, and there is nobody to sign in here.
app.get(`${WEB_ROUTE_PREFIX}*`, async (c) =>
	c.html(webShell(await bundleHtml()), 200, WEB_APP_HEADERS)
);
app.get(WEB_ROUTE_PREFIX.slice(0, -1), async (c) =>
	c.html(webShell(await bundleHtml()), 200, WEB_APP_HEADERS)
);
// A bare visit lands on the default brain rather than a 404.
app.get('/', (c) => c.redirect(webPathFor(defaultBrainId, '')));

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
	const toolCount = Object.keys(
		(buildServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
	).length;
	console.log(`\nIsomorphic local: ${basename(dir)}`);
	for (const b of brains.values()) {
		console.log(
			`  brain:  ${b.brainId}${b.brainId === defaultBrainId ? ' (default)' : ''}  ${b.dir}`
		);
	}
	console.log(
		`  tools:  ${toolCount}${custom.defs.length ? ` (${custom.defs.length} brain-authored)` : ''}`
	);
	console.log(`  commits as: ${author.name} <${author.email}>\n`);
	console.log(`Open it in a browser:`);
	console.log(`  http://127.0.0.1:${port}${webPathFor(defaultBrainId, '')}\n`);
	console.log(`Connect a local MCP host:`);
	console.log(`  claude mcp add --transport http isomorphic-local http://127.0.0.1:${port}/mcp\n`);
});
