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
import type {
	BrainLocator,
	BrainStore,
	CommitAuthor,
	FileWrite,
	StoreCapabilities
} from './brain-repo.ts';
import type { BrainStorageChoice } from './storage-connections.ts';
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

// Where a brain is moving to.
export interface MoveTarget {
	// Names this destination, connection included. A copy under way toward another one
	// is not continued.
	key: string;
	// Makes the destination ready and says how the brain is bound to it. `token` is what
	// an earlier step of this move returned (a folder made for it), null on the first.
	open(token: string | null): Promise<{
		end: StoreEnd;
		binding: D1PreparedStatement[];
		token?: string;
	}>;
}

interface MoveCounters {
	revision: string;
	target?: string;
	token?: string | null;
	// The brain has been served from a GitHub repository under its own name.
	leftRepository?: boolean;
}

// A row written before moves recorded their target is a move out of a repository.
const leftRepository = (pass: { counters: MoveCounters } | null): boolean =>
	!!pass && (pass.counters.leftRepository ?? pass.counters.target === undefined);

// Why a brain cannot move to `to`, or null when it can. Pure.
export function moveProblem(o: {
	from: BrainStorageChoice;
	to: BrainStorageChoice;
	// What the storage it would move to can do; undefined when this deployment has none.
	destination: StoreCapabilities | undefined;
	writeMode: 'direct' | 'pull-request';
	label: string;
}): string | null {
	const place = {
		isomorphic: 'held by Isomorphic',
		github: 'in a GitHub repository',
		'google-drive': 'kept in Google Drive'
	};
	if (o.from === o.to) return `${o.label} is already ${place[o.to]}. Nothing was changed.`;
	if (!o.destination) {
		return o.to === 'isomorphic'
			? 'This deployment cannot hold a brain itself, so nothing was changed.'
			: `This deployment is not set up to move a brain to storage ${place[o.to]}, so nothing was changed.`;
	}
	// A pull request still open would be left behind, and no later change could be held
	// for review.
	if (o.writeMode === 'pull-request' && !o.destination.proposals) {
		return `${o.label} takes its changes as pull requests, which storage ${place[o.to]} cannot do yet. Nothing was changed.`;
	}
	return null;
}

// One step of moving a brain onto other storage: copy within the budget, keep the place
// in `brain_passes`, and run the target's binding (the statements that bind the brain to
// the new storage) in the same batch as the finished pass once the copy is complete.
// Until then the brain is served from where it was.
export async function relocateBrain(
	db: D1Database,
	scope: { brainId: string; orgId?: string; actorUserId?: string },
	from: StoreEnd,
	target: MoveTarget,
	opts: {
		branch?: string;
		budget?: number;
		author?: CommitAuthor;
		now?: number;
		// The source is the brain's GitHub repository.
		fromRepository?: boolean;
	} = {}
): Promise<CopyStep> {
	const now = opts.now ?? Date.now();
	const defaults: MoveCounters = { revision: '' };
	const existing = await readPass<MoveCounters>(db, scope.brainId, RELOCATION_KIND, defaults);
	const left = leftRepository(existing);
	// A copy toward somewhere else is abandoned where it stands.
	const sameTarget = existing?.counters.target === target.key;
	const pass = continuePass(sameTarget ? existing : null, defaults, () => crypto.randomUUID(), now);
	const opened = await target.open(pass.counters.token ?? null);
	const prior = pass.counters.revision
		? { revision: pass.counters.revision, after: pass.cursor }
		: null;
	const step = await copyStep(from, opened.end, prior, opts);
	await db.batch([
		...(step.done ? opened.binding : []),
		savePassStatement(
			db,
			{ ...scope, kind: RELOCATION_KIND },
			{
				...pass,
				status: step.done ? 'done' : 'running',
				cursor: step.progress.after,
				counters: {
					revision: step.progress.revision,
					target: target.key,
					token: opened.token ?? null,
					leftRepository: left || (step.done && !!opts.fromRepository)
				}
			},
			now
		)
	]);
	return step;
}

// Whether this brain has been served from a GitHub repository under its own name and
// moved out of it. False for a brain created on other storage, whose name on GitHub, if
// a repository holds it, is somebody else's.
export async function cameFromRepository(db: D1Database, brainId: string): Promise<boolean> {
	return leftRepository(
		await readPass<MoveCounters>(db, brainId, RELOCATION_KIND, { revision: '' })
	);
}
