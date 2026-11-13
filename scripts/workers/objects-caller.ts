// A stand-in for the MCP Worker in pnpm test:objects. It reaches the objects Worker's
// classes the way the MCP Worker does, through Durable Object bindings by script_name:
// the coordinator through objectWriteCoordinator, with a FileBackend whose files live in
// the test process, over HTTP, so they outlive a restart of workerd; and a brain's files
// object through sqlBrainStore.
//
//   POST /write  { brainId, storage, drive, bundle }  -> { result } | { error }
//   POST /files  { brainId, op, args }                -> { result } | { error }
//                one BrainStore call on the brain's files object, through sqlBrainStore
//   GET  /backups?prefix= | ?key=                    -> the backup bucket's keys, or one object
//   GET  /health                                     -> 200 when the object answers ping()

import { WriteConflictError, type BrainStore } from '../../src/lib/brain-repo.ts';
import { sqlBrainStore } from '../../src/lib/brain-store-sql.ts';
import {
	objectWriteCoordinator,
	type CoordinatedWrite,
	type FileBackend
} from '../../src/lib/write-coordinator.ts';
import type { BrainFilesObject, WriteCoordinatorObject } from '../../src/objects/worker.ts';

interface Env {
	WRITE_COORDINATOR: DurableObjectNamespace<WriteCoordinatorObject>;
	BRAIN_FILES: DurableObjectNamespace<BrainFilesObject>;
	// The bucket the objects Worker backs brains up to.
	BACKUPS: R2Bucket;
}

const LOC = { owner: 'example-org', repo: 'brain' };
type StoreCall = (loc: typeof LOC, ...args: unknown[]) => Promise<unknown>;

// The test process answers 409 { path } for a failed precondition and 503 when the drive
// is down.
function httpBackend(drive: string, storage: string): FileBackend {
	const call = async <T>(op: string, body: unknown): Promise<T> => {
		const res = await fetch(`${drive}/${op}`, { method: 'POST', body: JSON.stringify(body) });
		if (res.status === 409)
			throw new WriteConflictError(((await res.json()) as { path: string }).path);
		if (!res.ok) throw new Error(await res.text());
		return (await res.json()) as T;
	};
	return {
		storage,
		read: (path, encoding) => call('read', { path, encoding }),
		put: (path, file, ifVersion) => call('put', { path, file, ifVersion }),
		remove: (path, ifVersion) => call('remove', { path, ifVersion })
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const ns = env.WRITE_COORDINATOR;
		const url = new URL(request.url);
		if (url.pathname === '/health') {
			const ok = (await ns.get(ns.idFromName('health')).ping()) === 'ok';
			return new Response(ok ? 'ok' : 'no answer', { status: ok ? 200 : 503 });
		}
		if (url.pathname === '/backups') {
			const key = url.searchParams.get('key');
			if (key) {
				const object = await env.BACKUPS.get(key);
				return object ? new Response(object.body) : new Response('absent', { status: 404 });
			}
			const listed = await env.BACKUPS.list({ prefix: url.searchParams.get('prefix') ?? '' });
			return Response.json(listed.objects.map((o) => o.key));
		}
		if (url.pathname === '/files') {
			const { brainId, op, args } = (await request.json()) as {
				brainId: string;
				op: keyof BrainStore;
				args: unknown[];
			};
			const store = sqlBrainStore(env.BRAIN_FILES.get(env.BRAIN_FILES.idFromName(brainId)));
			try {
				const call = store[op];
				if (typeof call !== 'function') throw new Error(`${op} is not a store operation`);
				return Response.json({ result: (await (call as StoreCall)(LOC, ...args)) ?? null });
			} catch (e) {
				return Response.json({ error: (e as Error).message });
			}
		}
		const { brainId, storage, drive, bundle } = (await request.json()) as {
			brainId: string;
			storage: string;
			drive: string;
			bundle: CoordinatedWrite;
		};
		const coordinator = objectWriteCoordinator((id) => ns.get(ns.idFromName(id)));
		try {
			const result = await coordinator.write(brainId, httpBackend(drive, storage), bundle);
			return Response.json({ result });
		} catch (e) {
			const err = e as Error;
			return Response.json({
				error: {
					message: err.message,
					conflict: e instanceof WriteConflictError ? e.path : null
				}
			});
		}
	}
};
