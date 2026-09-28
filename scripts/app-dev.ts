// Dev server for the MCP App UI (`pnpm app:dev`).
//
// Serves the generated ui:// bytes locally inside a sandboxed iframe, driven by the
// official AppBridge host (dev/harness.ts) with stubbed tools over in-memory fixtures:
// the tree/editor UI with no Worker, no auth, and no MCP host.
//
// Loop: edit anything in app/ or src/lib/ (the app imports a dozen lib modules, and
// they import more) -> the ui:// bundle regenerates (pnpm gen:app) -> esbuild rebuilds
// the harness -> the browser live-reloads.
//
// Caveat: tools are STUBBED against fixtures, so this exercises the UI, not the real
// write path. For the real tools over a git repo on disk, run `pnpm web:dev` (or
// `pnpm try <folder>`); for the Worker, `pnpm worker:dev` plus a local MCP host
// (Inspector / Claude Desktop) at http://localhost:8787/mcp.

import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createReadStream, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const PORT = Number(process.env.PORT) || 5175; // override with PORT=… (e.g. parallel worktrees)

// `--once`: build the harness bundle a single time and serve it statically, with no
// file watchers, no regeneration, and no live-reload channel. This is what
// `pnpm test:ui` starts.
//
// A watching dev server never settles, which is right for a human and wrong for a
// test runner: esbuild's serve() rebuilds on incoming requests and pushes a `change`
// event down /esbuild, so a reload can land in the middle of an assertion and the
// failure looks like a flaky app rather than a moving server. Serving still runs
// forever either way — Playwright's webServer owns the lifecycle and kills it.
const ONCE = process.argv.includes('--once');

function genApp(): Promise<void> {
	return new Promise((resolve) => {
		spawn('pnpm', ['gen:app'], { cwd: abs('.'), stdio: 'inherit' }).on('close', () => resolve());
	});
}

// Regenerate the ui:// bundle before the first harness build.
await genApp();

const ctx = await context({
	entryPoints: [abs('dev/harness.ts')],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	outfile: abs('dev/bundle.js'),
	loader: { '.json': 'json' },
	logLevel: 'info'
});
// --once: one build, then a plain static server. Nothing rebuilds, nothing reloads.
if (ONCE) {
	await ctx.rebuild();
	await ctx.dispose();
	const MIME: Record<string, string> = {
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.map': 'application/json; charset=utf-8'
	};
	const root = abs('dev');
	createServer(async (req, res) => {
		// Path only: the harness reads ?now=/?mode= client-side, and a query string must
		// not become part of the filename we try to open.
		const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
		const file = join(root, rel === '/' || rel.endsWith('/') ? `${rel}/index.html` : rel);
		// Contain the server to dev/ even though it only ever serves this repo's own
		// files: a static server that honours `..` is not one to leave lying around.
		if (!file.startsWith(root)) {
			res.writeHead(403).end('forbidden');
			return;
		}
		try {
			if (!(await stat(file)).isFile()) throw new Error('not a file');
		} catch {
			res.writeHead(404).end('not found');
			return;
		}
		res.writeHead(200, {
			'content-type': MIME[extname(file)] ?? 'application/octet-stream',
			// The harness is rebuilt per run; a cached bundle would silently test the last one.
			'cache-control': 'no-store'
		});
		createReadStream(file).pipe(res);
	}).listen(PORT);
	console.log(`\n  app:dev --once → http://localhost:${PORT}/  (static, no watch)\n`);
} else {
	await startWatchMode();
}

// The normal `pnpm app:dev` loop: watch, rebuild, live-reload.
async function startWatchMode() {
	await ctx.watch(); // rebuilds dev/bundle.js whenever the generated bundle (or harness) changes
	const { port } = await ctx.serve({ servedir: abs('dev'), port: PORT });

	// Regenerate the ui:// bundle when app sources change; esbuild then rebuilds the
	// harness and the browser reloads. Skip the codegen outputs to avoid a watch loop.
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let rerun = false;
	const runGenApp = async () => {
		// Re-entrancy guard: a watch event landing mid-run queues exactly one follow-up
		// instead of piling up overlapping pnpm/tsx/esbuild process chains.
		if (running) {
			rerun = true;
			return;
		}
		running = true;
		await genApp();
		running = false;
		if (rerun) {
			rerun = false;
			void runGenApp();
		}
	};
	const trigger = (file?: string) => {
		// Skip ALL codegen outputs (.tailwind.out.css, views/registry.generated.ts,
		// src/lib/app-bundle.generated.ts): gen:app writes them, so reacting to them is an
		// infinite watch loop.
		if (!file || !/\.(tsx|ts|css|html)$/.test(file)) return;
		if (file.includes('.tailwind.out') || file.includes('.generated.')) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(runGenApp, 150);
	};
	// All of src/lib/ rather than the files app/ imports today: the import graph grows,
	// and a lib edit the watcher misses serves a stale bundle with no error.
	// gen:app writes src/lib/app-bundle.generated.ts, which `trigger` skips.
	watch(abs('app'), { recursive: true }, (_e, f) => trigger(f ?? undefined));
	watch(abs('src/lib'), { recursive: true }, (_e, f) => trigger(f ?? undefined));

	console.log(`\n  app:dev → http://localhost:${port}/`);
	console.log(
		'  Edit app/* or src/lib/* → the ui:// bundle regenerates and the browser live-reloads.'
	);
	console.log(
		'  Views:  /   ·   /#browse   ·   /#edit   ·   /#edit=wiki/playbooks/brand-voice.md   ·   ?mode=pip\n'
	);
}
