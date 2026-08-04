// A BrainStore backed by a git repository on disk. Node-only.
//
// NOT in src/lib/, deliberately: that tree is typechecked against the Workers
// runtime and may not import `node:*`. This file is reachable only from
// src/local.ts, which is the Node entry point.
//
// WHY A GIT REPO AND NOT A BARE FOLDER. commitFiles promises that a multi-file
// bundle lands whole or not at all, and write_page's "an edit batch is never
// half-applied" rests on it. Plain filesystem writes cannot promise that. Committing
// also keeps view_activity meaningful and keeps the product's central claim ("your
// knowledge is a git repo you own") literally true rather than true-with-an-asterisk.
//
// WHY THE WORKING TREE RATHER THAN `git ls-tree`. Someone running a local brain will
// edit files in their editor, and reading only committed state would show them stale
// content until they remembered to commit. So reads see the working tree, and the
// "revision" the content index compares against is a digest of that tree (see
// treeToken) rather than a commit sha. The index only ever asks "has anything
// changed?", and a stat digest answers exactly that question, immediately.

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

// Never walked. `.git` would swamp the tree and the rest are noise no brain wants
// indexed; a local brain pointed at a project directory is a normal thing to do.
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

// Recursive walk of the working tree. One stat per file, no file contents read,
// so this stays cheap enough to run on every read the way ensureFresh expects.
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

// The per-file "blob sha" the content index diffs against. Size plus mtime rather
// than a content hash: the index only compares these for equality, and hashing every
// file on every read would mean reading the whole brain to answer "did anything
// change?", which is the cost the index exists to avoid.
const fileToken = (e: Entry) => `${e.size}-${e.mtimeMs}`;

// The whole-tree revision, standing in for a commit sha. Any create, delete, or edit
// moves it, including one made outside our tools, which is the same guarantee the
// GitHub backend gets from comparing the branch HEAD.
function treeToken(entries: Entry[]): string {
	const h = createHash('sha1');
	for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		h.update(`${e.path}:${fileToken(e)}\n`);
	}
	return h.digest('hex');
}

// Guard every path that comes in from a tool: a brain is the directory the operator
// pointed at, and nothing may be written outside it. `path.resolve` collapses `..`
// before the check, so this catches traversal rather than merely discouraging it.
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

// The local content index lives inside the brain (next to it is convenient and
// survives restarts) but is derived data that must never be committed. Ignore the
// database FILES specifically, not the whole `.isomorphic/` directory: the importer's
// per-source ledger lives at `.isomorphic/imports/<source>.json` and is meant to be
// committed, since it is what stops a deleted page being silently resurrected.
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

// Make `dir` a git repository if it is not one already, and make sure whatever was
// already sitting in it is COMMITTED. Adopting a folder of notes has to produce a
// repo whose history contains the notes: otherwise the first tool write commits one
// file into an otherwise-empty repo, view_activity shows a brain that apparently did
// not exist until today, and nothing the user wrote is recoverable through git.
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
	// --allow-empty so an empty folder still gets a HEAD: getHead has to answer
	// something, and a repo with no commits has nothing to answer with.
	const args = [
		'commit',
		'--allow-empty',
		'-m',
		'Adopt existing files as a brain',
		'--no-gpg-sign'
	];
	if (author) args.push('--author', `${author.name} <${author.email}>`);
	// git refuses to commit without an identity, and a machine that has never
	// configured one should not be a dead end. -c sets it for this command only.
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
		// This is the atomicity that write_page's edit batches depend on.
		const undo: Array<{ full: string; prior: string | null }> = [];
		const touched = [...(o.writes ?? []).map((w) => w.path), ...(o.deletes ?? [])];
		try {
			for (const w of o.writes ?? []) {
				const full = safeJoin(root, w.path);
				undo.push({ full, prior: existsSync(full) ? await readFile(full, 'utf8') : null });
				await mkdir(dirname(full), { recursive: true });
				await writeFile(full, w.content, 'utf8');
			}
			for (const p of o.deletes ?? []) {
				const full = safeJoin(root, p);
				if (!existsSync(full)) continue;
				undo.push({ full, prior: await readFile(full, 'utf8') });
				await rm(full, { force: true });
			}
		} catch (err) {
			for (const u of undo.reverse()) {
				if (u.prior === null) await rm(u.full, { force: true });
				else await writeFile(u.full, u.prior, 'utf8');
			}
			throw err;
		}

		if (touched.length > 0) {
			await git(root, ['add', '--all', '--', ...touched.map((p) => safeJoin(root, p))]);
		}
		const author = o.author ?? opts.author;
		const args = ['commit', '-m', o.message, '--no-gpg-sign', '--allow-empty'];
		if (author) args.push('--author', `${author.name} <${author.email}>`);
		// -c, so a machine with no configured git identity can still commit. Without
		// it git refuses outright, and every write in the session fails.
		const ident = author ?? { name: 'Isomorphic', email: 'local@localhost' };
		await git(root, ['-c', `user.name=${ident.name}`, '-c', `user.email=${ident.email}`, ...args]);
		const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
		return { sha, head: await head() };
	};

	return {
		getHead: () => head(),

		// Every branch is the same working tree here, so the branch name is not a
		// selector. Returning the tree digest keeps the index's freshness guard
		// working: it moves whenever anything on disk moves.
		branchCommitSha: async () => (await head()).commitSha,

		repoWritePolicy: async (): Promise<RepoWritePolicy> => {
			const h = await head();
			// Nothing gates a write to a directory you own, so reporting "not
			// protected" is honest rather than a special case.
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
					// Deleted between the walk and the read. The next read reconciles it,
					// exactly as a blob that vanished mid-scan would on GitHub.
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

		// There are no pull requests, so there is never one open. Not an error: the
		// caller uses this to decide whether to show a pending-review state.
		findOpenConfigPr: async () => undefined,

		listCommits: async (_repo, o): Promise<CommitEntry[]> => {
			// Unit separator between fields and record separator between commits, so a
			// commit message containing newlines cannot be misparsed as another entry.
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
				// Only reachable when a brain's own .isomorphic.json asks for review,
				// since repoWritePolicy never reports protection here. Committing anyway
				// would silently land a change the brain said needs approval, so refuse
				// and say why rather than quietly downgrading the guarantee.
				throw new LocalGitError(
					'This brain is configured for pull-request writes, which a local brain cannot open. Set writes.mode to "direct" in .isomorphic.json, or serve this brain from GitHub.'
				);
			}
			await commit(repo, o);
			return {};
		}
	};
}
