// run_script's sandbox (src/lib/code-mode.ts). The pure checks run in this process; the
// rest run scripts in a real Dynamic Worker under `wrangler dev`, through the caller
// Worker in scripts/workers/code-mode-caller.ts, with no Cloudflare account.
//
//   pnpm test:code-mode
//
// What it exists to catch:
//   1. A DECLARATION THAT LIES. The API the model reads names exactly the methods a
//      script can call.
//   2. A SANDBOX THAT REACHES OUT. fetch throws; the script sees no env or credential.
//   3. A RUN THAT NEVER ENDS OR NEVER STOPS CALLING. The wall clock and the call meter
//      each end a run with an error, and the next run still works. Local workerd does
//      not enforce a Dynamic Worker's `cpuMs` (a busy loop hangs the caller), so for the
//      CPU limit this battery pins only that every load passes SANDBOX_LIMITS and no network.
//   4. OUTPUT THAT FLOODS THE MODEL. A reply is cut at OUTPUT_MAX_CHARS.
//   5. ERRORS THAT VANISH. A syntax error, a throw and a bad argument each come back as
//      an error the model can read, with the lines logged before it.
//   6. A TEMPLATE THAT DOES NOT PARSE. The `code-mode` block is kept or dropped cleanly.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BRAIN_API_DECLARATION,
	BRAIN_API_METHODS,
	OUTPUT_MAX_CHARS,
	SANDBOX_LIMITS,
	SCRIPT_MAX_CHARS,
	formatScriptResult,
	meteredApi,
	runScript,
	scriptProblem,
	type BrainApi,
	type ScriptLoader,
	type ScriptResult
} from '../src/lib/code-mode.ts';
import { checker } from './check.ts';
import { optionalBlock } from './optional-block.ts';
import { parseJsonc } from './preview.ts';
import { waitForOrigin } from './smoke.ts';

const { check, done } = checker('code-mode checks');
const root = fileURLToPath(new URL('..', import.meta.url));

// ---------- pure ----------

{
	const declared = [...BRAIN_API_DECLARATION.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
	check(
		'the declaration names exactly the methods a script can call',
		declared.join() === [...BRAIN_API_METHODS].join(),
		declared.join()
	);

	check('an empty script is refused', scriptProblem('  \n') !== null);
	check('an oversized script is refused', scriptProblem('x'.repeat(SCRIPT_MAX_CHARS + 1)) !== null);
	check('an ordinary script is accepted', scriptProblem('return 1;') === null);

	const r = (over: Partial<ScriptResult>): ScriptResult => ({
		logs: [],
		value: null,
		calls: 0,
		...over
	});
	const big = formatScriptResult(r({ logs: ['x'.repeat(OUTPUT_MAX_CHARS * 2)] }));
	check(
		'a reply is cut at OUTPUT_MAX_CHARS and says so',
		big.text.length < OUTPUT_MAX_CHARS + 200 && /more characters cut/.test(big.text),
		String(big.text.length)
	);
	const failed = formatScriptResult(r({ logs: ['before'], error: 'boom', calls: 2 }));
	check(
		'an error keeps the lines logged before it and is an error result',
		failed.isError && failed.text.startsWith('before') && failed.text.includes('Error: boom'),
		failed.text
	);
	check(
		'an empty run says so',
		formatScriptResult(r({})).text.startsWith('The script logged and returned nothing.')
	);
}

{
	const seen: unknown[] = [];
	const inner: BrainApi = {
		search: async (q, o) => (seen.push(o), []),
		read: async () => null,
		list: async () => [],
		inbound: async () => []
	};
	const m = meteredApi(inner, 3);
	await m.api.search('x', { limit: 10_000 });
	check(
		'search limit is capped at 200',
		(seen[0] as { limit: number }).limit === 200,
		JSON.stringify(seen)
	);
	const refused = async (f: () => Promise<unknown>) =>
		f().then(
			() => false,
			() => true
		);
	check('a non-string path is refused', await refused(() => m.api.read(42 as unknown as string)));
	check('a third call still runs', !(await refused(() => m.api.list())));
	check('past the limit a call throws', await refused(() => m.api.inbound('a.md')));
	check('every call is counted, refused or not', m.calls() === 4, String(m.calls()));
}

{
	const seen: Record<string, unknown>[] = [];
	const loader: ScriptLoader = {
		get: (id, code) => {
			void code().then((c) => seen.push({ id, ...c }));
			return { getEntrypoint: () => ({ run: async () => ({ logs: [], value: null }) }) };
		}
	};
	const none: BrainApi = {
		search: async () => [],
		read: async () => null,
		list: async () => [],
		inbound: async () => []
	};
	await runScript(loader, 'return 1;', none);
	await runScript(loader, 'return 1;', none);
	await runScript(loader, 'return 2;', none);
	check(
		'every load has no network and the sandbox limits',
		seen.length === 3 &&
			seen.every(
				(c) =>
					c.globalOutbound === null && JSON.stringify(c.limits) === JSON.stringify(SANDBOX_LIMITS)
			),
		JSON.stringify(seen)
	);
	check(
		'one script keeps one worker id, another script gets another',
		seen[0].id === seen[1].id && seen[0].id !== seen[2].id
	);
}

{
	const template = readFileSync(join(root, 'wrangler.template.jsonc'), 'utf8');
	const kept = parseJsonc(optionalBlock(template, 'code-mode', true)) as {
		worker_loaders?: unknown[];
	};
	const dropped = parseJsonc(optionalBlock(template, 'code-mode', false)) as {
		worker_loaders?: unknown[];
	};
	check(
		'the code-mode block binds LOADER when kept and nothing when dropped',
		JSON.stringify(kept.worker_loaders) === '[{"binding":"LOADER"}]' &&
			dropped.worker_loaders === undefined
	);
}

// ---------- the sandbox, in workerd ----------

const dir = mkdtempSync(join(tmpdir(), 'isomorphic-code-mode-'));
writeFileSync(
	join(dir, 'caller.jsonc'),
	JSON.stringify({
		name: 'test-code-mode',
		main: join(root, 'scripts/workers/code-mode-caller.ts'),
		compatibility_date: '2026-04-26',
		worker_loaders: [{ binding: 'LOADER' }]
	})
);

const port = 20000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${port}`;
let dev: ChildProcess | undefined;
let log = '';

const PAGES = [
	{
		path: 'wiki/projects/atlas.md',
		title: 'Atlas',
		fields: { status: 'stale', owner: 'ana' },
		body: 'Atlas links [[beacon]].\nThe migration plan.'
	},
	{
		path: 'wiki/projects/beacon.md',
		title: 'Beacon',
		fields: { status: 'active', owner: 'ben' },
		body: 'Beacon ships the migration.'
	},
	{
		path: 'wiki/projects/comet.md',
		title: 'Comet',
		fields: { status: 'stale', owner: 'ana' },
		body: 'Comet links [[beacon]].'
	},
	{ path: 'wiki/people/ana.md', title: 'Ana', fields: null, body: 'Ana.' }
];

const run = async (code: string, extra: { maxCalls?: number; wallMs?: number } = {}) =>
	(await (
		await fetch(origin, { method: 'POST', body: JSON.stringify({ code, pages: PAGES, ...extra }) })
	).json()) as ScriptResult;

try {
	dev = spawn(
		join(root, 'node_modules/.bin/wrangler'),
		[
			'dev',
			'-c',
			'caller.jsonc',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port),
			'--inspector-port',
			'0'
		],
		{ cwd: dir, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
	);
	dev.stdout!.on('data', (d) => (log += d));
	dev.stderr!.on('data', (d) => (log += d));
	if (!(await waitForOrigin(origin, { attempts: 120, delayMs: 500 }))) {
		throw new Error('wrangler dev did not start');
	}

	const joined = await run(`
const stale = {};
for (const p of await brain.list("wiki/projects/")) {
  const page = await brain.read(p.path);
  if (page.fields.status === "stale") (stale[page.fields.owner] ??= []).push(p.title);
}
console.log("checked", Object.keys(stale).length, "owner");
return { stale, linkers: await brain.inbound("wiki/projects/beacon.md") };`);
	check(
		'a script reads, joins and returns, and only its result comes back',
		!joined.error &&
			joined.logs.join() === 'checked 1 owner' &&
			JSON.stringify(JSON.parse(joined.value!)) ===
				JSON.stringify({
					stale: { ana: ['Atlas', 'Comet'] },
					linkers: ['wiki/projects/atlas.md', 'wiki/projects/comet.md']
				}) &&
			joined.calls === 5,
		JSON.stringify(joined)
	);

	const hits = await run(
		'return (await brain.search("migration", { prefix: "wiki/projects/" })).map(h => h.path + ":" + h.line);'
	);
	check(
		'search results cross back as data',
		hits.value ===
			JSON.stringify(['wiki/projects/atlas.md:2', 'wiki/projects/beacon.md:1'], null, 2),
		JSON.stringify(hits)
	);

	const net = await run(
		'try { await fetch("https://example.com"); return "reached"; } catch (e) { return "blocked"; }'
	);
	check('fetch is blocked inside the sandbox', net.value === 'blocked', JSON.stringify(net));
	const env = await run(
		'return typeof env + "," + typeof process + "," + Object.keys(globalThis).filter(k => /token|secret|key/i.test(k)).length;'
	);
	check(
		'the script sees no env, no process, no credential',
		env.value === 'undefined,undefined,0',
		JSON.stringify(env)
	);

	const syntax = await run('return (;');
	check(
		'a syntax error comes back as an error',
		!!syntax.error && syntax.value === null,
		JSON.stringify(syntax)
	);
	const thrown = await run('console.log("first"); throw new Error("nope");');
	check(
		'a throw comes back with the lines logged before it',
		thrown.error === 'nope' && thrown.logs.join() === 'first',
		JSON.stringify(thrown)
	);
	const badArg = await run('return await brain.read(42);');
	check(
		'a bad argument comes back as an error',
		/path must be a string/.test(badArg.error ?? ''),
		JSON.stringify(badArg)
	);

	const metered = await run('for (let i = 0; i < 10; i++) await brain.list(); return "done";', {
		maxCalls: 5
	});
	check(
		'the call meter ends a run',
		/more than 5 calls/.test(metered.error ?? '') && metered.calls === 6,
		JSON.stringify(metered)
	);

	const hang = await run('await new Promise((r) => setTimeout(r, 5000));', { wallMs: 1500 });
	check(
		'the wall clock ends a run that outlasts it',
		/longer than 1.5s/.test(hang.error ?? ''),
		JSON.stringify(hang)
	);
	const after = await run('return 1 + 1;');
	check('the sandbox still runs scripts afterwards', after.value === '2', JSON.stringify(after));

	const [a, b] = await Promise.all([
		run('console.log("a"); await brain.list(); console.log("a2"); return "A";'),
		run('console.log("a"); await brain.list(); console.log("a2"); return "A";')
	]);
	check(
		'two runs of one script in one warm isolate keep their own output',
		a.logs.join() === 'a,a2' && b.logs.join() === 'a,a2',
		JSON.stringify([a, b])
	);
} catch (e) {
	check(`the battery ran: ${(e as Error).message}`, false, log.slice(-4000));
} finally {
	if (dev?.pid) {
		const exited = new Promise((r) => dev!.once('exit', r));
		process.kill(-dev.pid, 'SIGTERM');
		await exited;
	}
	rmSync(dir, { recursive: true, force: true });
}

done();
