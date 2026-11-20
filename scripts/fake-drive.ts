// A drive that writes one file at a time, for the write coordinator's batteries
// (test-coordinator calls its backend directly; test-objects serves it over HTTP to a
// Worker). Versions are a counter, as an eTag would be; a put or remove at the wrong
// version throws WriteConflictError, and `down` fails every call.

import { WriteConflictError } from '../src/lib/brain-repo.ts';
import type { FileBackend } from '../src/lib/write-coordinator.ts';

export function fakeDrive(initial: Record<string, string | Buffer> = {}) {
	const files = new Map<string, { bytes: Buffer; version: string }>();
	let n = 0;
	const set = (path: string, bytes: Buffer): string => {
		const version = `v${++n}`;
		files.set(path, { bytes, version });
		return version;
	};
	for (const [p, c] of Object.entries(initial)) set(p, Buffer.from(c));
	// Every put and remove: recorded, then the test's hook, then the outage check.
	const enter = async (op: string, path: string): Promise<void> => {
		drive.calls.push(`${op} ${path}`);
		await drive.before(op, path);
		if (drive.down) throw new Error('drive unavailable');
	};
	const drive = {
		files,
		calls: [] as string[],
		down: false,
		// Runs before each put or remove, after the call is recorded.
		before: async (_op: string, _path: string): Promise<void> => {},
		text: (path: string): string | undefined => files.get(path)?.bytes.toString('utf-8'),
		// An edit from outside Isomorphic.
		edit: (path: string, content: string | Buffer): string => set(path, Buffer.from(content)),
		backend: {
			storage: 'drive:test',
			async read(path, encoding) {
				if (drive.down) throw new Error('drive unavailable');
				const f = files.get(path);
				if (!f) return null;
				return {
					content: f.bytes.toString(encoding === 'base64' ? 'base64' : 'utf-8'),
					version: f.version
				};
			},
			async put(path, file, ifVersion) {
				await enter('put', path);
				if ((files.get(path)?.version ?? null) !== ifVersion) throw new WriteConflictError(path);
				return set(
					path,
					Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf-8')
				);
			},
			async remove(path, ifVersion) {
				await enter('remove', path);
				if (files.get(path)?.version !== ifVersion) throw new WriteConflictError(path);
				files.delete(path);
			}
		} satisfies FileBackend
	};
	return drive;
}

export const gate = () => {
	let open!: () => void;
	const opened = new Promise<void>((r) => (open = r));
	return { open, opened };
};
