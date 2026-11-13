// The objects Worker: the Durable Object classes the MCP Worker binds by `script_name`.
// Deployed on its own (wrangler.objects.template.jsonc), because a Worker that implements
// a Durable Object loses its preview URLs and with them the pre-promotion smoke
// (.claude/rules/deploy-and-config.md). Nothing in src/ outside this folder imports it,
// except as a type; pnpm test:wiring holds that. pnpm test:objects runs it in workerd.
//
// It has no public URL (workers_dev is off) and serves nothing over HTTP.

import { DurableObject } from 'cloudflare:workers';
import { sqlFiles, type SqlFilesApi, type SqlWrite } from '../lib/brain-store-sql.ts';
import {
	backendFromRpc,
	landBundle,
	serialized,
	sqlJournal,
	type CoordinatedWrite,
	type CoordinatorObject,
	type FileBackend,
	type WriteJournal
} from '../lib/write-coordinator.ts';

// One per brain, named by brain_id: the brain's write lane and its journal. The files are
// read and written by the caller, through the backend it passes; the object holds no
// credential.
//
// The lane lives in memory. Between two awaits on the caller's stubs another call can
// arrive, and the lane makes it wait its turn. If the object restarts mid-bundle the lane
// is gone and the journal is not, so the next call settles the bundle first.
export class WriteCoordinatorObject extends DurableObject implements CoordinatorObject {
	private readonly lane = serialized();
	// Made on first use, so an object that is only pinged never creates its tables.
	private journal?: WriteJournal;

	land(files: FileBackend, bundle: CoordinatedWrite) {
		this.journal ??= sqlJournal(this.ctx.storage.sql);
		const journal = this.journal;
		return this.lane(() => landBundle(journal, backendFromRpc(files), bundle));
	}

	// For the MCP Worker's /health: the binding reaches a running object. Touches no storage.
	ping(): string {
		return 'ok';
	}
}

// One per brain the platform holds, named by brain_id: the brain's files, every version
// of them, and its history, in the object's SQLite (src/lib/brain-store-sql.ts). The MCP
// Worker reaches it as the `files` of a sqlBrainStore.
//
// Every method is synchronous over local storage, so calls to one brain cannot interleave
// and a write is one transaction.
export class BrainFilesObject extends DurableObject implements SqlFilesApi {
	private readonly files = sqlFiles({
		sql: this.ctx.storage.sql,
		transaction: (fn) => this.ctx.storage.transactionSync(fn)
	});

	revision() {
		return this.files.revision();
	}
	list(extension: string) {
		return this.files.list(extension);
	}
	read(path: string, at?: string) {
		return this.files.read(path, at);
	}
	readMany(paths: string[]) {
		return this.files.readMany(paths);
	}
	write(opts: SqlWrite) {
		return this.files.write(opts);
	}
	history(limit: number, path?: string) {
		return this.files.history(limit, path);
	}
}

export default {
	fetch(): Response {
		return new Response('Not found', { status: 404 });
	}
};
