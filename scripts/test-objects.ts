// The objects Worker (src/objects/worker.ts) in workerd, reached the way the MCP Worker
// reaches it: a Durable Object binding by script_name, over real Workers RPC. Runs
// `wrangler dev` locally with no Cloudflare account; the files live in this process.
//
//   pnpm test:objects
//
// What it exists to catch (pnpm test:coordinator pins the coordinator's own logic):
//   1. THE CONFIGS DO NOT MEET. The MCP Worker's binding (wrangler.template.jsonc) names
//      the class and script the objects Worker (wrangler.objects.template.jsonc) exports.
//   2. CALLS THAT INTERLEAVE ACROSS REQUESTS. Two Worker requests writing to one brain
//      reach one object, which runs their bundles one after the other.
//   3. A BACKEND THAT DOES NOT CROSS RPC. The caller's FileBackend reaches the object as
//      stubs, a conflict thrown in the caller is still a conflict inside the object (it
//      rolls back and leaves a newer edit alone), and the object's conflict reaches the
//      caller as a WriteConflictError.
//   4. A JOURNAL THAT DOES NOT SURVIVE. A bundle interrupted mid-write is completed by the
//      next call after workerd restarts, from the object's SQLite storage.
//   5. CONTENT THAT DOES NOT FIT. A bundle replacing a full-size attachment
//      (MAX_ATTACHMENT_BYTES) is journaled and recovered byte for byte.
//   6. A FILES OBJECT THAT IS NOT A STORE (pnpm test:store pins the storage's own logic).
//      sqlBrainStore over the BrainFilesObject binding writes, lists, reads back bytes and
//      pinned revisions, and reports history; its refusals cross RPC with their message;
//      concurrent requests each land whole; one brain cannot see another; and the files
//      survive a restart of workerd.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ATTACHMENT_BYTES } from '../src/lib/media.ts';
import type { CoordinatedResult, CoordinatedWrite } from '../src/lib/write-coordinator.ts';
import {
	WriteConflictError,
	type BinaryContent,
	type CommitEntry,
	type FileEntry,
	type WriteResult
} from '../src/lib/brain-repo.ts';
import { checker } from './check.ts';
import { fakeDrive, gate } from './fake-drive.ts';
import { optionalBlock } from './optional-block.ts';
import { parseJsonc } from './preview.ts';
import { waitForOrigin } from './smoke.ts';

const { check, done } = checker('objects checks');
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'isomorphic-objects-'));

// ---------- the drive, in this process, served to the caller Worker ----------
const drive = fakeDrive();
const { files, calls, text, edit: set } = drive;

const body = async (req: IncomingMessage) => {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
};
// 409 { path } for a conflict and 503 for any other failure, which the caller turns back
// into the errors the backend threw.
const server = createServer(async (req, res) => {
	const reply = (status: number, value: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(value));
	};
	const op = req.url!.slice(1);
	const b = await body(req);
	try {
		if (op === 'read') return reply(200, await drive.backend.read(b.path, b.encoding));
		if (op === 'put') return reply(200, await drive.backend.put(b.path, b.file, b.ifVersion));
		await drive.backend.remove(b.path, b.ifVersion);
		return reply(200, null);
	} catch (e) {
		if (e instanceof WriteConflictError) return reply(409, { path: e.path });
		return reply(503, (e as Error).message);
	}
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const driveUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---------- the two Workers, from the real templates ----------
const OBJECTS = 'test-objects';
const fill = (template: string) =>
	readFileSync(join(root, template), 'utf8').split('__OBJECTS_WORKER_NAME__').join(OBJECTS);
const objects = parseJsonc(fill('wrangler.objects.template.jsonc')) as Record<string, unknown>;
const mcp = parseJsonc(optionalBlock(fill('wrangler.template.jsonc'), 'index-db', false)) as {
	durable_objects: { bindings: { name: string; class_name: string; script_name: string }[] };
};

{
	const exported = (objects.durable_objects as { bindings: { class_name: string }[] }).bindings;
	const bound = mcp.durable_objects.bindings;
	const names = (list: { class_name: string }[]) =>
		list
			.map((b) => b.class_name)
			.sort()
			.join();
	check(
		'the MCP Worker binds every class the objects Worker exports, by its name',
		names(bound) === names(exported) &&
			bound.every((b) => b.script_name === OBJECTS) &&
			objects.name === OBJECTS,
		JSON.stringify({ bound, exported })
	);
	const sqlite = (objects.migrations as { new_sqlite_classes?: string[] }[]).flatMap(
		(m) => m.new_sqlite_classes ?? []
	);
	check(
		'every class is SQLite-backed, added by one migration',
		bound.every((b) => sqlite.filter((c) => c === b.class_name).length === 1),
		JSON.stringify(objects.migrations)
	);
}

delete objects.$schema;
writeFileSync(
	join(dir, 'objects.jsonc'),
	JSON.stringify({ ...objects, main: join(root, String(objects.main)) })
);
writeFileSync(
	join(dir, 'caller.jsonc'),
	JSON.stringify({
		name: 'test-caller',
		main: join(root, 'scripts/workers/objects-caller.ts'),
		compatibility_date: objects.compatibility_date,
		durable_objects: mcp.durable_objects
	})
);

const port = 18000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${port}`;
let dev: ChildProcess | undefined;
let log = '';

async function start(): Promise<void> {
	dev = spawn(
		join(root, 'node_modules/.bin/wrangler'),
		[
			'dev',
			'-c',
			'caller.jsonc',
			'-c',
			'objects.jsonc',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port),
			'--inspector-port',
			'0',
			'--persist-to',
			join(dir, 'state')
		],
		{ cwd: dir, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
	);
	dev.stdout!.on('data', (d) => (log += d));
	dev.stderr!.on('data', (d) => (log += d));
	if (!(await waitForOrigin(origin, { attempts: 120, delayMs: 500 }))) {
		throw new Error(`wrangler dev did not start:\n${log}`);
	}
}

async function stop(): Promise<void> {
	if (!dev?.pid) return;
	const exited = new Promise((r) => dev!.once('exit', r));
	process.kill(-dev.pid, 'SIGTERM');
	await exited;
	dev = undefined;
}

type Reply = { result?: CoordinatedResult; error?: { message: string; conflict: string | null } };
const write = async (brainId: string, bundle: CoordinatedWrite, storage = 'drive:test') =>
	(await (
		await fetch(`${origin}/write`, {
			method: 'POST',
			body: JSON.stringify({ brainId, storage, drive: driveUrl, bundle })
		})
	).json()) as Reply;

// One BrainStore call on a brain's files object. JSON carries a missing argument as null,
// which the store reads as absent.
const filesCall = async <T>(brainId: string, op: string, ...args: unknown[]) =>
	(await (
		await fetch(`${origin}/files`, {
			method: 'POST',
			body: JSON.stringify({ brainId, op, args })
		})
	).json()) as { result?: T; error?: string };

const sameBytes = (read: { result?: BinaryContent }, bytes: Buffer): boolean =>
	Buffer.from(read.result?.contentBase64 ?? '', 'base64').equals(bytes);

const until = async (cond: () => boolean) => {
	for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
};
const reset = () => {
	calls.length = 0;
	drive.down = false;
	drive.before = async () => {};
};

try {
	await start();
	check('the binding reaches a running object', true);

	// ---------- 2. one bundle at a time, across requests ----------
	{
		reset();
		const hold = gate();
		drive.before = async (op, path) => {
			if (path === 's1.md') await hold.opened;
		};
		const first = write('b-serial', {
			message: 'first',
			writes: [
				{ path: 's1.md', content: '1' },
				{ path: 's2.md', content: '2' }
			]
		});
		await until(() => calls.includes('put s1.md'));
		const second = write('b-serial', {
			message: 'second',
			writes: [{ path: 's3.md', content: '3' }]
		});
		const elsewhere = await write('b-other', {
			message: 'other',
			writes: [{ path: 'o.md', content: 'o' }]
		});
		check(
			'a write to another brain does not wait',
			elsewhere.result?.versions['o.md'] !== undefined
		);
		check(
			"the second request's bundle has not started",
			!calls.some((c) => c.endsWith('s3.md')),
			calls.join(', ')
		);
		hold.open();
		const [a, b] = await Promise.all([first, second]);
		check('both land', a.result !== undefined && b.result !== undefined, JSON.stringify([a, b]));
		const order = calls.filter((c) => c.startsWith('put s')).join(', ');
		check('one after the other', order === 'put s1.md, put s2.md, put s3.md', order);
	}

	// ---------- 3. conflicts across RPC ----------
	{
		reset();
		set('c.md', 'c');
		const res = await write('b-conflict', {
			message: 'stale',
			writes: [{ path: 'c.md', content: 'mine' }],
			expected: { 'c.md': 'v-old' }
		});
		check(
			"the object's conflict reaches the caller as a WriteConflictError",
			res.error?.conflict === 'c.md',
			JSON.stringify(res)
		);
		check('and nothing was written', text('c.md') === 'c');
	}
	{
		reset();
		set('a.md', 'a');
		set('b.md', 'b');
		drive.before = async (op, path) => {
			if (op === 'put' && path === 'b.md') {
				set('a.md', 'edited after ours');
				set('b.md', 'edited too');
			}
		};
		const res = await write('b-conflict', {
			message: 'raced',
			writes: [
				{ path: 'a.md', content: 'A' },
				{ path: 'b.md', content: 'B' }
			]
		});
		check(
			"a conflict thrown in the caller's backend fails the bundle as a conflict",
			res.error?.conflict === 'b.md',
			JSON.stringify(res)
		);
		check(
			'and the rollback leaves the newer edits in place',
			text('a.md') === 'edited after ours' && text('b.md') === 'edited too'
		);
		const next = await write('b-conflict', { message: 'next' });
		check(
			'and closes the journal',
			next.result !== undefined && next.result.recovered === undefined
		);
	}

	// ---------- 5. a full-size attachment ----------
	{
		reset();
		const old = randomBytes(MAX_ATTACHMENT_BYTES);
		const fresh = randomBytes(MAX_ATTACHMENT_BYTES);
		set('img.png', old);
		set('page.md', 'page');
		drive.before = async (op, path) => {
			if (op === 'put' && path === 'page.md') drive.down = true;
		};
		const failed = await write('b-large', {
			message: 'Attach img',
			writes: [
				{ path: 'img.png', content: fresh.toString('base64'), encoding: 'base64' },
				{ path: 'page.md', content: 'page ![](img.png)' }
			]
		});
		check(
			'an interrupted attachment write fails',
			failed.error !== undefined,
			JSON.stringify(failed)
		);
		reset();
		const res = await write('b-large', { message: 'next' });
		check(
			'and the next call completes it from the journal',
			res.result?.recovered?.outcome === 'completed',
			JSON.stringify(res.result?.recovered ?? res.error)
		);
		check(
			'with the attachment byte for byte',
			files.get('img.png')?.bytes.equals(fresh) === true && text('page.md') === 'page ![](img.png)'
		);
	}

	// ---------- 6. the files object, as a store ----------
	const image = randomBytes(MAX_ATTACHMENT_BYTES);
	{
		const first = await filesCall<WriteResult>('f-main', 'write', {
			message: 'Add a page and an image',
			writes: [
				{ path: 'wiki/a.md', content: '# A\n\ncafé 東京\n' },
				{ path: 'assets/img.png', content: image.toString('base64'), encoding: 'base64' }
			],
			author: { name: 'Ada', email: 'ada@example.com' }
		});
		check(
			'a bundle with a full-size attachment lands in the files object',
			first.result?.revision.id === '1' && first.result.versions['wiki/a.md'] === '1',
			JSON.stringify(first.error ?? first.result?.revision)
		);
		const listed = await filesCall<FileEntry[]>('f-main', 'listTree', first.result?.revision, {
			extension: '*'
		});
		check(
			'and is listed with the tags the write returned',
			listed.result?.map((e) => `${e.path}@${e.version}`).join() === 'assets/img.png@1,wiki/a.md@1',
			JSON.stringify(listed)
		);
		const bin = await filesCall<BinaryContent>('f-main', 'readBinary', 'assets/img.png');
		check(
			'the attachment reads back byte for byte',
			sameBytes(bin, image) && bin.result?.size === MAX_ATTACHMENT_BYTES
		);

		const edit = await filesCall<WriteResult>('f-main', 'write', {
			message: 'Edit A',
			writes: [{ path: 'wiki/a.md', content: '# A\n\nEdited.\n' }],
			base: first.result?.revision
		});
		const then = await filesCall<{ content: string }>('f-main', 'readFile', 'wiki/a.md', '1');
		const now = await filesCall<{ content: string }>('f-main', 'readFile', 'wiki/a.md');
		check(
			'a read pinned to a revision sees that revision',
			edit.result?.revision.id === '2' &&
				then.result?.content === '# A\n\ncafé 東京\n' &&
				now.result?.content === '# A\n\nEdited.\n',
			JSON.stringify([edit.error, then, now])
		);

		const stale = await filesCall<WriteResult>('f-main', 'write', {
			message: 'Planned against revision 1',
			writes: [{ path: 'wiki/stale.md', content: 'x' }],
			base: first.result?.revision
		});
		check(
			'a write onto a revision the brain has moved past is refused, with its message',
			stale.error?.includes('changed since') === true,
			JSON.stringify(stale)
		);
		const refused = await filesCall<WriteResult>('f-main', 'commitOrPR', {
			message: 'Needs review',
			writeMode: 'pull-request',
			defaultBranch: 'main',
			writes: [{ path: 'wiki/review.md', content: 'x' }]
		});
		const head = await filesCall<string>('f-main', 'branchRevision', 'main');
		check(
			'pull-request mode is refused, and neither refusal wrote anything',
			refused.error?.includes('pull-request writes') === true && head.result === '2',
			JSON.stringify([refused, head])
		);

		const log = await filesCall<CommitEntry[]>('f-main', 'listCommits', { limit: 10 });
		check(
			'history is newest first, with the author',
			log.result?.map((c) => `${c.message}/${c.authorName}`).join() ===
				'Edit A/Isomorphic,Add a page and an image/Ada',
			JSON.stringify(log)
		);

		const other = await filesCall<FileEntry[]>('f-other', 'listTree', null, { extension: '*' });
		check("another brain's object holds none of it", other.result?.length === 0);

		// Twenty requests at once, each a two-file bundle to the same brain.
		const landed = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				filesCall<WriteResult>('f-busy', 'write', {
					message: `bundle ${i}`,
					writes: [
						{ path: `p${i}/one.md`, content: `${i}` },
						{ path: `p${i}/two.md`, content: `${i}` }
					]
				})
			)
		);
		const revisions = landed.map((r) => Number(r.result?.revision.id)).sort((a, b) => a - b);
		const busy = await filesCall<FileEntry[]>('f-busy', 'listTree', null);
		check(
			'concurrent requests each land whole, one revision apiece',
			revisions.join() === Array.from({ length: 20 }, (_, i) => i + 1).join() &&
				busy.result?.length === 40 &&
				landed.every(
					(r, i) => r.result?.versions[`p${i}/one.md`] === r.result?.versions[`p${i}/two.md`]
				),
			revisions.join()
		);
	}

	// ---------- 4. the journal survives a restart ----------
	{
		reset();
		set('r1.md', 'r1');
		set('r2.md', 'r2');
		drive.before = async (op, path) => {
			if (op === 'put' && path === 'r2.md') drive.down = true;
		};
		const failed = await write('b-restart', {
			message: 'Edit r1 and r2',
			writes: [
				{ path: 'r1.md', content: 'R1' },
				{ path: 'r2.md', content: 'R2' }
			]
		});
		check(
			'the interrupted write fails with one file written',
			failed.error !== undefined && text('r1.md') === 'R1' && text('r2.md') === 'r2'
		);
		await stop();
		reset();
		await start();
		const res = await write('b-restart', { message: 'after restart' });
		check(
			'after a restart the next call completes the bundle',
			res.result?.recovered?.outcome === 'completed' &&
				res.result.recovered.message === 'Edit r1 and r2' &&
				text('r2.md') === 'R2',
			JSON.stringify(res)
		);
		check('without rewriting the file that landed', !calls.includes('put r1.md'), calls.join(', '));

		const bin = await filesCall<BinaryContent>('f-main', 'readBinary', 'assets/img.png');
		const head = await filesCall<string>('f-main', 'branchRevision', 'main');
		check(
			"the files object's brain is as it was after the restart",
			head.result === '2' && sameBytes(bin, image),
			JSON.stringify(head)
		);
	}
} catch (e) {
	check(`the battery ran: ${(e as Error).message}`, false, log.slice(-4000));
} finally {
	await stop();
	server.close();
	rmSync(dir, { recursive: true, force: true });
}

done();
