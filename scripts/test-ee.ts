// Golden test for the enterprise foundation: entitlements and the model gateway. No network:
// fetch is stubbed, and D1 runs the REAL migrations over node:sqlite.
//
//   pnpm test:ee
//
// What this exists to catch:
//
//   1. CONTENT REACHING A RETAINING ENDPOINT. Every request the gateway builds carries
//      `provider: { zdr: true, data_collection: 'deny' }`, and the request that reaches fetch
//      is that one, not a copy that lost it.
//   2. AN UNENTITLED ORG REACHING A MODEL. No key, no entitlement, an expired one, or a spent
//      cap each refuse, in that order, and a refused gateway never calls fetch.
//   3. THE CAP LEAKING. Spend is counted from the cost the provider reports, per org per UTC
//      month, re-checked before every call, and a cap set on the entitlement beats the default.
//   4. `pnpm entitle` WRITING SOMETHING ELSE. Its SQL grants and revokes one row, rejects an
//      unknown feature or a malformed org id, and escapes a note.

import type { D1Database } from '@cloudflare/workers-types';
import { localD1 } from '../src/local/d1-sqlite.ts';
import {
	FEATURES,
	entitlementSql,
	getEntitlement,
	hasFeature,
	isActive,
	type Entitlement
} from '../ee/entitlements.ts';
import {
	DEFAULT_MONTHLY_CAP_USD,
	GatewayRefused,
	ZDR_PROVIDER,
	chatRequest,
	decisionRequest,
	gatewayAccess,
	HAIKU_MODEL,
	LUNA_MODEL,
	ModelUnavailable,
	haikuCostUsd,
	monthKey,
	openGateway,
	type Gateway
} from '../ee/review/gateway.ts';
import {
	TRIAGE_SYSTEM,
	advanceConsolidation,
	consolidationStepText,
	planStep,
	readRun,
	relatedPages,
	runConsolidationStep,
	sendable,
	triageFindings,
	type Claim,
	type PageText,
	type Proposal
} from '../ee/review/consolidation.ts';
import { conflictKey, readFindings } from '../src/lib/review-queue.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolderAsBrain } from './local-brain.ts';

import { checker } from './check.ts';

const { check, done } = checker('ee checks');

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 86_400_000;
const ent = (over: Partial<Entitlement> = {}): Entitlement => ({
	orgId: 'o1',
	feature: FEATURES.enterprise,
	source: 'manual',
	grantedAt: NOW - DAY,
	expiresAt: null,
	monthlyCapUsd: null,
	...over
});

console.log('\nrequests: zero data retention on every one (1)');
{
	const d = decisionRequest('state', { q: { type: 'noul', instructions: 'x' } });
	const c = chatRequest('sys', 'user', { type: 'object' });
	check(
		'the Jev request routes to ZDR only',
		JSON.stringify(d.provider) === JSON.stringify(ZDR_PROVIDER)
	);
	check(
		'the Luna request routes to ZDR only',
		JSON.stringify(c.provider) === JSON.stringify(ZDR_PROVIDER)
	);
	check(
		'ZDR is both zdr and data_collection deny',
		ZDR_PROVIDER.zdr === true && ZDR_PROVIDER.data_collection === 'deny'
	);
}

console.log('\naccess: refused in order (2)');
{
	const base = { hasKey: true, entitlement: ent() as Entitlement | null, spentUsd: 0, now: NOW };
	check('entitled, under cap: open', gatewayAccess(base).ok);
	const reason = (i: typeof base) => {
		const a = gatewayAccess(i);
		return a.ok ? 'ok' : a.reason;
	};
	check(
		'no key first, whatever else is true',
		reason({ ...base, hasKey: false, entitlement: null }) === 'no-key'
	);
	check('no entitlement', reason({ ...base, entitlement: null }) === 'not-entitled');
	check(
		'an expired entitlement',
		reason({ ...base, entitlement: ent({ expiresAt: NOW - 1 }) }) === 'not-entitled'
	);
	check('a future expiry is active', isActive(ent({ expiresAt: NOW + DAY }), NOW));
	check(
		'at the default cap',
		reason({ ...base, spentUsd: DEFAULT_MONTHLY_CAP_USD }) === 'over-cap'
	);
	check(
		"the entitlement's own cap beats the default (3)",
		reason({
			...base,
			entitlement: ent({ monthlyCapUsd: 100 }),
			spentUsd: DEFAULT_MONTHLY_CAP_USD
		}) === 'ok' &&
			reason({ ...base, entitlement: ent({ monthlyCapUsd: 1 }), spentUsd: 1 }) === 'over-cap'
	);
}

// A stubbed provider: records each request and answers with a fixed cost.
function stubFetch(cost: number) {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	const fn = (async (url: string, init: { body: string }) => {
		const body = JSON.parse(init.body) as Record<string, unknown>;
		calls.push({ url, body });
		const reply = String(url).endsWith('/alpha/decisions')
			? { answers: { q: { type: 'noul', noul: 0.9 } }, usage: { cost } }
			: { choices: [{ message: { content: '{"ok":true}' } }], usage: { cost } };
		return new Response(JSON.stringify(reply), { status: 200 });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

console.log('\ngateway: entitlements, ZDR on the wire, spend (1, 2, 3)');
{
	const db = localD1(':memory:').db as unknown as D1Database;
	const now = () => NOW;

	const provider = stubFetch(0.5);
	const refused = await openGateway({ apiKey: 'k', db, orgId: 'o1', fetch: provider.fn, now });
	check('no entitlement row: refused', !refused.ok && refused.reason === 'not-entitled');
	const noKey = await openGateway({ apiKey: undefined, db, orgId: 'o1', fetch: provider.fn, now });
	check('no key: refused', !noKey.ok && noKey.reason === 'no-key');
	check('a refused gateway never called the provider', provider.calls.length === 0);

	await db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId: 'o1',
				feature: FEATURES.enterprise,
				source: 'manual',
				now: NOW,
				monthlyCapUsd: 1
			})
		)
		.run();
	check(
		'the granted row reads back',
		(await getEntitlement(db, 'o1', FEATURES.enterprise))?.monthlyCapUsd === 1
	);
	check('hasFeature sees it', await hasFeature(db, 'o1', FEATURES.enterprise, NOW));
	check('another org has nothing', !(await hasFeature(db, 'o2', FEATURES.enterprise, NOW)));

	const opened = await openGateway({ apiKey: 'k', db, orgId: 'o1', fetch: provider.fn, now });
	if (!opened.ok) throw new Error('expected an open gateway');
	const answers = await opened.gateway.decide('state', { q: { type: 'noul', instructions: 'x' } });
	check('decide returns the answers', answers.q?.noul === 0.9);
	const reply = await opened.gateway.chatJson<{ ok: boolean }>('sys', 'user', { type: 'object' });
	check('chatJson parses the reply', reply.value.ok === true);
	check(
		'every request on the wire carried ZDR routing',
		provider.calls.length === 2 &&
			provider.calls.every((c) => JSON.stringify(c.body.provider) === JSON.stringify(ZDR_PROVIDER))
	);

	const row = await db
		.prepare('SELECT calls, cost_usd FROM model_usage_monthly WHERE org_id = ?1 AND month = ?2')
		.bind('o1', monthKey(NOW))
		.first<{ calls: number; cost_usd: number }>();
	check('spend is counted from the reported cost', row?.calls === 2 && row?.cost_usd === 1);

	let reason = '';
	try {
		await opened.gateway.decide('state', {});
	} catch (e) {
		reason = e instanceof GatewayRefused ? e.reason : String(e);
	}
	check(
		'the cap is re-checked before each call',
		reason === 'over-cap' && provider.calls.length === 2
	);

	const nextMonth = await openGateway({
		apiKey: 'k',
		db,
		orgId: 'o1',
		fetch: provider.fn,
		now: () => NOW + 31 * DAY
	});
	check('a new UTC month starts from zero', nextMonth.ok);

	await db
		.prepare(entitlementSql({ kind: 'revoke', orgId: 'o1', feature: FEATURES.enterprise }))
		.run();
	check('revoke removes it', !(await hasFeature(db, 'o1', FEATURES.enterprise, NOW)));
}

console.log('\npnpm entitle: the SQL (4)');
{
	const throws = (f: () => unknown) => {
		try {
			f();
			return false;
		} catch {
			return true;
		}
	};
	check(
		'an unknown feature is refused',
		throws(() => entitlementSql({ kind: 'revoke', orgId: 'o1', feature: 'everything' as never }))
	);
	check(
		'a malformed org id is refused',
		throws(() =>
			entitlementSql({ kind: 'revoke', orgId: "o1' OR 1=1 --", feature: FEATURES.enterprise })
		)
	);
	check(
		'a negative cap is refused',
		throws(() =>
			entitlementSql({
				kind: 'grant',
				orgId: 'o1',
				feature: FEATURES.enterprise,
				source: 'plan',
				now: NOW,
				monthlyCapUsd: -1
			})
		)
	);
	const db = localD1(':memory:').db as unknown as D1Database;
	await db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId: 'o1',
				feature: FEATURES.enterprise,
				source: 'trial',
				now: NOW,
				note: "Acme's trial"
			})
		)
		.run();
	const note = await db.prepare('SELECT note FROM org_entitlements').first<{ note: string }>();
	check('a note with a quote is escaped, not executed', note?.note === "Acme's trial");
	await db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId: 'o1',
				feature: FEATURES.enterprise,
				source: 'plan',
				now: NOW
			})
		)
		.run();
	const rows = (await db.prepare('SELECT source FROM org_entitlements').all<{ source: string }>())
		.results;
	check('granting again updates the one row', rows.length === 1 && rows[0].source === 'plan');
}

// A stubbed Anthropic API: answers each Messages request by `mode`, and records it.
function stubAnthropic(mode: () => 'ok' | 'refusal' | 429 | 402 | 529) {
	const calls: { url: string; body: Record<string, unknown>; key: string | null }[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url instanceof Request ? url.url : url);
		const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
		if (!href.startsWith('https://api.anthropic.com/')) {
			const reply = { choices: [{ message: { content: '{"ok":"luna"}' } }], usage: { cost: 0.01 } };
			calls.push({ url: href, body, key: null });
			return new Response(JSON.stringify(reply), { status: 200 });
		}
		const h = new Headers(init?.headers);
		const key = h.get('x-api-key') ?? h.get('authorization')?.replace(/^Bearer /, '') ?? null;
		calls.push({ url: href, body, key });
		const m = mode();
		const headers = { 'content-type': 'application/json', 'x-should-retry': 'false' };
		if (typeof m === 'number') {
			const type = { 429: 'rate_limit_error', 402: 'billing_error', 529: 'overloaded_error' }[m];
			return new Response(JSON.stringify({ type: 'error', error: { type, message: 'stub' } }), {
				status: m,
				headers
			});
		}
		const message = {
			id: 'msg_stub',
			type: 'message',
			role: 'assistant',
			model: HAIKU_MODEL,
			content: m === 'ok' ? [{ type: 'text', text: '{"ok":"haiku"}' }] : [],
			stop_reason: m === 'ok' ? 'end_turn' : 'refusal',
			stop_details: null,
			stop_sequence: null,
			usage: {
				input_tokens: 10_000,
				output_tokens: 2_000,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0
			}
		};
		return new Response(JSON.stringify(message), { status: 200, headers });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

async function entitled(db: D1Database, orgId = 'o1', cap?: number) {
	await db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId,
				feature: FEATURES.enterprise,
				source: 'manual',
				now: NOW,
				monthlyCapUsd: cap
			})
		)
		.run();
}

const spent = async (db: D1Database) =>
	(await db
		.prepare('SELECT calls, cost_usd FROM model_usage_monthly WHERE org_id = ?1')
		.bind('o1')
		.first<{ calls: number; cost_usd: number }>()) ?? { calls: 0, cost_usd: 0 };

const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;

console.log('\ngateway: Haiku first, Luna as the fallback, cost from tokens (5)');
{
	check(
		'Haiku cost is list price on the short card',
		near(haikuCostUsd({ input_tokens: 10_000, output_tokens: 2_000 }), 0.002)
	);
	check(
		'a prompt past 100K tokens bills on the long card',
		near(haikuCostUsd({ input_tokens: 150_000, output_tokens: 1_000 }), 0.0775)
	);
	check(
		'cache reads and writes count toward the prompt and the cost',
		near(
			haikuCostUsd({
				input_tokens: 1_000,
				output_tokens: 0,
				cache_read_input_tokens: 10_000,
				cache_creation_input_tokens: 1_000
			}),
			(1_000 * 0.1 + 10_000 * 0.01 + 1_000 * 0.125) / 1e6
		)
	);

	const db = localD1(':memory:').db as unknown as D1Database;
	await entitled(db);
	let mode: 'ok' | 'refusal' | 429 | 402 | 529 = 'ok';
	const api = stubAnthropic(() => mode);
	const open = (keys: { apiKey?: string; anthropicKey?: string }) =>
		openGateway({ ...keys, apiKey: keys.apiKey, db, orgId: 'o1', fetch: api.fn, now: () => NOW });

	const haikuOnly = await open({ anthropicKey: 'ak' });
	check('an Anthropic key alone opens the gateway', haikuOnly.ok);
	if (!haikuOnly.ok) throw new Error('expected an open gateway');
	const served = await haikuOnly.gateway.chatJson<{ ok: string }>('sys', 'user', {
		type: 'object'
	});
	const sent = api.calls[0];
	check(
		'text goes to Haiku first, with the schema as the output format',
		served.model === HAIKU_MODEL &&
			served.value.ok === 'haiku' &&
			sent.url === 'https://api.anthropic.com/v1/messages' &&
			sent.key === 'ak' &&
			sent.body.model === HAIKU_MODEL &&
			sent.body.system === 'sys' &&
			JSON.stringify(sent.body.output_config) ===
				JSON.stringify({ format: { type: 'json_schema', schema: { type: 'object' } } })
	);
	check(
		'Haiku spend is recorded from its tokens',
		near(served.costUsd, 0.002) && near((await spent(db)).cost_usd, 0.002)
	);

	const reasonOf = async (p: Promise<unknown>) => {
		try {
			await p;
			return 'served';
		} catch (e) {
			return e instanceof ModelUnavailable ? e.reason : String(e);
		}
	};
	mode = 'refusal';
	check(
		'a refusal with no fallback key is reported, not parsed',
		(await reasonOf(haikuOnly.gateway.chatJson('s', 'u', {}))) === 'refusal'
	);
	check('a refusal still counts what it cost', (await spent(db)).calls === 2);
	mode = 402;
	check(
		'exhausted credits with no fallback key are reported',
		(await reasonOf(haikuOnly.gateway.chatJson('s', 'u', {}))) === 'credits'
	);
	check('a failed request records no spend', (await spent(db)).calls === 2);

	const both = await open({ apiKey: 'ork', anthropicKey: 'ak' });
	if (!both.ok) throw new Error('expected an open gateway');
	for (const m of ['refusal', 429, 402, 529] as const) {
		mode = m;
		const before = api.calls.length;
		const fell = await both.gateway.chatJson<{ ok: string }>('s', 'u', {});
		const tail = api.calls.slice(before);
		check(
			`${m} from Haiku falls back to Luna, with ZDR routing`,
			fell.model === LUNA_MODEL &&
				fell.value.ok === 'luna' &&
				tail.length === 2 &&
				tail[0].url.startsWith('https://api.anthropic.com/') &&
				JSON.stringify(tail[1].body.provider) === JSON.stringify(ZDR_PROVIDER)
		);
	}
	mode = 'ok';
	const lunaOnly = await open({ apiKey: 'ork' });
	if (!lunaOnly.ok) throw new Error('expected an open gateway');
	const before = api.calls.length;
	check(
		'with no Anthropic key, text goes straight to Luna',
		(await lunaOnly.gateway.chatJson('s', 'u', {})).model === LUNA_MODEL &&
			!api.calls.slice(before).some((c) => c.url.startsWith('https://api.anthropic.com/'))
	);

	const capped = localD1(':memory:').db as unknown as D1Database;
	await entitled(capped, 'o1', 0.002);
	const tight = await openGateway({
		apiKey: undefined,
		anthropicKey: 'ak',
		db: capped,
		orgId: 'o1',
		fetch: api.fn,
		now: () => NOW
	});
	if (!tight.ok) throw new Error('expected an open gateway');
	await tight.gateway.chatJson('s', 'u', {});
	let capReason = '';
	try {
		await tight.gateway.chatJson('s', 'u', {});
	} catch (e) {
		capReason = e instanceof GatewayRefused ? e.reason : String(e);
	}
	check('the cap counts Haiku spend and stops the next call', capReason === 'over-cap');
}

console.log('\nconsolidation: candidates, pre-scan, claim filter, verify (6)');
{
	const page = (path: string, title: string, content: string): PageText => ({
		path,
		title,
		content
	});
	const pages = [
		page('a.md', 'Acme rates', 'Acme rates are listed here.'),
		page('b.md', 'Acme', 'Acme rates and terms.'),
		page('c.md', 'Garden', 'Tomatoes and basil.'),
		page('d.md', 'Basil', 'Garden basil notes.')
	];
	check(
		'related pages come from the title, never the page itself',
		JSON.stringify(relatedPages(pages[0], pages)) === JSON.stringify(['b.md'])
	);

	const all = new Set<string>();
	let cursor: string | null = null;
	let steps = 0;
	let repeats = 0;
	for (;;) {
		const plan = planStep(pages, new Map([['a.md', ['d.md']]]), cursor, 1);
		for (const { pair } of plan.pairs) {
			const k = pair.join('|');
			if (all.has(k)) repeats++;
			all.add(k);
		}
		cursor = plan.last;
		steps++;
		if (plan.done || steps > 10) break;
	}
	check(
		'a pass checks each pair once across steps, tension partners included',
		repeats === 0 && all.has('a.md|b.md') && all.has('a.md|d.md') && all.has('c.md|d.md')
	);
	check('the budget splits the pass into steps', steps > 1);
	check('a fresh plan with a big budget is one step', planStep(pages, new Map(), null, 100).done);

	check('a page with a private key is not sendable', !sendable('x\n-----BEGIN PRIVATE KEY-----\n'));
	check('a plain page is sendable', sendable('The day rate is $1,200.'));

	const a = page('people/a.md', 'Acme engagement', 'The day rate for Acme is $1,200 per day.\n');
	const b = page('clients/acme.md', 'Acme', 'As of 2026-01 the day rate is $1,500 per day.\n');
	const claim = (over: Partial<Claim> = {}): Claim => ({
		subject: 'Acme day rate',
		quote_a: 'The day rate for Acme is $1,200 per day.',
		quote_b: 'As of 2026-01 the day rate is $1,500 per day.',
		value_a: '$1,200',
		value_b: '$1,500',
		explained: false,
		misleading: 0.8,
		stands: 'b',
		action: 'patch',
		patch: { page: 'a', find: '$1,200', replace: '$1,500' },
		why: 'The dated record is later.',
		...over
	});
	const triage = (claims: Claim[], pair = { a, b }) =>
		triageFindings({
			...pair,
			claims,
			model: HAIKU_MODEL,
			pageShas: { [a.path]: 's1', [b.path]: 's2' },
			runId: 'r1'
		});

	const kept = await triage([claim()]);
	const f = kept.findings[0];
	const proposal = f?.proposal as Proposal | undefined;
	check(
		'a real disagreement becomes one conflict finding, keyed on the pair and the values',
		kept.findings.length === 1 &&
			f.kind === 'conflict' &&
			f.key === (await conflictKey([a.path, b.path], ['$1,200', '$1,500'])) &&
			f.pageShas[a.path] === 's1' &&
			f.pageShas[b.path] === 's2' &&
			f.scores?.misleading === 0.8
	);
	check(
		'its verified patch and the page that stands go in the proposal, for review',
		proposal?.tier === 'review' &&
			proposal.stands === b.path &&
			proposal.patch?.path === a.path &&
			proposal.patch.replace === '$1,500' &&
			proposal.patchRejected === undefined
	);
	const same = { a, b: { ...b, content: a.content } };
	const drops: [string, Claim, { a: PageText; b: PageText }][] = [
		['an explained claim', claim({ explained: true }), { a, b }],
		['a claim nobody would be misled by', claim({ misleading: 0.39 }), { a, b }],
		['a quote that is not on its page', claim({ quote_a: 'The day rate is $1,200.' }), { a, b }],
		['a value that is not inside its quote', claim({ value_a: '$1,100' }), { a, b }],
		['an empty value', claim({ value_b: ' ' }), { a, b }],
		[
			'the same value on both sides',
			claim({ value_b: '$1,200', quote_b: 'The day rate for Acme is $1,200 per day.' }),
			same
		]
	];
	for (const [label, c, pair] of drops) {
		const r = await triage([c], pair);
		check(`${label} is dropped`, r.findings.length === 0 && r.dropped === 1);
	}
	const twice = page(
		'people/a.md',
		'Acme engagement',
		'The day rate for Acme is $1,200 per day. Was $1,200.\n'
	);
	const rejected = await triage([claim()], { a: twice, b });
	const rp = rejected.findings[0]?.proposal as Proposal | undefined;
	check(
		'a patch whose text occurs more than once is kept for review without the patch',
		rejected.findings.length === 1 && rp?.patch === null && !!rp?.patchRejected
	);
	const person = await triage([claim({ action: 'person', patch: null, stands: 'neither' })]);
	const pp = person.findings[0]?.proposal as Proposal | undefined;
	check(
		'a claim the pages cannot settle goes to a person',
		pp?.tier === 'person' && pp.stands === null
	);
	const dup = await triage([claim(), claim({ subject: 'Reworded', why: 'Other words.' })]);
	check('the same disagreement twice is one finding', dup.findings.length === 1);
}

console.log('\nconsolidation: a pass over an indexed brain (7)');
{
	const src = await mkdtemp(join(tmpdir(), 'ee-brain-'));
	const write = async (rel: string, text: string) => {
		await mkdir(join(src, rel, '..'), { recursive: true });
		await writeFile(join(src, rel), text);
	};
	const LOW = 'The day rate for Acme engagement is $1,200 per day.';
	const HIGH = 'As of 2026-01 the Acme engagement day rate is $1,500 per day.';
	await write('people/acme-engagement.md', `# Acme engagement\n\n${LOW}\n`);
	await write('clients/acme.md', `# Acme engagement terms\n\n${HIGH}\n`);
	await write(
		'notes/acme-keys.md',
		'# Acme engagement keys\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n'
	);
	await write('misc/garden.md', '# Garden\n\nTomatoes and basil.\n');
	const brain = await openFolderAsBrain(src, 'wiki');
	const db = brain.db as unknown as D1Database;
	try {
		await entitled(db);
		const prompts: string[] = [];
		const systems = new Set<string>();
		let failOn = -1;
		const gateway: Pick<Gateway, 'chatJson'> = {
			async chatJson<T>(system: string, user: string) {
				const n = prompts.length;
				prompts.push(user);
				systems.add(system);
				if (n === failOn) throw new GatewayRefused('over-cap');
				const highFirst = user.indexOf('$1,500') < user.indexOf('$1,200');
				const claims =
					user.includes('$1,200') && user.includes('$1,500')
						? [
								{
									subject: 'Acme day rate',
									quote_a: highFirst ? HIGH : LOW,
									quote_b: highFirst ? LOW : HIGH,
									value_a: highFirst ? '$1,500' : '$1,200',
									value_b: highFirst ? '$1,200' : '$1,500',
									explained: false,
									misleading: 0.9,
									stands: 'neither',
									action: 'person',
									patch: null,
									why: 'The pages disagree.'
								}
							]
						: [];
				return { value: { claims } as T, model: HAIKU_MODEL, costUsd: 0.001 };
			}
		};
		const target = {
			db,
			brainId: brain.brainId,
			orgId: 'o1',
			actorUserId: 'u1',
			config: brain.config,
			gateway,
			newRunId: () => 'run-1'
		};

		const s = await advanceConsolidation(target, NOW);
		const rows = await readFindings(db, brain.brainId);
		check(
			'the pass finds the contradiction and queues it',
			s.status === 'done' &&
				rows.length === 1 &&
				rows[0].kind === 'conflict' &&
				rows[0].runId === 'run-1' &&
				JSON.stringify(rows[0].paths) ===
					JSON.stringify(['wiki/clients/acme.md', 'wiki/people/acme-engagement.md'])
		);
		check(
			'the triage instructions go as the system prompt',
			systems.size === 1 && systems.has(TRIAGE_SYSTEM)
		);
		check(
			'the page holding a private key never reached the model, and its pairs are skipped',
			prompts.length > 0 && !prompts.some((p) => p.includes('PRIVATE KEY')) && s.pairsSkipped >= 1
		);
		check(
			'the run records cost and who served it',
			near(s.costUsd, 0.001 * s.pairsChecked) && s.served[HAIKU_MODEL] === s.pairsChecked
		);
		check(
			'the step text says it finished',
			consolidationStepText(s).startsWith('Consolidation finished')
		);
		const full = new Set(prompts);

		prompts.length = 0;
		failOn = 0;
		const stopped = await advanceConsolidation({ ...target, newRunId: () => 'run-2' }, NOW);
		check(
			'a gateway refusal stops the pass and says why',
			stopped.status === 'stopped' &&
				stopped.stoppedReason === 'over-cap' &&
				consolidationStepText(stopped).includes('spend cap')
		);
		const refusedPrompt = prompts[0];
		const answered = new Set(prompts.slice(1));
		failOn = -1;
		prompts.length = 0;
		const resumed = await advanceConsolidation({ ...target, newRunId: () => 'run-3' }, NOW);
		check(
			'asking again resumes the stopped pass and asks again for the pair that was refused',
			resumed.status === 'done' && resumed.runId === 'run-2' && prompts.includes(refusedPrompt)
		);
		check(
			'between the two steps, every pair was answered',
			[...full].every((p) => answered.has(p) || prompts.includes(p))
		);
		check('the run row reads back', (await readRun(db, brain.brainId))?.status === 'done');

		await db.prepare('DELETE FROM org_entitlements').run();
		const unentitled = await runConsolidationStep({
			db,
			brainId: brain.brainId,
			orgId: 'o1',
			config: brain.config,
			anthropicKey: 'ak',
			fetch: (() => {
				throw new Error('no fetch');
			}) as unknown as typeof fetch
		});
		check(
			'an org without the enterprise entitlement runs nothing',
			unentitled.text.includes('no enterprise entitlement')
		);
	} finally {
		await brain.cleanup();
		await rm(src, { recursive: true, force: true });
	}
}

done();
