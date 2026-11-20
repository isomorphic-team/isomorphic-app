// The scheduled organization pass: one run of it.
//
// For each organization given, it opens the organization's brains, keeps those whose
// config says they take part (src/lib/org-pass.ts), and advances the contradictions pass
// of the brains that have a step to take, each against all the others. It runs as the
// organization: no person's access is consulted and no person is recorded as the actor.
// A brain that does not take part has its config read and nothing else.
//
// A run takes a bounded number of steps and the passes are resumable, so a large
// organization is covered over several runs. The pass state and pair memory are the ones
// `review_brain` with `against: "all"` uses, so a pair either has checked is not checked
// again by the other.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import {
	ORG_PASS_STEPS_PER_RUN,
	orgPassBrains,
	orgPassOrder,
	orgPassStart
} from '../../src/lib/org-pass.ts';
import { AGAINST_ALL, type ComparedBrain, type Comparison } from '../../src/lib/review-checks.ts';
import { readRun, type ConsolidationState } from './consolidation.ts';

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
			steps: []
		};
		report.orgs.push(org);
		if (brains.length === 0) continue;

		const runs = await Promise.all(brains.map((b) => readRun(deps.db, b.brainId, AGAINST_ALL)));
		const queue = orgPassOrder(
			brains.map((brain, i) => ({ brain, run: runs[i] })),
			now
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
			if (!state || state.status === 'stopped') break;
			if (state.status === 'running') queue.push(home);
		}
	}
	return report;
}
