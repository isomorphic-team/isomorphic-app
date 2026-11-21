// Code mode: `run_script` runs a JavaScript function body the model writes against a
// typed `brain` API, in a Dynamic Worker (the Worker Loader binding) with no network.
// Intermediate results stay in the sandbox; only what the script logs or returns comes
// back to the model.
//
// The sandbox holds no credential and reaches nothing but the `brain` object it is
// handed: a plain object whose functions cross Workers RPC as stubs calling back into
// the MCP Worker, where the caller's brain context was already resolved and authorized.
//
// This module is pure and Worker-safe. The `brain` implementation over a BrainContext
// is `src/tools/code-mode.ts`; `pnpm test:code-mode` runs the sandbox in workerd.

/** The methods a script may call on `brain`, read-only, mirroring the brain-tool op whitelist. */
export const BRAIN_API_METHODS = ['search', 'read', 'list', 'inbound'] as const;
export type BrainApiMethod = (typeof BRAIN_API_METHODS)[number];

export interface ScriptPage {
	path: string;
	title: string;
	/** Flat frontmatter, or null when the page has none. */
	fields: Record<string, unknown> | null;
	/** The page without its frontmatter. */
	body: string;
}

export interface BrainApi {
	search(
		query: string,
		opts?: { prefix?: string; limit?: number }
	): Promise<{ path: string; line: number; text: string }[]>;
	read(path: string): Promise<ScriptPage | null>;
	list(prefix?: string): Promise<{ path: string; title: string }[]>;
	inbound(path: string): Promise<string[]>;
}

// What the model reads in the tool description. `pnpm test:code-mode` checks it names
// exactly BRAIN_API_METHODS.
export const BRAIN_API_DECLARATION = `declare const brain: {
  // Ranked line matches, best first. limit defaults to 50, at most 200.
  search(query: string, opts?: { prefix?: string; limit?: number }): Promise<{ path: string; line: number; text: string }[]>;
  // One page, or null if it does not exist. fields is its flat frontmatter.
  read(path: string): Promise<{ path: string; title: string; fields: Record<string, unknown> | null; body: string } | null>;
  // Every page, or those under a path prefix such as "wiki/people/".
  list(prefix?: string): Promise<{ path: string; title: string }[]>;
  // Paths of the pages that link to this one.
  inbound(path: string): Promise<string[]>;
};`;

export const SCRIPT_MAX_CHARS = 20_000;
export const OUTPUT_MAX_CHARS = 24_000;
/** Calls on `brain` per run. Each one can read the index or a file. */
export const MAX_API_CALLS = 200;
/** Wall-clock bound on a run, waiting on `brain` included. */
export const SCRIPT_WALL_MS = 25_000;
/** CPU and subrequest limits inside the sandbox. `brain` calls run in the MCP Worker. */
export const SANDBOX_LIMITS = { cpuMs: 500, subRequests: 0 };
const COMPATIBILITY_DATE = '2026-04-26';

/** Why a script is refused before it runs, or null. */
export function scriptProblem(code: string): string | null {
	if (!code.trim()) return 'The script is empty.';
	if (code.length > SCRIPT_MAX_CHARS) {
		return `The script is ${code.length} characters; the limit is ${SCRIPT_MAX_CHARS}.`;
	}
	return null;
}

// The sandbox's two modules. The script becomes the body of an async function taking
// `brain` and a `console` that collects lines for this run alone, so two runs sharing a
// warm isolate never mix their output.
const HARNESS = `import { WorkerEntrypoint } from 'cloudflare:workers';
import script from './script.js';

const show = (v) => {
	if (typeof v === 'string') return v;
	try {
		const s = JSON.stringify(v, null, 2);
		return s === undefined ? String(v) : s;
	} catch {
		return String(v);
	}
};

export default class extends WorkerEntrypoint {
	async run(brain) {
		const logs = [];
		const line = (...args) => {
			logs.push(args.map(show).join(' '));
		};
		const console = { log: line, info: line, warn: line, error: line, debug: line };
		try {
			const value = await script(brain, console);
			return { logs, value: value === undefined ? null : show(value) };
		} catch (err) {
			const message = err && err.message ? String(err.message) : String(err);
			return { logs, value: null, error: message };
		}
	}
}
`;

export function sandboxModules(code: string): Record<string, string> {
	return {
		'harness.js': HARNESS,
		'script.js': `export default async function (brain, console) {\n${code}\n}\n`
	};
}

export interface ScriptResult {
	logs: string[];
	/** The function's return value, shown as text, or null. */
	value: string | null;
	error?: string;
	calls: number;
}

/**
 * `api` with every method counted. Past `max` calls a method throws instead of running,
 * and arguments that are not the declared types are refused, since they come from
 * model-written code.
 */
export function meteredApi(
	api: BrainApi,
	max = MAX_API_CALLS
): { api: BrainApi; calls: () => number } {
	let calls = 0;
	const tick = (method: BrainApiMethod) => {
		calls++;
		if (calls > max) throw new Error(`brain.${method}: more than ${max} calls in one run.`);
	};
	const str = (
		method: BrainApiMethod,
		name: string,
		v: unknown,
		optional = false
	): string | undefined => {
		if (v === undefined && optional) return undefined;
		if (typeof v !== 'string') throw new Error(`brain.${method}: ${name} must be a string.`);
		return v;
	};
	return {
		calls: () => calls,
		api: {
			search: async (query, opts) => {
				tick('search');
				const o = (opts ?? {}) as { prefix?: unknown; limit?: unknown };
				const limit = o.limit === undefined ? 50 : Number(o.limit);
				if (!Number.isFinite(limit) || limit < 1)
					throw new Error('brain.search: limit must be a positive number.');
				return api.search(str('search', 'query', query)!, {
					prefix: str('search', 'prefix', o.prefix, true),
					limit: Math.min(Math.floor(limit), 200)
				});
			},
			read: async (path) => {
				tick('read');
				return api.read(str('read', 'path', path)!);
			},
			list: async (prefix) => {
				tick('list');
				return api.list(str('list', 'prefix', prefix, true));
			},
			inbound: async (path) => {
				tick('inbound');
				return api.inbound(str('inbound', 'path', path)!);
			}
		}
	};
}

/** The Worker Loader binding, structurally: what runScript uses of it. */
export interface ScriptLoader {
	get(
		id: string,
		code: () => Promise<{
			compatibilityDate: string;
			mainModule: string;
			modules: Record<string, string>;
			globalOutbound: null;
			limits: { cpuMs: number; subRequests: number };
		}>
	): { getEntrypoint(): unknown };
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Run a script in a Dynamic Worker. The worker id is a hash of its modules, so the same
 * script reuses a warm isolate and counts once toward the daily Dynamic Worker total.
 */
export async function runScript(
	loader: ScriptLoader,
	code: string,
	api: BrainApi,
	opts: { maxCalls?: number; wallMs?: number } = {}
): Promise<ScriptResult> {
	const modules = sandboxModules(code);
	const id = 'run-script-' + (await sha256(JSON.stringify(modules)));
	const metered = meteredApi(api, opts.maxCalls);
	const worker = loader.get(id, async () => ({
		compatibilityDate: COMPATIBILITY_DATE,
		mainModule: 'harness.js',
		modules,
		globalOutbound: null,
		limits: SANDBOX_LIMITS
	}));
	const entry = worker.getEntrypoint() as {
		run(brain: BrainApi): Promise<{ logs: string[]; value: string | null; error?: string }>;
	};
	const wallMs = opts.wallMs ?? SCRIPT_WALL_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`The script ran longer than ${wallMs / 1000}s.`)),
			wallMs
		);
	});
	try {
		const out = await Promise.race([entry.run(metered.api), timeout]);
		return { ...out, calls: metered.calls() };
	} catch (err) {
		// A syntax error, the CPU limit, or the wall clock: the sandbox never answered.
		return { logs: [], value: null, error: (err as Error).message, calls: metered.calls() };
	} finally {
		clearTimeout(timer);
	}
}

/** The tool's reply text: the logs, then the return value, cut to OUTPUT_MAX_CHARS. */
export function formatScriptResult(r: ScriptResult): { text: string; isError: boolean } {
	const parts: string[] = [];
	if (r.logs.length) parts.push(r.logs.join('\n'));
	if (r.value !== null) parts.push(r.logs.length ? `Returned:\n${r.value}` : r.value);
	if (r.error) parts.push(`Error: ${r.error}`);
	if (parts.length === 0) parts.push('The script logged and returned nothing.');
	let text = parts.join('\n\n');
	if (text.length > OUTPUT_MAX_CHARS) {
		const cut = text.length - OUTPUT_MAX_CHARS;
		text = `${text.slice(0, OUTPUT_MAX_CHARS)}\n\n[${cut} more characters cut. Log less, or summarize in the script.]`;
	}
	text += `\n\n(${r.calls} brain call${r.calls === 1 ? '' : 's'})`;
	return { text, isError: Boolean(r.error) };
}
