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
	JEV_MODEL,
	LUNA_MODEL,
	ModelUnavailable,
	haikuCostUsd,
	monthKey,
	openGateway,
	type Gateway
} from '../ee/review/gateway.ts';
import {
	JEV_CLAIM_PAGE_CHARS,
	JEV_CONFLICT_QUESTION,
	MISLEADING_QUESTION,
	STEP_TIME_MS,
	TRIAGE_SYSTEM,
	advanceConsolidation,
	blockShape,
	consolidationStepText,
	passesScreen,
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
import { resetIndex } from '../src/lib/brain-index.ts';
import { continuePass, readPass, savePass, savePassStatement } from '../src/lib/brain-pass.ts';
import { SNAPSHOT_BEGIN, SNAPSHOT_END } from '../src/lib/view-directives.ts';
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
	const answers = await opened.gateway.decide!('state', { q: { type: 'noul', instructions: 'x' } });
	check('decide returns the answers', answers.value.q?.noul === 0.9);
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
		await opened.gateway.decide!('state', {});
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

// Write one file under a fixture folder.
async function seed(dir: string, rel: string, text: string) {
	await mkdir(join(dir, rel, '..'), { recursive: true });
	await writeFile(join(dir, rel), text);
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

	const limited = localD1(':memory:').db as unknown as D1Database;
	await entitled(limited);
	const busy = (async () =>
		new Response('{"error":"slow down"}', { status: 429 })) as unknown as typeof fetch;
	const lunaBusy = await openGateway({
		apiKey: 'ork',
		db: limited,
		orgId: 'o1',
		fetch: busy,
		now: () => NOW
	});
	if (!lunaBusy.ok) throw new Error('expected an open gateway');
	let lunaReason = '';
	try {
		await lunaBusy.gateway.chatJson('s', 'u', {});
	} catch (e) {
		lunaReason = e instanceof ModelUnavailable ? e.reason : String(e);
	}
	check(
		'a rate limit from OpenRouter is a rate limit, as from Anthropic',
		lunaReason === 'rate-limit'
	);
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
		stands: 'b',
		action: 'patch',
		patch: { page: 'a', find: '$1,200', replace: '$1,500' },
		why: 'The dated record is later.',
		...over
	});
	const scored: string[] = [];
	const triage = (claims: Claim[], pair = { a, b }, misleading: number | null = 0.8) =>
		triageFindings({
			...pair,
			claims,
			model: HAIKU_MODEL,
			pageShas: { [a.path]: 's1', [b.path]: 's2' },
			runId: 'r1',
			misleading: async (c) => {
				scored.push(c.subject);
				return misleading ?? undefined;
			}
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
		['a quote that is not on its page', claim({ quote_a: 'The day rate is $1,200.' }), { a, b }],
		['a value that is not inside its quote', claim({ value_a: '$1,100' }), { a, b }],
		['an empty value', claim({ value_b: ' ' }), { a, b }],
		[
			'the same value on both sides',
			claim({ value_b: '$1,200', quote_b: 'The day rate for Acme is $1,200 per day.' }),
			same
		]
	];
	scored.length = 0;
	for (const [label, c, pair] of drops) {
		const r = await triage([c], pair);
		check(`${label} is dropped`, r.findings.length === 0 && r.dropped === 1);
	}
	check('a claim the mechanical filters drop is never sent to be scored', scored.length === 0);
	const unmisleading = await triage([claim()], { a, b }, 0.39);
	check(
		'a claim Jev scores under 0.4 on misleading is dropped',
		unmisleading.findings.length === 0 && unmisleading.dropped === 1
	);
	const atGate = await triage([claim()], { a, b }, 0.4);
	check('a claim scored at 0.4 is kept', atGate.findings.length === 1);
	const unscored = await triage([claim()], { a, b }, null);
	check(
		'a claim with no score is kept, and carries no scores',
		unscored.findings.length === 1 && unscored.findings[0].scores === null
	);
	const twice = page(
		'people/a.md',
		'Acme engagement',
		'The day rate for Acme is $1,200 per day. Was $1,200.\n'
	);
	const rejected = await triage([claim()], { a: twice, b });
	const rp = rejected.findings[0]?.proposal as Proposal | undefined;
	check(
		'a patch whose text occurs more than once goes to a person without the patch',
		rejected.findings.length === 1 &&
			rp?.patch === null &&
			rp.tier === 'person' &&
			!!rp.patchRejected
	);
	const tabled = page(
		'people/a.md',
		'Acme engagement',
		'Rates:\n\n| Client | Rate |\n| --- | --- |\n| Acme | $1,200 |\n| Globex | $900 |\n'
	);
	const split = await triage(
		[
			claim({
				quote_a: '| Acme | $1,200 |',
				patch: {
					page: 'a',
					find: '| Acme | $1,200 |',
					replace: '| Acme | $1,500 |\n\nNote: rate changed in 2026.\n'
				}
			})
		],
		{ a: tabled, b }
	);
	const sp = split.findings[0]?.proposal as Proposal | undefined;
	check(
		'a patch that splits a table is rejected',
		sp?.patch === null && sp.tier === 'person' && /table/.test(sp.patchRejected ?? '')
	);
	const inTable = await triage(
		[
			claim({
				quote_a: '| Acme | $1,200 |',
				patch: { page: 'a', find: '| Acme | $1,200 |', replace: '| Acme | $1,500 |' }
			})
		],
		{ a: tabled, b }
	);
	const snapshotted = page(
		'people/a.md',
		'Acme engagement',
		`The day rate for Acme is $1,200 per day.\n\n${SNAPSHOT_BEGIN}\nRate: $1,200 (generated)\n${SNAPSHOT_END}\n`
	);
	const inSnapshot = await triage(
		[claim({ patch: { page: 'a', find: 'Rate: $1,200 (generated)', replace: 'Rate: $1,500' } })],
		{ a: snapshotted, b }
	);
	const isp = inSnapshot.findings[0]?.proposal as Proposal | undefined;
	check(
		"a patch inside a generated okf-view snapshot is rejected by the write path's own rule",
		isp?.patch === null && /snapshot/.test(isp.patchRejected ?? '')
	);
	check(
		'a tilde fence closes only on tildes, as the indexer reads it',
		blockShape('~~~\n```\n| x |\n~~~\n| y |') === 'FFT'
	);
	check(
		'a patch that edits a table cell in place passes',
		(inTable.findings[0]?.proposal as Proposal | undefined)?.patch !== null
	);
	check(
		'block shape sees fences, headings, and runs of table rows and list items',
		blockShape('# T\n\n- a\n- b\n\n| x |\n| y |\n\n```\n| not a table |\n```\n') === 'HLTFF' &&
			blockShape('| x |\nbreak\n| y |') === 'TT' &&
			blockShape('- a\n- b') === 'L'
	);
	const noted = await triage([claim({ action: 'note', patch: null })]);
	check(
		'a proposed note goes to a person',
		(noted.findings[0]?.proposal as Proposal | undefined)?.tier === 'person'
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
	const write = (rel: string, text: string) => seed(src, rel, text);
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
			store: brain.store,
			repo: brain.repoArgs,
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

		await resetIndex(db, brain.brainId);
		const fresh = await advanceConsolidation({ ...target, newRunId: () => 'run-4' }, NOW);
		check(
			'the pass brings the index up to the branch head itself',
			fresh.status === 'done' && fresh.pairsChecked > 0
		);

		await db.prepare('DELETE FROM org_entitlements').run();
		const unentitled = await runConsolidationStep({
			db,
			brainId: brain.brainId,
			orgId: 'o1',
			config: brain.config,
			store: brain.store,
			repo: brain.repoArgs,
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

console.log('\nconsolidation: the Jev screen (8)');
{
	check(
		'the gate is 0.3: below clears, at or above goes to triage, no answer goes to triage',
		!passesScreen(0.29) && passesScreen(0.3) && passesScreen(0.9) && passesScreen(undefined)
	);

	const db0 = localD1(':memory:').db as unknown as D1Database;
	await entitled(db0);
	const api = stubAnthropic(() => 'ok');
	const noOpenRouter = await openGateway({
		apiKey: undefined,
		anthropicKey: 'ak',
		db: db0,
		orgId: 'o1',
		fetch: api.fn,
		now: () => NOW
	});
	check(
		'without an OpenRouter key the gateway cannot decide',
		noOpenRouter.ok && !noOpenRouter.gateway.decide
	);
	const jevProvider = stubFetch(0.0002);
	const withJev = await openGateway({
		apiKey: 'ork',
		db: db0,
		orgId: 'o1',
		fetch: jevProvider.fn,
		now: () => NOW
	});
	if (!withJev.ok) throw new Error('expected an open gateway');
	const decided = await withJev.gateway.decide!(
		{ a: { path: 'a', text: 'x' } },
		JEV_CONFLICT_QUESTION
	);
	check(
		'decide reports Jev as the model and its cost, with the state sent as given',
		!!withJev.gateway.decide &&
			decided.model === JEV_MODEL &&
			near(decided.costUsd, 0.0002) &&
			JSON.stringify(jevProvider.calls[0].body.state) ===
				JSON.stringify({ a: { path: 'a', text: 'x' } })
	);

	const src = await mkdtemp(join(tmpdir(), 'ee-screen-'));
	const write = (rel: string, text: string) => seed(src, rel, text);
	const LOW = 'The day rate for Acme engagement is $1,200 per day.';
	const HIGH = 'As of 2026-01 the Acme engagement day rate is $1,500 per day.';
	await write('people/acme-engagement.md', `# Acme engagement\n\n${LOW}\n`);
	await write(
		'clients/acme.md',
		`# Acme engagement terms\n\n${HIGH}\n\n${'Terms. '.repeat(4_000)}\n`
	);
	await write('notes/acme-engagement-log.md', '# Acme engagement log\n\nKickoff went well.\n');
	await write(
		'notes/acme-engagement-archive.md',
		`# Acme engagement archive\n\n${'Old notes. '.repeat(4_000)}\n`
	);
	const brain = await openFolderAsBrain(src, 'wiki');
	const db = brain.db as unknown as D1Database;
	try {
		await entitled(db);
		const triaged: string[] = [];
		const screened: string[] = [];
		let screenFails: 'none' | 'error' | 'refused' = 'none';
		const gateway: Pick<Gateway, 'chatJson' | 'decide'> = {
			async decide(state) {
				const s = state as { a: { text: string }; b: { text: string } };
				const both = s.a.text + s.b.text;
				screened.push(both);
				if (screenFails === 'error') throw new Error('Model gateway 500');
				if (screenFails === 'refused') throw new GatewayRefused('over-cap');
				const conflict = both.includes('$1,200') && both.includes('$1,500') ? 0.9 : 0.1;
				return {
					value: { conflict: { type: 'noul', noul: conflict } },
					model: JEV_MODEL,
					costUsd: 0.0002
				};
			},
			async chatJson<T>(_system: string, user: string) {
				triaged.push(user);
				return { value: { claims: [] } as T, model: HAIKU_MODEL, costUsd: 0.001 };
			}
		};
		const target = {
			db,
			brainId: brain.brainId,
			orgId: 'o1',
			config: brain.config,
			store: brain.store,
			repo: brain.repoArgs,
			gateway,
			newRunId: () => 'screen-1'
		};
		const s = await advanceConsolidation(target, NOW);
		const archivePairs = triaged.filter((u) => u.includes('Old notes.')).length;
		check(
			'only the pair Jev flags, and pairs too long for Jev, reach triage',
			s.status === 'done' &&
				triaged.some((u) => u.includes('$1,200') && u.includes('$1,500')) &&
				triaged.length === 1 + archivePairs &&
				archivePairs > 0 &&
				!screened.some((x) => x.includes('Old notes.'))
		);
		check(
			'cleared pairs count as checked and screened, and Jev is recorded as a model',
			s.pairsScreened > 0 &&
				s.pairsChecked === s.pairsScreened + triaged.length &&
				s.served[JEV_MODEL] === screened.length &&
				near(s.costUsd, 0.0002 * screened.length + 0.001 * triaged.length)
		);
		check(
			'the step text says how many the screen cleared',
			consolidationStepText(s).includes(`(${s.pairsScreened} cleared by the screen)`)
		);
		check(
			'the screened count reads back',
			(await readRun(db, brain.brainId))?.pairsScreened === s.pairsScreened
		);

		triaged.length = 0;
		screenFails = 'error';
		const failed = await advanceConsolidation({ ...target, newRunId: () => 'screen-2' }, NOW);
		check(
			'a screen that errors lets every pair through to triage',
			failed.status === 'done' &&
				failed.pairsScreened === 0 &&
				triaged.length === failed.pairsChecked
		);
		screenFails = 'none';
		const screenedBefore = screened.length;
		const unscreened = await advanceConsolidation(
			{ ...target, gateway: { ...gateway, decide: undefined }, newRunId: () => 'screen-2b' },
			NOW
		);
		check(
			'a gateway that cannot decide never calls the screen',
			unscreened.status === 'done' &&
				unscreened.pairsScreened === 0 &&
				screened.length === screenedBefore
		);
		screenFails = 'refused';
		const refused = await advanceConsolidation({ ...target, newRunId: () => 'screen-3' }, NOW);
		check(
			'a refused gateway at the screen stops the pass',
			refused.status === 'stopped' && refused.stoppedReason === 'over-cap'
		);

		const claimStates: { claim?: { topic: string; says_a: string }; page_a?: { text: string } }[] =
			[];
		let claimScore = 0.2;
		let decideCalls = 0;
		const scoring: Pick<Gateway, 'chatJson' | 'decide'> = {
			async decide(state, questions): ReturnType<NonNullable<Gateway['decide']>> {
				decideCalls++;
				const st = state as (typeof claimStates)[number] & {
					a?: { text: string };
					b?: { text: string };
				};
				if (st.claim) {
					claimStates.push(st);
					check(
						'the claim question is the one the evals measured',
						questions === MISLEADING_QUESTION
					);
					return {
						value: { misleading: { type: 'noul', noul: claimScore } },
						model: JEV_MODEL,
						costUsd: 0.0003
					};
				}
				const both = (st.a?.text ?? '') + (st.b?.text ?? '');
				const conflict = both.includes('$1,200') && both.includes('$1,500') ? 0.9 : 0.1;
				return {
					value: { conflict: { type: 'noul', noul: conflict } },
					model: JEV_MODEL,
					costUsd: 0.0002
				};
			},
			async chatJson<T>(_system: string, user: string) {
				const hit = user.includes('$1,200') && user.includes('$1,500');
				const lowFirst = user.indexOf('$1,200') < user.indexOf('$1,500');
				const claims = hit
					? [
							{
								subject: 'Acme day rate',
								quote_a: lowFirst ? LOW : HIGH,
								quote_b: lowFirst ? HIGH : LOW,
								value_a: lowFirst ? '$1,200' : '$1,500',
								value_b: lowFirst ? '$1,500' : '$1,200',
								explained: false,
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
		await db.prepare('DELETE FROM review_findings').run();
		const low = await advanceConsolidation(
			{ ...target, gateway: scoring, newRunId: () => 'claim-1' },
			NOW
		);
		check(
			'a claim Jev scores as not misleading is dropped inside the pass, and its cost counted',
			low.status === 'done' &&
				low.findings === 0 &&
				claimStates.length === 1 &&
				claimStates[0].claim?.topic === 'Acme day rate' &&
				[LOW, HIGH].includes(claimStates[0].claim?.says_a ?? '') &&
				(claimStates[0].page_a?.text.length ?? 0) <= JEV_CLAIM_PAGE_CHARS &&
				low.served[JEV_MODEL] === decideCalls
		);
		claimScore = 0.9;
		const high = await advanceConsolidation(
			{ ...target, gateway: scoring, newRunId: () => 'claim-2' },
			NOW
		);
		const kept = await readFindings(db, brain.brainId);
		check(
			'a claim Jev scores as misleading is queued with its score',
			high.findings === 1 && kept.length === 1 && kept[0].scores?.misleading === 0.9
		);
		check(
			'the claim question reads each page cut to 24,000 characters, as measured',
			claimStates.length > 0 &&
				claimStates.every((st) => (st.page_a?.text.length ?? 0) <= JEV_CLAIM_PAGE_CHARS) &&
				claimStates.some((st) => (st.page_a?.text.length ?? 0) === JEV_CLAIM_PAGE_CHARS)
		);
		claimStates.length = 0;
		await db.prepare('DELETE FROM review_findings').run();
		const noJev = await advanceConsolidation(
			{ ...target, gateway: { ...scoring, decide: undefined }, newRunId: () => 'claim-3' },
			NOW
		);
		const unscoredRows = await readFindings(db, brain.brainId);
		check(
			'a gateway that cannot decide never scores claims, and keeps them unscored',
			noJev.findings === 1 && claimStates.length === 0 && unscoredRows[0]?.scores === null
		);
	} finally {
		await brain.cleanup();
		await rm(src, { recursive: true, force: true });
	}
}

console.log('\nconsolidation: each step is bounded by time (10)');
{
	const src = await mkdtemp(join(tmpdir(), 'ee-time-'));
	for (let n = 1; n <= 10; n++) {
		await seed(
			src,
			`notes/acme-${n}.md`,
			`# Acme topic ${n}\n\nAcme topic ${n} notes about Acme.\n`
		);
	}
	const brain = await openFolderAsBrain(src, 'wiki');
	const db = brain.db as unknown as D1Database;
	try {
		const prompts: string[] = [];
		const gateway: Pick<Gateway, 'chatJson'> = {
			async chatJson<T>(_system: string, user: string) {
				prompts.push(user);
				return { value: { claims: [] } as T, model: HAIKU_MODEL, costUsd: 0 };
			}
		};
		const base = {
			db,
			brainId: brain.brainId,
			orgId: 'o1',
			config: brain.config,
			store: brain.store,
			repo: brain.repoArgs,
			gateway
		};

		// A clock that never moves: one step checks the whole plan.
		const whole = await advanceConsolidation(
			{ ...base, newRunId: () => 'whole', clock: () => 0 },
			NOW
		);
		const all = new Set(prompts);
		check(
			'with time to spare, one step checks more pairs than one batch',
			whole.status === 'done' && whole.pairsChecked > 6 && all.size === whole.pairsChecked
		);

		// A clock that jumps past the limit after the first batch: each step checks one batch.
		prompts.length = 0;
		let tick = 0;
		const slow = () => (tick++ === 0 ? 0 : STEP_TIME_MS);
		const first = await advanceConsolidation({ ...base, newRunId: () => 'slow', clock: slow }, NOW);
		check(
			'a step stops starting batches once the time is up, and the pass keeps running',
			first.status === 'running' && first.pairsChecked === 6 && prompts.length === 6
		);
		let steps = 1;
		let state = first;
		while (state.status === 'running' && steps < 20) {
			tick = 0;
			state = await advanceConsolidation({ ...base, clock: slow }, NOW);
			steps++;
		}
		check(
			'later steps finish the pass, and between them every pair is checked',
			state.status === 'done' && steps > 1 && [...all].every((p) => prompts.includes(p))
		);
		check(
			'the cut-off steps check exactly the pairs the single step did, no more',
			new Set(prompts).size === all.size && state.pairsChecked === prompts.length
		);
		check(
			"a pair is repeated only where the cut fell inside one page's pairs",
			prompts.length - all.size < 6 * (steps - 1)
		);
	} finally {
		await brain.cleanup();
		await rm(src, { recursive: true, force: true });
	}
}

console.log('\nbrain passes: the shared run state (9)');
{
	const db = localD1(':memory:').db as unknown as D1Database;
	const defaults = { seen: 0, extra: 'none' };
	const scope = { brainId: 'b1', kind: 'probe', orgId: 'o1', actorUserId: 'u1' };
	const row = () =>
		db
			.prepare(
				'SELECT started_by, started_at, updated_at, finished_at, run_id FROM brain_passes WHERE brain_id = ?1 AND kind = ?2'
			)
			.bind('b1', 'probe')
			.first<{
				started_by: string;
				started_at: number;
				updated_at: number;
				finished_at: number | null;
				run_id: string;
			}>();

	const fresh = continuePass(null, defaults, () => 'r1', NOW);
	check(
		'no pass yet: a new running pass at the start',
		fresh.runId === 'r1' &&
			fresh.status === 'running' &&
			fresh.cursor === null &&
			fresh.counters.seen === 0
	);
	await savePass(db, scope, { ...fresh, cursor: 'a.md', counters: { seen: 3, extra: 'x' } }, NOW);
	const read = await readPass(db, 'b1', 'probe', defaults);
	check(
		'a saved step reads back',
		read?.runId === 'r1' &&
			read.cursor === 'a.md' &&
			read.counters.seen === 3 &&
			read.status === 'running'
	);
	if (!read) throw new Error('expected a pass');
	await savePass(
		db,
		{ ...scope, actorUserId: 'u2' },
		{ ...read, status: 'stopped', stoppedReason: 'over-cap' },
		NOW + 1000
	);
	const resumed = continuePass(
		await readPass(db, 'b1', 'probe', defaults),
		defaults,
		() => 'r2',
		NOW
	);
	check(
		'a stopped pass is resumed, not replaced',
		resumed.runId === 'r1' &&
			resumed.status === 'running' &&
			resumed.stoppedReason === null &&
			resumed.cursor === 'a.md'
	);
	const r1 = await row();
	check(
		'who started a run and when are kept across its steps',
		r1?.started_by === 'u1' &&
			r1.started_at === NOW &&
			r1.updated_at === NOW + 1000 &&
			r1.finished_at === null
	);
	await savePass(db, scope, { ...resumed, status: 'done' }, NOW + 2000);
	check('a finished pass records when', (await row())?.finished_at === NOW + 2000);
	const next = continuePass(await readPass(db, 'b1', 'probe', defaults), defaults, () => 'r2', NOW);
	check(
		'a finished pass is replaced by a new one',
		next.runId === 'r2' && next.cursor === null && next.counters.seen === 0
	);
	await savePass(db, { ...scope, actorUserId: 'u3' }, next, NOW + 3000);
	const r2 = await row();
	check(
		'a new run records its own starter and start',
		r2?.run_id === 'r2' &&
			r2.started_by === 'u3' &&
			r2.started_at === NOW + 3000 &&
			r2.finished_at === null
	);
	await db.prepare(`UPDATE brain_passes SET counters = '{"seen":7}' WHERE kind = 'probe'`).run();
	const older = await readPass(db, 'b1', 'probe', defaults);
	check(
		'a counter missing from an older row reads as its default',
		older?.counters.seen === 7 && older.counters.extra === 'none'
	);
	await db.prepare(`UPDATE brain_passes SET counters = 'not json' WHERE kind = 'probe'`).run();
	const broken = await readPass(db, 'b1', 'probe', defaults);
	check(
		'unreadable counters fall back to the defaults and keep the run',
		broken?.counters.seen === 0 && broken.runId === 'r2'
	);
	await db.batch([savePassStatement(db, { ...scope, kind: 'other' }, fresh, NOW)]);
	check(
		'kinds are separate rows, and a step can be saved inside a batch',
		(await readPass(db, 'b1', 'other', defaults))?.runId === 'r1' &&
			(await readPass(db, 'b1', 'probe', defaults))?.runId === 'r2'
	);
}

done();
