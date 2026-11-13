// The write coordinator: how a bundle lands on a backend that writes one file at a time.
// Runtime-portable (Worker-safe, no node:*). pnpm test:coordinator.
//
// A store without `capabilities.atomicWrite` sends every write() through here. Per brain,
// the coordinator runs one bundle at a time, journals it before touching a file, and on
// failure rolls the files it wrote back to their recorded prior content. A bundle
// interrupted outright (the process died) is found in the journal by the next call to
// that brain, which completes it or, if a file has since been changed by someone else,
// rolls it back.
//
// The journal records content, not progress: recovery reads every file and compares it
// with the prior and intended content, so it is correct wherever the interruption fell,
// including during a rollback.
//
// Two implementations run the same landBundle inside a serialized() lane:
// inMemoryWriteCoordinator, for tests and the local runtime, and the coordinator Durable
// Object (src/objects/worker.ts, one per brain, journaling with sqlJournal), which the
// deployed Worker reaches through objectWriteCoordinator. pnpm test:objects runs the
// object in workerd.

import { WriteConflictError, type FileWrite, type WriteOpts } from './brain-repo.ts';

type Encoding = NonNullable<FileWrite['encoding']>;
type FileBody = Omit<FileWrite, 'path'>;

// The per-file operations a non-atomic backend provides. `ifVersion` is the version the
// file must still be at (null: the file must not exist); a backend that can enforce it
// throws WriteConflictError when it does not hold. One that cannot ignores it, and the
// coordinator's own check just before is the only guard.
//
// Pass a plain object, not a class instance: it crosses Workers RPC to the coordinator
// object, where its functions become stubs that call back into the caller.
export interface FileBackend {
	// Which files this backend reaches (for example a drive and folder id). A journal entry
	// is only settled through a backend reaching the same storage.
	readonly storage: string;
	read(path: string, encoding: Encoding): Promise<{ content: string; version: string } | null>;
	// Returns the file's new version tag.
	put(path: string, file: FileBody, ifVersion: string | null): Promise<string>;
	remove(path: string, ifVersion: string): Promise<void>;
}

export interface CoordinatedWrite extends Pick<WriteOpts, 'message' | 'writes' | 'deletes'> {
	// Per path, the version the caller read the file at (null: it did not exist). A path
	// left out is checked against what the coordinator reads when the bundle starts.
	expected?: Record<string, string | null>;
}

// One file of a journaled bundle. `intended` null is a delete; `prior` null means the
// file did not exist before the bundle.
export interface JournalStep {
	path: string;
	intended: FileBody | null;
	prior: { content: string; encoding: Encoding } | null;
}

export interface JournalEntry {
	storage: string;
	message: string;
	steps: JournalStep[];
}

// Where one brain's open bundle is recorded. At most one at a time, since the lane
// serializes the brain's writes.
export interface WriteJournal {
	read(): Promise<JournalEntry | null>;
	open(entry: JournalEntry): Promise<void>;
	close(): Promise<void>;
}

// What the call did with an interrupted bundle it found before its own.
export interface Recovery {
	message: string;
	outcome: 'completed' | 'rolled-back';
	// Files left as someone else changed them, neither completed nor restored.
	untouched: string[];
}

export interface CoordinatedResult {
	versions: Record<string, string>;
	recovered?: Recovery;
}

export interface WriteCoordinator {
	write(brainId: string, files: FileBackend, bundle: CoordinatedWrite): Promise<CoordinatedResult>;
}

// Runs the tasks handed to it one after another, in call order. A failed task does not
// stop the ones queued behind it.
export function serialized(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(task, task);
		tail = run.catch(() => undefined);
		return run;
	};
}

// The steps of a bundle, writes before deletes: a move interrupted between them leaves
// the page in both places rather than in neither.
type PlannedStep = Omit<JournalStep, 'prior'>;

function stepsOf(bundle: CoordinatedWrite): PlannedStep[] {
	const steps: PlannedStep[] = [
		...(bundle.writes ?? []).map(({ path, ...file }) => ({ path, intended: file })),
		...(bundle.deletes ?? []).map((path) => ({ path, intended: null }))
	];
	const seen = new Set<string>();
	for (const s of steps) {
		if (seen.has(s.path)) throw new Error(`A write names ${s.path} more than once.`);
		seen.add(s.path);
	}
	return steps;
}

const encodingOf = (step: PlannedStep): Encoding =>
	step.intended?.encoding ?? (step.intended ? 'utf-8' : 'base64');

// Writes one step and returns the new version, or null for a delete.
async function apply(
	files: FileBackend,
	step: JournalStep,
	ifVersion: string | null
): Promise<string | null> {
	if (step.intended) return files.put(step.path, step.intended, ifVersion);
	if (ifVersion !== null) await files.remove(step.path, ifVersion);
	return null;
}

// Puts one applied step's file back as it was. `current` is the version the file is at
// now (null: absent). Returns false when the file changed under it, which leaves it be.
async function restore(
	files: FileBackend,
	step: JournalStep,
	current: string | null
): Promise<boolean> {
	try {
		if (step.prior) await files.put(step.path, step.prior, current);
		else if (current !== null) await files.remove(step.path, current);
		return true;
	} catch (e) {
		if (e instanceof WriteConflictError) return false;
		throw e;
	}
}

type Applied = { step: JournalStep; version: string | null };

// Rolls back the applied steps, newest first. Throws if the backend fails, which keeps
// the journal for the next call.
async function rollBack(files: FileBackend, applied: Applied[]): Promise<string[]> {
	const untouched: string[] = [];
	for (const { step, version } of [...applied].reverse()) {
		if (!(await restore(files, step, version))) untouched.push(step.path);
	}
	return untouched;
}

// Lands one bundle; recoverJournal has run.
async function coordinateWrite(
	journal: WriteJournal,
	files: FileBackend,
	bundle: CoordinatedWrite
): Promise<Record<string, string>> {
	const planned = stepsOf(bundle);
	const current = await Promise.all(planned.map((s) => files.read(s.path, encodingOf(s))));
	const at = current.map((f) => f?.version ?? null);
	const steps: JournalStep[] = planned.map((s, i) => {
		const expected = bundle.expected?.[s.path];
		if (expected !== undefined && at[i] !== expected) throw new WriteConflictError(s.path);
		const was = current[i];
		return { ...s, prior: was ? { content: was.content, encoding: encodingOf(s) } : null };
	});
	await journal.open({ storage: files.storage, message: bundle.message, steps });

	const applied: Applied[] = [];
	const versions: Record<string, string> = {};
	try {
		for (const [i, step] of steps.entries()) {
			const version = await apply(files, step, at[i]);
			applied.push({ step, version });
			if (version !== null) versions[step.path] = version;
		}
	} catch (e) {
		try {
			await rollBack(files, applied);
			await journal.close();
		} catch {
			// The backend failed again: the journal stays, and the next call settles it.
		}
		throw e;
	}
	await journal.close();
	return versions;
}

const holds = (file: { content: string } | null, want: { content: string } | null): boolean =>
	file === null ? want === null : want !== null && file.content === want.content;

// Settles a bundle an earlier call left in the journal. Completes it when every file it
// has not reached is still as it was; otherwise rolls back the files it reached.
export async function recoverJournal(
	journal: WriteJournal,
	files: FileBackend
): Promise<Recovery | undefined> {
	const entry = await journal.read();
	if (!entry) return undefined;
	if (entry.storage !== files.storage) {
		throw new Error(
			`An interrupted write to this brain ("${entry.message}") is recorded against ${entry.storage}, not ${files.storage}. Settle it there before writing here.`
		);
	}
	const found = await Promise.all(entry.steps.map((s) => files.read(s.path, encodingOf(s))));
	const states = entry.steps.map((s, i) =>
		holds(found[i], s.intended) ? 'applied' : holds(found[i], s.prior) ? 'pending' : 'foreign'
	);
	const reached: Applied[] = entry.steps
		.map((step, i) => ({ step, version: found[i]?.version ?? null }))
		.filter((_, i) => states[i] === 'applied');
	const foreign = entry.steps.filter((_, i) => states[i] === 'foreign').map((s) => s.path);

	if (foreign.length === 0) {
		try {
			for (const [i, step] of entry.steps.entries()) {
				if (states[i] !== 'pending') continue;
				reached.push({ step, version: await apply(files, step, found[i]?.version ?? null) });
			}
			await journal.close();
			return { message: entry.message, outcome: 'completed', untouched: [] };
		} catch (e) {
			if (!(e instanceof WriteConflictError)) throw e;
			foreign.push(e.path);
		}
	}
	const untouched = [...foreign, ...(await rollBack(files, reached))];
	await journal.close();
	return { message: entry.message, outcome: 'rolled-back', untouched };
}

// Settles any bundle an earlier call left, then lands this one. The caller holds the
// brain's lane.
export async function landBundle(
	journal: WriteJournal,
	files: FileBackend,
	bundle: CoordinatedWrite
): Promise<CoordinatedResult> {
	const recovered = await recoverJournal(journal, files);
	return { versions: await coordinateWrite(journal, files, bundle), recovered };
}

// Copies the entry's structure, not its content: strings are immutable.
const copyEntry = (e: JournalEntry): JournalEntry => ({
	...e,
	steps: e.steps.map((s) => ({ ...s }))
});

export function memoryJournal(): WriteJournal & { entry: JournalEntry | null } {
	return {
		entry: null,
		async read() {
			return this.entry ? copyEntry(this.entry) : null;
		},
		async open(entry) {
			this.entry = copyEntry(entry);
		},
		async close() {
			this.entry = null;
		}
	};
}

// One lane and journal per brain, held in this process. The journal does not survive a
// restart, which is enough for tests and for the local runtime.
export function inMemoryWriteCoordinator(
	journalFor: (brainId: string) => WriteJournal = () => memoryJournal()
): WriteCoordinator {
	const brains = new Map<string, { lane: ReturnType<typeof serialized>; journal: WriteJournal }>();
	return {
		write(brainId, files, bundle) {
			let brain = brains.get(brainId);
			if (!brain) {
				brain = { lane: serialized(), journal: journalFor(brainId) };
				brains.set(brainId, brain);
			}
			const { lane, journal } = brain;
			return lane(() => landBundle(journal, files, bundle));
		}
	};
}

// The SQL a journal is kept in: a Durable Object's `ctx.storage.sql`, or node:sqlite in
// the tests.
export interface SqlRunner {
	exec(query: string, ...bindings: (string | number | null)[]): { toArray(): unknown[] };
}

// A Durable Object caps one string or row at 8 MB. The journal is stored one row per chunk
// of this many UTF-16 units, at most 6 MB as UTF-8, so an entry holding attachments fits.
const CHUNK_UNITS = 2_000_000;

// Splits `s` into pieces of at most `size` units, never between the halves of a surrogate
// pair: a lone half does not survive being stored as text.
export function chunked(s: string, size: number): string[] {
	const out: string[] = [];
	for (let at = 0; at < s.length;) {
		let end = Math.min(at + size, s.length);
		const last = s.charCodeAt(end - 1);
		if (end < s.length && end - at > 1 && last >= 0xd800 && last <= 0xdbff) end--;
		out.push(s.slice(at, end));
		at = end;
	}
	return out;
}

// The journal in one SQL table: the entry as JSON, in chunks. In a Durable Object the
// statements of open() and close() run with no await between them, so each commits as one
// transaction.
export function sqlJournal(sql: SqlRunner, chunkUnits = CHUNK_UNITS): WriteJournal {
	sql.exec('CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)');
	return {
		async read() {
			const rows = sql.exec('SELECT data FROM journal ORDER BY seq').toArray() as {
				data: string;
			}[];
			return rows.length ? (JSON.parse(rows.map((r) => r.data).join('')) as JournalEntry) : null;
		},
		async open(entry) {
			sql.exec('DELETE FROM journal');
			for (const [seq, data] of chunked(JSON.stringify(entry), chunkUnits).entries()) {
				sql.exec('INSERT INTO journal (seq, data) VALUES (?, ?)', seq, data);
			}
		},
		async close() {
			sql.exec('DELETE FROM journal');
		}
	};
}

// Across Workers RPC a thrown error arrives as a plain Error that keeps its `name` and own
// properties but not its class. Both ends of the coordinator object's calls rebuild a
// WriteConflictError from that, so the coordinator itself tests with instanceof.
function conflictsRebuilt<A extends unknown[], R>(
	call: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
	return async (...args) => {
		try {
			return await call(...args);
		} catch (e) {
			const path = (e as { path?: unknown }).path;
			if (e instanceof Error && e.name === 'WriteConflictError' && typeof path === 'string') {
				throw new WriteConflictError(path);
			}
			throw e;
		}
	};
}

// The FileBackend the coordinator object receives: the caller's, as RPC stubs.
export function backendFromRpc(files: FileBackend): FileBackend {
	return {
		storage: files.storage,
		read: (path, encoding) => files.read(path, encoding),
		put: conflictsRebuilt((path, file, ifVersion) => files.put(path, file, ifVersion)),
		remove: conflictsRebuilt((path, ifVersion) => files.remove(path, ifVersion))
	};
}

// The coordinator object's RPC surface (src/objects/worker.ts).
export interface CoordinatorObject {
	land(files: FileBackend, bundle: CoordinatedWrite): Promise<CoordinatedResult>;
}

// The coordinator as the Worker reaches it: one object per brain serializes and journals,
// while every read and write of a file runs here, called back through the backend's stubs.
export function objectWriteCoordinator(
	objectFor: (brainId: string) => CoordinatorObject
): WriteCoordinator {
	return {
		write: conflictsRebuilt((brainId, files, bundle) => objectFor(brainId).land(files, bundle))
	};
}
