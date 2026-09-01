// Dev server for the WEB app (`pnpm web:dev <folder>`).
//
// `pnpm app:dev` renders the same bundle, but as an MCP App: mounted in a
// sandboxed iframe and driven over AppBridge postMessage. That is the other
// host. The web app is the same bytes as a TOP-LEVEL DOCUMENT, where tool calls
// go over `fetch('/mcp')` and the URL is the navigation state — so none of
// `app/core/host-web.ts`, `parseWebPath`, or the shell is reachable from the
// harness, however complete its fixtures are.
//
// This serves that host. Two halves, both of them the real thing:
//
//   the shell   `webShell(BRAIN_APP_HTML)` + `WEB_APP_HEADERS` from
//               src/lib/web-app.ts, byte for byte what the Worker returns.
//   the tools   `checkWebMcpRequest` — the REAL CSRF gate — in front of a proxy
//               to the local runtime (src/local.ts), which answers with the
//               REAL tool handlers over a real git repo on disk.
//
// So the whole path under test is production code: the shell, the flag, the
// transport in host-web.ts, the URL round-trip, and every tool handler. What is
// stubbed is only where the brain lives (a folder instead of GitHub) and who you
// are (below).
//
// THE ONE THING THIS DOES NOT REPRODUCE IS AUTHENTICATION, and it is the half
// most worth remembering. In production `/b/...` reads an Auth.js session cookie
// and redirects to sign-in without one, and the `/mcp` branch builds `props`
// from that session. Here there is no session, no cookie and no identity: the
// local runtime is single-tenant and reports `owner` for everything. That makes
// this the right tool for the app's behaviour and the wrong tool for anything
// about access. Bind to loopback only, and never point it at a real brain.

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	webShell,
	WEB_APP_HEADERS,
	checkWebMcpRequest,
	webPathFor,
	WEB_ROUTE_PREFIX
} from '../src/lib/web-app.ts';
import {
	personalPages,
	ACME_PAGES,
	NORTHWIND_PAGES,
	SAMPLE_PNG,
	PERSONAL_ASSET_PATH
} from '../dev/seed.ts';

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const BUNDLE = abs('src/lib/app-bundle.generated.ts');

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const RESET = process.argv.includes('--reset');
// Default: the SAME brain `pnpm app:dev` shows, materialized on disk (dev/seed.ts).
// An explicit folder overrides it, for pointing this at a real vault.
// `BRAIN_DIR` is for callers that own the directory and want it seeded anyway —
// the web UI tests point it at a throwaway path so a run never depends on, or
// disturbs, the brain a maintainer has been editing.
const root = args[0] ? resolve(args[0]) : resolve(process.env.BRAIN_DIR ?? abs('dev/demo-brain'));
const seeded = !args[0];

// THREE BRAINS, the same three `pnpm app:dev` shows, because one brain cannot
// exercise the question "did that reach the brain it named". The web app's
// brain-targeting defect was invisible here for exactly that reason: the URL named a
// brain, the runtime had only one, and being wrong looked identical to being right.
//
// Seeded as sibling folders so the local runtime's `local/<folder>` ids line up with
// the URLs: `/b/local/demo-brain`, `/b/local/acme`, `/b/local/northwind`.
const SEEDS: { name: string; pages: () => Record<string, string>; asset?: string }[] = [
	{ name: basename(root), pages: personalPages, asset: PERSONAL_ASSET_PATH },
	{ name: 'acme', pages: () => ({ ...ACME_PAGES }) },
	{ name: 'northwind', pages: () => ({ ...NORTHWIND_PAGES }) }
];
// Siblings NAMED AFTER the root, not bare `acme`/`northwind`. The test server runs
// with its own BRAIN_DIR and `--reset`, so unprefixed siblings would be shared with
// the preview and wiped out from under a maintainer mid-session.
const dirFor = (name: string) =>
	name === basename(root) ? root : resolve(root, '..', `${basename(root)}-${name}`);
const dir = root;
// NOT 5175 (`pnpm app:dev`) and NOT 5176 (UI_TEST_PORT in playwright.config.ts):
// a maintainer with the preview open, or a test run in flight, must not have this
// steal the port.
const PORT = Number(process.env.PORT) || 5177;
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT) || 8788;
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;

// The local runtime derives its brain id from the folder name, so the web URL
// that names it is fixed by the same fact. Keeping the derivation here rather
// than asking upstream means the first link is printable before it is ready.
const brainId = `local/${basename(dir)}`;

// Write the shared seed out as a folder. Only when we own the directory: an
// explicit path is the operator's, and seeding into it would overwrite pages.
//
// Seeded once and then left alone, because the copy on disk is a real git repo
// that the app WRITES to — re-seeding every launch would silently discard the
// edits you made last time, which is the opposite of what a local brain is for.
// `--reset` is the way back to a pristine one.
if (seeded) {
	for (const seed of SEEDS) {
		const target = dirFor(seed.name);
		if (RESET) rmSync(target, { recursive: true, force: true });
		if (existsSync(target)) continue;
		const write = (rel: string, body: string | Buffer) => {
			const file = resolve(target, rel);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, body);
		};
		for (const [path, body] of Object.entries(seed.pages())) write(path, body);
		if (seed.asset) write(seed.asset, Buffer.from(SAMPLE_PNG, 'base64'));
		console.log(`  seeded ${target} from dev/seed.ts`);
	}
}

function run(cmd: string, cmdArgs: string[]) {
	return spawn(cmd, cmdArgs, { cwd: abs('.'), stdio: 'inherit' });
}

// Regenerate the ui:// bundle before serving, exactly as app:dev does — the
// whole point is to serve the bytes the Worker would.
await new Promise<void>((r) => run('pnpm', ['gen:app']).on('close', () => r()));

// Re-imported per shell request, keyed on the generated file's mtime, so
// `pnpm gen:app` in another terminal shows up on the next reload instead of
// being pinned to whatever was on disk at boot. (No live-reload channel: a web
// page reloads by being reloaded, and the editor holds unsaved state that an
// automatic refresh would discard.)
async function bundleHtml(): Promise<string> {
	const stamp = statSync(BUNDLE).mtimeMs;
	const mod = (await import(`${BUNDLE}?v=${stamp}`)) as { BRAIN_APP_HTML: string };
	return mod.BRAIN_APP_HTML;
}

// The local runtime: the real tool handlers, over the folder.
// Its PORT is passed explicitly rather than left to the runtime's own default, so
// two of these (a preview and a test run) do not fight over one upstream.
const upstream = spawn('pnpm', ['try', ...SEEDS.map((s) => dirFor(s.name))], {
	cwd: abs('.'),
	stdio: 'inherit',
	env: { ...process.env, PORT: String(UPSTREAM_PORT) }
});
upstream.on('close', (code) => {
	console.error(`\n  the local runtime exited (${code}); shutting down.\n`);
	process.exit(code ?? 1);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => {
		upstream.kill(sig);
		process.exit(0);
	});
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((res, rej) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => res(body));
		req.on('error', rej);
	});
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const selfOrigin = `http://localhost:${PORT}`;

	// The app's tool calls. The gate is the real one, so a request this server
	// refuses is a request production refuses.
	if (url.pathname === '/mcp') {
		const verdict = checkWebMcpRequest({
			method: req.method ?? 'GET',
			selfOrigin,
			origin: req.headers.origin ?? null,
			fetchSite: (req.headers['sec-fetch-site'] as string) ?? null,
			contentType: req.headers['content-type'] ?? null,
			hasAuthorization: Boolean(req.headers.authorization)
		});
		if (!verdict.ok) {
			res.writeHead(verdict.status, { 'content-type': 'text/plain' }).end(verdict.message);
			return;
		}
		// Past the gate, production would resolve a session here and build
		// `props` from it. There is nothing to resolve: see the header comment.
		try {
			const upstreamRes = await fetch(UPSTREAM, {
				method: 'POST',
				headers: {
					accept: 'application/json, text/event-stream',
					'content-type': 'application/json'
				},
				body: await readBody(req)
			});
			const text = await upstreamRes.text();
			res
				.writeHead(upstreamRes.status, {
					'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
					'cache-control': 'no-store'
				})
				.end(text);
		} catch (err) {
			// Almost always the local runtime still starting up, which is worth
			// saying plainly rather than surfacing as a tool error in the app.
			res
				.writeHead(502, { 'content-type': 'text/plain' })
				.end(`the local runtime is not answering on ${UPSTREAM}: ${String(err)}`);
		}
		return;
	}

	// The shell. Production checks a session first and redirects to sign-in
	// without one; there is no session here, so it always serves.
	if (url.pathname === WEB_ROUTE_PREFIX.slice(0, -1) || url.pathname.startsWith(WEB_ROUTE_PREFIX)) {
		res.writeHead(200, { ...WEB_APP_HEADERS }).end(webShell(await bundleHtml()));
		return;
	}

	// A bare visit lands on the brain rather than a 404, since the folder this
	// was started against is the only thing it can show.
	if (url.pathname === '/') {
		res.writeHead(302, { location: webPathFor(brainId, '') }).end();
		return;
	}

	res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}).listen(PORT, '127.0.0.1');

console.log(`\n  web:dev → http://localhost:${PORT}${webPathFor(brainId, '')}`);
console.log(
	`  brain:    ${dir}${seeded ? '  (dev/seed.ts — same as app:dev; --reset to restore)' : ''}`
);
console.log(`  tools:    proxied to the local runtime on ${UPSTREAM}`);
console.log('  NO AUTH — loopback only, single-tenant, everything reports owner.\n');
