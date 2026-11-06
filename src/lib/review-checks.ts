// The deep review passes behind `review_brain`, and what `validate` says about them.
//
// `validate` is the fast, free report anyone with access can read. `review_brain` runs
// the slow passes that feed it, one budgeted step per call, for brain admins:
//
//   - sensitive-data: the baseline scan (policy-baseline.ts), deterministic, no model.
//   - contradictions: the model consolidation pass, an enterprise feature the Worker
//     wires in (ee/review/consolidation.ts) and the core only calls through the context.
//
// Pure, except readContradictionPass, which reads the pass's row from D1 `brain_passes`.
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import { readPass, type PassStatus } from './brain-pass.ts';
import type { PolicyMode } from './brain-policy.ts';
import { roleAtLeast, type Role } from './orgs.ts';

export const REVIEW_CHECKS = ['sensitive-data', 'contradictions'] as const;
export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

// Why a check cannot run on this brain, or null when it can.
export function reviewCheckRefusal(
	check: ReviewCheck,
	brain: { policyMode: PolicyMode; contradictionsAvailable: boolean }
): string | null {
	if (check === 'sensitive-data' && brain.policyMode === 'off') {
		return 'Sensitive-data checks are turned off for this brain, so nothing was scanned.';
	}
	if (check === 'contradictions' && !brain.contradictionsAvailable) {
		return 'The contradictions check is an enterprise feature this deployment has not set up: it needs a model key.';
	}
	return null;
}

// What `validate` needs from the contradictions pass's row.
export interface ContradictionPass {
	status: PassStatus;
	finishedAt: number | null;
	pairsChecked: number;
	findings: number;
}

// The pass kind the consolidation pass saves under (ee/review/consolidation.ts).
const CONTRADICTIONS_KIND = 'consolidation';

export async function readContradictionPass(
	db: D1Database,
	brainId: string
): Promise<ContradictionPass | null> {
	const pass = await readPass(db, brainId, CONTRADICTIONS_KIND, { pairsChecked: 0, findings: 0 });
	return (
		pass && {
			status: pass.status,
			finishedAt: pass.finishedAt,
			pairsChecked: pass.counters.pairsChecked,
			findings: pass.counters.findings
		}
	);
}

// The line `validate` adds about the contradictions pass: only for brain admins, and only
// where the check can run, since anyone else could not act on it.
export function contradictionCoverage(
	viewer: Role,
	contradictionsAvailable: boolean,
	pass: ContradictionPass | null
): string {
	if (!contradictionsAvailable || !roleAtLeast(viewer, 'admin')) return '';
	const run = 'review_brain with check "contradictions"';
	if (!pass) {
		return `\n\nContradiction check: not run on this brain yet. ${run} has a model compare related pages (an enterprise feature that spends model credits).`;
	}
	if (pass.status !== 'done') {
		return `\n\nContradiction check: in progress, ${pass.pairsChecked} page pair(s) checked so far. ${run} continues it.`;
	}
	const when = pass.finishedAt ? new Date(pass.finishedAt).toISOString().slice(0, 10) : 'earlier';
	return `\n\nContradiction check: last finished ${when} over ${pass.pairsChecked} page pair(s), ${pass.findings} finding(s) raised. ${run} checks pages edited since, and only those.`;
}
