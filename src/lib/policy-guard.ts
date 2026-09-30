// The data-policy guard: a BrainStore wrapper that checks every file a write is
// about to land. Wrapping the store rather than one tool is what makes it
// complete, because every tool that writes (page writes, moves, media, the
// importer, config) reaches storage through commitOrPR or commitFiles.
//
// Shadow mode only, for now (docs/roadmap.md, "brain review", step 1): the guard
// records what it would flag and never blocks, changes or delays a write beyond
// the scan itself. A failure to record is swallowed for the same reason, since
// measurement must never cost a user their edit.
//
// Worker-safe: no node:* imports.

import type { BrainStore, FileWrite } from './brain-repo.ts';
import type { PolicyMode } from './brain-policy.ts';
import { roleAtLeast, type Role } from './orgs.ts';
import { detectSensitive, type Detection } from './policy-detectors.ts';
import type { DetectionCount } from './policy-store.ts';

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

// How far back `validate` reports, and how many pages it lists.
export const REPORT_WINDOW_DAYS = 30;
export const MAX_REPORT_PATHS = 20;

// The `validate` section for shadow-mode detections: '' unless the caller is a brain
// admin and there is something to report. Admin-only because even a path and a kind
// ("wiki/intake.md: us-ssn") says where sensitive data sits. It names kinds and
// counts, never values, since none are stored.
export function detectionSection(role: Role, counts: readonly DetectionCount[]): string {
	if (!roleAtLeast(role, 'admin') || counts.length === 0) return '';
	const byPath = new Map<string, DetectionCount[]>();
	for (const c of counts) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
	const total = (cs: DetectionCount[]) => cs.reduce((n, c) => n + c.count, 0);
	const pages = [...byPath].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]));
	const lines = pages.slice(0, MAX_REPORT_PATHS).map(([path, cs]) => {
		const kinds = [...cs]
			.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
			.map((c) => `${c.count} ${c.kind}`)
			.join(', ');
		return `- ${path}: ${kinds}`;
	});
	const more = pages.length - lines.length;
	if (more > 0) lines.push(`- and ${more} more page(s)`);
	const all = total(counts as DetectionCount[]);
	return (
		`\n\nData-policy guard (shadow mode, shown to admins only): ${all} detection(s) across` +
		` ${pages.length} page(s) in the last ${REPORT_WINDOW_DAYS} days. Recorded as each write` +
		` landed; nothing was blocked, and a page may have changed since. Values are not stored,` +
		` so read the page to review.\n${lines.join('\n')}`
	);
}
