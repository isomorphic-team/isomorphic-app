// run_script: code mode over the active brain. The script runs in a Dynamic Worker
// (src/lib/code-mode.ts) and reaches the brain only through `brainApi`, built here from
// the caller's resolved BrainContext. Registered only where the deployment binds a
// Worker Loader (`LOADER`).

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BrainContext } from './librarian.ts';
import type { TenantOpts } from '../lib/orgs.ts';
import { backlinksTo } from '../lib/brain-index.ts';
import { parseFrontmatter } from '../lib/wiki.ts';
import { toolAnnotations } from '../lib/tool-annotations.ts';
import {
	BRAIN_API_DECLARATION,
	formatScriptResult,
	MAX_API_CALLS,
	OUTPUT_MAX_CHARS,
	SCRIPT_WALL_MS,
	runScript,
	scriptProblem,
	type BrainApi,
	type ScriptLoader
} from '../lib/code-mode.ts';

/** The `brain` a script sees: the read operations of the content tools, as data. */
export function brainApi(ctx: BrainContext): BrainApi {
	const { index, store, locator, config } = ctx;
	let fresh: Promise<unknown> | undefined;
	// One freshness check per run, not per call.
	const ready = () => (fresh ??= index.ensureFresh(store, locator, config));
	return {
		async search(query, opts) {
			await ready();
			const { hits } = await index.search(query, opts?.prefix || undefined, opts?.limit ?? 50);
			return hits.map((h) => ({ path: h.path, line: h.line, text: h.text }));
		},
		async read(path) {
			const file = await store.readFile(locator, path);
			if (!file) return null;
			const { frontmatter, body } = parseFrontmatter(file.content);
			const title =
				typeof frontmatter?.title === 'string'
					? frontmatter.title
					: (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? path.split('/').pop()!.replace(/\.md$/, ''));
			return { path, title, fields: frontmatter ? { ...frontmatter } : null, body };
		},
		async list(prefix) {
			await ready();
			const pages = await index.listPages();
			return (prefix ? pages.filter((p) => p.path.startsWith(prefix)) : pages).map((p) => ({
				path: p.path,
				title: p.title
			}));
		},
		async inbound(path) {
			await ready();
			return backlinksTo(await index.graph(config), path).map((r) => r.path);
		}
	};
}

// The description carries the whole API: the model writes against it with no other
// reference. It is a full description on purpose, not a terse line.
const DESCRIPTION = `Run a JavaScript script against the brain and get back only what it logs or returns. Use it for work that would otherwise take many reads: scanning a folder, joining pages by their frontmatter, following links several hops, counting or grouping. Intermediate pages stay inside the script.

The code is the body of an async function. Call the API with await, print with console.log, or return a value (objects are shown as JSON). No network, no imports, read-only. Limits: ${MAX_API_CALLS} brain calls and ${SCRIPT_WALL_MS / 1000} seconds per run; output over ${OUTPUT_MAX_CHARS} characters is cut, so summarize in the script rather than printing whole pages.

${BRAIN_API_DECLARATION}

Example: stale pages under wiki/projects/ by owner
const pages = await brain.list("wiki/projects/");
const byOwner = {};
for (const p of pages) {
  const page = await brain.read(p.path);
  if (page?.fields?.status === "stale") (byOwner[page.fields.owner ?? "none"] ??= []).push(p.path);
}
return byOwner;`;

export function registerCodeModeTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	loader: ScriptLoader
) {
	server.registerTool(
		'run_script',
		{
			...toolAnnotations('Run a script over the brain', 'read'),
			description: DESCRIPTION,
			inputSchema: z.object({
				code: z
					.string()
					.describe(
						'The body of an async function, e.g. `const p = await brain.read("wiki/index.md"); return p?.fields;`'
					),
				brain: z
					.string()
					.optional()
					.describe('Which brain to target (name/handle). Defaults to the active brain.')
			})
		},
		async ({ code, brain }) => {
			const problem = scriptProblem(code);
			if (problem) return { isError: true, content: [{ type: 'text' as const, text: problem }] };
			const ctx = await getContext({ brain });
			const { text, isError } = formatScriptResult(await runScript(loader, code, brainApi(ctx)));
			return { isError, content: [{ type: 'text' as const, text }] };
		}
	);
}
