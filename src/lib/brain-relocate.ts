// Copying a brain's current files from one store into another, a budgeted step per
// call, for moving a brain onto different storage. Runtime-portable (Worker-safe, no
// node:*). pnpm test:store.
//
// The destination is not served while the copy runs, so a half-finished copy is seen by
// nobody. A step reports `done` only when every file of one source revision is in the
// destination, nothing else is, and the source is still at that revision. History is
// not copied.

import type { D1Database } from '@cloudflare/workers-types';
import { continuePass, readPass, savePass } from './brain-pass.ts';
import type { BrainLocator, BrainStore, CommitAuthor, FileWrite } from './brain-repo.ts';
import { base64FromBytes } from './media.ts';
import { bindBrainToPlatformFiles } from './storage-connections.ts';

// brain_passes kind for a relocation's run state (src/lib/brain-pass.ts).
export const RELOCATION_KIND = 'relocation';

// Files read from the source per step. On GitHub a file costs up to two subrequests.
export const COPY_FILE_BUDGET = 200;
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
	copied: number;
}

export interface CopyStep {
	progress: CopyProgress;
	total: number;
	done: boolean;
	// The source moved, so this step began the copy again from its new revision.
	restarted: boolean;
}

function bytesOf(base64: string): Uint8Array {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

// A file as the destination should hold it: text when its bytes are UTF-8 that encodes
// back to the same bytes, otherwise the bytes themselves. A NUL counts as bytes: a text
// column may end at one.
export function fileWriteFor(path: string, contentBase64: string): FileWrite {
	const bytes = bytesOf(contentBase64);
	try {
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		if (!text.includes('\0')) return { path, content: text };
	} catch {
		// Not UTF-8.
	}
	return { path, content: base64FromBytes(bytes), encoding: 'base64' };
}

async function inOrder<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
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
		prior && !restarted ? { ...prior } : { revision: rev.id, after: null, copied: 0 };

	const paths = (await from.store.listTree(from.locator, rev, { extension: '*' }))
		.map((e) => e.path)
		.sort();
	const after = progress.after;
	const left = after === null ? paths : paths.filter((p) => p > after);
	const batch = left.slice(0, opts.budget ?? COPY_FILE_BUDGET);

	const files = await inOrder(batch, READ_CONCURRENCY, async (path) => {
		const file = await from.store.readBinary(from.locator, path, rev.id);
		if (!file) throw new Error(`${path} is listed in the source and could not be read.`);
		return fileWriteFor(path, file.contentBase64);
	});

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
		progress.copied += bundle.length;
		bundle = [];
		bytes = 0;
	};
	for (const file of files) {
		if (bundle.length > 0 && bytes + file.content.length > COPY_BUNDLE_BYTES) await flush();
		bundle.push(file);
		bytes += file.content.length;
	}
	await flush();

	if (batch.length < left.length) return { progress, total: paths.length, done: false, restarted };

	// Everything is across. Drop what the destination holds that the source does not (an
	// earlier copy of a file since deleted), then confirm the source did not move.
	const wanted = new Set(paths);
	const held = await to.store.listTree(to.locator, await to.store.getRevision(to.locator), {
		extension: '*'
	});
	const extra = held.map((e) => e.path).filter((p) => !wanted.has(p));
	if (extra.length > 0) {
		await to.store.write(to.locator, {
			message: `Remove ${extra.length} file${extra.length === 1 ? '' : 's'} the source no longer has`,
			deletes: extra,
			author: opts.author
		});
	}
	const head = await from.store.branchRevision(from.locator, rev.branch);
	if (head !== rev.id) {
		return {
			progress: { revision: head, after: null, copied: 0 },
			total: paths.length,
			done: false,
			restarted: true
		};
	}
	return { progress, total: paths.length, done: true, restarted };
}

// One step of moving a brain onto the platform's own files: copy within the budget, keep
// the place in `brain_passes`, and bind the brain to the new storage once the copy is
// complete. Until then the brain is served from where it was.
export async function relocateToPlatformFiles(
	db: D1Database,
	scope: { brainId: string; orgId?: string; actorUserId?: string },
	from: StoreEnd,
	to: StoreEnd,
	opts: { branch?: string; budget?: number; author?: CommitAuthor; now?: number } = {}
): Promise<CopyStep> {
	const now = opts.now ?? Date.now();
	const defaults = { revision: '', copied: 0 };
	const pass = continuePass(
		await readPass(db, scope.brainId, RELOCATION_KIND, defaults),
		defaults,
		() => crypto.randomUUID(),
		now
	);
	const prior: CopyProgress | null = pass.counters.revision
		? { revision: pass.counters.revision, after: pass.cursor, copied: pass.counters.copied }
		: null;
	const step = await copyStep(from, to, prior, opts);
	if (step.done) await bindBrainToPlatformFiles(db, scope.brainId);
	await savePass(
		db,
		{ ...scope, kind: RELOCATION_KIND },
		{
			...pass,
			status: step.done ? 'done' : 'running',
			cursor: step.progress.after,
			counters: { revision: step.progress.revision, copied: step.progress.copied }
		},
		now
	);
	return step;
}
