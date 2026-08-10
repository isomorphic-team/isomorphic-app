// A BrainStore backed by a git repository on disk. Node-only, so not in src/lib/,
// which is typechecked against the Workers runtime and may not import `node:*`.
// Reachable only from src/local.ts.
//
// A git repo rather than a bare folder: commitFiles has to land a multi-file bundle
// whole or not at all, which write_page's edit batches depend on, and plain
// filesystem writes cannot do that. Committing also gives view_activity a history.
//
// Reads come from the WORKING TREE rather than `git ls-tree`, so a file edited in the
// user's own editor is visible without them committing first. The revision the content
// index compares against is therefore a digest of that tree (treeToken), not a commit
// sha; the index only asks whether anything changed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
	BrainStore,
	CommitEntry,
	CommitOpts,
	CommitOrPROpts,
	Head,
	PageContent,
	RepoWritePolicy,
	TreeEntry,
	WriteOutcome
} from '../lib/brain-repo.ts';

const exec = promisify(execFile);

// Never walked. Pointing a local brain at a project directory is normal, so skip the
// directories that would swamp the index.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv']);

export class LocalGitError extends Error {}

async function git(dir: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await exec('git', args, { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch (err) {
		const detail = (err as { stderr?: string })?.stderr ?? String(err);
		throw new LocalGitError(`git ${args[0]} failed in ${dir}: ${detail.trim()}`);
	}
}

interface Entry {
	path: string; // repo-relative, forward slashes
	size: number;
	mtimeMs: number;
}

// Recursive walk of the working tree. One stat per file and no contents read, so it
// is cheap enough to run on every read, which is what ensureFresh does.
async function walk(root: string): Promise<Entry[]> {
	const out: Entry[] = [];
	async function visit(dir: string): Promise<void> {
		const items = await readdir(dir, { withFileTypes: true });
		for (const item of items) {
			if (item.isDirectory()) {
				if (SKIP_DIRS.has(item.name)) continue;
				await visit(join(dir, item.name));
			} else if (item.isFile()) {
				const full = join(dir, item.name);
				const s = await stat(full);
				out.push({
					path: relative(root, full).split(sep).join('/'),
					size: s.size,
					mtimeMs: Math.floor(s.mtimeMs)
				});
			}
		}
	}
	await visit(root);
	return out;
}

// The per-file "blob sha" the content index diffs against. Size plus mtime, not a
// content hash: the index only compares for equality, and hashing every file on every
// read would mean reading the whole brain to detect a change.
const fileToken = (e: Entry) => `${e.size}-${e.mtimeMs}`;

// The whole-tree revision, standing in for a commit sha. Any create, delete, or edit
// moves it, including one made outside our tools.
function treeToken(entries: Entry[]): string {
	const h = createHash('sha1');
	for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		h.update(`${e.path}:${fileToken(e)}\n`);
	}
	return h.digest('hex');
}

// Nothing may be read or written outside the directory the operator pointed at.
// `path.resolve` collapses `..` before the check.
function safeJoin(root: string, path: string): string {
	const full = resolve(root, path);
	if (full !== root && !full.startsWith(root + sep)) {
		throw new LocalGitError(`Refusing to touch a path outside the brain: ${path}`);
	}
	return full;
}

export interface FsStoreOptions {
	dir: string;
	// Committer identity for writes. Falls back to the repo's own git config.
	author?: { name: string; email: string };
}

// The local content index lives inside the brain and survives restarts, but is derived
// data that must not be committed. Ignore the database files specifically rather than
// the whole `.isomorphic/` directory: the importer's ledger at
// `.isomorphic/imports/<source>.json` does belong in the repo.
const IGNORE_LINE = '.isomorphic/index.sqlite*';

async function ensureIndexIgnored(dir: string): Promise<void> {
	const path = join(dir, '.gitignore');
	const current = existsSync(path) ? await readFile(path, 'utf8') : '';
	if (current.split('\n').some((l) => l.trim() === IGNORE_LINE)) return;
	const prefix = current === '' || current.endsWith('\n') ? current : current + '\n';
	await writeFile(
		path,
		`${prefix}\n# Isomorphic's local content index (derived, do not commit)\n${IGNORE_LINE}\n`,
		'utf8'
	);
}

// Make `dir` a git repository if it is not one, and commit whatever was already in it.
// Without the initial commit the first tool write lands one file in an empty repo,
// view_activity shows a brain with no past, and nothing the user wrote is recoverable
// through git.
export async function ensureGitRepo(
	dir: string,
	author?: { name: string; email: string }
): Promise<void> {
	if (!existsSync(dir)) throw new LocalGitError(`No such directory: ${dir}`);
	const fresh = !existsSync(join(dir, '.git'));
	if (fresh) await git(dir, ['init']);
	await ensureIndexIgnored(dir);
	if (!fresh) return;

	await git(dir, ['add', '--all']);
	// --allow-empty so an empty folder still gets a HEAD for getHead to report.
	const args = [
		'commit',
		'--allow-empty',
		'-m',
		'Adopt existing files as a brain',
		'--no-gpg-sign'
	];
	if (author) args.push('--author', `${author.name} <${author.email}>`);
	// git refuses to commit without an identity. -c sets one for this command only.
	const ident = author ?? { name: 'Isomorphic', email: 'local@localhost' };
	await git(dir, ['-c', `user.name=${ident.name}`, '-c', `user.email=${ident.email}`, ...args]);
}

export function fsBrainStore(opts: FsStoreOptions): BrainStore {
	const root = resolve(opts.dir);

	const head = async (): Promise<Head> => {
		const entries = await walk(root);
		const token = treeToken(entries);
		let branch = 'main';
		try {
			branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
		} catch {
			// A repo with no commits yet still has a branch name we can serve.
		}
		// commitSha and treeSha are the same digest: for this backend "which revision"
		// and "which tree" are the same question.
		return { branch, commitSha: token, treeSha: token };
	};

	const commit = async (
		repoUnused: unknown,
		o: CommitOpts
	): Promise<{ sha: string; head: Head }> => {
		void repoUnused;
		// Capture what we are about to overwrite so a failure halfway can be undone.
		// Buffers, not strings: rolling a half-written bundle back through a utf8 decode
		// would silently corrupt any binary file it restored.
		const undo: Array<{ full: string; prior: Buffer | null }> = [];
		const touched = [...(o.writes ?? []).map((w) => w.path), ...(o.deletes ?? [])];
		try {
			for (const w of o.writes ?? []) {
				const full = safeJoin(root, w.path);
				undo.push({ full, prior: existsSync(full) ? await readFile(full) : null });
				await mkdir(dirname(full), { recursive: true });
				// Same rule as the GitHub adapter: a base64 write carries bytes, so decode
				// it rather than writing the encoded text to disk.
				if (w.encoding === 'base64') await writeFile(full, Buffer.from(w.content, 'base64'));
				else await writeFile(full, w.content, 'utf8');
			}
			for (const p of o.deletes ?? []) {
				const full = safeJoin(root, p);
				if (!existsSync(full)) continue;
				undo.push({ full, prior: await readFile(full) });
				await rm(full, { force: true });
			}
		} catch (err) {
			for (const u of undo.reverse()) {
				if (u.prior === null) await rm(u.full, { force: true });
				else await writeFile(u.full, u.prior);
			}
			throw err;
		}

		if (touched.length > 0) {
			await git(root, ['add', '--all', '--', ...touched.map((p) => safeJoin(root, p))]);
		}
		const author = o.author ?? opts.author;
		const args = ['commit', '-m', o.message, '--no-gpg-sign', '--allow-empty'];
		if (author) args.push('--author', `${author.name} <${author.email}>`);
		// -c, so a machine with no configured git identity can still commit.
		const ident = author ?? { name: 'Isomorphic', email: 'local@localhost' };
		await git(root, ['-c', `user.name=${ident.name}`, '-c', `user.email=${ident.email}`, ...args]);
		const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
		return { sha, head: await head() };
	};

	return {
		getHead: () => head(),

		// Every branch is the same working tree here, so the branch name selects nothing.
		// The tree digest moves whenever anything on disk moves, which is what the
		// index's freshness guard needs.
		branchCommitSha: async () => (await head()).commitSha,

		repoWritePolicy: async (): Promise<RepoWritePolicy> => {
			const h = await head();
			// Nothing gates a write to a directory you own.
			return { defaultBranch: h.branch, branchProtected: false, mergeMethod: 'MERGE' };
		},

		listTree: async (_repo, _head, o): Promise<TreeEntry[]> => {
			const ext = o?.extension ?? '.md';
			return (await walk(root))
				.filter((e) => ext === '*' || e.path.endsWith(ext))
				.map((e) => ({ path: e.path, sha: fileToken(e) }));
		},

		fetchPages: async (_repo, entries): Promise<{ pages: PageContent[]; truncated: boolean }> => {
			const pages: PageContent[] = [];
			for (const e of entries) {
				try {
					pages.push({ path: e.path, content: await readFile(safeJoin(root, e.path), 'utf8') });
				} catch {
					// Deleted between the walk and the read; the next read reconciles it.
				}
			}
			return { pages, truncated: false };
		},

		readFile: async (_repo, path) => {
			const full = safeJoin(root, path);
			if (!existsSync(full)) return null;
			const s = await stat(full);
			if (!s.isFile()) return null;
			return {
				content: await readFile(full, 'utf8'),
				sha: fileToken({ path, size: s.size, mtimeMs: Math.floor(s.mtimeMs) })
			};
		},

		readBinary: async (_repo, path) => {
			const full = safeJoin(root, path);
			if (!existsSync(full)) return null;
			const s = await stat(full);
			if (!s.isFile()) return null;
			const bytes = await readFile(full);
			return {
				contentBase64: bytes.toString('base64'),
				sha: fileToken({ path, size: s.size, mtimeMs: Math.floor(s.mtimeMs) }),
				size: s.size
			};
		},

		// No pull requests, so never one open.
		findOpenConfigPr: async () => undefined,

		listCommits: async (_repo, o): Promise<CommitEntry[]> => {
			// Unit separator between fields, record separator between commits, so a message
			// containing newlines cannot be misparsed as another entry.
			const fmt = '%H%x1f%an%x1f%aI%x1f%B%x1e';
			const args = ['log', `-n${o.limit}`, `--format=${fmt}`];
			if (o.path) args.push('--', o.path);
			let out: string;
			try {
				out = await git(root, args);
			} catch {
				return []; // A repo with no commits yet has no history to show.
			}
			return out
				.split('\x1e')
				.map((rec) => rec.trim())
				.filter(Boolean)
				.map((rec) => {
					const [sha, authorName, date, message] = rec.split('\x1f');
					return { sha, authorName, date, message: (message ?? '').trim() };
				});
		},

		commitFiles: (repo, o) => commit(repo, o),

		commitOrPR: async (repo, o: CommitOrPROpts): Promise<WriteOutcome> => {
			if (o.writeMode === 'pull-request') {
				// Only reachable when a brain's own .isomorphic.json asks for review, since
				// repoWritePolicy never reports protection here. Committing anyway would
				// land a change the brain said needs approval.
				throw new LocalGitError(
					'This brain is configured for pull-request writes, which a local brain cannot open. Set writes.mode to "direct" in .isomorphic.json, or serve this brain from GitHub.'
				);
			}
			await commit(repo, o);
			return {};
		}
	};
}
