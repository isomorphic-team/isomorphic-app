// Model-powered consolidation: pairs of pages that disagree about the same fact, as
// `conflict` findings in the unified queue. Licensed under ee/LICENSE.
// Design: docs/design/consistency-checks.md, Part 2 (C4).
//
// A pass is budgeted and resumable. Each call checks up to PAIRS_PER_STEP page pairs from
// its cursor (D1 `brain_passes`, kind 'consolidation', through src/lib/brain-pass.ts),
// through the gateway, and writes what survives the filters to review_findings. Nothing is written to the brain: every finding waits for a person
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
//   5. Claim filter: explained claims and claims whose quotes or values do not appear word
//      for word on their page are dropped. With Jev, so is a claim it scores under
//      MIN_MISLEADING on whether a reader would be misled. The triaging model's own score is
//      not used: in the evals a model's confidence in its own claims carried no signal.
//   6. Verify, mechanically: a proposed patch must match its page exactly once and leave its
//      markdown structure as it was (no table, list or fence split).
//   7. Tier: `review` for a patch that passed, `person` for everything else. Proposed notes go
//      to a person too: in the evals most were judged unnecessary or misplaced.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import type { BrainConfig } from '../../src/lib/brain-policy.ts';
import { isContentPath, isToolMaintained } from '../../src/lib/brain-policy.ts';
import {
	ensureFresh,
	listIndexedPages,
	loadAllFields,
	loadPageContents
} from '../../src/lib/brain-index.ts';
import type { BrainStore, RepoRef } from '../../src/lib/brain-repo.ts';
import {
	continuePass,
	readPass,
	savePass,
	type PassState,
	type PassStatus
} from '../../src/lib/brain-pass.ts';
import { computeTensions, MAX_DUP_PAGES } from '../../src/lib/consolidate.ts';
import { applyPageEdits } from '../../src/lib/page-patch.ts';
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
import { nextFence } from '../../src/lib/wiki.ts';
import {
	GatewayRefused,
	ModelUnavailable,
	openGateway,
	type Gateway,
	type Question
} from './gateway.ts';

// Pairs one call checks. Each is one model request, run CONCURRENCY at a time.
export const PAIRS_PER_STEP = 12;
const CONCURRENCY = 4;

// Search hits paired with each page.
export const RELATED_PER_PAGE = 3;

// A pair longer than this is skipped and counted, never cut: a cut page could hide the
// line that settles the disagreement. About 50K tokens, inside Haiku's short rate card.
export const MAX_PAIR_CHARS = 200_000;

// Claims Jev scores under this on MISLEADING_QUESTION are dropped (brain-evals: precision
// 71-79% at 0.4, against 70-74% unfiltered).
export const MIN_MISLEADING = 0.4;

// The per-claim question the evals measured, word for word. Pages are cut to
// JEV_CLAIM_PAGE_CHARS as there: the claim names what to look at.
export const MISLEADING_QUESTION = {
	misleading: {
		type: 'noul',
		instructions:
			'Reading `page_a` and `page_b` as they stand today, would a reader take something outdated or wrong about `claim.topic` as current? Answer no if the difference is explained by dates, scope, or a note already on the page.'
	}
} as const;
export const JEV_CLAIM_PAGE_CHARS = 24_000;

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
	// Lowered once: ranking lowercases every body it scores, and a step ranks many times.
	const lowered = sorted.map((p) => ({ ...p, content: p.content.toLowerCase() }));
	const byPath = new Map(lowered.map((p) => [p.path, p]));
	const related = new Map<string, Set<string>>();
	const partnersOf = (path: string) => {
		let set = related.get(path);
		if (!set) {
			const page = byPath.get(path);
			set = new Set([...(page ? relatedPages(page, lowered) : []), ...(partners.get(path) ?? [])]);
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
- stands: which version is right by these rules.
  - Primary records outrank derived pages. Primary: dated meeting notes, contracts, threads, source documents, data exports. Derived: index and overview pages, rollups, summaries, profiles.
  - Where facts changed over time, the later dated record wins.
  - A dated record that was accurate on its date is not wrong. Never rewrite it to match later events: correct the living summary page instead.
  - Use "neither" when the pages cannot settle it.
- action: "patch" to correct the wrong page's line, "note" to add a dated note, or "person" when someone has to decide. If the page that would change says a script, sync or generator produces it, use "person" and name the generator in why.
- patch: for "patch", the page to change, a span of its text to find (copied exactly, long enough to occur once) and its replacement. Otherwise null.
- why: one sentence.

Report only real disagreements about the same thing. Different facts about different things are not disagreements. Return an empty list when the pages agree.`;

export function triagePrompt(a: PageText, b: PageText): string {
	const page = (label: string, p: PageText) =>
		`<page_${label} path="${p.path}" title="${p.title.replace(/"/g, "'")}">\n${p.content}\n</page_${label}>`;
	return `${page('a', a)}\n\n${page('b', b)}`;
}

// A page's block structure: fences, headings, and each run of table rows or list items.
// A patch that changes it has split or broken something a reader relies on.
export function blockShape(markdown: string): string {
	const out: string[] = [];
	let fence: string | null = null;
	let prev = '';
	for (const line of markdown.split('\n')) {
		const was: string | null = fence;
		fence = nextFence(line, fence);
		if (was !== fence) {
			out.push('F');
			prev = 'F';
		}
		if (was !== null || fence !== null) continue;
		const t = line.trim();
		const kind = /^#{1,6}\s/.test(t)
			? 'H'
			: t.startsWith('|')
				? 'T'
				: /^([-*+]|\d+[.)])\s/.test(t)
					? 'L'
					: t === ''
						? ''
						: 'P';
		if (kind === 'H' || ((kind === 'T' || kind === 'L') && kind !== prev)) out.push(kind);
		prev = kind;
	}
	return out.join('');
}

export interface Proposal {
	// `review` for a patch that passed the checks, `person` for everything else.
	tier: 'review' | 'person';
	action: Claim['action'];
	// The page whose version stands, or null when the pages cannot say.
	stands: string | null;
	patch: { path: string; find: string; replace: string } | null;
	// Set when the model proposed a patch the checks rejected.
	patchRejected?: string;
	model: string;
}

// The claims worth a person's time, each with its key, its verified proposal and why the
// rest were dropped. `misleading` scores a claim that passed the mechanical filters, or
// says nothing (undefined), which keeps it.
export async function triageFindings(input: {
	a: PageText;
	b: PageText;
	claims: readonly Claim[];
	model: string;
	pageShas: Readonly<Record<string, string>>;
	runId: string;
	misleading?: (claim: Claim) => Promise<number | undefined>;
}): Promise<{ findings: QueueFinding[]; dropped: number }> {
	const { a, b } = input;
	const contents = new Map([
		[a.path, a.content],
		[b.path, b.content]
	]);
	const passed = input.claims.filter((c) => {
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
		return !c.explained && quoted && valued && differs;
	});
	const scores = await Promise.all(passed.map((c) => input.misleading?.(c)));
	const out = new Map<string, QueueFinding>();
	let dropped = input.claims.length - passed.length;
	for (const [i, c] of passed.entries()) {
		const misleading = scores[i];
		if (misleading !== undefined && misleading < MIN_MISLEADING) {
			dropped++;
			continue;
		}

		let patch: Proposal['patch'] = null;
		let patchRejected: string | undefined;
		if (c.action === 'patch') {
			const target = c.patch?.page === 'b' ? b : a;
			// The write path's own rule for an edit: matches exactly once, outside any
			// generated okf-view snapshot.
			const applied = c.patch && applyPageEdits(target.content, { edits: [c.patch] });
			if (!c.patch || !applied) patchRejected = 'No patch was given.';
			else if (c.patch.find === c.patch.replace) patchRejected = 'The patch changes nothing.';
			else if (!applied.ok) patchRejected = applied.error;
			else if (blockShape(target.content) !== blockShape(applied.body))
				patchRejected = 'The patch would split a table, list or code block.';
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
				tier: patch ? 'review' : 'person',
				action: c.action,
				stands: c.stands === 'a' ? a.path : c.stands === 'b' ? b.path : null,
				patch,
				...(patchRejected ? { patchRejected } : {}),
				model: input.model
			} satisfies Proposal,
			scores: misleading === undefined ? null : { misleading },
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

const KIND = 'consolidation';

export interface ConsolidationState {
	runId: string;
	startedAt: number;
	finishedAt: number | null;
	status: PassStatus;
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

type Counters = Pick<
	ConsolidationState,
	'pairsChecked' | 'pairsSkipped' | 'pairsScreened' | 'findings' | 'costUsd' | 'served'
>;

const noCounts = (): Counters => ({
	pairsChecked: 0,
	pairsSkipped: 0,
	pairsScreened: 0,
	findings: 0,
	costUsd: 0,
	served: {}
});

const flatten = ({ counters, ...p }: PassState<Counters>): ConsolidationState => ({
	...p,
	...counters
});

export async function readRun(db: D1Database, brainId: string): Promise<ConsolidationState | null> {
	const pass = await readPass(db, brainId, KIND, noCounts());
	return pass && flatten(pass);
}

async function saveRun(
	db: D1Database,
	scope: { brainId: string; orgId: string; actorUserId?: string },
	{ runId, status, cursor, stoppedReason, startedAt, finishedAt, ...counters }: ConsolidationState,
	now: number
) {
	await savePass(
		db,
		{ ...scope, kind: KIND },
		{ runId, status, cursor, stoppedReason, startedAt, finishedAt, counters },
		now
	);
}

// ---------- one step ----------

export interface ConsolidationTarget {
	db: D1Database;
	brainId: string;
	orgId: string;
	actorUserId?: string;
	config: BrainConfig;
	// The pass reads the content index, so it brings the index up to the branch head first.
	store: BrainStore;
	repo: RepoRef;
	gateway: Pick<Gateway, 'chatJson' | 'decide'>;
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
	const state = flatten(
		continuePass(
			await readPass(t.db, t.brainId, KIND, noCounts()),
			noCounts(),
			t.newRunId ?? (() => crypto.randomUUID()),
			now
		)
	);

	await ensureFresh(t.db, t.store, t.repo, t.brainId, t.config);
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
	// The first pair a refused gateway stopped. Pairs after it may have run in the same
	// batch; the cursor stays before it, so the next step checks them again.
	let firstStopped = Infinity;
	let stoppedReason: string | null = null;

	// Jev's answer to one question, or undefined when it cannot say. A refused gateway stops
	// the pass as anywhere else; any other failure answers nothing, so a broken Jev costs
	// money, not findings.
	async function jevScore(
		state: unknown,
		question: Record<string, Question>,
		count: (model: string, costUsd: number) => void
	): Promise<number | undefined> {
		if (!t.gateway.decide) return undefined;
		try {
			const served = await t.gateway.decide(state, question);
			count(served.model, served.costUsd);
			return served.value[Object.keys(question)[0]]?.noul;
		} catch (err) {
			if (err instanceof GatewayRefused) throw err;
			return undefined;
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
			return;
		}
		const count = (model: string, costUsd: number) => {
			state.costUsd += costUsd;
			state.served[model] = (state.served[model] ?? 0) + 1;
		};
		const cut = (p: PageText, max: number) => ({ path: p.path, text: p.content.slice(0, max) });
		try {
			// A page too long for Jev skips the screen rather than being cut.
			const screenable =
				a.content.length <= JEV_MAX_PAGE_CHARS && b.content.length <= JEV_MAX_PAGE_CHARS;
			const conflict = screenable
				? await jevScore(
						{ a: cut(a, JEV_MAX_PAGE_CHARS), b: cut(b, JEV_MAX_PAGE_CHARS) },
						JEV_CONFLICT_QUESTION,
						count
					)
				: undefined;
			if (!passesScreen(conflict)) {
				state.pairsChecked++;
				state.pairsScreened++;
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
				runId: state.runId,
				misleading: (claim) =>
					jevScore(
						{
							page_a: cut(a, JEV_CLAIM_PAGE_CHARS),
							page_b: cut(b, JEV_CLAIM_PAGE_CHARS),
							claim: { topic: claim.subject, says_a: claim.quote_a, says_b: claim.quote_b }
						},
						MISLEADING_QUESTION,
						count
					)
			});
			found.push(...findings);
			state.pairsChecked++;
		} catch (err) {
			const reason = stopReason(err);
			if (reason) {
				stoppedReason ??= reason;
				firstStopped = Math.min(firstStopped, index);
				return;
			}
			if (err instanceof ModelUnavailable) state.pairsSkipped++;
			else throw err;
		}
	}

	for (let i = 0; i < plan.pairs.length && !stoppedReason; i += CONCURRENCY) {
		const batch = plan.pairs.slice(i, i + CONCURRENCY).map((_, j) => check(i + j));
		await Promise.all(batch);
	}

	await upsertFindings(t.db, t.brainId, found, now);
	state.findings += found.length;

	if (stoppedReason) {
		// The cursor moves past every source that ends before the first stopped pair.
		const stoppedSource = plan.pairs[firstStopped].source;
		const before = plan.pairs.slice(0, firstStopped).filter((p) => p.source !== stoppedSource);
		state.cursor = before.at(-1)?.source ?? state.cursor;
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
	store: BrainStore;
	repo: RepoRef;
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
