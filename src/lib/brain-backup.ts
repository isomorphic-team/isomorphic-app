// Backups of a brain the platform holds: the files of one revision, sealed to a public
// key and written to a bucket, a budgeted step per call. Runtime-portable (Worker-safe,
// no node:*). pnpm test:store.
//
// The object that holds the brain runs this on its alarm (BrainFilesObject,
// src/objects/worker.ts) and holds only the PUBLIC key, so nothing in the deployment
// can read a backup back. `pnpm backup:restore` opens one with the private key.
//
// In the bucket, under `brains/<brain>/`:
//   <id>/part-00001 ...   sealed JSON, { files: [{ path, content, binary }] }
//   <id>/manifest.json    written last; a backup without one is incomplete
//   latest.json           a copy of the newest manifest
// The manifests are plain JSON and name no file.

import { EMPTY_REVISION, type SnapshotFile, type SqlFilesLocal } from './brain-store-sql.ts';
import { base64FromBytes, bytesFromBase64 } from './media.ts';
import type { SqlDatabase } from './sql-storage.ts';

// A brain is backed up at most this often, and only when it has changed.
const BACKUP_INTERVAL_HOURS = 24;
// How long after a change a backup waits, so a run of writes makes one backup.
const SETTLE_MS = 10 * 60 * 1000;
// Content per part, as stored.
const PART_BYTES = 4 * 1024 * 1024;
// Parts written per step.
const PARTS_PER_STEP = 8;
// Backups kept per brain, newest first.
export const BACKUPS_KEPT = 14;

const MAGIC = new TextEncoder().encode('ISOB1');
const IV_BYTES = 12;
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

// What the bucket must do: the part of an R2 bucket binding this uses. It cannot read.
export interface BackupBucket {
	put(key: string, value: Uint8Array | string): Promise<unknown>;
	list(opts: { prefix: string; cursor?: string }): Promise<{
		objects: { key: string }[];
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string[]): Promise<unknown>;
}

// Reads one object of the bucket, or null when it is absent.
export type BackupReader = (key: string) => Promise<Uint8Array | null>;

export interface BackupManifest {
	format: 1;
	brain: string;
	id: string;
	revision: string;
	at: string;
	parts: number;
	files: number;
	bytes: number;
}

interface BackupState {
	last?: { revision: string; at: number };
	// The backup being written. Every file up to and including `after`, in path order,
	// is in a part.
	run?: { manifest: BackupManifest; after: string | null };
}

export const backupPrefix = (brain: string): string => `brains/${brain}/`;
const partKey = (brain: string, id: string, part: number): string =>
	`${backupPrefix(brain)}${id}/part-${String(part).padStart(5, '0')}`;
const manifestKey = (brain: string, id: string): string =>
	`${backupPrefix(brain)}${id}/manifest.json`;
export const latestKey = (brain: string): string => `${backupPrefix(brain)}latest.json`;

// ---------- sealing ----------

export function importBackupPublicKey(spkiBase64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'spki',
		bytesFromBase64(spkiBase64.trim()) as BufferSource,
		RSA,
		false,
		['wrapKey']
	);
}

export function importBackupPrivateKey(pkcs8Base64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		bytesFromBase64(pkcs8Base64.trim()) as BufferSource,
		RSA,
		false,
		['unwrapKey']
	);
}

// A new key pair, as base64: the public half for the deployment (BACKUP_PUBLIC_KEY), the
// private half for whoever may restore.
export async function generateBackupKeys(): Promise<{ publicKey: string; privateKey: string }> {
	const pair = await crypto.subtle.generateKey(
		{ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['wrapKey', 'unwrapKey']
	);
	const b64 = async (format: 'spki' | 'pkcs8', key: CryptoKey) =>
		base64FromBytes(new Uint8Array(await crypto.subtle.exportKey(format, key)));
	return {
		publicKey: await b64('spki', pair.publicKey),
		privateKey: await b64('pkcs8', pair.privateKey)
	};
}

// MAGIC, the wrapped key's length (two bytes), the wrapped key, the IV, the ciphertext.
// Each part has an AES-256-GCM key of its own, wrapped to the public key. `name` (the
// part's key in the bucket) is authenticated with it, so a part cannot stand in for
// another.
async function sealPart(
	publicKey: CryptoKey,
	name: string,
	plain: Uint8Array
): Promise<Uint8Array> {
	const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) },
			key,
			plain as BufferSource
		)
	);
	const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', key, publicKey, RSA));
	const out = new Uint8Array(MAGIC.length + 2 + wrapped.length + IV_BYTES + sealed.length);
	let at = 0;
	out.set(MAGIC, at);
	at += MAGIC.length;
	out[at++] = wrapped.length >> 8;
	out[at++] = wrapped.length & 0xff;
	out.set(wrapped, at);
	at += wrapped.length;
	out.set(iv, at);
	out.set(sealed, at + IV_BYTES);
	return out;
}

export async function openPart(
	privateKey: CryptoKey,
	name: string,
	sealed: Uint8Array
): Promise<Uint8Array> {
	if (!MAGIC.every((b, i) => sealed[i] === b)) throw new Error(`${name} is not a backup part.`);
	let at = MAGIC.length;
	const wrappedLength = (sealed[at] << 8) | sealed[at + 1];
	at += 2;
	const key = await crypto.subtle.unwrapKey(
		'raw',
		sealed.slice(at, at + wrappedLength),
		privateKey,
		RSA,
		{ name: 'AES-GCM' },
		false,
		['decrypt']
	);
	at += wrappedLength;
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: sealed.slice(at, at + IV_BYTES),
				additionalData: new TextEncoder().encode(name)
			},
			key,
			sealed.slice(at + IV_BYTES)
		)
	);
}

// The files of an opened part, each as its bytes.
function partFiles(plain: Uint8Array): { path: string; bytes: Uint8Array }[] {
	const { files } = JSON.parse(new TextDecoder().decode(plain)) as { files: SnapshotFile[] };
	return files.map((f) => ({
		path: f.path,
		bytes: f.binary ? bytesFromBase64(f.content) : new TextEncoder().encode(f.content)
	}));
}

// ---------- the run ----------

function readState(db: SqlDatabase): BackupState {
	db.sql.exec(
		'CREATE TABLE IF NOT EXISTS backup_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)'
	);
	const row = db.sql.exec('SELECT state FROM backup_state WHERE id = 1').toArray()[0] as
		{ state: string } | undefined;
	return row ? (JSON.parse(row.state) as BackupState) : {};
}

function saveState(db: SqlDatabase, state: BackupState): void {
	db.sql.exec(
		'INSERT OR REPLACE INTO backup_state (id, state) VALUES (1, ?)',
		JSON.stringify(state)
	);
}

// BACKUP_INTERVAL_HOURS as configured, in milliseconds. Anything that is not a number
// of hours, zero or more, is the default.
export function backupIntervalMs(configured: string | undefined): number {
	const hours = Number(configured?.trim() || NaN);
	return (Number.isFinite(hours) && hours >= 0 ? hours : BACKUP_INTERVAL_HOURS) * 60 * 60 * 1000;
}

// When the next step should run, or null when the newest revision is already backed up
// (or the brain has no commit). `revision` is the brain's current one.
export function backupDue(
	db: SqlDatabase,
	revision: string,
	now: number,
	intervalMs: number
): number | null {
	const state = readState(db);
	if (state.run) return now;
	if (revision === EMPTY_REVISION || state.last?.revision === revision) return null;
	const settled = now + Math.min(SETTLE_MS, intervalMs);
	return state.last ? Math.max(settled, state.last.at + intervalMs) : settled;
}

const backupId = (now: number, revision: string): string =>
	`${new Date(now).toISOString().replace(/[-:]|\.\d+/g, '')}-r${revision}`;

// One step of backing up `brain` at the revision the run began on, and the manifest
// once the backup is whole. Reads are pinned to that revision, so writes that land
// between steps are not in this backup; the next one has them. A step that fails is safe
// to run again: it rewrites the part it was on. `db` holds the run's place, in the
// database `files` reads.
export async function backupStep(
	db: SqlDatabase,
	files: Pick<SqlFilesLocal, 'snapshot'>,
	bucket: BackupBucket,
	publicKey: CryptoKey,
	brain: string,
	revision: string,
	now: number
): Promise<BackupManifest | null> {
	const state = readState(db);
	const run = state.run ?? {
		manifest: {
			format: 1 as const,
			brain,
			id: backupId(now, revision),
			revision,
			at: new Date(now).toISOString(),
			parts: 0,
			files: 0,
			bytes: 0
		},
		after: null
	};
	const { manifest } = run;
	for (let written = 0; written < PARTS_PER_STEP; written++) {
		const page = files.snapshot(manifest.revision, run.after, PART_BYTES);
		if (page.length === 0) {
			const text = JSON.stringify(manifest, null, '\t') + '\n';
			await bucket.put(manifestKey(brain, manifest.id), text);
			await bucket.put(latestKey(brain), text);
			saveState(db, { last: { revision: manifest.revision, at: now } });
			await pruneBackups(bucket, brain);
			return manifest;
		}
		const name = partKey(brain, manifest.id, manifest.parts + 1);
		const plain = new TextEncoder().encode(JSON.stringify({ files: page }));
		await bucket.put(name, await sealPart(publicKey, name, plain));
		manifest.parts += 1;
		manifest.files += page.length;
		manifest.bytes += page.reduce((n, f) => n + f.size, 0);
		run.after = page[page.length - 1].path;
		saveState(db, { ...state, run });
	}
	return null;
}

// Deletes every backup of `brain` older than the newest BACKUPS_KEPT. Ids begin with
// their time, so their order is their age.
async function pruneBackups(bucket: BackupBucket, brain: string): Promise<void> {
	const prefix = backupPrefix(brain);
	const byId = new Map<string, string[]>();
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		for (const { key } of page.objects) {
			const rest = key.slice(prefix.length);
			// `latest.json` sits beside the backups, not in one.
			if (!rest.includes('/')) continue;
			const id = rest.split('/')[0];
			byId.set(id, [...(byId.get(id) ?? []), key]);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	const old = [...byId.keys()]
		.sort()
		.slice(0, -BACKUPS_KEPT)
		.flatMap((id) => byId.get(id)!);
	for (let i = 0; i < old.length; i += 1000) await bucket.delete(old.slice(i, i + 1000));
}

// ---------- reading one back ----------

// A backup's manifest (the newest when `id` is omitted) and its files, a part at a
// time.
export async function readBackup(
	get: BackupReader,
	privateKey: CryptoKey,
	brain: string,
	id?: string
): Promise<{
	manifest: BackupManifest;
	files: () => AsyncGenerator<{ path: string; bytes: Uint8Array }>;
}> {
	const key = id ? manifestKey(brain, id) : latestKey(brain);
	const found = await get(key);
	if (!found) {
		throw new Error(
			id
				? `No complete backup ${id} of ${brain}: ${key} is missing.`
				: `No backup of ${brain}: ${key} is missing.`
		);
	}
	const manifest = JSON.parse(new TextDecoder().decode(found)) as BackupManifest;
	if (manifest.format !== 1) throw new Error(`${key} is in a format this version cannot read.`);
	return {
		manifest,
		async *files() {
			for (let part = 1; part <= manifest.parts; part++) {
				const name = partKey(brain, manifest.id, part);
				const sealed = await get(name);
				if (!sealed) throw new Error(`${name} is missing.`);
				yield* partFiles(await openPart(privateKey, name, sealed));
			}
		}
	};
}
