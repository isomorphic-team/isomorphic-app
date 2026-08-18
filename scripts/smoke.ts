// Smoke check for a deployed origin: the assertions that stand between a merge and
// production once nobody clicks approve.
//
// Every check is read-only and unauthenticated, so it is safe to point at any origin,
// including a version preview URL that shares production's bindings. Nothing here
// writes, and nothing here needs a credential.
//
// The logic lives in this module rather than in a `run:` block so it can be driven
// from `pnpm test:smoke` against stub responses. A smoke check is the thing that
// DECIDES whether a deploy is rolled back, and one asserting the wrong path would
// revert every good deploy while a mis-scoped `catch` would pass every bad one.
//
//   tsx scripts/smoke.ts https://example.workers.dev

import { pathToFileURL } from 'node:url';

export type Check = { name: string; ok: boolean; detail?: string };

/** How long any single request may take before it counts as a failure. */
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function ok(name: string): Check {
	return { name, ok: true };
}
function bad(name: string, detail: string): Check {
	return { name, ok: false, detail };
}

/** Anything thrown by a check becomes a failed check, never an unhandled rejection. */
async function attempt(name: string, run: () => Promise<Check>): Promise<Check> {
	try {
		return await run();
	} catch (err) {
		return bad(name, err instanceof Error ? err.message : String(err));
	}
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`response is not JSON: ${text.slice(0, 120)}`);
	}
}

/**
 * Run every assertion against one origin. Resolves to one Check per assertion,
 * in a fixed order, whether they passed or failed: the caller decides what to do
 * about a failure, and a partial result is more diagnosable than an early throw.
 */
export async function smokeOrigin(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<Check[]> {
	const origin = new URL(baseUrl).origin;
	const get = (path: string) =>
		fetchImpl(`${origin}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

	const checks: Check[] = [];

	// 1. The Worker booted at all. Everything below is downstream of this, but they
	//    are still all evaluated: "health is fine, OAuth is gone" is a different
	//    diagnosis from "nothing answers", and stopping early hides which one it is.
	checks.push(
		await attempt('GET /health returns 200 ok', async () => {
			const res = await get('/health');
			if (res.status !== 200) return bad('GET /health returns 200 ok', `status ${res.status}`);
			const body = (await res.text()).trim();
			return body === 'ok'
				? ok('GET /health returns 200 ok')
				: bad('GET /health returns 200 ok', `body was ${JSON.stringify(body.slice(0, 60))}`);
		})
	);

	// 2. The OAuth provider is mounted AND refusing. A 401 proves the request reached
	//    the provider; anything else means either the version did not boot behind it
	//    or, in the 2xx case, that an unauthenticated caller just reached the tools.
	checks.push(
		await attempt('POST /mcp unauthenticated returns 401 + WWW-Authenticate', async () => {
			const name = 'POST /mcp unauthenticated returns 401 + WWW-Authenticate';
			const res = await fetchImpl(`${origin}/mcp`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (res.status !== 401) return bad(name, `status ${res.status}, expected 401`);
			const header = res.headers.get('www-authenticate');
			if (!header) return bad(name, 'no WWW-Authenticate header');
			return /bearer/i.test(header) ? ok(name) : bad(name, `WWW-Authenticate was ${header}`);
		})
	);

	// 3+4. The two metadata documents a host reads before it can begin a connection.
	//      Both are built from the REQUEST origin by @cloudflare/workers-oauth-provider,
	//      not from PUBLIC_BASE_URL, so asserting they point back at the origin we asked
	//      is a real check on any hostname. See the known hole in the header of
	//      docs/ops/deploy-and-rollback.md.
	checks.push(
		await attempt('protected-resource metadata is self-consistent', async () => {
			const name = 'protected-resource metadata is self-consistent';
			const res = await get('/.well-known/oauth-protected-resource/mcp');
			if (res.status !== 200) return bad(name, `status ${res.status}`);
			const doc = await readJson(res);
			if (doc.resource !== `${origin}/mcp`)
				return bad(name, `resource was ${String(doc.resource)}`);
			const servers = doc.authorization_servers;
			if (!Array.isArray(servers) || !servers.includes(origin))
				return bad(name, `authorization_servers was ${JSON.stringify(servers)}`);
			return ok(name);
		})
	);

	checks.push(
		await attempt('authorization-server metadata is self-consistent', async () => {
			const name = 'authorization-server metadata is self-consistent';
			const res = await get('/.well-known/oauth-authorization-server');
			if (res.status !== 200) return bad(name, `status ${res.status}`);
			const doc = await readJson(res);
			if (doc.issuer !== origin) return bad(name, `issuer was ${String(doc.issuer)}`);
			for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
				const value = doc[key];
				if (typeof value !== 'string' || !value.startsWith(`${origin}/`))
					return bad(name, `${key} was ${String(value)}`);
			}
			return ok(name);
		})
	);

	return checks;
}

/**
 * Poll /health until the origin answers. A version that has just been uploaded or
 * promoted is not always serving by the time the CLI returns, and a smoke check that
 * races the rollout would roll back a deploy that was about to be fine.
 */
export async function waitForOrigin(
	baseUrl: string,
	opts: {
		attempts?: number;
		delayMs?: number;
		fetchImpl?: FetchLike;
		sleep?: (ms: number) => Promise<void>;
	} = {}
): Promise<boolean> {
	const {
		attempts = 10,
		delayMs = 3_000,
		fetchImpl = fetch,
		sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
	} = opts;
	const origin = new URL(baseUrl).origin;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetchImpl(`${origin}/health`, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (res.status === 200) return true;
		} catch {
			// Not up yet. DNS and cold starts both land here.
		}
		if (i < attempts - 1) await sleep(delayMs);
	}
	return false;
}

export function allPassed(checks: Check[]): boolean {
	return checks.length > 0 && checks.every((c) => c.ok);
}

export function formatChecks(checks: Check[]): string {
	return checks
		.map((c) => (c.ok ? `  ✓ ${c.name}` : `  ✗ ${c.name}${c.detail ? `: ${c.detail}` : ''}`))
		.join('\n');
}

// CLI. Guarded so `pnpm test:smoke` can import the functions above without running it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const baseUrl = process.argv[2];
	if (!baseUrl) {
		console.error('usage: tsx scripts/smoke.ts <base-url>');
		process.exit(2);
	}
	console.log(`\nsmoke checking ${new URL(baseUrl).origin}`);
	const up = await waitForOrigin(baseUrl);
	if (!up) {
		console.log('  ✗ origin never answered /health');
		console.log('\nSmoke check FAILED.\n');
		process.exit(1);
	}
	const checks = await smokeOrigin(baseUrl);
	console.log(formatChecks(checks));
	const passed = allPassed(checks);
	console.log(passed ? '\nAll smoke checks passed.\n' : '\nSmoke check FAILED.\n');
	process.exit(passed ? 0 : 1);
}
