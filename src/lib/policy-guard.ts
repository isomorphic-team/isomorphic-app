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
import { detectSensitive, type Detection } from './policy-detectors.ts';

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
