// Golden test for the deploy-time smoke check (scripts/smoke.ts).
//
// This battery exists because the smoke check is the thing that DECIDES whether a
// merge stays in production. Both of its failure directions are expensive and neither
// is visible from a green pipeline:
//
//   too strict -> every healthy deploy is rolled back, and `main` stops shipping
//   too loose  -> a broken version passes and the rollback never fires
//
// So the cases below are mostly BAD origins, asserting that each one is caught and
// named. Everything runs against a stub fetch: no network, no credentials, and no
// dependence on production being up while a contributor runs `pnpm test`.
//
// The second half checks the WIRING in .github/workflows/deploy.yml. The assertions
// themselves being right is only half of a working safety valve; the other half is the
// step conditions that decide when they run and what happens after one fails, and those
// are read rather than executed until a deploy actually goes wrong. A single `always()`
// added to the promote step would silently promote a version that had just failed its
// pre-promotion check, and nothing else in this repo would notice.
//
//   pnpm test:smoke

import { readFileSync } from 'node:fs';

import { smokeOrigin, waitForOrigin, allPassed, type Check } from './smoke.ts';

const ORIGIN = 'https://example.workers.dev';

import { checker } from './check.ts';

const { check, done } = checker('smoke checks');

/** A response shaped like the one the named route really returns (verified against prod). */
type Routes = Record<string, () => Response>;

function healthyRoutes(origin = ORIGIN): Routes {
	return {
		'GET /health': () => new Response('ok', { status: 200 }),
		'POST /mcp': () =>
			new Response(JSON.stringify({ error: 'invalid_token' }), {
				status: 401,
				headers: {
					'www-authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`
				}
			}),
		'GET /.well-known/oauth-protected-resource/mcp': () =>
			new Response(
				JSON.stringify({
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
					bearer_methods_supported: ['header']
				}),
				{ status: 200 }
			),
		'GET /b/example/brain': () =>
			new Response(null, {
				status: 302,
				headers: { location: `${origin}/auth/signin?callbackUrl=%2Fb%2Fexample%2Fbrain` }
			}),
		'GET /.well-known/oauth-authorization-server': () =>
			new Response(
				JSON.stringify({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`
				}),
				{ status: 200 }
			)
	};
}

/** Build a fetch that serves `routes`, with any override replacing one route. */
function stubFetch(routes: Routes) {
	return async (url: string, init?: RequestInit) => {
		const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
		const route = routes[key];
		if (!route) throw new Error(`unstubbed route ${key}`);
		return route();
	};
}

function withRoute(over: Routes, origin = ORIGIN): Routes {
	return { ...healthyRoutes(origin), ...over };
}

async function run(routes: Routes) {
	return smokeOrigin(ORIGIN, stubFetch(routes));
}

function named(checks: Check[], fragment: string): Check {
	const found = checks.find((c) => c.name.includes(fragment));
	if (!found) throw new Error(`no check named like ${fragment}`);
	return found;
}

console.log('\na healthy origin passes every assertion');
{
	const checks = await run(healthyRoutes());
	check('five checks ran', checks.length === 5, `got ${checks.length}`);
	check('all passed', allPassed(checks), JSON.stringify(checks.filter((c) => !c.ok)));
}

console.log('\nthe Worker did not boot');
{
	const checks = await run(
		withRoute({ 'GET /health': () => new Response('error', { status: 500 }) })
	);
	check('a 500 on /health fails', !named(checks, '/health').ok);
	check('the other four are still evaluated', checks.length === 5);
	check('the failure names the status', named(checks, '/health').detail?.includes('500') === true);
}
{
	const checks = await run(
		withRoute({ 'GET /health': () => new Response('<!doctype html>', { status: 200 }) })
	);
	check('a 200 with the wrong body fails', !named(checks, '/health').ok);
}

console.log('\nthe OAuth surface is the assertion that matters most');
{
	// The regression this catches: an unauthenticated caller reaching the tools.
	// The challenge header is deliberately VALID here so that the status assertion is
	// the only thing that can catch it. With the header missing too, this case passes
	// even when the status check is deleted, and the assertion is untested.
	const checks = await run(
		withRoute({
			'POST /mcp': () =>
				new Response('{}', { status: 200, headers: { 'www-authenticate': 'Bearer realm="OAuth"' } })
		})
	);
	check('an unauthenticated 200 on /mcp FAILS', !named(checks, 'POST /mcp').ok);
	check(
		'and says it expected a 401',
		named(checks, 'POST /mcp').detail?.includes('expected 401') === true
	);
}
{
	const checks = await run(withRoute({ 'POST /mcp': () => new Response('{}', { status: 401 }) }));
	check('a 401 with no WWW-Authenticate fails', !named(checks, 'POST /mcp').ok);
	check(
		'and says which half was missing',
		named(checks, 'POST /mcp').detail?.includes('WWW-Authenticate') === true
	);
}
{
	const checks = await run(
		withRoute({
			'POST /mcp': () =>
				new Response('{}', { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } })
		})
	);
	check('a non-Bearer challenge fails', !named(checks, 'POST /mcp').ok);
}
{
	const checks = await run(withRoute({ 'POST /mcp': () => new Response('', { status: 500 }) }));
	check('a 500 on /mcp fails', !named(checks, 'POST /mcp').ok);
}

console.log('\nmetadata must point back at the origin that served it');
{
	// A version serving another deployment's metadata: the shape is valid, the
	// identity is wrong, and a host following it would authenticate elsewhere.
	// The two fields are wrong SEPARATELY, one case each. Making both foreign at once
	// lets either assertion cover for the other's deletion.
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-protected-resource/mcp': () =>
				new Response(
					JSON.stringify({
						resource: 'https://other.example/mcp',
						authorization_servers: [ORIGIN]
					}),
					{ status: 200 }
				)
		})
	);
	check('a foreign resource url fails on its own', !named(checks, 'protected-resource').ok);
	check(
		'and names the resource',
		named(checks, 'protected-resource').detail?.includes('other.example') === true
	);
}
{
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-protected-resource/mcp': () =>
				new Response(
					JSON.stringify({
						resource: `${ORIGIN}/mcp`,
						authorization_servers: ['https://other.example']
					}),
					{ status: 200 }
				)
		})
	);
	check('a foreign authorization server fails on its own', !named(checks, 'protected-resource').ok);
}
{
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-protected-resource/mcp': () =>
				new Response(JSON.stringify({ resource: `${ORIGIN}/mcp` }), { status: 200 })
		})
	);
	check('a missing authorization_servers list fails', !named(checks, 'protected-resource').ok);
}
{
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-authorization-server': () =>
				new Response(
					JSON.stringify({
						issuer: ORIGIN,
						authorization_endpoint: `${ORIGIN}/authorize`,
						token_endpoint: 'https://other.example/token',
						registration_endpoint: `${ORIGIN}/register`
					}),
					{ status: 200 }
				)
		})
	);
	check('one foreign endpoint among three fails', !named(checks, 'authorization-server').ok);
	check(
		'and names the offending key',
		named(checks, 'authorization-server').detail?.includes('token_endpoint') === true
	);
}
{
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-authorization-server': () =>
				new Response(
					JSON.stringify({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize` }),
					{
						status: 200
					}
				)
		})
	);
	check('a missing endpoint fails', !named(checks, 'authorization-server').ok);
}
{
	// Issuer wrong, all three endpoints right: only the issuer assertion can catch it.
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-authorization-server': () =>
				new Response(
					JSON.stringify({
						issuer: 'https://other.example',
						authorization_endpoint: `${ORIGIN}/authorize`,
						token_endpoint: `${ORIGIN}/token`,
						registration_endpoint: `${ORIGIN}/register`
					}),
					{ status: 200 }
				)
		})
	);
	check('a foreign issuer fails on its own', !named(checks, 'authorization-server').ok);
	check(
		'and names the issuer',
		named(checks, 'authorization-server').detail?.includes('issuer') === true
	);
}

console.log('\nthe web app hands its shell to a stranger');
{
	const shell = () => new Response('<!doctype html><html>', { status: 200 });
	const checks = await run(withRoute({ 'GET /b/example/brain': shell }));
	check('a 200 on /b/ fails', !named(checks, '/b/').ok);
	check('the failure names the status', named(checks, '/b/').detail?.includes('200') === true);
}
{
	// A redirect somewhere other than sign-in, or to another origin, is not a
	// session check: the first is a route that lost its way, the second an open
	// redirect.
	const checks = await run(
		withRoute({
			'GET /b/example/brain': () =>
				new Response(null, { status: 302, headers: { location: `${ORIGIN}/health` } })
		})
	);
	check('a redirect that is not to sign-in fails', !named(checks, '/b/').ok);
	const off = await run(
		withRoute({
			'GET /b/example/brain': () =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://elsewhere.example/auth/signin' }
				})
		})
	);
	check('an off-origin redirect fails', !named(off, '/b/').ok);
	check('and says so', named(off, '/b/').detail?.includes('off-origin') === true);
}
{
	// Not mounted at all. Static and github identity modes have no browser session,
	// so the route does not exist there, and this script gates their deploys too.
	const checks = await run(
		withRoute({ 'GET /b/example/brain': () => new Response('not found', { status: 404 }) })
	);
	check('a 404 passes: the route is optional, serving the shell is not', named(checks, '/b/').ok);
	const err = await run(
		withRoute({ 'GET /b/example/brain': () => new Response('boom', { status: 500 }) })
	);
	check('a 500 fails', !named(err, '/b/').ok);
}

console.log('\na broken response is a failed check, never a thrown error');
{
	// Cloudflare's own error pages are HTML. Parsing one must not crash the run,
	// because a crashed run reports nothing and rolls back nothing.
	const checks = await run(
		withRoute({
			'GET /.well-known/oauth-protected-resource/mcp': () =>
				new Response('<html>1101 Worker threw exception</html>', { status: 200 })
		})
	);
	check('unparseable JSON fails without throwing', !named(checks, 'protected-resource').ok);
	check(
		'and quotes what came back',
		named(checks, 'protected-resource').detail?.includes('not JSON') === true
	);
}
{
	const throwing = async () => {
		throw new Error('ECONNREFUSED');
	};
	const checks = await smokeOrigin(ORIGIN, throwing);
	check(
		'a connection error fails all five without throwing',
		checks.length === 5 && checks.every((c) => !c.ok)
	);
}

console.log('\nallPassed does not call an empty run a success');
check('no checks is not a pass', !allPassed([]));
check(
	'one failure sinks the set',
	!allPassed([
		{ name: 'a', ok: true },
		{ name: 'b', ok: false }
	])
);

console.log('\nwaitForOrigin gives a cold start time to answer');
{
	let calls = 0;
	const flaky = async () => {
		calls++;
		if (calls < 3) throw new Error('DNS not ready');
		return new Response('ok', { status: 200 });
	};
	const up = await waitForOrigin(ORIGIN, {
		attempts: 5,
		delayMs: 0,
		fetchImpl: flaky,
		sleep: async () => {}
	});
	check('it retries past a cold start', up && calls === 3, `up=${up} calls=${calls}`);
}
{
	let calls = 0;
	const dead = async () => {
		calls++;
		return new Response('', { status: 503 });
	};
	const up = await waitForOrigin(ORIGIN, {
		attempts: 4,
		delayMs: 0,
		fetchImpl: dead,
		sleep: async () => {}
	});
	check('it gives up rather than hanging', !up, `up=${up}`);
	check('it used every attempt and no more', calls === 4, `calls=${calls}`);
}

// ---------------------------------------------------------------------------
// The deploy workflow's wiring.
// ---------------------------------------------------------------------------

type Step = { name: string; id?: string; if?: string; continueOnError: boolean; body: string };

/**
 * Split a workflow job into steps. Deliberately a small parser over the raw file rather
 * than a YAML dependency added for one test: the file is ours, its shape is stable, and
 * the alternative is a package in the tree to read four fields.
 */
function parseSteps(yaml: string): Step[] {
	const lines = yaml.split('\n');
	const steps: Step[] = [];
	let current: string[] | null = null;
	for (const line of lines) {
		if (/^\s{6}- name:/.test(line)) {
			if (current) steps.push(toStep(current));
			current = [line];
		} else if (current) {
			// A new list item at the step indent ends the current step.
			if (/^\s{0,6}\S/.test(line) && !/^\s{7,}/.test(line) && line.trim() !== '') {
				steps.push(toStep(current));
				current = null;
			} else current.push(line);
		}
	}
	if (current) steps.push(toStep(current));
	return steps;
}

function toStep(lines: string[]): Step {
	const body = lines.join('\n');
	const field = (key: string) => body.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
	return {
		name: field('name') ?? '',
		id: field('id'),
		if: field('if'),
		continueOnError: field('continue-on-error') === 'true',
		body
	};
}

const deployYml = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const steps = parseSteps(deployYml);
const byId = (id: string) => steps.find((s) => s.id === id);

console.log('\nthe deploy workflow is wired so the valve can fire');
check('the workflow parsed into steps', steps.length > 5, `got ${steps.length}`);

{
	// The premise of the whole change: `wrangler deploy` uploads and shifts traffic in one
	// step, which leaves nothing to roll back to.
	//
	// Comment lines are stripped first. The header of that workflow explains at length why
	// it no longer calls `wrangler deploy`, and matching prose that says a thing is not
	// done is how a wiring test ends up asserting the opposite of what it means. Note the
	// word boundary too: `wrangler deployments status` is a read and must not trip this.
	const commands = deployYml
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n');
	const usesPlainDeploy = /wrangler deploy\b/.test(commands) || /pnpm worker:deploy/.test(commands);
	check('it does not call `wrangler deploy`', !usesPlainDeploy);
	check('it uploads a version', /wrangler versions upload/.test(deployYml));
	check('it promotes explicitly', /wrangler versions deploy/.test(deployYml));
	check('it can roll back', /wrangler rollback/.test(deployYml));
}

{
	const live = byId('live');
	const upload = byId('upload');
	check('the rollback target is recorded', live !== undefined);
	check('and recorded BEFORE the upload', steps.indexOf(live!) < steps.indexOf(upload!));
}

{
	const promote = byId('promote');
	check('there is a promote step', promote !== undefined);
	// This is the assertion that protects the pre-promotion check. A status function in
	// this condition would run the promote even after the pre-check failed, which is the
	// exact failure the check exists to prevent.
	const forced = /always\(|failure\(|cancelled\(/.test(promote?.if ?? '');
	check('promote does not force itself past a failed pre-check', !forced, promote?.if);
}

{
	const smoke = byId('smoke');
	check('there is a production smoke step', smoke !== undefined);
	// Without continue-on-error the job stops here and the rollback below never runs,
	// leaving the bad version serving traffic. This one line is the valve.
	check('the production smoke does not end the job', smoke?.continueOnError === true);
	check('it checks the configured public origin', /PUBLIC_BASE_URL/.test(smoke?.body ?? ''));
	check('it runs the tested script', /scripts\/smoke\.ts/.test(smoke?.body ?? ''));
}

{
	const rollback = byId('rollback');
	check('there is a rollback step', rollback !== undefined);
	// `outcome` is the pre-continue-on-error result; `conclusion` would be 'success' on a
	// step that failed under continue-on-error, so a rollback keyed on it never fires.
	check(
		'the rollback keys on the smoke step OUTCOME',
		/steps\.smoke\.outcome\s*==\s*'failure'/.test(rollback?.if ?? ''),
		rollback?.if
	);
	check(
		'and does not attempt a rollback with no recorded target',
		/steps\.live\.outputs\.previous\s*!=\s*''/.test(rollback?.if ?? ''),
		rollback?.if
	);
	check(
		'it rolls back to the recorded version',
		/steps\.live\.outputs\.previous/.test(rollback?.body ?? '')
	);
}

{
	// A rolled-back deploy that reports green is the worst outcome available: production
	// is on old code and the pipeline says everything is fine.
	const failing = steps.filter(
		(s) => /steps\.smoke\.outcome\s*==\s*'failure'/.test(s.if ?? '') && /exit 1/.test(s.body)
	);
	check('a failed smoke check turns the run red', failing.length > 0);
}

{
	const verify = steps.find((s) => /steps\.rollback\.outcome/.test(s.if ?? ''));
	check('the rollback is verified rather than assumed', verify !== undefined);
	check('and re-runs the checks against production', /scripts\/smoke\.ts/.test(verify?.body ?? ''));
}

done();
