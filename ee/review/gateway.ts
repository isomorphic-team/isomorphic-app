// The model gateway: the one way brain content reaches a model. Licensed under ee/LICENSE.
//
// Guarantees, each enforced here rather than by callers:
//
//   1. Entitled orgs only. No active `enterprise` entitlement, no gateway.
//   2. A monthly spend cap per org, counted in this deployment's own D1
//      (model_usage_monthly) from each response: the cost OpenRouter reports, or the cost
//      computed from Anthropic's token counts at list price. Spend paid from credits counts.
//   3. Retention by provider. OpenRouter requests carry ZDR_PROVIDER, so they route only to
//      zero-data-retention endpoints. Anthropic requests carry no such flag: they get the
//      operator's Anthropic organization's own retention, which is standard unless the
//      operator has arranged otherwise with Anthropic.
//
// Yes/no judgments go to Jev through OpenRouter. Text-writing requests try Claude Haiku first and fall back to Luna on a refusal, a rate
// limit, exhausted credits or an overload, when an OpenRouter key exists. The operator
// configures the keys. A deployment with neither has no gateway, and the core product runs
// exactly as before.
//
// Worker-safe: no node:* imports.

import Anthropic from '@anthropic-ai/sdk';
import type { D1Database } from '@cloudflare/workers-types';
import {
	FEATURES,
	getEntitlement,
	isActive,
	type Entitlement
} from '../../src/lib/entitlements.ts';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
export const JEV_MODEL = 'typesafe/jev-1.13';
export const LUNA_MODEL = 'openai/gpt-6-luna';
export const HAIKU_MODEL = 'claude-haiku-5-5';

// `zdr` restricts routing to zero-data-retention endpoints; `data_collection: 'deny'` also
// excludes any provider that stores or trains on inputs. Both, because either alone is one
// provider-policy change away from letting content through.
export const ZDR_PROVIDER = { zdr: true, data_collection: 'deny' } as const;

// Used when an entitlement sets no cap of its own.
export const DEFAULT_MONTHLY_CAP_USD = 25;

// Haiku list prices, USD per million tokens. The long rate card applies once the prompt
// passes HAIKU_LONG_PROMPT tokens. Cache reads bill at a tenth of input, writes at 1.25x.
export const HAIKU_PRICE = {
	short: { input: 0.1, output: 0.5 },
	long: { input: 0.5, output: 2.5 },
	cacheRead: 0.1,
	cacheWrite: 1.25
} as const;
export const HAIKU_LONG_PROMPT = 100_000;

const HAIKU_MAX_TOKENS = 16_000;

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

// Why a text request got no answer from any model. `refusal` is the model declining this
// input; the others say the provider cannot serve anything right now, so a caller should
// stop rather than try the next input.
export type UnservedReason = 'refusal' | 'rate-limit' | 'credits' | 'overloaded';

export class ModelUnavailable extends Error {
	constructor(readonly reason: UnservedReason) {
		super(`No model served the request: ${reason}`);
	}
}

// What Haiku's token counts cost at list price.
export function haikuCostUsd(usage: {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}): number {
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const prompt = usage.input_tokens + cacheWrite + cacheRead;
	const rate = prompt > HAIKU_LONG_PROMPT ? HAIKU_PRICE.long : HAIKU_PRICE.short;
	return (
		(usage.input_tokens * rate.input +
			cacheWrite * rate.input * HAIKU_PRICE.cacheWrite +
			cacheRead * rate.input * HAIKU_PRICE.cacheRead +
			usage.output_tokens * rate.output) /
		1_000_000
	);
}

// The failure an HTTP status stands for, from either provider, or null when it is not one a
// fallback or a later retry can cure.
function unservedStatus(status: number | undefined): UnservedReason | null {
	if (status === 429) return 'rate-limit';
	if (status === 402) return 'credits';
	if (status === 529) return 'overloaded';
	return null;
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

// `state` is what Jev judges: a string, or an object of named parts.
export function decisionRequest(state: unknown, questions: Record<string, Question>) {
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

export function haikuRequest(
	system: string,
	user: string,
	schema: Record<string, unknown>
): Anthropic.MessageCreateParamsNonStreaming {
	return {
		model: HAIKU_MODEL,
		max_tokens: HAIKU_MAX_TOKENS,
		system,
		messages: [{ role: 'user', content: user }],
		output_config: { format: { type: 'json_schema', schema } }
	};
}

// ---------- the gateway ----------

export interface Served<T> {
	value: T;
	// The model that wrote the answer.
	model: string;
	costUsd: number;
}

export interface Gateway {
	// Jev, present only with the OpenRouter key.
	decide?(
		state: unknown,
		questions: Record<string, Question>
	): Promise<Served<Record<string, Answer>>>;
	chatJson<T>(system: string, user: string, schema: Record<string, unknown>): Promise<Served<T>>;
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
	// OpenRouter: Jev, and Luna as the text fallback.
	apiKey: string | undefined;
	// Anthropic: Haiku, tried first for text.
	anthropicKey?: string;
	db: D1Database;
	orgId: string;
	fetch?: typeof fetch;
	now?: () => number;
}): Promise<{ ok: true; gateway: Gateway } | { ok: false; reason: RefusalReason }> {
	const now = opts.now ?? Date.now;
	const doFetch = opts.fetch ?? fetch;
	const entitlement = await getEntitlement(opts.db, opts.orgId, FEATURES.enterprise);
	const check = async () =>
		gatewayAccess({
			hasKey: !!opts.apiKey || !!opts.anthropicKey,
			entitlement,
			spentUsd: await spentThisMonth(opts.db, opts.orgId, now()),
			now: now()
		});
	const first = await check();
	if (!first.ok) return first;

	const anthropic = opts.anthropicKey
		? new Anthropic({ apiKey: opts.anthropicKey, fetch: doFetch, maxRetries: 2 })
		: null;

	async function admit() {
		const access = await check();
		if (!access.ok) throw new GatewayRefused(access.reason);
	}

	// An OpenRouter request, and the cost it reports, already counted toward the cap.
	async function post(
		path: string,
		body: unknown
	): Promise<{ json: Record<string, unknown>; costUsd: number }> {
		if (!opts.apiKey) throw new GatewayRefused('no-key');
		await admit();
		const res = await doFetch(OPENROUTER_BASE + path, {
			method: 'POST',
			headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const text = await res.text();
		if (!res.ok) {
			const reason = unservedStatus(res.status);
			if (reason) throw new ModelUnavailable(reason);
			throw new Error(`Model gateway ${path} ${res.status}: ${text.slice(0, 300)}`);
		}
		const json = JSON.parse(text) as Record<string, unknown>;
		const cost = (json.usage as { cost?: unknown } | undefined)?.cost;
		const costUsd = typeof cost === 'number' ? cost : 0;
		await recordSpend(opts.db, opts.orgId, now(), costUsd);
		return { json, costUsd };
	}

	async function luna<T>(system: string, user: string, schema: Record<string, unknown>) {
		const { json, costUsd } = await post('/v1/chat/completions', chatRequest(system, user, schema));
		const content = (json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message
			?.content;
		if (typeof content !== 'string') throw new Error('Model gateway: no content in reply');
		return { value: JSON.parse(content) as T, model: LUNA_MODEL, costUsd };
	}

	// Haiku's answer, or the reason it gave none.
	async function haiku<T>(
		client: Anthropic,
		system: string,
		user: string,
		schema: Record<string, unknown>
	): Promise<Served<T> | UnservedReason> {
		await admit();
		let msg: Anthropic.Message;
		try {
			msg = await client.messages.create(haikuRequest(system, user, schema));
		} catch (err) {
			const reason = err instanceof Anthropic.APIError ? unservedStatus(err.status) : null;
			if (reason) return reason;
			throw err;
		}
		const costUsd = haikuCostUsd(msg.usage);
		await recordSpend(opts.db, opts.orgId, now(), costUsd);
		if (msg.stop_reason === 'refusal') return 'refusal';
		if (msg.stop_reason === 'max_tokens') throw new Error('Model gateway: reply cut off');
		const text = msg.content.find((b) => b.type === 'text');
		if (!text || text.type !== 'text') throw new Error('Model gateway: no content in reply');
		return { value: JSON.parse(text.text) as T, model: HAIKU_MODEL, costUsd };
	}

	return {
		ok: true,
		gateway: {
			...(opts.apiKey && {
				async decide(state: unknown, questions: Record<string, Question>) {
					const { json, costUsd } = await post(
						'/alpha/decisions',
						decisionRequest(state, questions)
					);
					return {
						value: (json.answers ?? {}) as Record<string, Answer>,
						model: JEV_MODEL,
						costUsd
					};
				}
			}),
			async chatJson<T>(system: string, user: string, schema: Record<string, unknown>) {
				if (!anthropic) return luna<T>(system, user, schema);
				const served = await haiku<T>(anthropic, system, user, schema);
				if (typeof served !== 'string') return served;
				if (!opts.apiKey) throw new ModelUnavailable(served);
				return luna<T>(system, user, schema);
			}
		}
	};
}
