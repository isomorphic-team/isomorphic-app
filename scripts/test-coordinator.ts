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
//      mid-bundle rolls back. A conflict that crossed Workers RPC, and so lost its class,
//      is still a conflict.
//   5. A JOURNAL THAT DOES NOT READ BACK. The SQL journal the coordinator object keeps
//      returns what was written, byte for byte, across chunks, including a surrogate pair
//      on a chunk boundary, and an interrupted bundle recovers from it.
//   6. A BUNDLE SETTLED ON THE WRONG STORAGE. A journal entry is only settled through a
//      backend reaching the storage it was written against.
//   7. A BUNDLE TOO LARGE TO CROSS RPC OR TO JOURNAL. One over MAX_BUNDLE_BYTES, counting
//      what it replaces, is refused before a file is written, and before the call to the
//      coordinator object is made.
//
// pnpm test:objects runs the same coordinator in the Durable Object, over real RPC.

import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { WriteConflictError } from '../src/lib/brain-repo.ts';
import {
	backendFromRpc,
	chunked,
	inMemoryWriteCoordinator,
	MAX_BUNDLE_BYTES,
	memoryJournal,
	objectWriteCoordinator,
	recoverJournal,
	sqlJournal,
	type FileBackend,
	type JournalEntry,
	type SqlRunner
} from '../src/lib/write-coordinator.ts';
import { checker, errorOf } from './check.ts';
import { fakeDrive, gate } from './fake-drive.ts';

const { check, done } = checker('coordinator checks');

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
		storage: 'drive:test',
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

// ---------- 4. conflicts across RPC ----------
{
	// What Workers RPC delivers for a thrown WriteConflictError: a plain Error that keeps
	// its name and own properties.
	const crossed = (path: string) =>
		Object.assign(new Error(`${path} changed since it was read.`), {
			name: 'WriteConflictError',
			path
		});
	const drive = fakeDrive({ 'a.md': 'a', 'b.md': 'b' });
	const put = drive.backend.put;
	const backend: FileBackend = {
		...drive.backend,
		async put(path, file, ifVersion) {
			try {
				return await put(path, file, ifVersion);
			} catch (e) {
				throw e instanceof WriteConflictError ? crossed(e.path) : e;
			}
		}
	};
	drive.before = async (_op, path) => {
		if (path === 'b.md') {
			drive.edit('a.md', 'edited after ours');
			drive.edit('b.md', 'edited too');
		}
	};
	const journal = memoryJournal();
	const err = await errorOf(() =>
		// What the object does with the backend it receives.
		inMemoryWriteCoordinator(() => journal).write('b', backendFromRpc(backend), {
			message: 'conflicts over RPC',
			writes: [
				{ path: 'a.md', content: 'A' },
				{ path: 'b.md', content: 'B' }
			]
		})
	);
	check(
		'a conflict that lost its class still fails the write',
		err?.includes('b.md') === true,
		String(err)
	);
	check(
		'and the rollback still leaves a newer edit in place',
		drive.text('a.md') === 'edited after ours' && journal.entry === null
	);

	// The Worker's side of the object: a conflict from the object comes back as the class.
	const remote = objectWriteCoordinator(() => ({
		land: async () => {
			throw crossed('x.md');
		}
	}));
	let caught: unknown;
	await remote.write('b', drive.backend, { message: 'm' }).catch((e) => (caught = e));
	check(
		"the object's conflict reaches the caller as a WriteConflictError",
		caught instanceof WriteConflictError && caught.path === 'x.md'
	);
	const other = await errorOf(() =>
		objectWriteCoordinator(() => ({
			land: async () => {
				throw new Error('object failed');
			}
		})).write('b', drive.backend, { message: 'm' })
	);
	check('any other error from the object passes through', other === 'object failed');
}

// ---------- 5. the SQL journal ----------
function sqlite(): SqlRunner {
	const db = new DatabaseSync(':memory:');
	return {
		// Eager, as a Durable Object's exec is: the statement runs before the cursor is read.
		exec: (query, ...bindings) => {
			const rows = db.prepare(query).all(...bindings);
			return { toArray: () => rows };
		}
	};
}

{
	check(
		'content splits into chunks of the given size',
		chunked('abcdefg', 3).join('|') === 'abc|def|g'
	);
	check('empty content is no chunks', chunked('', 3).length === 0);
	check(
		'a surrogate pair is never split',
		chunked('ab\u{1F600}cd', 3).join('|') === 'ab|\u{1F600}c|d',
		chunked('ab\u{1F600}cd', 3).join('|')
	);

	const journal = sqlJournal(sqlite(), 3);
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe, 0x80, 1, 2]).toString(
		'base64'
	);
	const entry: JournalEntry = {
		storage: 'drive:test',
		message: 'every kind of step',
		steps: [
			{
				path: 'a.md',
				intended: { content: 'new text with \u{1F600} across chunks' },
				prior: { content: 'old', encoding: 'utf-8' }
			},
			{ path: 'img.png', intended: { content: png, encoding: 'base64' }, prior: null },
			{ path: 'empty.md', intended: { content: '' }, prior: { content: '', encoding: 'utf-8' } },
			{ path: 'gone.png', intended: null, prior: { content: png, encoding: 'base64' } }
		]
	};
	check('an empty SQL journal reads as none', (await journal.read()) === null);
	await journal.open(entry);
	const back = await journal.read();
	check(
		'the SQL journal reads back what was written',
		isDeepStrictEqual(back, entry),
		JSON.stringify(back)
	);
	await journal.open({ storage: 'drive:test', message: 'second', steps: [] });
	check(
		'opening replaces the entry before it',
		(await journal.read())?.message === 'second' && (await journal.read())?.steps.length === 0
	);
	await journal.close();
	check('closing empties it', (await journal.read()) === null);
}

{
	// The interrupted bundle of section 3, journaled in SQL and recovered by a coordinator
	// built over the same database, as the object is after a restart.
	const sql = sqlite();
	const drive = fakeDrive({ 'a.md': 'a', 'b.md': 'b' });
	drive.before = async () => {
		if (drive.calls.length === 2) drive.down = true;
	};
	await errorOf(() =>
		inMemoryWriteCoordinator(() => sqlJournal(sql, 2)).write('b', drive.backend, {
			message: 'Edit a and b',
			writes: [
				{ path: 'a.md', content: 'A \u{1F600}' },
				{ path: 'b.md', content: 'B \u{1F600}' }
			]
		})
	);
	drive.down = false;
	drive.before = async () => {};
	check(
		'the SQL journal holds the interrupted bundle',
		(await sqlJournal(sql).read())?.message === 'Edit a and b'
	);
	const res = await inMemoryWriteCoordinator(() => sqlJournal(sql, 2)).write('b', drive.backend, {
		message: 'next'
	});
	check(
		'and a restarted coordinator completes it from there',
		res.recovered?.outcome === 'completed' && drive.text('b.md') === 'B \u{1F600}'
	);
	check('then closes it', (await sqlJournal(sql).read()) === null);
}

// ---------- 6. the journal belongs to one storage ----------
{
	const { drive, journal } = await interrupted();
	const elsewhere: FileBackend = { ...drive.backend, storage: 'drive:other' };
	const err = await errorOf(() =>
		inMemoryWriteCoordinator(() => journal).write('b', elsewhere, { message: 'next' })
	);
	check(
		'an entry is not settled through a backend reaching other storage',
		err?.includes('drive:test') === true && err.includes('drive:other'),
		String(err)
	);
	check(
		'which leaves the files and the journal as they were',
		drive.text('b.md') === 'b' && journal.entry?.message === 'Edit a and b'
	);
}

// ---------- 7. a bundle has a size ----------
{
	// Text counts two bytes a unit, so this many units is exactly the cap.
	const atCap = 'x'.repeat(MAX_BUNDLE_BYTES / 2);
	const journal = memoryJournal();
	const coord = inMemoryWriteCoordinator(() => journal);

	const drive = fakeDrive();
	const fits = await coord.write('b', drive.backend, {
		message: 'at the cap',
		writes: [{ path: 'big.md', content: atCap }]
	});
	check('a bundle exactly at the cap lands', 'big.md' in fits.versions);

	const empty = fakeDrive();
	let reads = 0;
	const counting: FileBackend = {
		...empty.backend,
		read: (path, encoding) => (reads++, empty.backend.read(path, encoding))
	};
	const over = await errorOf(() =>
		coord.write('b', counting, {
			message: 'over the cap',
			writes: [
				{ path: 'big.md', content: atCap },
				{ path: 'one-more.md', content: 'x' }
			]
		})
	);
	check(
		'a bundle over the cap is refused',
		over?.includes('at most 16.0 MB') === true,
		String(over)
	);
	check('before a file is read or written', reads === 0 && empty.calls.length === 0);

	// Base64 counts one byte a unit: the same number of units is half the cap.
	const binary = fakeDrive();
	const b64 = await coord.write('b', binary.backend, {
		message: 'bytes',
		writes: [
			{ path: 'a.bin', content: 'A'.repeat(MAX_BUNDLE_BYTES / 2), encoding: 'base64' },
			{ path: 'b.bin', content: 'A'.repeat(MAX_BUNDLE_BYTES / 2), encoding: 'base64' }
		]
	});
	check('base64 content counts one byte a unit', 'b.bin' in b64.versions);

	// What a write replaces is journaled with it.
	const full = fakeDrive({ 'big.md': atCap });
	const replacing = await errorOf(() =>
		coord.write('b', full.backend, {
			message: 'small over large',
			writes: [{ path: 'big.md', content: 'x' }]
		})
	);
	check(
		'a small write over a file that fills the cap is refused',
		replacing?.includes('the files it replaces') === true,
		String(replacing)
	);
	check(
		'with nothing written and no journal left',
		full.calls.length === 0 && full.text('big.md') === atCap && journal.entry === null
	);

	let landed = 0;
	const remote = objectWriteCoordinator(() => ({
		land: async () => (landed++, { versions: {} })
	}));
	const refused = await errorOf(() =>
		remote.write('b', empty.backend, {
			message: 'over the cap',
			writes: [
				{ path: 'big.md', content: atCap },
				{ path: 'one-more.md', content: 'x' }
			]
		})
	);
	check(
		'an oversized bundle is refused before the call to the coordinator object',
		refused?.includes('at most 16.0 MB') === true && landed === 0,
		`${refused} / ${landed}`
	);
}

done();
