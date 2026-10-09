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
	monthKey,
	openGateway
} from '../ee/review/gateway.ts';

import { checker } from './check.ts';

const { check, done } = checker('ee checks');

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 86_400_000;
const ent = (over: Partial<Entitlement> = {}): Entitlement => ({
	orgId: 'o1',
	feature: FEATURES.reviewModels,
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
				feature: FEATURES.reviewModels,
				source: 'manual',
				now: NOW,
				monthlyCapUsd: 1
			})
		)
		.run();
	check(
		'the granted row reads back',
		(await getEntitlement(db, 'o1', FEATURES.reviewModels))?.monthlyCapUsd === 1
	);
	check('hasFeature sees it', await hasFeature(db, 'o1', FEATURES.reviewModels, NOW));
	check('another org has nothing', !(await hasFeature(db, 'o2', FEATURES.reviewModels, NOW)));

	const opened = await openGateway({ apiKey: 'k', db, orgId: 'o1', fetch: provider.fn, now });
	if (!opened.ok) throw new Error('expected an open gateway');
	const answers = await opened.gateway.decide('state', { q: { type: 'noul', instructions: 'x' } });
	check('decide returns the answers', answers.q?.noul === 0.9);
	const reply = await opened.gateway.chatJson<{ ok: boolean }>('sys', 'user', { type: 'object' });
	check('chatJson parses the reply', reply.ok === true);
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
		.prepare(entitlementSql({ kind: 'revoke', orgId: 'o1', feature: FEATURES.reviewModels }))
		.run();
	check('revoke removes it', !(await hasFeature(db, 'o1', FEATURES.reviewModels, NOW)));
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
			entitlementSql({ kind: 'revoke', orgId: "o1' OR 1=1 --", feature: FEATURES.reviewModels })
		)
	);
	check(
		'a negative cap is refused',
		throws(() =>
			entitlementSql({
				kind: 'grant',
				orgId: 'o1',
				feature: FEATURES.reviewModels,
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
				feature: FEATURES.reviewModels,
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
				feature: FEATURES.reviewModels,
				source: 'plan',
				now: NOW
			})
		)
		.run();
	const rows = (await db.prepare('SELECT source FROM org_entitlements').all<{ source: string }>())
		.results;
	check('granting again updates the one row', rows.length === 1 && rows[0].source === 'plan');
}

done();
