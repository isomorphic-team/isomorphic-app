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
import type { BrainIndex } from './brain-index.ts';
import { readPass, type PassStatus } from './brain-pass.ts';
import type { BrainConfig, PolicyMode } from './brain-policy.ts';
import type { BrainLocator, BrainStore } from './brain-repo.ts';
import { roleAtLeast, type Role } from './orgs.ts';
import type { ConsolidationStepWire } from './tool-payloads.ts';

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

// Another brain the contradictions check compares this one against, as the caller reaches
// it: its id, the handle a tool takes, and how to read its pages.
export interface ComparedBrain {
	brainId: string;
	handle: string;
	index: BrainIndex;
	store: BrainStore;
	repo: BrainLocator;
	config: BrainConfig;
}

/** One step of the consolidation pass, as the Worker wires it into a brain's context. */
export type ConsolidationStep = (opts?: {
	// Start a new pass that checks every pair, ignoring what earlier passes checked.
	fresh?: boolean;
	// Compare this brain against another one instead of against itself.
	against?: ComparedBrain;
}) => Promise<{ text: string; wire: ConsolidationStepWire }>;

// Why this brain cannot be checked against `other`, or null when it can. The caller has
// already opened both, so reading the other brain is settled before this is asked. The
// same organization is required because the other brain's pages go to the model under
// this brain's organization's entitlement and spend, and are quoted in its queue.
export function againstRefusal(
	check: ReviewCheck,
	home: { brainId: string; orgId?: string },
	other: { brainId: string; orgId?: string }
): string | null {
	if (check !== 'contradictions') {
		return '`against` only applies to check "contradictions".';
	}
	if (home.brainId === other.brainId) {
		return 'A brain is not compared against itself: leave `against` out to check it on its own.';
	}
	if (!home.orgId || home.orgId !== other.orgId) {
		return 'Two brains can be compared only when they belong to the same organization.';
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
