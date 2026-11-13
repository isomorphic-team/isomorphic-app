// The objects Worker: the Durable Object classes the MCP Worker binds by `script_name`.
// Deployed on its own (wrangler.objects.template.jsonc), because a Worker that implements
// a Durable Object loses its preview URLs and with them the pre-promotion smoke
// (.claude/rules/deploy-and-config.md). Nothing in src/ outside this folder imports it,
// except as a type; pnpm test:wiring holds that. pnpm test:objects runs it in workerd.
//
// It has no public URL (workers_dev is off) and serves nothing over HTTP.

import { DurableObject } from 'cloudflare:workers';
import {
	backupDue,
	backupIntervalMs,
	backupStep,
	importBackupPublicKey,
	type BackupBucket
} from '../lib/brain-backup.ts';
import { sqlFiles, type SqlFilesApi, type SqlWrite } from '../lib/brain-store-sql.ts';
import type { SqlDatabase } from '../lib/sql-storage.ts';
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

interface Env {
	// The bucket backups go to, and the public key they are sealed to
	// (src/lib/brain-backup.ts). Without both, nothing is backed up.
	BACKUPS?: R2Bucket;
	BACKUP_PUBLIC_KEY?: string;
	BACKUP_INTERVAL_HOURS?: string;
}

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
//
// With a BACKUPS bucket and a BACKUP_PUBLIC_KEY, the object backs its brain up on an
// alarm after it changes (src/lib/brain-backup.ts). The key is public: the object can
// write a backup and cannot read one.
export class BrainFilesObject extends DurableObject<Env> implements SqlFilesApi {
	private readonly db: SqlDatabase = {
		sql: this.ctx.storage.sql,
		transaction: (fn) => this.ctx.storage.transactionSync(fn)
	};
	private readonly store = sqlFiles(this.db);
	// Whether this instance has looked at its alarm. An alarm wakes the object through
	// the constructor and no method below, so arming here cannot push its own alarm back.
	private armed = false;

	// The storage, for a call from the MCP Worker: the first one looks at the alarm.
	private get files() {
		this.arm();
		return this.store;
	}

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
		const result = this.store.write(opts);
		// A write is what makes a backup due, so it always looks.
		this.armed = false;
		this.arm();
		return result;
	}
	history(limit: number, path?: string) {
		return this.files.history(limit, path);
	}

	private get backups(): { bucket: BackupBucket; publicKey: string; intervalMs: number } | null {
		const bucket = this.env.BACKUPS;
		const publicKey = this.env.BACKUP_PUBLIC_KEY?.trim();
		if (!bucket || !publicKey) return null;
		return {
			bucket: bucket as unknown as BackupBucket,
			publicKey,
			intervalMs: backupIntervalMs(this.env.BACKUP_INTERVAL_HOURS)
		};
	}

	// Sets the alarm for the next backup when one is due and none is set.
	private arm(): void {
		if (this.armed) return;
		this.armed = true;
		const backups = this.backups;
		if (!backups) return;
		const due = backupDue(this.db, this.store.revision(), Date.now(), backups.intervalMs);
		if (due === null) return;
		this.ctx.waitUntil(
			this.ctx.storage.getAlarm().then((set) => {
				if (set === null) return this.ctx.storage.setAlarm(due);
			})
		);
	}

	// One step of a backup, and another alarm while there is more of it to write. A step
	// that throws is retried by the runtime, and by the next call's arm() after that.
	async alarm(): Promise<void> {
		const backups = this.backups;
		// The name the MCP Worker reaches this object by: the brain's id.
		const brain = this.ctx.id.name;
		if (!backups || !brain) return;
		const now = Date.now();
		const revision = this.store.revision();
		const due = backupDue(this.db, revision, now, backups.intervalMs);
		if (due === null) return;
		// Fired early or twice: wait for the time the backup is due.
		if (due > now) return this.ctx.storage.setAlarm(due);
		const finished = await backupStep(
			this.db,
			this.store,
			backups.bucket,
			await importBackupPublicKey(backups.publicKey),
			brain,
			revision,
			now
		);
		if (!finished) await this.ctx.storage.setAlarm(Date.now());
	}
}

export default {
	fetch(): Response {
		return new Response('Not found', { status: 404 });
	}
};
