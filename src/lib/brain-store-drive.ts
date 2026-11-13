// A brain's files in a Google Drive folder: the store for a brain kept in the customer's
// own Drive (a folder in My Drive, or in a shared drive). Runtime-portable (Worker-safe,
// no node:*). pnpm test:store.
//
// Drive addresses files by id and lets one folder hold two files of the same name, so
// every operation goes through a listing of the folder tree that maps paths to ids. The
// oldest file holds a contested path, and the others are reported as `duplicates`.
//
// A revision is a digest of that listing (every path and its version tag), so it moves
// when any file under the folder does and only then. A file's version tag is the md5 of
// its bytes, as Drive reports it.
//
// Drive writes one file at a time and has no conditional write, so a bundle lands
// through the write coordinator (write-coordinator.ts), and the check that a file is
// still at the version it was read at is a metadata read just before the upload. An edit
// from outside in between is overwritten, and shows as a changed revision on the next read.

import {
	MAX_SCAN_PAGES,
	WriteConflictError,
	defineStore,
	type BinaryContent,
	type BrainStore,
	type FileEntry,
	type PageContent,
	type Revision,
	type WriteOpts,
	type WriteResult
} from './brain-repo.ts';
import { base64FromBytes, bytesFromBase64 } from './media.ts';
import type { FileBackend, WriteCoordinator } from './write-coordinator.ts';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
// Docs, Sheets, shortcuts and the rest of Drive's own types have no bytes to read.
const NATIVE_PREFIX = 'application/vnd.google-apps.';
const BRANCH = 'main';

// Folders named in one files.list query, and queries or downloads in flight at once.
const PARENTS_PER_QUERY = 40;
const CONCURRENCY = 8;
// Attempts at one request that Drive throttled or failed (429, 5xx, a rate-limit 403).
const ATTEMPTS = 4;

// Where one brain lives: the folder its paths are relative to.
export interface DriveRoot {
	folderId: string;
}

export interface DriveItem {
	id: string;
	name: string;
	mimeType: string;
	parents?: string[];
	md5Checksum?: string;
	headRevisionId?: string;
	size?: string;
	createdTime?: string;
	trashed?: boolean;
}

export class DriveError extends Error {
	override readonly name = 'DriveError';
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

// The Drive v3 calls the store makes.
export interface DriveApi {
	// Every untrashed item directly inside any of these folders.
	children(parents: string[]): Promise<DriveItem[]>;
	// Null when the file is gone.
	meta(id: string): Promise<DriveItem | null>;
	download(id: string): Promise<Uint8Array | null>;
	create(parent: string, name: string, bytes: Uint8Array): Promise<DriveItem>;
	update(id: string, bytes: Uint8Array): Promise<DriveItem>;
	createFolder(parent: string, name: string): Promise<DriveItem>;
	trash(id: string): Promise<void>;
}

const FIELDS = 'id,name,mimeType,parents,md5Checksum,headRevisionId,size,createdTime,trashed';

const contentTypeOf = (name: string): string =>
	name.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

// `token` is asked for on every request, so a caller can refresh it. `pause` waits
// between attempts.
export function driveApi(
	fetcher: typeof fetch,
	token: () => Promise<string>,
	pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): DriveApi {
	const throttled = async (res: Response): Promise<boolean> => {
		if (res.status === 429 || res.status >= 500) return true;
		if (res.status !== 403) return false;
		return /rateLimitExceeded/i.test(await res.clone().text());
	};
	// The response, or null on 404.
	const call = async (url: string, init: RequestInit = {}): Promise<Response | null> => {
		for (let attempt = 1; ; attempt++) {
			const res = await fetcher(url, {
				...init,
				headers: { ...init.headers, authorization: `Bearer ${await token()}` }
			});
			if (res.ok) return res;
			if (res.status === 404) return null;
			if (attempt < ATTEMPTS && (await throttled(res))) {
				await pause(250 * 2 ** attempt);
				continue;
			}
			const detail = (await res.text()).slice(0, 300);
			throw new DriveError(res.status, `Google Drive answered ${res.status}: ${detail}`);
		}
	};
	const must = async (url: string, init?: RequestInit): Promise<Response> => {
		const res = await call(url, init);
		if (!res) throw new DriveError(404, 'Google Drive no longer has that file or folder.');
		return res;
	};
	const json = { 'content-type': 'application/json' };
	const shared = 'supportsAllDrives=true';

	return {
		async children(parents) {
			const q = `(${parents.map((p) => `'${p}' in parents`).join(' or ')}) and trashed = false`;
			const items: DriveItem[] = [];
			let pageToken: string | undefined;
			do {
				const params = new URLSearchParams({
					q,
					fields: `nextPageToken,files(${FIELDS})`,
					pageSize: '1000',
					supportsAllDrives: 'true',
					includeItemsFromAllDrives: 'true'
				});
				if (pageToken) params.set('pageToken', pageToken);
				const page = (await (await must(`${API}/files?${params}`)).json()) as {
					files?: DriveItem[];
					nextPageToken?: string;
				};
				items.push(...(page.files ?? []));
				pageToken = page.nextPageToken;
			} while (pageToken);
			return items;
		},

		async meta(id) {
			const res = await call(`${API}/files/${id}?fields=${FIELDS}&${shared}`);
			return res ? ((await res.json()) as DriveItem) : null;
		},

		async download(id) {
			const res = await call(`${API}/files/${id}?alt=media&${shared}`);
			return res ? new Uint8Array(await res.arrayBuffer()) : null;
		},

		async create(parent, name, bytes) {
			// One multipart request carries the metadata and the bytes, so a failed upload
			// leaves no empty file behind.
			const boundary = `isomorphic-${crypto.randomUUID()}`;
			const type = contentTypeOf(name);
			const head =
				`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
				`${JSON.stringify({ name, parents: [parent], mimeType: type })}\r\n` +
				`--${boundary}\r\ncontent-type: ${type}\r\n\r\n`;
			const enc = new TextEncoder();
			const body = concat([enc.encode(head), bytes, enc.encode(`\r\n--${boundary}--`)]);
			const res = await must(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}&${shared}`, {
				method: 'POST',
				headers: { 'content-type': `multipart/related; boundary=${boundary}` },
				body: body as BodyInit
			});
			return (await res.json()) as DriveItem;
		},

		async update(id, bytes) {
			const res = await must(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}&${shared}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/octet-stream' },
				body: bytes as BodyInit
			});
			return (await res.json()) as DriveItem;
		},

		async createFolder(parent, name) {
			const res = await must(`${API}/files?fields=${FIELDS}&${shared}`, {
				method: 'POST',
				headers: json,
				body: JSON.stringify({ name, parents: [parent], mimeType: FOLDER_TYPE })
			});
			return (await res.json()) as DriveItem;
		},

		async trash(id) {
			// Trashed rather than deleted: the owner can still restore it from Drive.
			await must(`${API}/files/${id}?fields=id&${shared}`, {
				method: 'PATCH',
				headers: json,
				body: JSON.stringify({ trashed: true })
			});
		}
	};
}

export interface DriveFile {
	id: string;
	version: string;
}

// One reading of a brain's folder tree.
export interface DriveListing {
	// The revision: a digest of every path and version.
	id: string;
	files: Map<string, DriveFile>;
	// Folder path to id; the root is ''.
	folders: Map<string, string>;
	// Paths a second file or folder also claims. The oldest holds the path.
	duplicates: string[];
}

const versionOf = (item: DriveItem): string | undefined => item.md5Checksum || item.headRevisionId;

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

async function digest(files: Map<string, DriveFile>): Promise<string> {
	const lines = [...files].map(([path, f]) => `${path}\n${f.version}\n`).sort();
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('')));
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Walks the folder tree a level at a time, many folders to a query.
export async function listDrive(api: DriveApi, root: DriveRoot): Promise<DriveListing> {
	const files = new Map<string, DriveFile>();
	const folders = new Map<string, string>([['', root.folderId]]);
	const duplicates: string[] = [];
	let level = new Map<string, string>([[root.folderId, '']]);
	while (level.size > 0) {
		const ids = [...level.keys()];
		const batches: string[][] = [];
		for (let i = 0; i < ids.length; i += PARENTS_PER_QUERY) {
			batches.push(ids.slice(i, i + PARENTS_PER_QUERY));
		}
		const found = (await mapLimit(batches, CONCURRENCY, (b) => api.children(b))).flat();
		// Oldest first, so the oldest of two items with one name takes the path.
		found.sort(
			(a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || a.id.localeCompare(b.id)
		);
		const next = new Map<string, string>();
		for (const item of found) {
			const parent = item.parents?.find((p) => level.has(p));
			// A name holding a slash cannot be a path segment.
			if (parent === undefined || !item.name || item.name.includes('/')) continue;
			const dir = level.get(parent)!;
			const path = dir ? `${dir}/${item.name}` : item.name;
			const folder = item.mimeType === FOLDER_TYPE;
			if (!folder && item.mimeType.startsWith(NATIVE_PREFIX)) continue;
			const version = versionOf(item);
			if (!folder && !version) continue;
			if (files.has(path) || folders.has(path)) {
				duplicates.push(path);
				continue;
			}
			if (folder) {
				folders.set(path, item.id);
				next.set(item.id, path);
			} else {
				files.set(path, { id: item.id, version: version! });
			}
		}
		level = next;
	}
	return { id: await digest(files), files, folders, duplicates };
}

const bytesOf = (file: { content: string; encoding?: 'utf-8' | 'base64' }): Uint8Array =>
	file.encoding === 'base64'
		? bytesFromBase64(file.content)
		: new TextEncoder().encode(file.content);

// The storage a brain's journal entries are recorded against.
export const driveStorageName = (root: DriveRoot): string => `google-drive:${root.folderId}`;

// One file at a time, for the write coordinator. It reads and updates `listing` as it
// goes, so the caller's listing describes the folder after the bundle.
function driveBackend(api: DriveApi, root: DriveRoot, listing: DriveListing): FileBackend {
	// The file's version now, or null when it is gone or in the trash.
	const versionNow = async (id: string): Promise<string | null> => {
		const item = await api.meta(id);
		return item && !item.trashed ? (versionOf(item) ?? null) : null;
	};
	const folderFor = async (path: string): Promise<string> => {
		const segments = path.split('/').slice(0, -1);
		let dir = '';
		let id = root.folderId;
		for (const segment of segments) {
			dir = dir ? `${dir}/${segment}` : segment;
			const known = listing.folders.get(dir);
			if (known) {
				id = known;
				continue;
			}
			id = (await api.createFolder(id, segment)).id;
			listing.folders.set(dir, id);
		}
		return id;
	};
	const written = (path: string, item: DriveItem): string => {
		const version = versionOf(item);
		if (!version) throw new Error(`Google Drive reported no version for ${path}.`);
		listing.files.set(path, { id: item.id, version });
		return version;
	};

	return {
		storage: driveStorageName(root),

		async read(path, encoding) {
			const file = listing.files.get(path);
			if (!file) return null;
			const [version, bytes] = await Promise.all([versionNow(file.id), api.download(file.id)]);
			if (version === null || !bytes) return null;
			return {
				content: encoding === 'base64' ? base64FromBytes(bytes) : new TextDecoder().decode(bytes),
				version
			};
		},

		async put(path, file, ifVersion) {
			const existing = listing.files.get(path);
			if (!existing) {
				if (ifVersion !== null) throw new WriteConflictError(path);
				const name = path.split('/').pop()!;
				return written(path, await api.create(await folderFor(path), name, bytesOf(file)));
			}
			if ((await versionNow(existing.id)) !== ifVersion) throw new WriteConflictError(path);
			return written(path, await api.update(existing.id, bytesOf(file)));
		},

		async remove(path, ifVersion) {
			const existing = listing.files.get(path);
			if (!existing || (await versionNow(existing.id)) !== ifVersion) {
				throw new WriteConflictError(path);
			}
			await api.trash(existing.id);
			listing.files.delete(path);
		}
	};
}

const revisionOf = (id: string): Revision => ({ id, branch: BRANCH, snapshot: id });

// The BrainStore for one brain. The locator selects nothing: `root` already is the brain.
// Build one per request: it lists the folder once and answers from that listing until it
// writes.
export function driveBrainStore(
	api: DriveApi,
	root: DriveRoot,
	coordinator: WriteCoordinator,
	brainId: string
): BrainStore {
	let current: Promise<DriveListing> | null = null;
	// Per revision this store has reported, each path's version: what a write planned on
	// that revision expects to find.
	const seen = new Map<string, Map<string, string>>();
	const remember = (l: DriveListing): DriveListing => {
		seen.set(l.id, new Map([...l.files].map(([path, f]) => [path, f.version])));
		return l;
	};
	const listing = (): Promise<DriveListing> => (current ??= listDrive(api, root).then(remember));
	const revision = async (): Promise<Revision> => revisionOf((await listing()).id);

	const bytesAt = async (path: string): Promise<{ bytes: Uint8Array; version: string } | null> => {
		const file = (await listing()).files.get(path);
		if (!file) return null;
		const bytes = await api.download(file.id);
		return bytes ? { bytes, version: file.version } : null;
	};

	const write = async (o: WriteOpts): Promise<WriteResult> => {
		const l = await listing();
		const planned = o.base ? seen.get(o.base.id) : undefined;
		if (o.base && !planned) {
			throw new Error(
				'The brain changed since this write was planned. Read it again and retry the change.'
			);
		}
		const paths = [...(o.writes ?? []).map((w) => w.path), ...(o.deletes ?? [])];
		const expected = planned
			? Object.fromEntries(paths.map((p) => [p, planned.get(p) ?? null]))
			: undefined;
		try {
			const res = await coordinator.write(brainId, driveBackend(api, root, l), {
				message: o.message,
				writes: o.writes,
				deletes: o.deletes,
				expected
			});
			// A bundle recovered on the way changed files this listing never saw.
			if (res.recovered) current = null;
			else remember(Object.assign(l, { id: await digest(l.files) }));
			return { revision: await revision(), versions: res.versions };
		} catch (e) {
			current = null;
			throw e;
		}
	};

	return defineStore({
		// Drive writes one file at a time, holds nothing for review, and its versions are
		// per file.
		capabilities: { atomicWrite: false, proposals: false, history: false },
		getRevision: revision,
		writeBase: revision,
		branchRevision: async () => (await listing()).id,
		repoWritePolicy: async () => ({
			defaultBranch: BRANCH,
			branchProtected: false,
			mergeMethod: 'MERGE'
		}),

		listTree: async (_loc, _at, o) => {
			const extension = o?.extension ?? '.md';
			const entries: FileEntry[] = [];
			for (const [path, f] of (await listing()).files) {
				if (path.endsWith(extension)) entries.push({ path, version: f.version });
			}
			return entries.sort((a, b) => a.path.localeCompare(b.path));
		},

		fetchPages: async (_loc, entries) => {
			const wanted = entries.slice(0, MAX_SCAN_PAGES);
			const read = await mapLimit(wanted, CONCURRENCY, async (e): Promise<PageContent | null> => {
				const file = await bytesAt(e.path);
				return file && { path: e.path, content: new TextDecoder().decode(file.bytes) };
			});
			return {
				pages: read.filter((p): p is PageContent => p !== null),
				truncated: entries.length > MAX_SCAN_PAGES
			};
		},

		// Drive keeps no revision of the whole folder, so `ref` cannot pin a read.
		readFile: async (_loc, path) => {
			const file = await bytesAt(path);
			return file && { content: new TextDecoder().decode(file.bytes), version: file.version };
		},

		readBinary: async (_loc, path): Promise<BinaryContent | null> => {
			const file = await bytesAt(path);
			return (
				file && {
					contentBase64: base64FromBytes(file.bytes),
					version: file.version,
					size: file.bytes.length
				}
			);
		},

		findOpenConfigPr: async () => undefined,
		listCommits: async () => [],
		write: (_loc, o) => write(o),
		// Pull-request mode never reaches here: defineStore refuses it.
		commitOrPR: async (_loc, o) => ({ landed: await write(o) })
	});
}
