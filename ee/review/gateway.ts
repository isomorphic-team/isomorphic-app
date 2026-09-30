// The model gateway: the one way brain content reaches a model. Licensed under ee/LICENSE.
//
// Three guarantees, each enforced here rather than by callers:
//
//   1. Zero data retention. Every request carries ZDR_PROVIDER, so OpenRouter routes it only
//      to endpoints with a zero-data-retention policy (Jev's TypeSafe endpoint; GPT-6 Luna on
//      Azure, never OpenAI's own endpoint) and fails rather than falls back to one without.
//   2. Entitled orgs only. No active `review-models` entitlement, no gateway.
//   3. A monthly spend cap per org, counted from the cost the provider reports on each
//      response, in this deployment's own D1 (model_usage_monthly).
//
// The operator configures the key. A deployment without one has no gateway, and the core
// product runs exactly as before.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import { FEATURES, getEntitlement, isActive, type Entitlement } from '../entitlements.ts';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
export const JEV_MODEL = 'typesafe/jev-1.13';
export const LUNA_MODEL = 'openai/gpt-6-luna';

// `zdr` restricts routing to zero-data-retention endpoints; `data_collection: 'deny'` also
// excludes any provider that stores or trains on inputs. Both, because either alone is one
// provider-policy change away from letting content through.
export const ZDR_PROVIDER = { zdr: true, data_collection: 'deny' } as const;

// Used when an entitlement sets no cap of its own.
export const DEFAULT_MONTHLY_CAP_USD = 25;

export type RefusalReason = 'no-key' | 'not-entitled' | 'over-cap';
export type Access = { ok: true; capUsd: number } | { ok: false; reason: RefusalReason };

// Whether an org may use the gateway right now. Pure: the order of the checks is the
// answer a refused caller gets, most fundamental first.
export function gatewayAccess(input: {
	hasKey: boolean;
	entitlement: Entitlement | null;
	spentUsd: number;
	now: number;
}): Access {
	if (!input.hasKey) return { ok: false, reason: 'no-key' };
	if (!isActive(input.entitlement, input.now)) return { ok: false, reason: 'not-entitled' };
	const capUsd = input.entitlement.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD;
	if (input.spentUsd >= capUsd) return { ok: false, reason: 'over-cap' };
	return { ok: true, capUsd };
}

export class GatewayRefused extends Error {
	constructor(readonly reason: RefusalReason) {
		super(`Model gateway refused: ${reason}`);
	}
}

// ---------- requests ----------

// Jev's typed questions: yes/no (`noul`), one of a set (`choice`), or a number (`score`).
export type Question =
	| { type: 'noul'; instructions: string }
	| { type: 'choice'; instructions: string; choices: string[] }
	| { type: 'score'; instructions: string; criteria?: string };

export interface Answer {
	type: string;
	noul?: number;
	choice?: string;
	probabilities?: Record<string, number>;
	score?: number;
	confidence?: number;
}

export function decisionRequest(state: string, questions: Record<string, Question>) {
	return { model: JEV_MODEL, state, questions, provider: ZDR_PROVIDER };
}

export function chatRequest(system: string, user: string, schema: Record<string, unknown>) {
	return {
		model: LUNA_MODEL,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user }
		],
		response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
		provider: ZDR_PROVIDER
	};
}

// ---------- the gateway ----------

export interface Gateway {
	decide(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>>;
	chatJson<T>(system: string, user: string, schema: Record<string, unknown>): Promise<T>;
}

export function monthKey(now: number): string {
	return new Date(now).toISOString().slice(0, 7);
}

async function spentThisMonth(db: D1Database, orgId: string, now: number): Promise<number> {
	const row = await db
		.prepare('SELECT cost_usd FROM model_usage_monthly WHERE org_id = ?1 AND month = ?2')
		.bind(orgId, monthKey(now))
		.first<{ cost_usd: number }>();
	return row?.cost_usd ?? 0;
}

async function recordSpend(db: D1Database, orgId: string, now: number, costUsd: number) {
	await db
		.prepare(
			`INSERT INTO model_usage_monthly (org_id, month, calls, cost_usd) VALUES (?1, ?2, 1, ?3)
			 ON CONFLICT (org_id, month) DO UPDATE SET calls = calls + 1, cost_usd = cost_usd + excluded.cost_usd`
		)
		.bind(orgId, monthKey(now), costUsd)
		.run();
}

// Open the gateway for one org, or say why not. The cap is re-checked before every call, so
// a long pass stops at the cap rather than at the end of the pass.
export async function openGateway(opts: {
	apiKey: string | undefined;
	db: D1Database;
	orgId: string;
	fetch?: typeof fetch;
	now?: () => number;
}): Promise<{ ok: true; gateway: Gateway } | { ok: false; reason: RefusalReason }> {
	const now = opts.now ?? Date.now;
	const doFetch = opts.fetch ?? fetch;
	const entitlement = await getEntitlement(opts.db, opts.orgId, FEATURES.reviewModels);
	const check = async () =>
		gatewayAccess({
			hasKey: !!opts.apiKey,
			entitlement,
			spentUsd: await spentThisMonth(opts.db, opts.orgId, now()),
			now: now()
		});
	const first = await check();
	if (!first.ok) return first;

	async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
		const access = await check();
		if (!access.ok) throw new GatewayRefused(access.reason);
		const res = await doFetch(OPENROUTER_BASE + path, {
			method: 'POST',
			headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`Model gateway ${path} ${res.status}: ${text.slice(0, 300)}`);
		const json = JSON.parse(text) as Record<string, unknown>;
		const cost = (json.usage as { cost?: unknown } | undefined)?.cost;
		await recordSpend(opts.db, opts.orgId, now(), typeof cost === 'number' ? cost : 0);
		return json;
	}

	return {
		ok: true,
		gateway: {
			async decide(state, questions) {
				const json = await post('/alpha/decisions', decisionRequest(state, questions));
				return (json.answers ?? {}) as Record<string, Answer>;
			},
			async chatJson<T>(system: string, user: string, schema: Record<string, unknown>) {
				const json = await post('/v1/chat/completions', chatRequest(system, user, schema));
				const content = (json.choices as { message?: { content?: string } }[] | undefined)?.[0]
					?.message?.content;
				if (typeof content !== 'string') throw new Error('Model gateway: no content in reply');
				return JSON.parse(content) as T;
			}
		}
	};
}
