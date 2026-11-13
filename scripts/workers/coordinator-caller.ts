// A stand-in for the MCP Worker in pnpm test:objects. It reaches the coordinator object
// the way the MCP Worker does (a Durable Object binding by script_name, through
// objectWriteCoordinator) and gives it a FileBackend whose files live in the test
// process, over HTTP, so they outlive a restart of workerd.
//
//   POST /write  { brainId, storage, drive, bundle }  -> { result } | { error }
//   GET  /health                                     -> 200 when the object answers ping()

import { WriteConflictError } from '../../src/lib/brain-repo.ts';
import {
	objectWriteCoordinator,
	type CoordinatedWrite,
	type FileBackend
} from '../../src/lib/write-coordinator.ts';
import type { WriteCoordinatorObject } from '../../src/objects/worker.ts';

interface Env {
	WRITE_COORDINATOR: DurableObjectNamespace<WriteCoordinatorObject>;
}

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
