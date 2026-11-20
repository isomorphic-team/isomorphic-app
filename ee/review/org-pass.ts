// The scheduled organization pass: one run of it.
//
// For each organization given, it opens the organization's brains, keeps those whose
// config says they take part (src/lib/org-pass.ts), and advances the contradictions pass
// of the brains that have a step to take, each against all the others. It runs as the
// organization: no person's access is consulted and no person is recorded as the actor.
// A brain that does not take part has its config read and nothing else.
//
// A run takes a bounded number of steps and the passes are resumable, so a large
// organization is covered over several runs. A pair of pages in two brains is remembered
// once for both (`acrossMemory`), so the second brain's pass does not check it again, and
// its finding is in both queues. Each brain's cursor is the one `review_brain` with
// `against: "all"` uses.
//
// `review_brain` with `against: "organization"` runs the same thing for one organization
// when an organization admin asks (`orgPassNowText` is its reply).
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import {
	ORG_PASS_EVERY_MS,
	ORG_PASS_NOW_STANDS_MS,
	ORG_PASS_STEPS_PER_RUN,
	orgPassBrains,
	orgPassOrder,
	orgPassStart
} from '../../src/lib/org-pass.ts';
import { AGAINST_ALL, type ComparedBrain, type Comparison } from '../../src/lib/review-checks.ts';
import { STOP_TEXT, readRun, type ConsolidationState } from './consolidation.ts';

export interface OrgPassDeps<R extends { brain_id: string }> {
	db: D1Database;
	// The organizations to cover: those entitled to the pass.
	orgs: readonly string[];
	listBrains(orgId: string): Promise<R[]>;
	// Opens one brain's storage and reads its config. Throws when it cannot.
	open(row: R): Promise<ComparedBrain>;
	// One step of `home`'s pass against the others: the state after it, or null when the
	// pass could not run and has never run.
	advance(
		orgId: string,
		home: ComparedBrain,
		against: Comparison
	): Promise<ConsolidationState | null>;
	now?: number;
	maxSteps?: number;
	// How long a finished pass stands before its brain is checked again.
	stands?: number;
}

export interface OrgPassStep {
	brainId: string;
	status: ConsolidationState['status'] | 'not-run' | 'failed';
	stoppedReason?: string | null;
	pairsChecked?: number;
	findings?: number;
	costUsd?: number;
	error?: string;
}

export interface OrgPassOrgReport {
	orgId: string;
	// Brains taking part, and those the pass could not use: not opened, or past what one
	// pass compares.
	brains: number;
	unopened: string[];
	leftOut: string[];
	steps: OrgPassStep[];
	// Brains that still have a step to take after this run.
	pending: number;
}

export interface OrgPassReport {
	steps: number;
	orgs: OrgPassOrgReport[];
}

const brief = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function runOrgPass<R extends { brain_id: string }>(
	deps: OrgPassDeps<R>
): Promise<OrgPassReport> {
	const now = deps.now ?? Date.now();
	const max = deps.maxSteps ?? ORG_PASS_STEPS_PER_RUN;
	const report: OrgPassReport = { steps: 0, orgs: [] };
	const first = orgPassStart(deps.orgs.length, now);

	for (let k = 0; k < deps.orgs.length && report.steps < max; k++) {
		const orgId = deps.orgs[(first + k) % deps.orgs.length];
		const rows = await deps.listBrains(orgId);
		const opened: ComparedBrain[] = [];
		const unopened: string[] = [];
		await Promise.all(
			rows.map(async (row) => {
				try {
					opened.push(await deps.open(row));
				} catch {
					unopened.push(row.brain_id);
				}
			})
		);
		const { brains, leftOut } = orgPassBrains(opened);
		const org: OrgPassOrgReport = {
			orgId,
			brains: brains.length,
			unopened: unopened.sort(),
			leftOut: leftOut.map((b) => b.brainId),
			steps: [],
			pending: 0
		};
		report.orgs.push(org);
		if (brains.length === 0) continue;

		const runs = await Promise.all(brains.map((b) => readRun(deps.db, b.brainId, AGAINST_ALL)));
		const queue = orgPassOrder(
			brains.map((brain, i) => ({ brain, run: runs[i] })),
			now,
			deps.stands ?? ORG_PASS_EVERY_MS
		);
		while (queue.length > 0 && report.steps < max) {
			const home = queue.shift()!;
			report.steps++;
			let state: ConsolidationState | null;
			try {
				state = await deps.advance(orgId, home, {
					all: true,
					brains: brains.filter((b) => b !== home)
				});
			} catch (err) {
				org.steps.push({ brainId: home.brainId, status: 'failed', error: brief(err) });
				continue;
			}
			const waits = !state || state.status !== 'done';
			org.steps.push(
				state
					? {
							brainId: home.brainId,
							status: state.status,
							stoppedReason: state.stoppedReason,
							pairsChecked: state.pairsChecked,
							findings: state.findings,
							costUsd: state.costUsd
						}
					: { brainId: home.brainId, status: 'not-run' }
			);
			// What stops a pass (the spend cap, the entitlement, the provider) stops the
			// organization's other brains too, so the rest wait for the next run.
			if (waits) queue.push(home);
			if (!state || state.status === 'stopped') break;
		}
		org.pending = queue.length;
	}
	return report;
}

// What an organization admin is told after asking for the organization's checks now.
// Counts only: the brains are not named, since the asker may not be able to open them all.
export function orgPassNowText(org: OrgPassOrgReport | undefined): string {
	const again = 'Call review_brain with check "contradictions" and against "organization"';
	if (!org || org.brains < 2) {
		return 'Fewer than two brains of this organization take part in its checks, so there is nothing to run. configure_brain with org_checks: true adds a brain.';
	}
	const apart = [
		...(org.unopened.length ? [`${org.unopened.length} could not be opened`] : []),
		...(org.leftOut.length ? [`${org.leftOut.length} are past what one pass compares`] : [])
	];
	const who = `${org.brains} brains take part${apart.length ? ` (${apart.join(', ')})` : ''}.`;
	if (org.steps.length === 0) {
		return `${who} Each one's check finished in the last ${ORG_PASS_NOW_STANDS_MS / 60_000} minutes, so nothing was run. validate on each brain lists its findings.`;
	}
	const sum = (pick: (s: OrgPassStep) => number | undefined) =>
		org.steps.reduce((n, s) => n + (pick(s) ?? 0), 0);
	const counts = `In the brains this call stepped: ${sum((s) => s.pairsChecked)} page pair(s) checked, ${sum((s) => s.findings)} conflict finding(s), $${sum((s) => s.costUsd).toFixed(4)} spent so far.`;
	const stopped = org.steps.find((s) => s.status === 'stopped');
	if (stopped) {
		const why = STOP_TEXT[stopped.stoppedReason ?? ''] ?? stopped.stoppedReason ?? 'unknown';
		return `${who} The organization's checks stopped: ${why}. ${counts} ${again} to resume once that changes.`;
	}
	if (org.steps.some((s) => s.status === 'not-run')) {
		return `${who} The organization's checks did not run: the organization needs the contradictions check and the deployment a model key.`;
	}
	const failed = org.steps.filter((s) => s.status === 'failed').length;
	const failures = failed ? ` ${failed} brain(s) failed this time and will be tried again.` : '';
	if (org.pending > 0) {
		return `${who} The organization's checks are in progress, ${org.pending} brain(s) still to finish. ${counts}${failures} ${again} again to continue.`;
	}
	return `${who} The organization's checks finished. ${counts}${failures} A pair of pages is checked once for both brains, and its finding is in both brains' reports: validate on each lists them.`;
}
