// A fake Google Drive for batteries that drive the REAL Drive store (driveApi, listDrive,
// driveBrainStore) without a network. It implements the Drive v3 requests that store
// makes, as a `fetch`: files.list by parent, files.get (metadata and alt=media), the
// multipart create, the media update, folder creation and trashing.
//
// Like Drive it addresses files by id, lets one folder hold two items of one name, and
// reports the md5 of a file's bytes, computed here with node:crypto so a battery checks
// the store's version tags against the bytes and not against the store.

import { createHash } from 'node:crypto';

const FOLDER = 'application/vnd.google-apps.folder';

interface Item {
	id: string;
	name: string;
	mimeType: string;
	parent: string;
	bytes: Buffer | null;
	createdTime: string;
	trashed: boolean;
}

export const md5 = (content: string | Uint8Array): string =>
	createHash('md5').update(content).digest('hex');

export function fakeGoogleDrive(opts: { token?: string; pageSize?: number } = {}) {
	const token = opts.token ?? 'test-token';
	const pageSize = opts.pageSize ?? 1000;
	const items = new Map<string, Item>();
	let n = 0;
	const add = (parent: string, name: string, mimeType: string, bytes: Buffer | null): Item => {
		n++;
		const item: Item = {
			id: `id-${String(n).padStart(4, '0')}`,
			name,
			mimeType,
			parent,
			bytes,
			createdTime: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
			trashed: false
		};
		items.set(item.id, item);
		return item;
	};
	const root = add('', 'brain', FOLDER, null);

	const view = (i: Item) => ({
		id: i.id,
		name: i.name,
		mimeType: i.mimeType,
		parents: [i.parent],
		createdTime: i.createdTime,
		trashed: i.trashed,
		...(i.bytes ? { md5Checksum: md5(i.bytes), size: String(i.bytes.length) } : {})
	});
	const child = (parent: string, name: string): Item | undefined =>
		[...items.values()].find((i) => i.parent === parent && i.name === name && !i.trashed);
	const pathOf = (i: Item): string => {
		const parent = items.get(i.parent);
		return parent && parent !== root ? `${pathOf(parent)}/${i.name}` : i.name;
	};
	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	const drive = {
		rootId: root.id,
		// One line per request: the method and what it addressed.
		calls: [] as string[],
		// Answers the next requests matching `match` with this status instead of serving them.
		failures: [] as { match: RegExp; status: number; body?: string; times: number }[],
		// Runs before a request is served, after it is recorded.
		before: async (_call: string): Promise<void> => {},

		// The folder at `path` under the root, made if absent.
		folder(path: string): string {
			let at = root.id;
			for (const name of path.split('/').filter(Boolean)) {
				at = (child(at, name) ?? add(at, name, FOLDER, null)).id;
			}
			return at;
		},
		// A file put there from outside Isomorphic. Always a new item, as Drive would make.
		put(path: string, content: string | Buffer, mimeType = 'text/markdown'): string {
			const segments = path.split('/');
			const name = segments.pop()!;
			return add(drive.folder(segments.join('/')), name, mimeType, Buffer.from(content)).id;
		},
		// A file with exactly this name, which Drive lets hold a slash.
		named(folder: string, name: string, content: string): string {
			return add(drive.folder(folder), name, 'text/markdown', Buffer.from(content)).id;
		},
		// An edit from outside Isomorphic to the file holding `path`.
		edit(path: string, content: string): void {
			const item = drive.find(path);
			if (!item) throw new Error(`no file at ${path}`);
			item.bytes = Buffer.from(content);
		},
		find(path: string): Item | undefined {
			return [...items.values()].find((i) => !i.trashed && i.bytes && pathOf(i) === path);
		},
		// Every untrashed file, path to text.
		tree(): Record<string, string> {
			const out: Record<string, string> = {};
			for (const i of items.values()) {
				if (i.bytes && !i.trashed) out[pathOf(i)] = i.bytes.toString('utf-8');
			}
			return out;
		},
		trashed: (): string[] => [...items.values()].filter((i) => i.trashed).map(pathOf),
		folders: (): string[] =>
			[...items.values()].filter((i) => i.mimeType === FOLDER && i !== root).map(pathOf),

		fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
			const url = new URL(String(input));
			const method = init.method ?? 'GET';
			const call = `${method} ${url.pathname}${url.searchParams.get('alt') === 'media' ? ' media' : ''}`;
			drive.calls.push(call);
			await drive.before(call);
			const failure = drive.failures.find((f) => f.times > 0 && f.match.test(call));
			if (failure) {
				failure.times--;
				return new Response(failure.body ?? 'failed', { status: failure.status });
			}
			const headers = new Headers(init.headers);
			if (headers.get('authorization') !== `Bearer ${token}`) return json({ error: 'auth' }, 401);

			const upload = url.pathname.startsWith('/upload/drive/v3/files');
			const id = url.pathname.split('/files/')[1];
			const body =
				init.body === undefined || init.body === null
					? Buffer.alloc(0)
					: typeof init.body === 'string'
						? Buffer.from(init.body)
						: Buffer.from(init.body as Uint8Array);

			if (method === 'GET' && !id) {
				const q = url.searchParams.get('q') ?? '';
				const parents = new Set([...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]));
				const found = [...items.values()].filter((i) => parents.has(i.parent) && !i.trashed);
				const from = Number(url.searchParams.get('pageToken') ?? 0);
				const size = Math.min(pageSize, Number(url.searchParams.get('pageSize') ?? pageSize));
				const page = found.slice(from, from + size);
				return json({
					files: page.map(view),
					...(from + size < found.length ? { nextPageToken: String(from + size) } : {})
				});
			}
			if (method === 'POST' && upload) {
				const boundary = /boundary=(.+)$/.exec(headers.get('content-type') ?? '')?.[1];
				if (!boundary) return json({ error: 'not multipart' }, 400);
				// Two parts: JSON metadata, then the bytes. Each is headers, a blank line, a body.
				const mark = Buffer.from(`--${boundary}`);
				const first = body.indexOf(mark) + mark.length;
				const second = body.indexOf(mark, first);
				const last = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
				const bodyOf = (part: Buffer): Buffer => part.subarray(part.indexOf('\r\n\r\n') + 4);
				const meta = JSON.parse(bodyOf(body.subarray(first, second - 2)).toString('utf-8')) as {
					name: string;
					parents: string[];
					mimeType: string;
				};
				const bytes = Buffer.from(bodyOf(body.subarray(second + mark.length, last)));
				if (!items.has(meta.parents[0])) return json({ error: 'no parent' }, 404);
				return json(view(add(meta.parents[0], meta.name, meta.mimeType, bytes)));
			}
			if (method === 'POST') {
				const meta = JSON.parse(body.toString('utf-8')) as {
					name: string;
					parents: string[];
					mimeType: string;
				};
				return json(view(add(meta.parents[0], meta.name, meta.mimeType, null)));
			}
			const item = id ? items.get(id) : undefined;
			if (!item) return json({ error: 'not found' }, 404);
			if (method === 'GET' && url.searchParams.get('alt') === 'media') {
				return new Response(new Uint8Array(item.bytes ?? Buffer.alloc(0)));
			}
			if (method === 'GET') return json(view(item));
			if (method === 'PATCH' && upload) {
				item.bytes = Buffer.from(body);
				return json(view(item));
			}
			if (method === 'PATCH') {
				const patch = JSON.parse(body.toString('utf-8')) as { trashed?: boolean };
				if (patch.trashed !== undefined) item.trashed = patch.trashed;
				return json(view(item));
			}
			return json({ error: 'unsupported' }, 400);
		}) as typeof fetch
	};
	return drive;
}
