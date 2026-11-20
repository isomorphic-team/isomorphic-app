// Sets the MCP Worker's cron schedules from the generated wrangler.jsonc.
//
//   pnpm exec tsx scripts/schedules.ts          # needs CLOUDFLARE_API_TOKEN
//
// The account is CLOUDFLARE_ACCOUNT_ID, or, like wrangler, the one account the token
// reaches.
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
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/**
 * The account to act on when none is named: the only one the token reaches, from the body
 * of `GET /accounts`. With none or several there is nothing to choose by.
 */
export function onlyAccount(listing: unknown): string {
	const result = (listing as { result?: unknown } | null)?.result;
	const ids = Array.isArray(result)
		? result.map((a) => (a as { id?: unknown } | null)?.id).filter((id) => typeof id === 'string')
		: [];
	if (ids.length !== 1)
		throw new Error(
			`The API token reaches ${ids.length} accounts, so set CLOUDFLARE_ACCOUNT_ID to name the one to use.`
		);
	return ids[0] as string;
}

/** The request that gives a Worker the schedules its config declares, or why it cannot be made. */
export function schedulesRequest(config: unknown, accountId: string | undefined): SchedulesRequest {
	const { name, triggers } = (config ?? {}) as { name?: unknown; triggers?: { crons?: unknown } };
	if (typeof name !== 'string' || !WORKER_NAME.test(name))
		throw new Error('The config names no Worker, or a name that is not a Worker name.');
	if (!accountId || !ACCOUNT_ID.test(accountId))
		throw new Error('No Cloudflare account id, or one that is not an account id.');
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
	const auth = { authorization: `Bearer ${token}` };
	let accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (!accountId) {
		const listed = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
			headers: auth
		});
		if (!listed.ok)
			throw new Error(
				`Listing the token's accounts: Cloudflare answered ${listed.status}. Set CLOUDFLARE_ACCOUNT_ID.`
			);
		accountId = onlyAccount(await listed.json());
	}
	const { url, body } = schedulesRequest(
		parseJsonc(readFileSync('wrangler.jsonc', 'utf8')),
		accountId
	);
	const res = await fetch(url, {
		method: 'PUT',
		headers: { ...auth, 'content-type': 'application/json' },
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
