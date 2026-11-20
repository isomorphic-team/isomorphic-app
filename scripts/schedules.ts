// Sets the MCP Worker's cron schedules from the generated wrangler.jsonc.
//
//   pnpm exec tsx scripts/schedules.ts          # needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//
// `wrangler deploy` applies `triggers.crons` itself. The production workflow uploads and
// promotes versions instead, which leaves triggers alone, and `wrangler triggers deploy`
// would also set workers.dev and preview URLs from the config. This makes the one call
// that changes schedules and nothing else. It replaces whatever schedules the Worker has.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonc } from './preview.ts';

export interface SchedulesRequest {
	url: string;
	body: { cron: string }[];
}

// What may reach the request from the config file: a Worker name and cron expressions,
// each by its own alphabet, so nothing else in the file can shape the URL or the body.
const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const CRON = /^[A-Za-z0-9*/,?#\- ]{1,100}$/;

/** The request that gives a Worker the schedules its config declares, or why it cannot be made. */
export function schedulesRequest(config: unknown, accountId: string | undefined): SchedulesRequest {
	const { name, triggers } = (config ?? {}) as { name?: unknown; triggers?: { crons?: unknown } };
	if (typeof name !== 'string' || !WORKER_NAME.test(name))
		throw new Error('The config names no Worker, or a name that is not a Worker name.');
	if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set.');
	const crons = triggers?.crons;
	if (
		!Array.isArray(crons) ||
		!crons.every((c): c is string => typeof c === 'string' && CRON.test(c))
	)
		throw new Error('The config declares no `triggers.crons` list of cron expressions.');
	return {
		url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/schedules`,
		body: crons.map((cron) => ({ cron }))
	};
}

async function main() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set.');
	const { url, body } = schedulesRequest(
		parseJsonc(readFileSync('wrangler.jsonc', 'utf8')),
		process.env.CLOUDFLARE_ACCOUNT_ID
	);
	const res = await fetch(url, {
		method: 'PUT',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok)
		throw new Error(`Cloudflare answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
	console.log(`Schedules set: ${body.map((b) => b.cron).join(', ') || 'none'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
