// Model-powered consolidation: pairs of pages that disagree about the same fact, as
// `conflict` findings in the unified queue. Licensed under ee/LICENSE.
// Design: docs/design/consistency-checks.md, Part 2 (C4).
//
// A pass is budgeted and resumable. Each call checks up to PAIRS_PER_STEP page pairs from
// the cursor in D1, through the gateway, and writes what survives the filters to
// review_findings. Nothing is written to the brain: every finding waits for a person
// (the auto tier is off).
//
// Stages per pair:
//   1. Candidates: each page's RELATED_PER_PAGE best search hits on its title, plus the
//      near-duplicate and same-identifier tensions.
//   2. Pre-scan: a page with a high-severity detection never reaches the gateway.
//   3. Screen, when the gateway has Jev: a pair Jev scores under JEV_GATE for contradiction
//      goes no further. A pair with a page over JEV_MAX_PAGE_CHARS skips the screen rather
//      than being cut, and a screen that errors lets the pair through.
//   4. Triage in one Haiku request: the model lists each disagreement, quoting both
//      sides, says whether dates or scope explain it, which version stands, and proposes
//      one action.
//   5. Claim filter: explained claims, claims scored under MIN_MISLEADING, and claims whose
//      quotes or values do not appear word for word on their page are dropped.
//   6. Verify, mechanically: a proposed patch must match its page exactly once.
//   7. Tier: `person` when the pages cannot settle it, `review` otherwise.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import type { BrainConfig } from '../../src/lib/brain-policy.ts';
import { isContentPath, isToolMaintained } from '../../src/lib/brain-policy.ts';
import { listIndexedPages, loadAllFields, loadPageContents } from '../../src/lib/brain-index.ts';
import { computeTensions, MAX_DUP_PAGES } from '../../src/lib/consolidate.ts';
import { detectSensitive } from '../../src/lib/policy-detectors.ts';
import {
	conflictKey,
	normalizeDisputedValue,
	readPageShas,
	upsertFindings,
	valuesOnPages,
	type QueueFinding
} from '../../src/lib/review-queue.ts';
import { rankPages, signalsFromContent, tokenizeQuery } from '../../src/lib/search.ts';
import type { ConsolidationStepWire } from '../../src/lib/tool-payloads.ts';
import { GatewayRefused, ModelUnavailable, openGateway, type Gateway } from './gateway.ts';

// Pairs one call checks. Each is one model request, run CONCURRENCY at a time.
export const PAIRS_PER_STEP = 12;
const CONCURRENCY = 4;

// Search hits paired with each page.
export const RELATED_PER_PAGE = 3;

// A pair longer than this is skipped and counted, never cut: a cut page could hide the
// line that settles the disagreement. About 50K tokens, inside Haiku's short rate card.
export const MAX_PAIR_CHARS = 200_000;

// Claims a reader would not be misled by are dropped.
export const MIN_MISLEADING = 0.4;

// Jev's contradiction score below which a pair is cleared without triage. 0.3 kept 81% of
// the conflicts a reference model found and sent on a fifth of all pairs (brain-evals,
// 2026-09-24).
export const JEV_GATE = 0.3;

// Jev reads 32K tokens. A pair with a longer page skips the screen and goes to triage.
export const JEV_MAX_PAGE_CHARS = 40_000;

// The question the gate was measured on, word for word.
export const JEV_CONFLICT_QUESTION = {
	conflict: {
		type: 'noul',
		instructions: 'Do `a` and `b` state facts about the same thing that contradict each other?'
	}
} as const;

// Whether a pair goes on to triage, from Jev's conflict score. No score sends it on.
export function passesScreen(conflict: number | undefined): boolean {
	return conflict === undefined || !(conflict < JEV_GATE);
}

export interface PageText {
	path: string;
	title: string;
	content: string;
}

export type Pair = readonly [string, string];

// ---------- candidates ----------

// The pages most like `page` by its title, best first, never itself.
export function relatedPages(page: PageText, pages: readonly PageText[], k = RELATED_PER_PAGE) {
	const q = tokenizeQuery(page.title);
	if (!q.terms.length) return [];
	const others = pages.filter((p) => p.path !== page.path);
	const signals = others.map((p) => signalsFromContent(p, q));
	return rankPages(signals, q.terms, q.bigrams)
		.filter((s) => s.has.some(Boolean))
		.slice(0, k)
		.map((s) => s.path);
}

export interface StepPlan {
	// Each pair once, with the source page that owns it.
	pairs: { source: string; pair: Pair }[];
	// The last source page this plan covers; the cursor when it completes.
	last: string | null;
	done: boolean;
}

// The next window of pairs after `cursor`. A pair belongs to the earlier page in path
// order when that page names it, otherwise to the later one, so a resumed pass checks
// each pair once without remembering which it has done.
export function planStep(
	pages: readonly PageText[],
	partners: ReadonlyMap<string, readonly string[]>,
	cursor: string | null,
	budget = PAIRS_PER_STEP
): StepPlan {
	const sorted = [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const related = new Map<string, Set<string>>();
	const partnersOf = (path: string) => {
		let set = related.get(path);
		if (!set) {
			const page = sorted.find((p) => p.path === path);
			set = new Set([...(page ? relatedPages(page, sorted) : []), ...(partners.get(path) ?? [])]);
			related.set(path, set);
		}
		return set;
	};

	const pairs: StepPlan['pairs'] = [];
	let last = cursor;
	const remaining = sorted.filter((p) => cursor === null || p.path > cursor);
	for (const [i, page] of remaining.entries()) {
		const own = [...partnersOf(page.path)]
			.filter((other) => other !== page.path)
			.filter((other) => other > page.path || !partnersOf(other).has(page.path))
			.sort()
			.map((other) => ({ source: page.path, pair: [page.path, other].sort() as unknown as Pair }));
		if (pairs.length && pairs.length + own.length > budget) {
			return { pairs, last, done: false };
		}
		pairs.push(...own);
		last = page.path;
		if (i === remaining.length - 1) return { pairs, last, done: true };
	}
	return { pairs, last, done: true };
}

// Whether a page may be sent: a high-severity detection keeps it in the deployment.
export const sendable = (content: string) =>
	!detectSensitive(content).some((d) => d.severity === 'high');

// ---------- triage ----------

export interface Claim {
	subject: string;
	quote_a: string;
	quote_b: string;
	value_a: string;
	value_b: string;
	explained: boolean;
	misleading: number;
	stands: 'a' | 'b' | 'neither';
	action: 'patch' | 'note' | 'person';
	patch: { page: 'a' | 'b'; find: string; replace: string } | null;
	why: string;
}

export const TRIAGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['claims'],
	properties: {
		claims: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: [
					'subject',
					'quote_a',
					'quote_b',
					'value_a',
					'value_b',
					'explained',
					'misleading',
					'stands',
					'action',
					'patch',
					'why'
				],
				properties: {
					subject: { type: 'string' },
					quote_a: { type: 'string' },
					quote_b: { type: 'string' },
					value_a: { type: 'string' },
					value_b: { type: 'string' },
					explained: { type: 'boolean' },
					misleading: { type: 'number' },
					stands: { type: 'string', enum: ['a', 'b', 'neither'] },
					action: { type: 'string', enum: ['patch', 'note', 'person'] },
					patch: {
						anyOf: [
							{ type: 'null' },
							{
								type: 'object',
								additionalProperties: false,
								required: ['page', 'find', 'replace'],
								properties: {
									page: { type: 'string', enum: ['a', 'b'] },
									find: { type: 'string' },
									replace: { type: 'string' }
								}
							}
						]
					},
					why: { type: 'string' }
				}
			}
		}
	}
} as const;

export const TRIAGE_SYSTEM = `You compare two pages from a team's knowledge base and list every point where they disagree about the same fact.

For each disagreement:
- subject: the fact in a few words.
- quote_a / quote_b: the line from each page that states it, copied exactly.
- value_a / value_b: the disputed value as each page writes it, copied exactly from inside the quote (a number, a date, a name, a status).
- explained: true when dates, scope or an existing note on either page account for the difference, so a careful reader would not be misled.
- misleading: from 0 to 1, how likely a reader of the current pages is to be misled.
- stands: which version is right by these rules. A dated record outranks a summary of it. Where facts changed, the later dated record wins. A dated record that was accurate on its date is annotated, never rewritten. Use "neither" when the pages cannot settle it.
- action: "patch" to correct the wrong page's line, "note" to add a dated note, or "person" when someone has to decide.
- patch: for "patch", the page to change, a span of its text to find (copied exactly, long enough to occur once) and its replacement. Otherwise null.
- why: one sentence.

Report only real disagreements about the same thing. Different facts about different things are not disagreements. Return an empty list when the pages agree.`;

export function triagePrompt(a: PageText, b: PageText): string {
	const page = (label: string, p: PageText) =>
		`<page_${label} path="${p.path}" title="${p.title.replace(/"/g, "'")}">\n${p.content}\n</page_${label}>`;
	return `${page('a', a)}\n\n${page('b', b)}`;
}

const occurrences = (haystack: string, needle: string) => {
	if (!needle) return 0;
	let n = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
	return n;
};

export type Tier = 'review' | 'person';

export interface Proposal {
	tier: Tier;
	action: Claim['action'];
	// The page whose version stands, or null when the pages cannot say.
	stands: string | null;
	patch: { path: string; find: string; replace: string } | null;
	// Set when the model proposed a patch the checks rejected.
	patchRejected?: string;
	model: string;
}

// The claims worth a person's time, each with its key, its verified proposal and why the
// rest were dropped. Pure.
export async function triageFindings(input: {
	a: PageText;
	b: PageText;
	claims: readonly Claim[];
	model: string;
	pageShas: Readonly<Record<string, string>>;
	runId: string;
}): Promise<{ findings: QueueFinding[]; dropped: number }> {
	const { a, b } = input;
	const contents = new Map([
		[a.path, a.content],
		[b.path, b.content]
	]);
	const out = new Map<string, QueueFinding>();
	let dropped = 0;
	for (const c of input.claims) {
		const quoted = valuesOnPages(
			[
				{ path: a.path, value: c.quote_a },
				{ path: b.path, value: c.quote_b }
			],
			contents
		);
		const valued =
			c.value_a.trim() !== '' &&
			c.value_b.trim() !== '' &&
			c.quote_a.includes(c.value_a) &&
			c.quote_b.includes(c.value_b);
		const differs = normalizeDisputedValue(c.value_a) !== normalizeDisputedValue(c.value_b);
		if (c.explained || c.misleading < MIN_MISLEADING || !quoted || !valued || !differs) {
			dropped++;
			continue;
		}

		let patch: Proposal['patch'] = null;
		let patchRejected: string | undefined;
		if (c.action === 'patch') {
			const target = c.patch?.page === 'b' ? b : a;
			if (!c.patch) patchRejected = 'No patch was given.';
			else if (c.patch.find === c.patch.replace) patchRejected = 'The patch changes nothing.';
			else if (occurrences(target.content, c.patch.find) !== 1)
				patchRejected = 'The text to replace does not occur exactly once on the page.';
			else patch = { path: target.path, find: c.patch.find, replace: c.patch.replace };
		}

		const key = await conflictKey([a.path, b.path], [c.value_a, c.value_b]);
		out.set(key, {
			key,
			kind: 'conflict',
			paths: [a.path, b.path].sort(),
			headline: `${c.subject}: "${a.title}" says ${c.value_a}, "${b.title}" says ${c.value_b}.`,
			evidence: [`${a.path}: "${c.quote_a}"`, `${b.path}: "${c.quote_b}"`, c.why],
			proposal: {
				tier: c.action === 'person' ? 'person' : 'review',
				action: c.action,
				stands: c.stands === 'a' ? a.path : c.stands === 'b' ? b.path : null,
				patch,
				...(patchRejected ? { patchRejected } : {}),
				model: input.model
			} satisfies Proposal,
			scores: { misleading: c.misleading },
			pageShas: {
				[a.path]: input.pageShas[a.path] ?? '',
				[b.path]: input.pageShas[b.path] ?? ''
			},
			runId: input.runId,
			clusterId: null,
			authorUserId: null
		});
	}
	return { findings: [...out.values()], dropped };
}

// ---------- run state ----------

export type RunStatus = 'running' | 'stopped' | 'done';

export interface ConsolidationState {
	runId: string;
	status: RunStatus;
	cursor: string | null;
	pairsChecked: number;
	pairsSkipped: number;
	// Checked pairs Jev cleared, so triage never saw them.
	pairsScreened: number;
	findings: number;
	costUsd: number;
	served: Record<string, number>;
	stoppedReason: string | null;
}

interface RunRow {
	run_id: string;
	status: string;
	cursor: string | null;
	pairs_checked: number;
	pairs_skipped: number;
	pairs_screened: number;
	findings: number;
	cost_usd: number;
	served: string;
	stopped_reason: string | null;
}

export async function readRun(db: D1Database, brainId: string): Promise<ConsolidationState | null> {
	const r = await db
		.prepare(
			`SELECT run_id, status, cursor, pairs_checked, pairs_skipped, pairs_screened, findings,
			        cost_usd, served, stopped_reason
			 FROM consolidation_runs WHERE brain_id = ?1`
		)
		.bind(brainId)
		.first<RunRow>();
	if (!r) return null;
	let served: Record<string, number> = {};
	try {
		served = JSON.parse(r.served) as Record<string, number>;
	} catch {
		// A row that cannot say who served it still says how far it got.
	}
	return {
		runId: r.run_id,
		status: r.status as RunStatus,
		cursor: r.cursor,
		pairsChecked: r.pairs_checked,
		pairsSkipped: r.pairs_skipped,
		pairsScreened: r.pairs_screened,
		findings: r.findings,
		costUsd: r.cost_usd,
		served,
		stoppedReason: r.stopped_reason
	};
}

async function saveRun(
	db: D1Database,
	scope: { brainId: string; orgId: string; actorUserId?: string },
	s: ConsolidationState,
	now: number
) {
	await db
		.prepare(
			`INSERT INTO consolidation_runs
			   (brain_id, org_id, run_id, status, cursor, pairs_checked, pairs_skipped, findings,
			    cost_usd, served, stopped_reason, started_by, started_at, updated_at, pairs_screened)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)
			 ON CONFLICT (brain_id) DO UPDATE SET
			   org_id = ?2, run_id = ?3, status = ?4, cursor = ?5, pairs_checked = ?6,
			   pairs_skipped = ?7, findings = ?8, cost_usd = ?9, served = ?10, stopped_reason = ?11,
			   started_by = CASE WHEN run_id = ?3 THEN started_by ELSE ?12 END,
			   started_at = CASE WHEN run_id = ?3 THEN started_at ELSE ?13 END,
			   updated_at = ?13, pairs_screened = ?14`
		)
		.bind(
			scope.brainId,
			scope.orgId,
			s.runId,
			s.status,
			s.cursor,
			s.pairsChecked,
			s.pairsSkipped,
			s.findings,
			s.costUsd,
			JSON.stringify(s.served),
			s.stoppedReason,
			scope.actorUserId ?? null,
			now,
			s.pairsScreened
		)
		.run();
}

// ---------- one step ----------

export interface ConsolidationTarget {
	db: D1Database;
	brainId: string;
	orgId: string;
	actorUserId?: string;
	config: BrainConfig;
	gateway: Pick<Gateway, 'chatJson'> & Partial<Pick<Gateway, 'canDecide' | 'decide'>>;
	newRunId?: () => string;
}

// Why a pass stopped, for the run row and the reply.
function stopReason(err: unknown): string | null {
	if (err instanceof GatewayRefused) return err.reason;
	if (err instanceof ModelUnavailable && err.reason !== 'refusal') return err.reason;
	return null;
}

// One call's worth of the pass. Starts a pass when none is running or stopped, so the same
// call begins and resumes, and a finished pass is replaced by asking again.
export async function advanceConsolidation(
	t: ConsolidationTarget,
	now = Date.now()
): Promise<ConsolidationState> {
	const scope = { brainId: t.brainId, orgId: t.orgId, actorUserId: t.actorUserId };
	const existing = await readRun(t.db, t.brainId);
	const state: ConsolidationState =
		existing && existing.status !== 'done'
			? { ...existing, status: 'running', stoppedReason: null }
			: {
					runId: t.newRunId?.() ?? crypto.randomUUID(),
					status: 'running',
					cursor: null,
					pairsChecked: 0,
					pairsSkipped: 0,
					pairsScreened: 0,
					findings: 0,
					costUsd: 0,
					served: {},
					stoppedReason: null
				};

	const listed = (await listIndexedPages(t.db, t.brainId)).filter(
		(p) => isContentPath(p.path, t.config) && !isToolMaintained(p.path, t.config)
	);
	if (listed.length > MAX_DUP_PAGES) {
		const stopped = { ...state, status: 'stopped' as const, stoppedReason: 'too-many-pages' };
		await saveRun(t.db, scope, stopped, now);
		return stopped;
	}
	const contents = await loadPageContents(
		t.db,
		t.brainId,
		listed.map((p) => p.path)
	);
	const pages: PageText[] = listed.map((p) => ({ ...p, content: contents.get(p.path) ?? '' }));
	const byPath = new Map(pages.map((p) => [p.path, p]));

	const partners = new Map<string, string[]>();
	for (const tension of computeTensions({
		pages: listed,
		edges: [],
		contents,
		fields: await loadAllFields(t.db, t.brainId),
		identityFields: t.config.identityFields,
		isContent: (p) => isContentPath(p, t.config)
	})) {
		if (tension.kind !== 'near-duplicate' && tension.kind !== 'same-identifier') continue;
		const [first, ...rest] = [...tension.paths].sort();
		for (const other of rest) {
			partners.set(first, [...(partners.get(first) ?? []), other]);
		}
	}

	const plan = planStep(pages, partners, state.cursor);
	const shas = Object.fromEntries(await readPageShas(t.db, t.brainId));
	const found: QueueFinding[] = [];
	const finished = new Set<number>();
	let stoppedReason: string | null = null;

	// Whether Jev clears the pair. A refused gateway stops the pass as anywhere else; any
	// other failure lets the pair through to triage, so a broken screen costs money, not
	// findings.
	async function screenedOut(
		a: PageText,
		b: PageText,
		count: (model: string, costUsd: number) => void
	): Promise<boolean> {
		const { decide, canDecide } = t.gateway;
		if (!canDecide || !decide) return false;
		if (a.content.length > JEV_MAX_PAGE_CHARS || b.content.length > JEV_MAX_PAGE_CHARS)
			return false;
		try {
			const served = await decide(
				{ a: { path: a.path, text: a.content }, b: { path: b.path, text: b.content } },
				JEV_CONFLICT_QUESTION
			);
			count(served.model, served.costUsd);
			return !passesScreen(served.value.conflict?.noul);
		} catch (err) {
			if (err instanceof GatewayRefused) throw err;
			return false;
		}
	}

	async function check(index: number) {
		const [pa, pb] = plan.pairs[index].pair;
		const a = byPath.get(pa);
		const b = byPath.get(pb);
		if (
			!a ||
			!b ||
			!sendable(a.content) ||
			!sendable(b.content) ||
			a.content.length + b.content.length > MAX_PAIR_CHARS
		) {
			state.pairsSkipped++;
			finished.add(index);
			return;
		}
		const count = (model: string, costUsd: number) => {
			state.costUsd += costUsd;
			state.served[model] = (state.served[model] ?? 0) + 1;
		};
		try {
			if (await screenedOut(a, b, count)) {
				state.pairsChecked++;
				state.pairsScreened++;
				finished.add(index);
				return;
			}
			const served = await t.gateway.chatJson<{ claims: Claim[] }>(
				TRIAGE_SYSTEM,
				triagePrompt(a, b),
				TRIAGE_SCHEMA as unknown as Record<string, unknown>
			);
			count(served.model, served.costUsd);
			const { findings } = await triageFindings({
				a,
				b,
				claims: served.value.claims ?? [],
				model: served.model,
				pageShas: shas,
				runId: state.runId
			});
			found.push(...findings);
			state.pairsChecked++;
		} catch (err) {
			const reason = stopReason(err);
			if (reason) {
				stoppedReason ??= reason;
				return;
			}
			if (err instanceof ModelUnavailable) state.pairsSkipped++;
			else throw err;
		}
		finished.add(index);
	}

	for (let i = 0; i < plan.pairs.length && !stoppedReason; i += CONCURRENCY) {
		const batch = plan.pairs.slice(i, i + CONCURRENCY).map((_, j) => check(i + j));
		await Promise.all(batch);
	}

	await upsertFindings(t.db, t.brainId, found, now);
	state.findings += found.length;

	if (stoppedReason) {
		// The cursor moves only past sources whose every pair finished, in plan order.
		for (const source of new Set(plan.pairs.map((p) => p.source))) {
			if (plan.pairs.some((p, i) => p.source === source && !finished.has(i))) break;
			state.cursor = source;
		}
		state.status = 'stopped';
		state.stoppedReason = stoppedReason;
	} else {
		state.cursor = plan.last;
		state.status = plan.done ? 'done' : 'running';
	}
	await saveRun(t.db, scope, state, now);
	return state;
}

const STOP_TEXT: Record<string, string> = {
	'over-cap': "this month's model spend cap for the organization is used up",
	'not-entitled': 'the organization has no enterprise entitlement',
	'no-key': 'this deployment has no model key',
	'rate-limit': 'the model provider is rate limiting requests',
	credits: 'the model account is out of credits',
	overloaded: 'the model provider is overloaded',
	'too-many-pages': `the brain has more than ${MAX_DUP_PAGES} pages`
};

// What the tool says about a step, for the model and for an admin reading the reply.
export function consolidationStepText(s: ConsolidationState): string {
	const cost = `$${s.costUsd.toFixed(4)}`;
	const screened = s.pairsScreened ? ` (${s.pairsScreened} cleared by the screen)` : '';
	const counts = `${s.pairsChecked} page pair(s) checked${screened}, ${s.pairsSkipped} skipped, ${s.findings} conflict finding(s), ${cost} spent.`;
	if (s.status === 'done') return `Consolidation finished: ${counts} validate lists the findings.`;
	if (s.status === 'stopped') {
		const why = STOP_TEXT[s.stoppedReason ?? ''] ?? s.stoppedReason ?? 'unknown';
		return `Consolidation stopped: ${why}. ${counts} Call configure_brain with consolidate: true to resume once that changes.`;
	}
	return `Consolidation in progress: ${counts} Call configure_brain with consolidate: true again to continue.`;
}

// ---------- the step a tool runs ----------

// The state as configure_brain returns it.
export function consolidationWire(s: ConsolidationState): ConsolidationStepWire['consolidation'] {
	return {
		status: s.status,
		pairsChecked: s.pairsChecked,
		pairsSkipped: s.pairsSkipped,
		pairsScreened: s.pairsScreened,
		findings: s.findings,
		costUsd: s.costUsd
	};
}

export interface ConsolidationStepReply {
	text: string;
	state: ConsolidationState | null;
}

// Open the gateway for the brain's org and advance its pass one step. The one entry point
// the Worker and `pnpm consolidate:report --models` share.
export async function runConsolidationStep(opts: {
	db: D1Database;
	brainId: string;
	orgId: string;
	actorUserId?: string;
	config: BrainConfig;
	openRouterKey?: string;
	anthropicKey?: string;
	fetch?: typeof fetch;
}): Promise<ConsolidationStepReply> {
	const opened = await openGateway({
		apiKey: opts.openRouterKey,
		anthropicKey: opts.anthropicKey,
		db: opts.db,
		orgId: opts.orgId,
		fetch: opts.fetch
	});
	if (!opened.ok) {
		return {
			text: `Consolidation did not run: ${STOP_TEXT[opened.reason]}.`,
			state: await readRun(opts.db, opts.brainId)
		};
	}
	const state = await advanceConsolidation({ ...opts, gateway: opened.gateway });
	return { text: consolidationStepText(state), state };
}
