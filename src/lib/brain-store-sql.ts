// A brain's files in one SQLite database: the store for a brain the platform holds itself,
// with no GitHub repository behind it. Runtime-portable (Worker-safe, no node:*).
// pnpm test:store.
//
// `sqlFiles` is the storage, synchronous over a SqlDatabase: a Durable Object's
// `ctx.storage` deployed (BrainFilesObject, src/objects/worker.ts), node:sqlite in the
// tests. `sqlBrainStore` is the BrainStore over
// it, and takes the same operations as promises so that it can sit on the other side of
// Workers RPC from the object.
//
// Every write is one transaction that adds a commit and a new version of each file it
// touches. Old versions are kept, so a read can be pinned to a revision and history is a
// query. A revision id is the commit's sequence number; a file's version tag is the
// sequence number of the commit that last changed it.

import {
	MAX_SCAN_PAGES,
	defineStore,
	type BinaryContent,
	type BrainStore,
	type CommitAuthor,
	type CommitEntry,
	type FileEntry,
	type FileWrite,
	type PageContent,
	type Revision,
	type WriteOpts,
	type WriteResult
} from './brain-repo.ts';
import { base64FromBytes } from './media.ts';
import type { SqlDatabase } from './sql-storage.ts';
import { base64ToUtf8 } from './wiki.ts';

// The most one file may hold, as stored (text as UTF-8, bytes as base64). A Durable Object
// caps a row at 8 MB; MAX_ATTACHMENT_BYTES of base64 is under this.
export const MAX_FILE_BYTES = 7 * 1024 * 1024;

// The most page text one readMany call returns, so a reply stays far under the Workers
// RPC cap. The caller asks again for the paths left over.
const READ_BATCH_BYTES = 8 * 1024 * 1024;

const BRANCH = 'main';

export interface SqlWrite {
	message: string;
	writes?: FileWrite[];
	deletes?: string[];
	// The revision this write was planned against. A write onto any other is refused.
	base?: string;
	author?: CommitAuthor;
	// ISO time the commit is recorded at.
	at: string;
}

export interface SqlFile {
	// Text as written; bytes as base64.
	content: string;
	binary: boolean;
	version: string;
	size: number;
}

// What the storage does.
export interface SqlFilesSync {
	revision(): string;
	list(extension: string): FileEntry[];
	read(path: string, at?: string): SqlFile | null;
	readMany(paths: string[]): ReadBatch;
	write(opts: SqlWrite): SqlWriteResult;
	history(limit: number, path?: string): CommitEntry[];
}

// The same operations where each may answer later, which is what sqlBrainStore takes: the
// storage directly, or a Durable Object holding it, over RPC.
export type SqlFilesApi = {
	[K in keyof SqlFilesSync]: (
		...args: Parameters<SqlFilesSync[K]>
	) => ReturnType<SqlFilesSync[K]> | Promise<ReturnType<SqlFilesSync[K]>>;
};

export interface ReadBatch {
	pages: PageContent[];
	// The paths not reached; ask again with these.
	rest: string[];
}

export interface SqlWriteResult {
	revision: string;
	versions: Record<string, string>;
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

// A path as the tools write it: relative, forward slashes, no empty or dot segments.
function checkPath(path: string): void {
	const ok =
		path.length > 0 &&
		!path.includes('\\') &&
		path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
	if (!ok) throw new Error(`Not a path inside the brain: ${JSON.stringify(path)}`);
}

// The file's size as stored, or a refusal when it is over the limit.
function storedSize(w: FileWrite): number {
	const size = w.encoding === 'base64' ? w.content.length : utf8Bytes(w.content);
	if (size > MAX_FILE_BYTES) {
		throw new Error(
			`${w.path} is ${(size / (1024 * 1024)).toFixed(1)} MB as stored, and a file holds at most ${MAX_FILE_BYTES / (1024 * 1024)} MB.`
		);
	}
	return size;
}

const textOf = (file: SqlFile): string => (file.binary ? base64ToUtf8(file.content) : file.content);

type Row = Record<string, string | number | null>;

export function sqlFiles(db: SqlDatabase): SqlFilesSync {
	const rows = (query: string, ...bindings: (string | number | null)[]) =>
		db.sql.exec(query, ...bindings).toArray() as Row[];

	db.transaction(() => {
		rows(
			`CREATE TABLE IF NOT EXISTS commits (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				message TEXT NOT NULL,
				author_name TEXT,
				author_email TEXT,
				at TEXT NOT NULL
			)`
		);
		// One row per file per commit that touched it. `body` NULL records a delete.
		rows(
			`CREATE TABLE IF NOT EXISTS versions (
				path TEXT NOT NULL,
				seq INTEGER NOT NULL,
				body TEXT,
				binary INTEGER NOT NULL DEFAULT 0,
				size INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (path, seq)
			)`
		);
		// The files that exist now, each at the commit that last changed it.
		rows(
			'CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, seq INTEGER NOT NULL) WITHOUT ROWID'
		);
	});

	const revision = (): string =>
		String(rows('SELECT COALESCE(MAX(seq), 0) AS seq FROM commits')[0].seq);

	const fileOf = (row: Row | undefined): SqlFile | null =>
		row && row.body !== null
			? {
					content: String(row.body),
					binary: row.binary === 1,
					version: String(row.seq),
					size: Number(row.size)
				}
			: null;

	// The newest version at or before `at` (default: now). A delete is a version with no
	// body, so a file that is gone reads as null from then on.
	const read = (path: string, at?: string): SqlFile | null =>
		fileOf(
			rows(
				`SELECT seq, body, binary, size FROM versions
				 WHERE path = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`,
				path,
				at === undefined ? Number.MAX_SAFE_INTEGER : Number(at)
			)[0]
		);

	return {
		revision,
		read,

		list(extension) {
			const all = rows('SELECT path, seq FROM files ORDER BY path');
			return all
				.filter((r) => extension === '*' || String(r.path).endsWith(extension))
				.map((r) => ({ path: String(r.path), version: String(r.seq) }));
		},

		readMany(paths) {
			const pages: PageContent[] = [];
			let bytes = 0;
			for (const [i, path] of paths.entries()) {
				const file = read(path);
				// Gone since it was listed; the next read of the brain reconciles it.
				if (!file) continue;
				if (pages.length > 0 && bytes + file.size > READ_BATCH_BYTES) {
					return { pages, rest: paths.slice(i) };
				}
				bytes += file.size;
				pages.push({ path, content: textOf(file) });
			}
			return { pages, rest: [] };
		},

		write(opts) {
			const writes = opts.writes ?? [];
			const deletes = opts.deletes ?? [];
			for (const w of writes) checkPath(w.path);
			const sizes = writes.map(storedSize);
			return db.transaction(() => {
				const head = revision();
				if (opts.base !== undefined && opts.base !== head) {
					throw new Error(
						'The brain changed since this write was planned. Read it again and retry the change.'
					);
				}
				const seq = Number(
					rows(
						'INSERT INTO commits (message, author_name, author_email, at) VALUES (?, ?, ?, ?) RETURNING seq',
						opts.message,
						opts.author?.name ?? null,
						opts.author?.email ?? null,
						opts.at
					)[0].seq
				);
				const versions: Record<string, string> = {};
				for (const [i, w] of writes.entries()) {
					rows(
						'INSERT OR REPLACE INTO versions (path, seq, body, binary, size) VALUES (?, ?, ?, ?, ?)',
						w.path,
						seq,
						w.content,
						w.encoding === 'base64' ? 1 : 0,
						sizes[i]
					);
					rows('INSERT OR REPLACE INTO files (path, seq) VALUES (?, ?)', w.path, seq);
					versions[w.path] = String(seq);
				}
				for (const path of deletes) {
					if (rows('DELETE FROM files WHERE path = ? RETURNING path', path).length === 0) continue;
					rows('INSERT OR REPLACE INTO versions (path, seq, body) VALUES (?, ?, NULL)', path, seq);
					delete versions[path];
				}
				return { revision: String(seq), versions };
			});
		},

		history(limit, path) {
			const found = path
				? rows(
						// Ordered by the versions key, so the scan stops at `limit`.
						`SELECT c.seq, c.message, c.author_name, c.at FROM versions v
						 JOIN commits c ON c.seq = v.seq WHERE v.path = ? ORDER BY v.seq DESC LIMIT ?`,
						path,
						limit
					)
				: rows(
						'SELECT seq, message, author_name, at FROM commits ORDER BY seq DESC LIMIT ?',
						limit
					);
			return found.map((r) => ({
				sha: String(r.seq),
				message: String(r.message),
				authorName: r.author_name === null ? 'Isomorphic' : String(r.author_name),
				date: String(r.at)
			}));
		}
	};
}

// The name of a brain's files object. A deployment that shares its objects Worker with
// others (a pull request's Preview) sets a scope, so two of them never address the same
// object.
export function filesObjectName(brainId: string, scope?: string): string {
	return scope ? `${scope}:${brainId}` : brainId;
}

const revisionOf = (id: string): Revision => ({ id, branch: BRANCH, snapshot: id });

// A ref that names a revision pins a read to it; a branch name reads what is there now.
const pinned = (ref?: string): string | undefined =>
	ref !== undefined && /^\d+$/.test(ref) ? ref : undefined;

// The BrainStore for one brain. The locator selects nothing: `files` already is the brain.
export function sqlBrainStore(
	files: SqlFilesApi,
	now: () => string = () => new Date().toISOString()
): BrainStore {
	const write = async (o: WriteOpts): Promise<WriteResult> => {
		const res = await files.write({
			message: o.message,
			writes: o.writes,
			deletes: o.deletes,
			base: o.base?.id,
			author: o.author,
			at: now()
		});
		return { revision: revisionOf(res.revision), versions: res.versions };
	};
	const revision = async () => revisionOf(await files.revision());

	return defineStore({
		// A write is one transaction, and every commit is kept. Nothing holds a change for
		// review.
		capabilities: { atomicWrite: true, proposals: false, history: true },
		getRevision: revision,
		writeBase: revision,
		branchRevision: async () => files.revision(),
		repoWritePolicy: async () => ({
			defaultBranch: BRANCH,
			branchProtected: false,
			mergeMethod: 'MERGE'
		}),
		listTree: async (_loc, _at, o) => files.list(o?.extension ?? '.md'),

		fetchPages: async (_loc, entries) => {
			const pages: PageContent[] = [];
			let rest = entries.slice(0, MAX_SCAN_PAGES).map((e) => e.path);
			while (rest.length > 0) {
				const batch = await files.readMany(rest);
				pages.push(...batch.pages);
				rest = batch.rest;
			}
			return { pages, truncated: entries.length > MAX_SCAN_PAGES };
		},

		readFile: async (_loc, path, ref) => {
			const file = await files.read(path, pinned(ref));
			if (!file) return null;
			return { content: textOf(file), version: file.version };
		},

		readBinary: async (_loc, path, ref): Promise<BinaryContent | null> => {
			const file = await files.read(path, pinned(ref));
			if (!file) return null;
			if (file.binary) {
				return {
					contentBase64: file.content,
					version: file.version,
					// `size` is the base64's length; the bytes are three for every four characters,
					// less the padding.
					size:
						Math.floor((file.size * 3) / 4) -
						(file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0)
				};
			}
			const bytes = new TextEncoder().encode(file.content);
			return { contentBase64: base64FromBytes(bytes), version: file.version, size: bytes.length };
		},

		findOpenConfigPr: async () => undefined,
		listCommits: async (_loc, o) => files.history(o.limit, o.path),
		write: (_loc, o) => write(o),
		// Pull-request mode never reaches here: defineStore refuses it. The revision is
		// exactly the commit this write made, so it is safe to write through.
		commitOrPR: async (_loc, o) => ({ landed: await write(o) })
	});
}
