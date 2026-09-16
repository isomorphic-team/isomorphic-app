// `pnpm web:dev`: the app as a WEB PAGE, over the local runtime.
//
// This is a thin wrapper and is meant to stay one. The local runtime (src/local.ts,
// `pnpm try`) serves the web shell at `/b/` and the real tool handlers at `/mcp`
// itself, exactly as the Worker does, so there is no web server here: this script
// materializes the shared seed onto disk and starts `pnpm try` over it. The first
// version of it WAS a server (a shell route, a CSRF gate and a proxy to a second
// process on a second port), which was a second copy of what the runtime already
// did, plus a race between the two coming up.
//
//   pnpm web:dev              # the three seeded brains, http://127.0.0.1:8788/b/local/demo-brain
//   pnpm web:dev --reset      # start over from a pristine seed
//   pnpm web:dev ~/some/vault # a real folder instead (no seeding)
//
// `pnpm app:dev` renders the same bundle as an MCP App: mounted in a sandboxed
// iframe and driven over AppBridge, with the tools stubbed in dev/harness.ts. That is
// the other host. Both seed from dev/seed.ts, so a difference you notice between the
// two is a difference in the app, not in what it was handed.
//
// WHAT NEITHER REPRODUCES IS AUTHENTICATION. In production `/b/...` reads an Auth.js
// session cookie and redirects to sign-in without one, and the `/mcp` branch builds
// `props` from that session. The local runtime has no session, no cookie and no
// identity, and reports `owner` for everything. Right tool for the app's behaviour,
// wrong tool for anything about access.

import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	personalPages,
	ACME_PAGES,
	NORTHWIND_PAGES,
	SAMPLE_PNG,
	PERSONAL_ASSET_PATH
} from '../dev/seed.ts';

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const RESET = process.argv.includes('--reset');
// Default: the SAME brain `pnpm app:dev` shows, materialized on disk (dev/seed.ts).
// An explicit folder overrides it, for pointing this at a real vault. `BRAIN_DIR` is
// for callers that own the directory and want it seeded anyway: the web UI tests
// point it at a throwaway path so a run never depends on, or disturbs, the brain a
// maintainer has been editing.
const root = args[0] ? resolve(args[0]) : resolve(process.env.BRAIN_DIR ?? abs('dev/demo-brain'));
const seeded = !args[0];

// THREE BRAINS, the same three `pnpm app:dev` shows, because one brain cannot
// exercise the question "did that reach the brain it named". Seeded as sibling
// folders NAMED AFTER the root (`demo-brain-acme`, not `acme`): the test run uses its
// own BRAIN_DIR and `--reset`, so unprefixed siblings would be shared with the
// preview and wiped out from under a maintainer mid-session. The local runtime keys
// each by folder name, so the URLs are `/b/local/demo-brain`,
// `/b/local/demo-brain-acme`, `/b/local/demo-brain-northwind`.
const SEEDS: { name: string; pages: () => Record<string, string>; asset?: string }[] = [
	{ name: basename(root), pages: personalPages, asset: PERSONAL_ASSET_PATH },
	{ name: 'acme', pages: () => ({ ...ACME_PAGES }) },
	{ name: 'northwind', pages: () => ({ ...NORTHWIND_PAGES }) }
];
const dirFor = (name: string) =>
	name === basename(root) ? root : resolve(root, '..', `${basename(root)}-${name}`);

// Seeded once and then left alone, because the copy on disk is a real git repo that
// the app WRITES to: re-seeding every launch would silently discard the edits you
// made last time. `--reset` is the way back to a pristine one. Only when we own the
// directory; an explicit path is the operator's.
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
	return spawn(cmd, cmdArgs, { cwd: abs('.'), stdio: 'inherit', env: process.env });
}

// Regenerate the bundle first, exactly as app:dev does: the point is to serve the
// bytes the Worker would. The runtime re-reads it on change after that.
await new Promise<void>((r) => run('pnpm', ['gen:app']).on('close', () => r()));

const dirs = seeded ? SEEDS.map((s) => dirFor(s.name)) : [root];
const runtime = run('pnpm', ['try', ...dirs]);
runtime.on('close', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => runtime.kill(sig));
}
