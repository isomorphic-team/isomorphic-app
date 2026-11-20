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
import { MAX_COMPARED_BRAINS } from './review-checks.ts';

// How long a brain's finished pass stands before the next one starts. A pass over brains
// that have not changed checks no pair again, so this bounds reading, not model spend.
export const ORG_PASS_EVERY_MS = 24 * 60 * 60 * 1000;

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

export interface OrgPassRun {
	status: PassStatus;
	startedAt: number;
	finishedAt: number | null;
}

// Whether a brain's pass has a step to take now: one that is under way or stopped, one
// that never ran, or one that finished long enough ago.
export function orgPassDue(run: OrgPassRun | null, now: number): boolean {
	if (!run || run.status !== 'done') return true;
	return now - (run.finishedAt ?? run.startedAt) >= ORG_PASS_EVERY_MS;
}

// The brains with a step to take, in the order to take them: passes under way first, so
// one that started finishes before another begins, then brains never checked, then the
// longest since they finished.
export function orgPassOrder<B>(
	brains: readonly { brain: B; run: OrgPassRun | null }[],
	now: number
): B[] {
	const rank = (run: OrgPassRun | null) =>
		run && run.status !== 'done' ? 0 : run === null ? 1 : 2;
	return brains
		.filter((b) => orgPassDue(b.run, now))
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

// Where a run starts among the organizations, so the step budget does not always go to
// the same ones: it moves on by one each hour.
export function orgPassStart(orgCount: number, now: number): number {
	return orgCount > 0 ? Math.floor(now / (60 * 60 * 1000)) % orgCount : 0;
}
