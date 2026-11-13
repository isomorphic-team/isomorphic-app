// Copying a brain's current files from one store into another, a budgeted step per
// call, for moving a brain onto different storage. Runtime-portable (Worker-safe, no
// node:*). pnpm test:store.
//
// The destination is not served while the copy runs, so a half-finished copy is seen by
// nobody. A step reports `done` only when every file of one source revision is in the
// destination, nothing else is, and the source is still at that revision. History is
// not copied.

import type { D1Database } from '@cloudflare/workers-types';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { continuePass, readPass, savePassStatement } from './brain-pass.ts';
import type { BrainLocator, BrainStore, CommitAuthor, FileWrite } from './brain-repo.ts';
import { bytesFromBase64 } from './media.ts';

// brain_passes kind for a relocation's run state (src/lib/brain-pass.ts).
export const RELOCATION_KIND = 'relocation';

// Files read from the source per step. On GitHub a file costs up to two subrequests.
const COPY_FILE_BUDGET = 200;
// Content per destination write, far under the Workers RPC cap.
const COPY_BUNDLE_BYTES = 4 * 1024 * 1024;
const READ_CONCURRENCY = 6;

export interface StoreEnd {
	store: BrainStore;
	locator: BrainLocator;
}

// Where a copy has got to: every file up to and including `after`, in path order, of
// source revision `revision`.
export interface CopyProgress {
	revision: string;
	after: string | null;
}

export interface CopyStep {
	progress: CopyProgress;
	// Files of this revision in the destination so far, of `total`.
	copied: number;
	total: number;
	done: boolean;
	// The source moved, so the copy began again from its new revision.
	restarted: boolean;
}

// A file as the destination should hold it: text when its bytes are UTF-8 that encodes
// back to the same bytes, otherwise the bytes themselves. A NUL counts as bytes: a text
// column may end at one.
export function fileWriteFor(path: string, contentBase64: string): FileWrite {
	try {
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			bytesFromBase64(contentBase64)
		);
		if (!text.includes('\0')) return { path, content: text };
	} catch {
		// Not UTF-8.
	}
	return { path, content: contentBase64, encoding: 'base64' };
}

export async function copyStep(
	from: StoreEnd,
	to: StoreEnd,
	prior: CopyProgress | null,
	opts: { branch?: string; budget?: number; author?: CommitAuthor } = {}
): Promise<CopyStep> {
	const rev = await from.store.getRevision(from.locator, opts.branch);
	const restarted = prior !== null && prior.revision !== rev.id;
	const progress: CopyProgress =
		prior && !restarted ? { ...prior } : { revision: rev.id, after: null };

	const paths = (await from.store.listTree(from.locator, rev, { extension: '*' }))
		.map((e) => e.path)
		.sort();
	const total = paths.length;
	const after = progress.after;
	const start = after === null ? 0 : paths.findLastIndex((p) => p <= after) + 1;
	const end = Math.min(total, start + (opts.budget ?? COPY_FILE_BUDGET));

	// Read a few files at a time and write each bundle as it fills, so a step holds one
	// bundle and not its whole budget.
	let bundle: FileWrite[] = [];
	let bytes = 0;
	const flush = async () => {
		if (bundle.length === 0) return;
		await to.store.write(to.locator, {
			message: `Copy ${bundle.length} file${bundle.length === 1 ? '' : 's'} in`,
			writes: bundle,
			author: opts.author
		});
		progress.after = bundle[bundle.length - 1].path;
		bundle = [];
		bytes = 0;
	};
	for (let i = start; i < end; i += READ_CONCURRENCY) {
		const files = await Promise.all(
			paths.slice(i, Math.min(end, i + READ_CONCURRENCY)).map(async (path) => {
				const file = await from.store.readBinary(from.locator, path, rev.id);
				if (!file) throw new Error(`${path} is listed in the source and could not be read.`);
				return fileWriteFor(path, file.contentBase64);
			})
		);
		for (const file of files) {
			if (bundle.length > 0 && bytes + file.content.length > COPY_BUNDLE_BYTES) await flush();
			bundle.push(file);
			bytes += file.content.length;
		}
	}
	await flush();

	if (end < total) return { progress, copied: end, total, done: false, restarted };

	// Everything is across. The copy counts only if the source did not move meanwhile.
	const [held, head] = await Promise.all([
		to.store
			.getRevision(to.locator)
			.then((at) => to.store.listTree(to.locator, at, { extension: '*' })),
		from.store.branchRevision(from.locator, rev.branch)
	]);
	if (head !== rev.id) {
		return {
			progress: { revision: head, after: null },
			copied: 0,
			total,
			done: false,
			restarted: true
		};
	}
	// Drop what the destination holds that the source does not: an earlier copy of a
	// file since deleted.
	const wanted = new Set(paths);
	const extra = held.map((e) => e.path).filter((p) => !wanted.has(p));
	if (extra.length > 0) {
		await to.store.write(to.locator, {
			message: `Remove ${extra.length} file${extra.length === 1 ? '' : 's'} the source no longer has`,
			deletes: extra,
			author: opts.author
		});
	}
	return { progress, copied: total, total, done: true, restarted };
}

// One step of moving a brain onto other storage: copy within the budget, keep the place
// in `brain_passes`, and run `binding` (the statements that bind the brain to the new
// storage) in the same batch as the finished pass once the copy is complete. Until then
// the brain is served from where it was.
export async function relocateBrain(
	db: D1Database,
	scope: { brainId: string; orgId?: string; actorUserId?: string },
	from: StoreEnd,
	to: StoreEnd,
	binding: D1PreparedStatement[],
	opts: { branch?: string; budget?: number; author?: CommitAuthor; now?: number } = {}
): Promise<CopyStep> {
	const now = opts.now ?? Date.now();
	const defaults = { revision: '' };
	const pass = continuePass(
		await readPass(db, scope.brainId, RELOCATION_KIND, defaults),
		defaults,
		() => crypto.randomUUID(),
		now
	);
	const prior = pass.counters.revision
		? { revision: pass.counters.revision, after: pass.cursor }
		: null;
	const step = await copyStep(from, to, prior, opts);
	await db.batch([
		...(step.done ? binding : []),
		savePassStatement(
			db,
			{ ...scope, kind: RELOCATION_KIND },
			{
				...pass,
				status: step.done ? 'done' : 'running',
				cursor: step.progress.after,
				counters: { revision: step.progress.revision }
			},
			now
		)
	]);
	return step;
}
