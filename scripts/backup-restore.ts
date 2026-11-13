// Opens a backup of a brain the deployment holds into a folder of files
// (src/lib/brain-backup.ts, docs/ops/backups.md).
//
//   pnpm backup:restore --brain <brain-id> --key <private-key-file> --out <folder>
//                       (--bucket <name> | --from <folder>) [--backup <id>]
//
// --bucket reads the bucket through `wrangler r2 object get --remote`, with Wrangler's
// own credentials. --from reads a folder that holds the bucket's objects under their
// keys. Without --backup the newest backup is opened. The folder it writes is the
// brain's files and nothing else: serve it with `pnpm try`, or push it to a repository
// and connect that.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
	importBackupPrivateKey,
	readBackup,
	type BackupManifest,
	type BackupReader
} from '../src/lib/brain-backup.ts';

const exec = promisify(execFile);

export const folderReader =
	(folder: string): BackupReader =>
	async (key) => {
		const file = join(folder, key);
		return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
	};

function bucketReader(bucket: string): BackupReader {
	const dir = mkdtempSync(join(tmpdir(), 'isomorphic-restore-'));
	process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
	let n = 0;
	return async (key) => {
		const file = join(dir, String(n++));
		try {
			await exec(
				'pnpm',
				['exec', 'wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', file],
				{ maxBuffer: 10 * 1024 * 1024 }
			);
		} catch (e) {
			const output = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
			if (/not exist|not found|NoSuchKey|404/i.test(output)) return null;
			throw new Error(`Could not read ${bucket}/${key}:\n${output || (e as Error).message}`);
		}
		if (!existsSync(file)) return null;
		const bytes = new Uint8Array(readFileSync(file));
		rmSync(file);
		return bytes;
	};
}

// Writes the backup's files under `out`, which must be empty or absent.
export async function restoreInto(
	get: BackupReader,
	privateKeyBase64: string,
	brain: string,
	out: string,
	id?: string
): Promise<BackupManifest> {
	const root = resolve(out);
	if (existsSync(root) && readdirSync(root).length > 0) {
		throw new Error(`${root} is not empty.`);
	}
	const backup = await readBackup(get, await importBackupPrivateKey(privateKeyBase64), brain, id);
	let written = 0;
	for await (const file of backup.files()) {
		const target = resolve(root, file.path);
		if (!target.startsWith(root + sep))
			throw new Error(`Not a path inside the brain: ${file.path}`);
		mkdirSync(dirname(target), { recursive: true });
		await writeFile(target, file.bytes);
		written++;
	}
	if (written !== backup.manifest.files) {
		throw new Error(
			`The backup lists ${backup.manifest.files} files and held ${written}. ${root} is incomplete.`
		);
	}
	return backup.manifest;
}

async function main(argv: string[]): Promise<void> {
	const arg = (name: string) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const [brain, key, out, bucket, from] = ['brain', 'key', 'out', 'bucket', 'from'].map(arg);
	if (!brain || !key || !out || (!bucket && !from)) {
		console.error(
			'usage: pnpm backup:restore --brain <brain-id> --key <private-key-file> --out <folder>\n' +
				'                           (--bucket <name> | --from <folder>) [--backup <id>]'
		);
		process.exit(1);
	}
	const get = from ? folderReader(from) : bucketReader(bucket!);
	const done = await restoreInto(get, readFileSync(key, 'utf8'), brain, out, arg('backup'));
	console.log(
		`Restored ${done.files} files of ${brain} at revision ${done.revision}, backed up ${done.at}, into ${resolve(out)}.`
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main(process.argv.slice(2)).catch((e) => {
		console.error((e as Error).message);
		process.exit(1);
	});
}
