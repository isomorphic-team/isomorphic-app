// The scheduled organization pass: which brains it covers and which is next.
//
// The pass runs as the organization, with no person behind it, so a person's access
// decides nothing here. A brain is covered when its own config says it takes part
// (`BrainConfig.orgChecks`). Each covered brain is checked against the others by the
// contradictions pass (ee/review/consolidation.ts), a step at a time, and its findings
// land in its own queue, where each reader sees only those whose pages they can open.
//
// Pure. The runner is ee/review/org-pass.ts.
//
// Worker-safe: no node:* imports.

import type { PassStatus } from './brain-pass.ts';
import { AGAINST_ORGANIZATION, MAX_COMPARED_BRAINS } from './review-checks.ts';

// How long a brain's finished pass stands before the next one starts. A pass over brains
// that have not changed checks no pair again, so this bounds reading, not model spend.
export const ORG_PASS_EVERY_MS = 24 * 60 * 60 * 1000;

// How long a finished pass stands when a person asks for the checks now. Asking again
// within it starts nothing, which is how repeated calls come to an end.
export const ORG_PASS_NOW_STANDS_MS = 10 * 60 * 1000;

// Steps one scheduled run takes across every organization. Each step is one call's worth
// of the contradictions pass, so this bounds a run's time and its outbound requests.
export const ORG_PASS_STEPS_PER_RUN = 4;

// The brains of one organization the pass covers, in a stable order: those that take
// part, when there are at least two. More than one pass compares are cut to the first
// by id, and the rest are reported as left out.
export function orgPassBrains<B extends { brainId: string; config: { orgChecks: boolean } }>(
	brains: readonly B[]
): { brains: B[]; leftOut: B[] } {
	const taking = brains
		.filter((b) => b.config.orgChecks)
		.sort((a, b) => (a.brainId < b.brainId ? -1 : a.brainId > b.brainId ? 1 : 0));
	if (taking.length < 2) return { brains: [], leftOut: [] };
	return {
		brains: taking.slice(0, MAX_COMPARED_BRAINS + 1),
		leftOut: taking.slice(MAX_COMPARED_BRAINS + 1)
	};
}

// What stands between an organization's brains and its scheduled checks, as the person
// who just changed one brain's part in them is told it.
export interface OrgChecksStatus {
	orgLabel: string;
	// Brains of the organization that take part, the caller's included when it does.
	takingPart: number;
	// Brains whose config could not be read, so are in neither count.
	unread: number;
	// The organization holds the feature the pass is part of.
	entitled: boolean;
	// The deployment has a model key to run it with.
	modelKey: boolean;
}

// How many of an organization's brains take part. `self` is the brain whose setting was
// just written: its answer is the one given, not one read back through a cache.
export async function countOrgChecks<R extends { brain_id: string }>(
	rows: readonly R[],
	self: { brainId: string; on: boolean },
	read: (row: R) => Promise<boolean>
): Promise<{ takingPart: number; unread: number }> {
	const answers = await Promise.all(
		rows.filter((r) => r.brain_id !== self.brainId).map((r) => read(r).catch(() => null))
	);
	return {
		takingPart: answers.filter((a) => a === true).length + (self.on ? 1 : 0),
		unread: answers.filter((a) => a === null).length
	};
}

// The sentences that say whether the scheduled checks run for this organization, and
// what is missing when they do not.
export function orgChecksStatusText(s: OrgChecksStatus): string {
	const n = s.takingPart;
	const count =
		n === 0
			? `In ${s.orgLabel}, no brain takes part.`
			: `In ${s.orgLabel}, ${n === 1 ? '1 brain takes' : `${n} brains take`} part.`;
	const unread =
		s.unread > 0
			? ` ${s.unread === 1 ? '1 brain' : `${s.unread} brains`} could not be read and ${s.unread === 1 ? 'is' : 'are'} not counted.`
			: '';
	const missing = [
		...(n < 2 ? ['a second brain takes part'] : []),
		...(s.entitled ? [] : [`${s.orgLabel} has the contradictions check`]),
		...(s.modelKey ? [] : ['this deployment has a model key'])
	];
	const runs =
		missing.length === 0
			? ` The scheduled checks run across them, each brain about once a day. An organization admin can run them now: review_brain with check "contradictions" and against "${AGAINST_ORGANIZATION}".`
			: ` The scheduled checks do not run until ${missing.join(', and ')}.`;
	return count + unread + runs;
}

export interface OrgPassRun {
	status: PassStatus;
	startedAt: number;
	finishedAt: number | null;
}

// Whether a brain's pass has a step to take now: one that is under way or stopped, one
// that never ran, or one that finished at least `stands` ago.
export function orgPassDue(
	run: OrgPassRun | null,
	now: number,
	stands = ORG_PASS_EVERY_MS
): boolean {
	if (!run || run.status !== 'done') return true;
	return now - (run.finishedAt ?? run.startedAt) >= stands;
}

// The brains with a step to take, in the order to take them: passes under way first, so
// one that started finishes before another begins, then brains never checked, then the
// longest since they finished.
export function orgPassOrder<B>(
	brains: readonly { brain: B; run: OrgPassRun | null }[],
	now: number,
	stands = ORG_PASS_EVERY_MS
): B[] {
	const rank = (run: OrgPassRun | null) =>
		run && run.status !== 'done' ? 0 : run === null ? 1 : 2;
	return brains
		.filter((b) => orgPassDue(b.run, now, stands))
		.map((b, i) => ({ ...b, i }))
		.sort(
			(a, b) =>
				rank(a.run) - rank(b.run) ||
				(a.run?.finishedAt ?? a.run?.startedAt ?? 0) -
					(b.run?.finishedAt ?? b.run?.startedAt ?? 0) ||
				a.i - b.i
		)
		.map((b) => b.brain);
}

// What an organization's checks have counted, every brain's current pass together: the
// passes this run stepped, those under way, and those that finished and still stand. A
// brain whose finished pass is due again counts nothing until it is stepped.
export interface OrgPassTotals {
	pairsChecked: number;
	findings: number;
	costUsd: number;
}
export function orgPassTotals(
	brains: readonly { run: (OrgPassRun & OrgPassTotals) | null; stepped: boolean }[],
	now: number,
	stands = ORG_PASS_EVERY_MS
): OrgPassTotals {
	const totals = { pairsChecked: 0, findings: 0, costUsd: 0 };
	for (const { run, stepped } of brains) {
		if (!run) continue;
		if (!stepped && run.status === 'done' && orgPassDue(run, now, stands)) continue;
		totals.pairsChecked += run.pairsChecked;
		totals.findings += run.findings;
		totals.costUsd += run.costUsd;
	}
	return totals;
}

// Where a run starts among the organizations, so the step budget does not always go to
// the same ones: it moves on by one each hour.
export function orgPassStart(orgCount: number, now: number): number {
	return orgCount > 0 ? Math.floor(now / (60 * 60 * 1000)) % orgCount : 0;
}
