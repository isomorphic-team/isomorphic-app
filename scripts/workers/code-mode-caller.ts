// A stand-in for the MCP Worker in pnpm test:code-mode. It runs scripts through the real
// runScript over a real Worker Loader binding, against a `brain` over pages the test
// posts, so what crosses into the sandbox and back is what crosses in production.
//
//   POST /run { code, pages, maxCalls?, wallMs? } -> ScriptResult

import { runScript, type BrainApi, type ScriptLoader } from '../../src/lib/code-mode.ts';

interface Env {
	LOADER: ScriptLoader;
}

type Page = { path: string; title: string; fields: Record<string, unknown> | null; body: string };

function pagesApi(pages: Page[]): BrainApi {
	return {
		async search(query, opts) {
			const hits = [];
			for (const p of pages) {
				if (opts?.prefix && !p.path.startsWith(opts.prefix)) continue;
				const lines = p.body.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].toLowerCase().includes(query.toLowerCase())) {
						hits.push({ path: p.path, line: i + 1, text: lines[i] });
					}
				}
			}
			return hits.slice(0, opts?.limit ?? 50);
		},
		async read(path) {
			return pages.find((p) => p.path === path) ?? null;
		},
		async list(prefix) {
			return pages
				.filter((p) => !prefix || p.path.startsWith(prefix))
				.map((p) => ({ path: p.path, title: p.title }));
		},
		async inbound(path) {
			const name = path.split('/').pop()!.replace(/\.md$/, '');
			return pages.filter((p) => p.body.includes(`[[${name}]]`)).map((p) => p.path);
		}
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== 'POST') return new Response('ok');
		const { code, pages, maxCalls, wallMs } = (await request.json()) as {
			code: string;
			pages: Page[];
			maxCalls?: number;
			wallMs?: number;
		};
		return Response.json(await runScript(env.LOADER, code, pagesApi(pages), { maxCalls, wallMs }));
	}
};
