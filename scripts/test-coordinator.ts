// The write coordinator (src/lib/write-coordinator.ts) over an in-memory per-file backend.
// Offline.
//
//   pnpm test:coordinator
//
// What it exists to catch:
//   1. INTERLEAVED BUNDLES. Two writes to one brain never interleave their files; writes
//      to different brains do not wait on each other; a failed write does not stall the
//      brain's queue.
//   2. A HALF-APPLIED BUNDLE AFTER A FAILURE. A write that fails partway puts every file it
//      wrote back as it was (created files removed, deleted files restored, bytes exact),
//      and closes its journal.
//   3. A HALF-APPLIED BUNDLE AFTER AN INTERRUPTION. When the rollback itself cannot run,
//      the journal survives, and the next call to the brain completes the bundle, or rolls
//      it back when someone else has since changed one of its files, leaving that file
//      as they left it.
//   4. A WRITE OVER SOMEONE ELSE'S CHANGE. A file not at the version the caller read is a
//      conflict before anything is written, and a backend's own precondition failure
//      mid-bundle rolls back.

import { WriteConflictError } from '../src/lib/brain-repo.ts';
import {
	inMemoryWriteCoordinator,
	memoryJournal,
	recoverJournal,
	type FileBackend
} from '../src/lib/write-coordinator.ts';
import { checker, errorOf } from './check.ts';

const { check, done } = checker('coordinator checks');

// A drive that writes one file at a time. Versions are a counter, as an eTag would be.
function fakeDrive(initial: Record<string, string | Buffer> = {}) {
	const files = new Map<string, { bytes: Buffer; version: string }>();
	let n = 0;
	const set = (path: string, bytes: Buffer): string => {
		const version = `v${++n}`;
		files.set(path, { bytes, version });
		return version;
	};
	for (const [p, c] of Object.entries(initial)) set(p, Buffer.from(c));
	// Every put and remove: recorded, then the test's hook, then the outage check.
	const enter = async (op: string, path: string): Promise<void> => {
		drive.calls.push(`${op} ${path}`);
		await drive.before(op, path);
		if (drive.down) throw new Error('drive unavailable');
	};
	const drive = {
		files,
		calls: [] as string[],
		down: false,
		// Runs before each put or remove, after the call is recorded.
		before: async (_op: string, _path: string): Promise<void> => {},
		text: (path: string): string | undefined => files.get(path)?.bytes.toString('utf-8'),
		// An edit from outside Isomorphic.
		edit: (path: string, content: string | Buffer): string => set(path, Buffer.from(content)),
		backend: {
			async read(path, encoding) {
				if (drive.down) throw new Error('drive unavailable');
				const f = files.get(path);
				if (!f) return null;
				return {
					content: f.bytes.toString(encoding === 'base64' ? 'base64' : 'utf-8'),
					version: f.version
				};
			},
			async put(path, file, ifVersion) {
				await enter('put', path);
				if ((files.get(path)?.version ?? null) !== ifVersion) throw new WriteConflictError(path);
				return set(
					path,
					Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf-8')
				);
			},
			async remove(path, ifVersion) {
				await enter('remove', path);
				if (files.get(path)?.version !== ifVersion) throw new WriteConflictError(path);
				files.delete(path);
			}
		} satisfies FileBackend
	};
	return drive;
}

const gate = () => {
	let open!: () => void;
	const opened = new Promise<void>((r) => (open = r));
	return { open, opened };
};

// ---------- 1. one bundle at a time ----------
{
	const drive = fakeDrive();
	const coord = inMemoryWriteCoordinator();
	const hold = gate();
	drive.before = async (_op, path) => {
		if (path === 'a1.md') await hold.opened;
	};
	const first = coord.write('brain-1', drive.backend, {
		message: 'first',
		writes: [
			{ path: 'a1.md', content: 'a1' },
			{ path: 'a2.md', content: 'a2' }
		]
	});
	const second = coord.write('brain-1', drive.backend, {
		message: 'second',
		writes: [{ path: 'b1.md', content: 'b1' }]
	});
	const other = fakeDrive();
	const elsewhere = await coord.write('brain-2', other.backend, {
		message: 'other brain',
		writes: [{ path: 'c.md', content: 'c' }]
	});
	check('a write to another brain does not wait on a held one', 'c.md' in elsewhere.versions);
	check(
		'the queued write has not started',
		!drive.calls.includes('put b1.md'),
		drive.calls.join(', ')
	);
	hold.open();
	await Promise.all([first, second]);
	check(
		'the second bundle starts after the first finishes',
		drive.calls.join(', ') === 'put a1.md, put a2.md, put b1.md',
		drive.calls.join(', ')
	);
}

{
	const drive = fakeDrive();
	const coord = inMemoryWriteCoordinator();
	drive.down = true;
	const failed = coord.write('brain-1', drive.backend, {
		message: 'fails',
		writes: [{ path: 'x.md', content: 'x' }]
	});
	const queued = coord.write('brain-1', fakeDrive().backend, {
		message: 'after',
		writes: [{ path: 'y.md', content: 'y' }]
	});
	check('the failing write rejects', (await errorOf(() => failed)) === 'drive unavailable');
	check('the write queued behind it still runs', 'y.md' in (await queued).versions);
}

// ---------- the bundle lands ----------
{
	const drive = fakeDrive({ 'old.md': 'old' });
	const coord = inMemoryWriteCoordinator();
	const res = await coord.write('b', drive.backend, {
		message: 'move',
		writes: [{ path: 'new.md', content: 'moved' }],
		deletes: ['old.md']
	});
	check(
		'the write lands and the delete removes',
		drive.text('new.md') === 'moved' && !drive.files.has('old.md')
	);
	check(
		'writes go before deletes',
		drive.calls.join(', ') === 'put new.md, remove old.md',
		drive.calls.join(', ')
	);
	check(
		'each written file reports the version the backend gave it',
		res.versions['new.md'] === drive.files.get('new.md')?.version && !('old.md' in res.versions)
	);
	check('a clean write reports no recovery', res.recovered === undefined);
}

{
	const drive = fakeDrive({ 'a.md': 'a' });
	const coord = inMemoryWriteCoordinator();
	const err = await errorOf(() =>
		coord.write('b', drive.backend, {
			message: 'dup',
			writes: [{ path: 'a.md', content: 'x' }],
			deletes: ['a.md']
		})
	);
	check(
		'a bundle naming a path twice is refused',
		err?.includes('more than once') === true,
		String(err)
	);
	check('and nothing is written', drive.calls.length === 0 && drive.text('a.md') === 'a');
}

// ---------- 4. conflicts ----------
{
	const drive = fakeDrive({ 'a.md': 'a' });
	const journal = memoryJournal();
	const coord = inMemoryWriteCoordinator(() => journal);
	const readAt = drive.files.get('a.md')!.version;
	drive.edit('a.md', 'edited elsewhere');
	let err: unknown;
	await coord
		.write('b', drive.backend, {
			message: 'stale',
			writes: [
				{ path: 'z.md', content: 'z' },
				{ path: 'a.md', content: 'mine' }
			],
			expected: { 'a.md': readAt }
		})
		.catch((e) => (err = e));
	check(
		'a file changed since it was read is a conflict',
		err instanceof WriteConflictError && err.path === 'a.md'
	);
	check('found before anything is written', drive.calls.length === 0 && !drive.files.has('z.md'));
	check('and no journal is left', journal.entry === null);

	const err2 = await errorOf(() =>
		coord.write('b', drive.backend, {
			message: 'create over',
			writes: [{ path: 'a.md', content: 'mine' }],
			expected: { 'a.md': null }
		})
	);
	check(
		'creating a file that now exists is a conflict',
		err2?.includes('changed since') === true,
		String(err2)
	);
}

{
	const drive = fakeDrive({ 'a.md': 'a', 'b.md': 'b' });
	const journal = memoryJournal();
	const coord = inMemoryWriteCoordinator(() => journal);
	drive.before = async (_op, path) => {
		if (path === 'a.md') drive.edit('b.md', 'edited mid-bundle');
	};
	let err: unknown;
	await coord
		.write('b', drive.backend, {
			message: 'raced',
			writes: [
				{ path: 'new.md', content: 'n' },
				{ path: 'a.md', content: 'A' },
				{ path: 'b.md', content: 'B' }
			]
		})
		.catch((e) => (err = e));
	check(
		'a precondition failure mid-bundle surfaces as a conflict',
		err instanceof WriteConflictError
	);
	check(
		'the files written before it are put back',
		drive.text('a.md') === 'a' && !drive.files.has('new.md'),
		`a=${drive.text('a.md')} new=${drive.text('new.md')}`
	);
	check("the other writer's change is kept", drive.text('b.md') === 'edited mid-bundle');
	check('the journal is closed', journal.entry === null);
}

// ---------- 2. failure rolls back ----------
{
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
	const drive = fakeDrive({ 'a.md': 'a', 'img.png': png, 'gone.md': 'gone' });
	const journal = memoryJournal();
	const coord = inMemoryWriteCoordinator(() => journal);
	drive.before = async (op, path) => {
		if (op === 'remove' && path === 'gone.md') throw new Error('drive refused');
	};
	const err = await errorOf(() =>
		coord.write('b', drive.backend, {
			message: 'fails late',
			writes: [
				{ path: 'a.md', content: 'A' },
				{ path: 'img.png', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' },
				{ path: 'created.md', content: 'c' }
			],
			deletes: ['gone.md']
		})
	);
	check("the backend's error reaches the caller", err === 'drive refused', String(err));
	check('a text file is restored', drive.text('a.md') === 'a');
	check(
		'a binary file is restored byte for byte',
		drive.files.get('img.png')?.bytes.equals(png) === true
	);
	check('a created file is removed', !drive.files.has('created.md'));
	check('the file it failed on is untouched', drive.text('gone.md') === 'gone');
	check('the journal is closed', journal.entry === null);
}

{
	const png = Buffer.from([0xff, 0x00, 0xfe]);
	const drive = fakeDrive({ 'img.png': png, 'b.md': 'b' });
	const coord = inMemoryWriteCoordinator();
	drive.before = async (op, path) => {
		if (op === 'put' && path === 'b.md') throw new Error('drive refused');
	};
	await errorOf(() =>
		coord.write('b', drive.backend, {
			message: 'delete binary then fail',
			writes: [{ path: 'b.md', content: 'B' }],
			deletes: ['img.png']
		})
	);
	check(
		'nothing was deleted when the write before it failed',
		drive.files.get('img.png')?.bytes.equals(png) === true
	);
}

{
	const png = Buffer.from([0xff, 0x00, 0xfe]);
	const drive = fakeDrive({ 'img.png': png, 'b.md': 'b' });
	const coord = inMemoryWriteCoordinator();
	drive.before = async (op) => {
		if (op === 'remove' && drive.calls.filter((c) => c.startsWith('remove')).length === 2)
			throw new Error('drive refused');
	};
	await errorOf(() =>
		coord.write('b', drive.backend, {
			message: 'two deletes, second fails',
			deletes: ['img.png', 'b.md']
		})
	);
	check(
		'a deleted binary file is restored byte for byte',
		drive.files.get('img.png')?.bytes.equals(png) === true
	);
	check('the second file is still there', drive.text('b.md') === 'b');
}

{
	const drive = fakeDrive({ 'a.md': 'a', 'b.md': 'b' });
	const journal = memoryJournal();
	const coord = inMemoryWriteCoordinator(() => journal);
	drive.before = async (op, path) => {
		if (path === 'b.md') {
			drive.edit('a.md', 'edited after ours');
			throw new Error('drive refused');
		}
	};
	const err = await errorOf(() =>
		coord.write('b', drive.backend, {
			message: 'rollback meets an edit',
			writes: [
				{ path: 'a.md', content: 'A' },
				{ path: 'b.md', content: 'B' }
			]
		})
	);
	check(
		'a rollback that meets a newer edit still reports the original error',
		err === 'drive refused',
		String(err)
	);
	check('and leaves the newer edit in place', drive.text('a.md') === 'edited after ours');
	check('and closes the journal', journal.entry === null);
}

// ---------- 3. interrupted bundles ----------
// The drive goes down after the first file lands, so the rollback cannot run either:
// what a process dying mid-bundle leaves behind.
async function interrupted() {
	const drive = fakeDrive({ 'a.md': 'a', 'b.md': 'b', 'wiki/log.md': 'log\n' });
	const journal = memoryJournal();
	drive.before = async () => {
		if (drive.calls.length === 2) drive.down = true;
	};
	const err = await errorOf(() =>
		inMemoryWriteCoordinator(() => journal).write('b', drive.backend, {
			message: 'Edit a and b',
			writes: [
				{ path: 'a.md', content: 'A' },
				{ path: 'b.md', content: 'B' },
				{ path: 'wiki/log.md', content: 'log\n- edit\n' }
			]
		})
	);
	drive.down = false;
	drive.before = async () => {};
	drive.calls.length = 0;
	return { drive, journal, err };
}

{
	const { drive, journal, err } = await interrupted();
	check('the interrupted write rejects', err === 'drive unavailable', String(err));
	check('it leaves one file written', drive.text('a.md') === 'A' && drive.text('b.md') === 'b');
	check('and its journal open', journal.entry?.message === 'Edit a and b');

	// A restart: a new coordinator over the same journal.
	const res = await inMemoryWriteCoordinator(() => journal).write('b', drive.backend, {
		message: 'next',
		writes: [{ path: 'c.md', content: 'c' }]
	});
	check(
		'the next call completes the interrupted bundle',
		drive.text('b.md') === 'B' && drive.text('wiki/log.md') === 'log\n- edit\n'
	);
	check(
		'without rewriting the file that already landed',
		!drive.calls.includes('put a.md'),
		drive.calls.join(', ')
	);
	check(
		'and reports it',
		res.recovered?.outcome === 'completed' &&
			res.recovered.message === 'Edit a and b' &&
			res.recovered.untouched.length === 0
	);
	check('then lands its own write', drive.text('c.md') === 'c' && 'c.md' in res.versions);
	check('the journal is closed', journal.entry === null);
}

{
	const { drive, journal } = await interrupted();
	drive.edit('b.md', 'edited elsewhere');
	const recovered = await recoverJournal(journal, drive.backend);
	check(
		'a file changed since the interruption means a rollback',
		recovered?.outcome === 'rolled-back'
	);
	check('the file the bundle wrote is restored', drive.text('a.md') === 'a');
	check(
		"the other writer's file is left as they left it",
		drive.text('b.md') === 'edited elsewhere'
	);
	check('and is named', recovered?.untouched.join() === 'b.md', recovered?.untouched.join());
	check(
		'the untouched log is not rewritten',
		drive.text('wiki/log.md') === 'log\n' && !drive.calls.includes('put wiki/log.md')
	);
	check('the journal is closed', journal.entry === null);
}

{
	const { drive, journal } = await interrupted();
	drive.edit('a.md', 'edited after ours');
	const recovered = await recoverJournal(journal, drive.backend);
	check(
		'a landed file someone has since edited is not rolled back over',
		recovered?.outcome === 'rolled-back' && drive.text('a.md') === 'edited after ours'
	);
}

{
	// Interrupted during its rollback: a.md restored, b.md still written, c.md never reached.
	const drive = fakeDrive({ 'a.md': 'a', 'b.md': 'B', 'c.md': 'c' });
	const journal = memoryJournal();
	await journal.open({
		message: 'half rolled back',
		steps: [
			{ path: 'a.md', intended: { content: 'A' }, prior: { content: 'a', encoding: 'utf-8' } },
			{ path: 'b.md', intended: { content: 'B' }, prior: { content: 'b', encoding: 'utf-8' } },
			{ path: 'c.md', intended: { content: 'C' }, prior: { content: 'c', encoding: 'utf-8' } },
			{ path: 'gone.md', intended: null, prior: null }
		]
	});
	const recovered = await recoverJournal(journal, drive.backend);
	check(
		'a bundle interrupted mid-rollback is settled whole',
		recovered?.outcome === 'completed' &&
			drive.text('a.md') === 'A' &&
			drive.text('b.md') === 'B' &&
			drive.text('c.md') === 'C'
	);
}

{
	const { drive, journal } = await interrupted();
	drive.down = true;
	const err = await errorOf(() => recoverJournal(journal, drive.backend));
	check('recovery against a backend that is still down fails', err === 'drive unavailable');
	check('and keeps the journal', journal.entry?.message === 'Edit a and b');
}

{
	const journal = memoryJournal();
	check(
		'an empty journal recovers nothing',
		(await recoverJournal(journal, fakeDrive().backend)) === undefined
	);
}

done();
