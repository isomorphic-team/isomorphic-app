// Model-powered consolidation: pairs of pages that disagree about the same fact, as
// `conflict` findings in the unified queue. Licensed under ee/LICENSE.
// Design: docs/design/consistency-checks.md, Part 2 (C4).
//
// A pass is budgeted and resumable. Each call plans up to PAIRS_PER_STEP page pairs from
// its cursor (D1 `brain_passes`, kind 'consolidation', through src/lib/brain-pass.ts),
// through the gateway, and writes what survives the filters to review_findings. Nothing is written to the brain: every finding waits for a person
// (the auto tier is off).
//
// Stages per pair:
//   1. Candidates: each page's RELATED_PER_PAGE best search hits on its title, plus the
//      near-duplicate and same-identifier tensions.
//      A page marked `status: deprecated` is no candidate and has none.
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
// With `against`, the same pass runs between two brains: both brains' pages in one list,
// a page paired only with pages of the other brain, and findings that carry no patch.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import type { BrainConfig } from '../../src/lib/brain-policy.ts';
import { isContentPath, isToolMaintained } from '../../src/lib/brain-policy.ts';
import type { BrainIndex } from '../../src/lib/brain-index.ts';
import type { BrainStore, BrainLocator } from '../../src/lib/brain-repo.ts';
import {
	continuePass,
	readPass,
	readPassItems,
	savePass,
	savePassItems,
	type PassState,
	type PassStatus
} from '../../src/lib/brain-pass.ts';
import { computeTensions, MAX_DUP_PAGES } from '../../src/lib/consolidate.ts';
import { applyPageEdits } from '../../src/lib/page-patch.ts';
import { detectSensitive } from '../../src/lib/policy-detectors.ts';
import {
	conflictKey,
	normalizeDisputedValue,
	normalizeFactLabel,
	otherPageRef,
	readFactLabels,
	upsertFindings,
	valuesOnPages,
	type QueueFinding
} from '../../src/lib/review-queue.ts';
import type { ComparedBrain } from '../../src/lib/review-checks.ts';
import { rankPages, signalsFromContent, tokenizeQuery } from '../../src/lib/search.ts';
import type { ConsolidationStepWire } from '../../src/lib/tool-payloads.ts';
import { nextFence } from '../../src/lib/wiki.ts';
import {
	GatewayRefused,
	HAIKU_MODEL,
	JEV_MODEL,
	ModelUnavailable,
	openGateway,
	type Gateway,
	type Question
} from './gateway.ts';

// Pairs one call plans. The clock decides how many it checks: a step starts no new batch
// once STEP_TIME_MS have passed, so a call ends inside a host's tool timeout however slow
// the models are, and the pairs it did not reach are the next call's. The first batch
// always runs, so every call makes progress.
export const PAIRS_PER_STEP = 48;
export const STEP_TIME_MS = 15_000;

// Pairs checked at once. Each holds one model request open.
const CONCURRENCY = 6;

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

// A pass against another brain runs over both brains' pages at once. A page of the other
// brain is identified by its path behind this prefix, which no content path starts with,
// so two pages at the same path in the two brains stay apart.
const OTHER = '//';
export const otherPageId = (path: string) => `${OTHER}${path}`;
export const isOtherPage = (id: string) => id.startsWith(OTHER);
export const pagePath = (id: string) => (isOtherPage(id) ? id.slice(OTHER.length) : id);

// ---------- candidates ----------

// The pages most like `page` by its title, best first, never itself. With `everyTerm`, a
// page counts only when it holds every word of the title, not just one of them.
export function relatedPages(
	page: PageText,
	pages: readonly PageText[],
	k = RELATED_PER_PAGE,
	everyTerm = false
) {
	const q = tokenizeQuery(page.title);
	if (!q.terms.length) return [];
	const others = pages.filter((p) => p.path !== page.path);
	const signals = others.map((p) => signalsFromContent(p, q));
	return rankPages(signals, q.terms, q.bigrams)
		.filter((s) => (everyTerm ? s.has.every(Boolean) : s.has.some(Boolean)))
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
	budget = PAIRS_PER_STEP,
	// Whether a pair costs a check. One that does not (unchanged since its last check)
	// rides along without using the budget, so a brain that has not changed is one call.
	costs: (pair: Pair) => boolean = () => true,
	// A pass against another brain: a page is paired only with pages of the other brain.
	acrossOnly = false
): StepPlan {
	const sorted = [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	// Lowered once: ranking lowercases every body it scores, and a step ranks many times.
	const lowered = sorted.map((p) => ({ ...p, content: p.content.toLowerCase() }));
	const byPath = new Map(lowered.map((p) => [p.path, p]));
	const home = lowered.filter((p) => !isOtherPage(p.path));
	const away = lowered.filter((p) => isOtherPage(p.path));
	const candidates = (page: PageText) =>
		!acrossOnly ? lowered : isOtherPage(page.path) ? home : away;
	const related = new Map<string, Set<string>>();
	const partnersOf = (path: string) => {
		let set = related.get(path);
		if (!set) {
			const page = byPath.get(path);
			set = new Set([
				// Between brains the other brain is not about the same things, so one shared word
				// pairs a long page with everything: the title's every word is required there.
				...(page ? relatedPages(page, candidates(page), RELATED_PER_PAGE, acrossOnly) : []),
				...(partners.get(path) ?? [])
			]);
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
		const spent = pairs.filter((p) => costs(p.pair)).length;
		if (spent && spent + own.filter((p) => costs(p.pair)).length > budget) {
			return { pairs, last, done: false };
		}
		pairs.push(...own);
		last = page.path;
		if (i === remaining.length - 1) return { pairs, last, done: true };
	}
	return { pairs, last, done: true };
}

// Whether a page says it is no longer current (OKF `status: deprecated`). Such a page is
// expected to disagree with what replaced it, so the pass leaves it out.
export const isDeprecated = (fields: ReadonlyMap<string, readonly string[]> | undefined) =>
	(fields?.get('status') ?? []).some((v) => v.trim().toLowerCase() === 'deprecated');

// Whether a page may be sent: a high-severity detection keeps it in the deployment.
export const sendable = (content: string) =>
	!detectSensitive(content).some((d) => d.severity === 'high');

// ---------- triage ----------

export interface Claim {
	subject: string;
	fact: string;
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
					'fact',
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
					fact: { type: 'string' },
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
- fact: two to five lowercase words naming WHAT is disputed, never either value, worded the same whichever pages state it (e.g. "engagement length", "advisor hourly rate"). If it is the same fact as one listed in known_facts, copy that label exactly.
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

// The pair, plus the fact labels the brain already uses, so the same fact gets the same
// label whichever pair raises it.
export function triagePrompt(a: PageText, b: PageText, knownFacts: readonly string[] = []): string {
	const page = (label: string, p: PageText) =>
		`<page_${label} path="${pagePath(p.path)}" title="${p.title.replace(/"/g, "'")}">\n${p.content}\n</page_${label}>`;
	const facts = knownFacts.length
		? `\n\n<known_facts>\n${knownFacts.join('\n')}\n</known_facts>`
		: '';
	return `${page('a', a)}\n\n${page('b', b)}${facts}`;
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
	// Set for a pass against another brain, one of whose pages `a` or `b` is. The finding
	// then carries this brain's page in `paths`, the other in `other`, and no patch: a
	// finding between brains always waits for a person.
	otherBrainId?: string;
}): Promise<{ findings: QueueFinding[]; dropped: number }> {
	const { a, b } = input;
	const across = input.otherBrainId !== undefined;
	const [here, there] = isOtherPage(a.path) ? [b, a] : [a, b];
	// The two brains can hold a page at the same path, so the other brain's line says so.
	const cite = (p: PageText) =>
		isOtherPage(p.path) ? `In the other brain, ${pagePath(p.path)}` : p.path;
	// This brain's page first, when the pair spans two.
	const quoted = (c: Claim) => (p: PageText) => `${cite(p)}: "${p === a ? c.quote_a : c.quote_b}"`;
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
		if (c.action === 'patch' && !across) {
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

		const key = await conflictKey(
			across
				? [here.path, await otherPageRef(input.otherBrainId!, pagePath(there.path))]
				: [a.path, b.path],
			[c.value_a, c.value_b]
		);
		const standing = c.stands === 'a' ? a : c.stands === 'b' ? b : null;
		out.set(key, {
			key,
			kind: 'conflict',
			paths: across ? [here.path] : [a.path, b.path].sort(),
			headline: `${c.subject}: "${a.title}" says ${c.value_a}, "${b.title}" says ${c.value_b}.`,
			evidence: [...(across ? [here, there] : [a, b]).map(quoted(c)), c.why],
			proposal: {
				tier: patch ? 'review' : 'person',
				action: across ? 'person' : c.action,
				// Between brains a path does not say which brain, so none is named.
				stands: across ? null : (standing?.path ?? null),
				patch,
				...(patchRejected ? { patchRejected } : {}),
				model: input.model
			} satisfies Proposal,
			scores: misleading === undefined ? null : { misleading },
			pageShas: across
				? { [here.path]: input.pageShas[here.path] ?? '' }
				: {
						[a.path]: input.pageShas[a.path] ?? '',
						[b.path]: input.pageShas[b.path] ?? ''
					},
			runId: input.runId,
			clusterId: normalizeFactLabel(c.fact ?? '') || null,
			authorUserId: null,
			other: across
				? {
						brainId: input.otherBrainId!,
						path: pagePath(there.path),
						sha: input.pageShas[there.path] ?? ''
					}
				: null
		});
	}
	return { findings: [...out.values()], dropped };
}

// ---------- what earlier passes checked ----------

// A digest of everything that decides a pair's answer: the prompts, the schema, the gates
// and the models. Part of every pair's fingerprint, so changing any of it makes every pair
// worth checking again.
let versionMemo: Promise<string> | null = null;
function checkVersion(): Promise<string> {
	versionMemo ??= crypto.subtle
		.digest(
			'SHA-256',
			new TextEncoder().encode(
				JSON.stringify([
					TRIAGE_SYSTEM,
					TRIAGE_SCHEMA,
					JEV_CONFLICT_QUESTION,
					MISLEADING_QUESTION,
					JEV_GATE,
					MIN_MISLEADING,
					JEV_MAX_PAGE_CHARS,
					JEV_CLAIM_PAGE_CHARS,
					HAIKU_MODEL,
					JEV_MODEL
				])
			)
		)
		.then((d) =>
			[...new Uint8Array(d)]
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
				.slice(0, 16)
		);
	return versionMemo;
}

// ---------- run state ----------

const KIND = 'consolidation';

// A pass against another brain keeps its own cursor and pair memory, per other brain.
const passKind = (otherBrainId?: string) => (otherBrainId ? `${KIND}:${otherBrainId}` : KIND);

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
	// Pairs skipped because neither page, nor the check itself, changed since they were
	// last checked. Their findings stand as they were.
	pairsUnchanged: number;
	// Pages left out of this step because they are marked deprecated, both brains counted.
	pagesDeprecated: number;
	// A pass that ignores what earlier passes checked, set when it starts.
	fresh: boolean;
	findings: number;
	costUsd: number;
	served: Record<string, number>;
	stoppedReason: string | null;
}

type Counters = Pick<
	ConsolidationState,
	| 'pairsChecked'
	| 'pairsSkipped'
	| 'pairsScreened'
	| 'pairsUnchanged'
	| 'pagesDeprecated'
	| 'fresh'
	| 'findings'
	| 'costUsd'
	| 'served'
>;

const noCounts = (): Counters => ({
	pairsChecked: 0,
	pairsSkipped: 0,
	pairsScreened: 0,
	pairsUnchanged: 0,
	pagesDeprecated: 0,
	fresh: false,
	findings: 0,
	costUsd: 0,
	served: {}
});

const flatten = ({ counters, ...p }: PassState<Counters>): ConsolidationState => ({
	...p,
	...counters
});

export async function readRun(
	db: D1Database,
	brainId: string,
	otherBrainId?: string
): Promise<ConsolidationState | null> {
	const pass = await readPass(db, brainId, passKind(otherBrainId), noCounts());
	return pass && flatten(pass);
}

async function saveRun(
	db: D1Database,
	scope: { brainId: string; orgId: string; actorUserId?: string; kind: string },
	{ runId, status, cursor, stoppedReason, startedAt, finishedAt, ...counters }: ConsolidationState,
	now: number
) {
	await savePass(
		db,
		scope,
		{ runId, status, cursor, stoppedReason, startedAt, finishedAt, counters },
		now
	);
}

// ---------- one step ----------

export interface ConsolidationTarget {
	db: D1Database;
	index: BrainIndex;
	brainId: string;
	orgId: string;
	actorUserId?: string;
	config: BrainConfig;
	// The pass reads the content index, so it brings the index up to the branch head first.
	store: BrainStore;
	repo: BrainLocator;
	gateway: Pick<Gateway, 'chatJson' | 'decide'>;
	newRunId?: () => string;
	// Start a new pass that checks every pair, ignoring what earlier passes checked.
	fresh?: boolean;
	// Another brain to compare this one against. Only pairs with one page in each brain
	// are checked, and the findings land in this brain's queue.
	against?: ComparedBrain;
	// The step's clock, for STEP_TIME_MS. Date.now unless a test drives it.
	clock?: () => number;
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
	const kind = passKind(t.against?.brainId);
	const scope = { brainId: t.brainId, orgId: t.orgId, actorUserId: t.actorUserId, kind };
	const state = flatten(
		continuePass(
			t.fresh ? null : await readPass(t.db, t.brainId, kind, noCounts()),
			{ ...noCounts(), fresh: !!t.fresh },
			t.newRunId ?? (() => crypto.randomUUID()),
			now
		)
	);

	let deprecated = 0;
	const contentPages = async (b: Pick<ComparedBrain, 'index' | 'store' | 'repo' | 'config'>) => {
		await b.index.ensureFresh(b.store, b.repo, b.config);
		const fields = await b.index.allFields();
		const content = (await b.index.listPages()).filter(
			(p) => isContentPath(p.path, b.config) && !isToolMaintained(p.path, b.config)
		);
		const current = content.filter((p) => !isDeprecated(fields.get(p.path)));
		deprecated += content.length - current.length;
		return { pages: current, fields };
	};
	const { pages: listed, fields: homeFields } = await contentPages(t);
	const otherListed = t.against ? (await contentPages(t.against)).pages : [];
	state.pagesDeprecated = deprecated;
	if (listed.length + otherListed.length > MAX_DUP_PAGES) {
		const stopped = {
			...state,
			status: 'stopped' as const,
			stoppedReason: t.against ? 'too-many-pages-together' : 'too-many-pages'
		};
		await saveRun(t.db, scope, stopped, now);
		return stopped;
	}
	const contents = await t.index.pageContents(listed.map((p) => p.path));
	const otherContents = t.against
		? await t.against.index.pageContents(otherListed.map((p) => p.path))
		: new Map<string, string>();
	const pages: PageText[] = [
		...listed.map((p) => ({ ...p, content: contents.get(p.path) ?? '' })),
		...otherListed.map((p) => ({
			path: otherPageId(p.path),
			title: p.title,
			content: otherContents.get(p.path) ?? ''
		}))
	];
	const byPath = new Map(pages.map((p) => [p.path, p]));

	// Near-duplicates and shared identifiers are found inside one brain only.
	const partners = new Map<string, string[]>();
	const tensions = t.against
		? []
		: computeTensions({
				pages: listed,
				edges: [],
				contents,
				fields: homeFields,
				identityFields: t.config.identityFields,
				isContent: (p) => isContentPath(p, t.config)
			});
	for (const tension of tensions) {
		if (tension.kind !== 'near-duplicate' && tension.kind !== 'same-identifier') continue;
		const [first, ...rest] = [...tension.paths].sort();
		for (const other of rest) {
			partners.set(first, [...(partners.get(first) ?? []), other]);
		}
	}

	const shas: Record<string, string> = Object.fromEntries(await t.index.pageShas());
	if (t.against) {
		for (const [path, sha] of await t.against.index.pageShas()) shas[otherPageId(path)] = sha;
	}
	// What earlier passes checked: a pair whose fingerprint still matches costs nothing.
	const version = await checkVersion();
	const lastChecked = state.fresh
		? new Map<string, string>()
		: await readPassItems(t.db, t.brainId, kind);
	const fingerprint = ([a, b]: Pair) =>
		shas[a] && shas[b] ? `${version}:${shas[a]}:${shas[b]}` : null;
	const unchanged = (pair: Pair) => {
		const fp = fingerprint(pair);
		return fp !== null && lastChecked.get(pair.join('|')) === fp;
	};
	const checked: { item: string; fingerprint: string }[] = [];
	const remember = (pair: Pair) => {
		const fp = fingerprint(pair);
		if (fp) checked.push({ item: pair.join('|'), fingerprint: fp });
	};
	const plan = planStep(
		pages,
		partners,
		state.cursor,
		PAIRS_PER_STEP,
		(pair) => !unchanged(pair),
		!!t.against
	);
	const knownFacts = await readFactLabels(t.db, t.brainId);
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
		const pair = plan.pairs[index].pair;
		if (unchanged(pair)) {
			state.pairsUnchanged++;
			return;
		}
		const [pa, pb] = pair;
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
				remember(pair);
				return;
			}
			const served = await t.gateway.chatJson<{ claims: Claim[] }>(
				TRIAGE_SYSTEM,
				triagePrompt(a, b, knownFacts),
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
				otherBrainId: t.against?.brainId,
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
			remember(pair);
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

	const clock = t.clock ?? Date.now;
	const started = clock();
	// The first pair this step did not start, when the clock ran out first.
	let firstUnstarted = Infinity;
	for (let i = 0; i < plan.pairs.length && !stoppedReason; i += CONCURRENCY) {
		if (i > 0 && clock() - started >= STEP_TIME_MS) {
			firstUnstarted = i;
			break;
		}
		const batch = plan.pairs.slice(i, i + CONCURRENCY).map((_, j) => check(i + j));
		await Promise.all(batch);
	}

	await upsertFindings(t.db, t.brainId, found, now);
	await savePassItems(t.db, t.brainId, kind, checked, now);
	state.findings += found.length;

	const firstOpen = Math.min(firstStopped, firstUnstarted);
	if (firstOpen !== Infinity) {
		// The cursor moves past every source that ends before the first pair left open.
		const openSource = plan.pairs[firstOpen].source;
		const before = plan.pairs.slice(0, firstOpen).filter((p) => p.source !== openSource);
		state.cursor = before.at(-1)?.source ?? state.cursor;
		state.status = stoppedReason ? 'stopped' : 'running';
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
	'too-many-pages': `the brain has more than ${MAX_DUP_PAGES} pages`,
	'too-many-pages-together': `the two brains together have more than ${MAX_DUP_PAGES} pages`
};

// What the tool says about a step, for the model and for an admin reading the reply.
// `against` is the other brain's handle, for a pass between two brains.
export function consolidationStepText(s: ConsolidationState, against?: string): string {
	const name = against ? `The check against "${against}"` : 'Consolidation';
	const call = against
		? `Call review_brain with check "contradictions" and against "${against}"`
		: 'Call review_brain with check "contradictions"';
	const cost = `$${s.costUsd.toFixed(4)}`;
	const screened = s.pairsScreened ? ` (${s.pairsScreened} cleared by the screen)` : '';
	const unchanged = s.pairsUnchanged
		? ` ${s.pairsUnchanged} unchanged since their last check, not checked again.`
		: '';
	const deprecated = s.pagesDeprecated
		? ` ${s.pagesDeprecated} page(s) marked deprecated were left out.`
		: '';
	const counts = `${s.pairsChecked} page pair(s) checked${screened}, ${s.pairsSkipped} skipped, ${s.findings} conflict finding(s), ${cost} spent.${unchanged}${deprecated}`;
	if (s.status === 'done') return `${name} finished: ${counts} validate lists the findings.`;
	if (s.status === 'stopped') {
		const why = STOP_TEXT[s.stoppedReason ?? ''] ?? s.stoppedReason ?? 'unknown';
		return `${name} stopped: ${why}. ${counts} ${call} to resume once that changes.`;
	}
	return `${name} in progress: ${counts} ${call} again to continue.`;
}

// ---------- the step a tool runs ----------

// The state as review_brain returns it.
export function consolidationWire(s: ConsolidationState): ConsolidationStepWire['consolidation'] {
	return {
		status: s.status,
		pairsChecked: s.pairsChecked,
		pairsSkipped: s.pairsSkipped,
		pairsScreened: s.pairsScreened,
		pairsUnchanged: s.pairsUnchanged,
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
	index: BrainIndex;
	brainId: string;
	orgId: string;
	actorUserId?: string;
	config: BrainConfig;
	store: BrainStore;
	repo: BrainLocator;
	openRouterKey?: string;
	anthropicKey?: string;
	fetch?: typeof fetch;
	fresh?: boolean;
	against?: ComparedBrain;
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
			state: await readRun(opts.db, opts.brainId, opts.against?.brainId)
		};
	}
	const state = await advanceConsolidation({ ...opts, gateway: opened.gateway });
	return { text: consolidationStepText(state, opts.against?.handle), state };
}
