// Dev server for the MCP App UI (`pnpm app:dev`).
//
// The brain viewer/editor is normally codegen'd into the Worker and only renders
// inside a real MCP host (claude.ai). This serves the SAME generated ui:// bytes
// locally, driven by the official AppBridge host (dev/harness.ts) with stubbed
// tools over in-memory fixtures — so you can iterate on the tree/editor UI with no
// Worker, no auth, and no host.
//
// Loop: edit anything in app/ (or src/lib/wiki.ts) -> the ui:// bundle regenerates
// (pnpm gen:app) -> esbuild rebuilds the harness -> the browser live-reloads.
//
// Caveat: tools are STUBBED against fixtures, so this exercises the UI, not the real
// path-based create/move/delete against a GitHub repo. For that, run `pnpm worker:dev`
// and point a local MCP host (Inspector / Claude Desktop) at http://localhost:8787/mcp.

import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const PORT = Number(process.env.PORT) || 5175; // override with PORT=… (e.g. parallel worktrees)

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
	// Skip ALL codegen outputs (.tailwind.out.css, views/registry.generated.ts) —
	// gen:app writes them into app/, so reacting to them is an infinite watch loop.
	if (!file || !/\.(tsx|ts|css|html)$/.test(file)) return;
	if (file.includes('.tailwind.out') || file.includes('.generated.')) return;
	if (timer) clearTimeout(timer);
	timer = setTimeout(runGenApp, 150);
};
watch(abs('app'), { recursive: true }, (_e, f) => trigger(f ?? undefined));
watch(abs('src/lib/wiki.ts'), () => trigger('wiki.ts'));

console.log(`\n  app:dev → http://localhost:${port}/`);
console.log('  Edit app/* → the ui:// bundle regenerates and the browser live-reloads.');
console.log(
	'  Views:  /   ·   /#browse   ·   /#edit   ·   /#edit=wiki/playbooks/brand-voice.md   ·   ?mode=pip\n'
);
