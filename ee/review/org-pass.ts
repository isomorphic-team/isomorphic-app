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
// when an organization admin asks (`runOrgChecksNow`).
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import {
	ORG_PASS_EVERY_MS,
	ORG_PASS_NOW_STANDS_MS,
	ORG_PASS_STEPS_PER_RUN,
	orgPassBrains,
	orgPassOrder,
	orgPassTotals,
	type OrgPassTotals,
	orgPassStart
} from '../../src/lib/org-pass.ts';
import {
	AGAINST_ALL,
	AGAINST_ORGANIZATION,
	type ComparedBrain,
	type Comparison
} from '../../src/lib/review-checks.ts';
import type { OrgChecksWire } from '../../src/lib/tool-payloads.ts';
import { readRun, reviewCall, stopText, type ConsolidationState } from './consolidation.ts';

export interface OrgPassDeps<R extends { brain_id: string }> {
	db: D1Database;
	// The organizations to cover: those entitled to the pass.
	orgs: readonly string[];
	listBrains(orgId: string): Promise<R[]>;
	// Opens one brain's storage and reads its config. Throws when it cannot.
	open(row: R): Promise<ComparedBrain>;
	// One step of `home`'s pass against the others: the state after it, or why the step
	// was refused before it ran (the entitlement, the spend cap, the model key).
	advance(
		orgId: string,
		home: ComparedBrain,
		against: Comparison
	): Promise<ConsolidationState | { refused: string }>;
	now?: number;
	maxSteps?: number;
	// How long a finished pass stands before its brain is checked again.
	stands?: number;
}

export interface OrgPassStep {
	brainId: string;
	status: ConsolidationState['status'] | 'failed';
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
	// Every brain's current pass together (`orgPassTotals`).
	totals: OrgPassTotals;
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
			pending: 0,
			totals: { pairsChecked: 0, findings: 0, costUsd: 0 }
		};
		report.orgs.push(org);
		if (brains.length === 0) continue;

		const runs = await Promise.all(brains.map((b) => readRun(deps.db, b.brainId, AGAINST_ALL)));
		const stands = deps.stands ?? ORG_PASS_EVERY_MS;
		const queue = orgPassOrder(
			brains.map((brain, i) => ({ brain, run: runs[i] })),
			now,
			stands
		);
		// Each brain's pass as it stands, and the brains this run stepped.
		const latest = new Map(brains.map((b, i) => [b.brainId, runs[i]]));
		const stepped = new Set<string>();
		while (queue.length > 0 && report.steps < max) {
			const home = queue.shift()!;
			report.steps++;
			let state: ConsolidationState | { refused: string };
			try {
				state = await deps.advance(orgId, home, {
					all: true,
					brains: brains.filter((b) => b !== home)
				});
			} catch (err) {
				org.steps.push({ brainId: home.brainId, status: 'failed', error: brief(err) });
				continue;
			}
			// A refused step is a stopped pass that did nothing: what its row says is older.
			const step: OrgPassStep =
				'refused' in state
					? { brainId: home.brainId, status: 'stopped', stoppedReason: state.refused }
					: {
							brainId: home.brainId,
							status: state.status,
							stoppedReason: state.stoppedReason,
							pairsChecked: state.pairsChecked,
							findings: state.findings,
							costUsd: state.costUsd
						};
			org.steps.push(step);
			if (!('refused' in state)) {
				latest.set(home.brainId, state);
				stepped.add(home.brainId);
			}
			if (step.status !== 'done') queue.push(home);
			// What stops a pass (the spend cap, the entitlement, the provider) stops the
			// organization's other brains too, so the rest wait for the next run.
			if (step.status === 'stopped') break;
		}
		org.pending = queue.length;
		org.totals = orgPassTotals(
			[...latest].map(([brainId, run]) => ({ run, stepped: stepped.has(brainId) })),
			now,
			stands
		);
	}
	return report;
}

// One step of one organization's pass, asked for by an organization admin: the reply and
// its payload. A finished pass stands for `ORG_PASS_NOW_STANDS_MS`, which is how repeated
// calls come to an end.
export async function runOrgChecksNow<R extends { brain_id: string }>(
	deps: Omit<OrgPassDeps<R>, 'orgs' | 'maxSteps' | 'stands'>,
	orgId: string
): Promise<{ text: string; wire: OrgChecksWire }> {
	const report = await runOrgPass({
		...deps,
		orgs: [orgId],
		maxSteps: 1,
		stands: ORG_PASS_NOW_STANDS_MS
	});
	const org = report.orgs[0];
	return {
		text: orgPassNowText(org),
		wire: {
			organization: {
				brains: org.brains,
				pending: org.pending,
				steps: org.steps.length,
				...org.totals
			}
		}
	};
}

// What an organization admin is told after asking for the organization's checks now.
// Counts only: the brains are not named, since the asker may not be able to open them all.
export function orgPassNowText(org: OrgPassOrgReport): string {
	const again = reviewCall(AGAINST_ORGANIZATION);
	if (org.brains < 2) {
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
	const t = org.totals;
	const counts = (soFar: string) =>
		`Across the organization's brains${soFar}: ${t.pairsChecked} page pair(s) checked, ${t.findings} conflict finding(s), $${t.costUsd.toFixed(4)} spent.`;
	const stopped = org.steps.find((s) => s.status === 'stopped');
	if (stopped) {
		return `${who} The organization's checks stopped: ${stopText(stopped.stoppedReason)}. ${counts(' so far')} ${again} to resume once that changes.`;
	}
	const failed = org.steps.filter((s) => s.status === 'failed').length;
	const failures = failed ? ` ${failed} brain(s) failed this time and will be tried again.` : '';
	if (org.pending > 0) {
		return `${who} The organization's checks are in progress, ${org.pending} brain(s) still to finish. ${counts(' so far')}${failures} ${again} again to continue.`;
	}
	return `${who} The organization's checks finished. ${counts('')}${failures} A pair of pages is checked once for both brains, and its finding is in both brains' reports: validate on each lists them.`;
}
