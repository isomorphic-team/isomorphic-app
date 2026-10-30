// The baseline scan: the guard's deterministic detectors over a brain as it stands, run
// when an admin asks (docs/design/privacy-checks.md, Part 1). It reaches what the guard
// cannot: content that landed before the guard, or by a push it never saw.
//
// A whole-repository pass, so it is budgeted and resumable: each call handles
// BASELINE_FILE_BUDGET paths from the cursor in D1, and the status turns `done` only at
// the end. It reads through the BrainStore so it covers every text file in the
// repository, not only the indexed pages.
//
// No model is involved and nothing leaves the deployment. Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import type { BrainStore, RepoRef, TreeEntry } from './brain-repo.ts';
import type { BrainConfig } from './brain-policy.ts';
import { detectSensitive } from './policy-detectors.ts';
import type { WriteDetection } from './policy-guard.ts';
import {
	beginBaseline,
	readBaseline,
	saveBaselineStep,
	type BaselineState,
	type BaselineScope
} from './policy-store.ts';

// Paths per call. Blob reads batch through GraphQL, so this costs a few subrequests.
export const BASELINE_FILE_BUDGET = 300;

// Skipped unread. A binary the extension does not name comes back with no text from
// `fetchPages` and is counted the same way.
const BINARY_FILE =
	/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|pdf|zip|gz|tgz|tar|7z|rar|mp3|mp4|m4a|mov|wav|webm|avi|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|sqlite|db|wasm|bin|exe|dylib|so)$/i;

export interface BaselineStepPlan {
	// Paths to read this call.
	read: TreeEntry[];
	// Binary paths passed over this call.
	skipped: number;
	// The last path this call covers; null when there was nothing left.
	last: string | null;
	done: boolean;
}

// The next window of the tree after `cursor`. Sorted by code unit, the order the
// cursor compares in.
export function planBaselineStep(
	tree: readonly TreeEntry[],
	cursor: string | null,
	budget = BASELINE_FILE_BUDGET
): BaselineStepPlan {
	const remaining = tree
		.filter((e) => cursor === null || e.path > cursor)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const window = remaining.slice(0, budget);
	const read = window.filter((e) => !BINARY_FILE.test(e.path));
	return {
		read,
		skipped: window.length - read.length,
		last: window.at(-1)?.path ?? cursor,
		done: remaining.length <= budget
	};
}

export interface BaselineTarget {
	db: D1Database;
	store: BrainStore;
	repo: RepoRef;
	config: BrainConfig;
	scope: BaselineScope;
}

// One call's worth of the scan. Starts a new scan when none is running, so the same
// call both begins and resumes, and a finished scan is replaced by asking again.
export async function advanceBaseline(t: BaselineTarget, now = Date.now()): Promise<BaselineState> {
	const { db, store, repo, config, scope } = t;
	const existing = await readBaseline(db, scope.brainId);
	const state = existing?.status === 'running' ? existing : await beginBaseline(db, scope, now);

	const head = await store.getHead(repo, config.defaultBranch);
	const tree = await store.listTree(repo, head, { extension: '*' });
	const plan = planBaselineStep(tree, state.cursor);
	const { pages } = plan.read.length
		? await store.fetchPages(repo, plan.read)
		: { pages: [] as { path: string; content: string }[] };

	const detections: WriteDetection[] = pages.flatMap((p) =>
		detectSensitive(p.content).map((d) => ({ path: p.path, ...d }))
	);
	const next: BaselineState = {
		...state,
		status: plan.done ? 'done' : 'running',
		cursor: plan.last,
		filesScanned: state.filesScanned + pages.length,
		filesSkipped: state.filesSkipped + plan.skipped + plan.read.length - pages.length,
		detections: state.detections + detections.length,
		finishedAt: plan.done ? now : null
	};
	await saveBaselineStep(db, scope, state.cursor, next, detections, now);
	return next;
}

// What the tool says about a step, for the model and for an admin reading the reply.
export function baselineStepText(s: BaselineState): string {
	const counts = `${s.filesScanned} file(s) scanned, ${s.filesSkipped} binary file(s) skipped, ${s.detections} detection(s).`;
	return s.status === 'done'
		? `Baseline scan finished: ${counts} view_review shows what it found.`
		: `Baseline scan in progress: ${counts} Call configure_brain with baseline_scan: true again to continue.`;
}
