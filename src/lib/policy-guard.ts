// The data-policy guard: a BrainStore wrapper that checks every file a write is
// about to land. Wrapping the store rather than one tool is what makes it
// complete, because every tool that writes (page writes, moves, media, the
// importer, config) reaches storage through commitOrPR or commitFiles.
//
// Shadow mode only, for now (docs/roadmap.md, "brain review", step 1): the guard
// records what it finds and never blocks, changes or delays a write beyond
// the scan itself. A failure to record is swallowed for the same reason, since
// measurement must never cost a user their edit.
//
// Worker-safe: no node:* imports.

import type { BrainStore, FileWrite } from './brain-repo.ts';
import type { PolicyMode } from './brain-policy.ts';
import { roleAtLeast, type Role } from './orgs.ts';
import { detectSensitive, type Detection } from './policy-detectors.ts';
import type { BaselineState } from './policy-store.ts';

export interface WriteDetection extends Detection {
	path: string;
}

// Detections across a bundle's text writes. Binary writes (encoding base64:
// uploaded images) are skipped: the text detectors mean nothing on bytes.
export function scanWrites(writes: readonly FileWrite[] | undefined): WriteDetection[] {
	const out: WriteDetection[] = [];
	for (const w of writes ?? []) {
		if (w.encoding === 'base64') continue;
		for (const d of detectSensitive(w.content)) out.push({ path: w.path, ...d });
	}
	return out;
}

export interface GuardOptions {
	mode: PolicyMode;
	// Persist detections for a write that landed. Called only when there are any.
	record: (detections: WriteDetection[]) => Promise<void>;
}

export function guardStore(store: BrainStore, opts: GuardOptions): BrainStore {
	if (opts.mode === 'off') return store;

	// Scan before the write so the content is read exactly as it will be written,
	// and record after, so a write that failed leaves no row behind.
	async function recordLanded<T>(writes: FileWrite[] | undefined, write: () => Promise<T>) {
		const detections = scanWrites(writes);
		const result = await write();
		if (detections.length > 0) {
			try {
				await opts.record(detections);
			} catch {
				// Shadow mode never costs a write; see the header.
			}
		}
		return result;
	}

	return {
		...store,
		commitFiles: (repo, o) => recordLanded(o.writes, () => store.commitFiles(repo, o)),
		commitOrPR: (repo, o) => recordLanded(o.writes, () => store.commitOrPR(repo, o))
	};
}

// How many pages a summary lists.
export const MAX_REPORT_PATHS = 20;

// The release that first ran the guard. Nothing before it was scanned, however old the
// brain, so a coverage date is never earlier than this.
export const GUARD_FIRST_RELEASED = '2026-09-30';

/** What the report in front of an admin has actually looked at. */
export interface GuardCoverage {
	// YYYY-MM-DD: the earliest write the guard can have seen on this brain.
	since: string;
	baseline: 'none' | 'running' | 'done';
	// The statement both surfaces show. Partial coverage is never reported as clean.
	text: string;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function guardCoverage(
	mode: PolicyMode,
	brainCreatedAt: string | null,
	baseline: BaselineState | null
): GuardCoverage {
	const created = (brainCreatedAt ?? '').slice(0, 10);
	const since = created > GUARD_FIRST_RELEASED ? created : GUARD_FIRST_RELEASED;
	const writes =
		mode === 'off'
			? 'Checks are off, so new writes are not scanned.'
			: `This covers writes made through Isomorphic since ${since}. Changes pushed directly to the repository are not seen.`;
	let existing = 'Content already in the brain has not been scanned.';
	if (baseline?.status === 'running') {
		existing = `A scan of existing content is unfinished: ${baseline.filesScanned} file(s) so far.`;
	} else if (baseline?.finishedAt) {
		existing = `Existing content was scanned on ${isoDate(baseline.finishedAt)}: ${baseline.filesScanned} file(s), ${baseline.filesSkipped} binary file(s) skipped.`;
	}
	return { since, baseline: baseline?.status ?? 'none', text: `${writes} ${existing}` };
}

export interface DetectionCount {
	path: string;
	kind: string;
	count: number;
}

/** One page's detections, busiest kind first. */
export interface DetectionPage {
	path: string;
	count: number;
	kinds: { kind: string; count: number }[];
}

// Per-(path, kind) counts folded into pages, busiest page first, then by path. The
// ONE ordering both the `validate` text and the app's Review screen show.
export function groupDetections(counts: readonly DetectionCount[]): {
	total: number;
	pages: DetectionPage[];
} {
	const byPath = new Map<string, DetectionPage>();
	for (const c of counts) {
		const page = byPath.get(c.path) ?? { path: c.path, count: 0, kinds: [] };
		page.count += c.count;
		page.kinds.push({ kind: c.kind, count: c.count });
		byPath.set(c.path, page);
	}
	const pages = [...byPath.values()].sort(
		(a, b) => b.count - a.count || a.path.localeCompare(b.path)
	);
	for (const p of pages) p.kinds.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
	return { total: pages.reduce((n, p) => n + p.count, 0), pages };
}

// The `validate` section for the guard: '' unless the caller is a brain admin. A path
// and a kind already say where sensitive data sits. The
// findings themselves are in the list above it, with the keys `resolve` takes, so this
// counts them and states coverage, which an empty report must never read as a clean
// brain. A null count means the queue could not be read, and claims nothing.
export function detectionSection(role: Role, open: number | null, coverage: GuardCoverage): string {
	if (!roleAtLeast(role, 'admin')) return '';
	const count =
		open === null
			? ''
			: open === 0
				? 'no open findings. '
				: `${open} open finding(s) among those above. Values are not stored, so read the file to review. `;
	return `\n\nSensitive data (shown to admins only): ${count}${coverage.text}`;
}

function detectionLines(pages: readonly DetectionPage[]): string {
	const lines = pages
		.slice(0, MAX_REPORT_PATHS)
		.map((p) => `- ${p.path}: ${p.kinds.map((k) => `${k.count} ${k.kind}`).join(', ')}`);
	const more = pages.length - lines.length;
	if (more > 0) lines.push(`- and ${more} more page(s)`);
	return lines.join('\n');
}

// The Review screen's text block, for the model reading the result.
export function reviewSummary(
	mode: PolicyMode,
	grouped: { total: number; pages: readonly DetectionPage[] },
	coverage: GuardCoverage
): string {
	const off = mode === 'off' ? 'Sensitive-data checks are turned off for this brain.\n\n' : '';
	if (grouped.total === 0) {
		return `${off}Nothing open. ${coverage.text}`;
	}
	return (
		`${off}${grouped.total} detection(s) across ${grouped.pages.length} page(s). Values are` +
		` not stored, so read the page to review.\n` +
		`${detectionLines(grouped.pages)}\n${coverage.text}`
	);
}
