// The storage seam: what a brain's storage must do for the tools, and the types the
// tools and stores share. Runtime-portable (Worker-safe, no node:*).
//
// THE USER NEVER SEES GIT. Tools speak in saves and pages; a store hides how its
// backend versions files. The core primitive is `write()`: one bundle of writes and
// deletes (the page, the changelog, and any pages whose links a move repoints) landing
// as a unit. The unit of work is the bundle, never a single file.
//
// Implementations: githubStore (brain-store-github.ts), the fs/git adapter
// (src/local/brain-store-fs.ts), and sqlBrainStore (brain-store-sql.ts), which no brain
// is served from yet.

// Where one brain's files live, within the backend its store talks to. A GitHub
// repository today; a backend that is not addressed by owner and name adds its own
// variant here. Type alias (not interface) so it picks up an implicit index signature
// and stays assignable to octokit's RequestParameters.
export type BrainLocator = {
	owner: string;
	repo: string;
};

// One state of a whole brain. `id` is opaque: compare it for equality, never parse
// it. A commit sha on GitHub, a working-tree digest on the fs backend.
export interface Revision {
	id: string;
	branch: string;
	// Backend-private: what listTree reads at this revision (GitHub: the root tree id).
	snapshot: string;
	// Set only by writeBase: `branch` is this open pull request's branch, and a write
	// based on this revision is appended to it instead of opening another pull request.
	pr?: PendingPr;
}

// The brain's open pull request that PR-mode writes accumulate on.
export interface PendingPr {
	number: number;
	url: string;
	nodeId: string;
	title: string;
	body: string;
	// The default branch has moved past it. Under "require branches to be up to
	// date" auto-merge waits on this forever, so an append also updates the branch.
	behind: boolean;
	autoMerge: boolean;
}

// One file in a listing. `version` is an opaque per-file tag that changes when the
// file's bytes do: the git blob id on GitHub, a size and mtime token on the fs backend.
export interface FileEntry {
	path: string;
	version: string;
}

export interface FileWrite {
	path: string;
	content: string;
	// How to read `content`. Omitted means `utf-8`, which is every page write in the
	// codebase — the field exists so a caller that holds BYTES (an uploaded image) can
	// say so. Binary cannot ride the text path: createTree decodes inline `content` as
	// UTF-8, so a PNG sent that way is silently mangled rather than rejected.
	encoding?: 'utf-8' | 'base64';
}

// One stored file's bytes, base64-encoded. Deliberately separate from `readFile`,
// which decodes to a string: the whole point here is to never turn bytes into text.
export interface BinaryContent {
	contentBase64: string;
	version: string;
	size: number;
}

// Who a commit is attributed to. All writes go through the GitHub App installation
// token, so without this GitHub stamps the App as the author and `git blame` shows
// a bot for every edit. Setting `author` on createCommit (committer is filled from
// author when omitted) makes history reflect the human who actually made the change.
export interface CommitAuthor {
	name: string;
	email: string;
}

// Only attribute when we have a usable name AND a syntactically valid email —
// createCommit rejects a blank/garbage email, and a bad value is worse than
// falling back to the App author. Returns undefined to mean "don't attribute".
export function validCommitAuthor(author?: CommitAuthor): CommitAuthor | undefined {
	if (!author) return undefined;
	const name = author.name?.trim();
	const email = author.email?.trim();
	if (!name || !email) return undefined;
	// Deliberately loose: just enough to reject empties/whitespace/obvious junk.
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
	return { name, email };
}

// WHO to attribute to, as opposed to validCommitAuthor's WHETHER the result is
// usable. The app_users row wins because it holds the verified address and the name
// the person actually chose; the token's email is the fallback for a caller with no
// row yet. A person with no name is attributed under their address rather than being
// dropped, since a real address in `git blame` beats the App.
//
// Extracted from McpSession.resolveProductContext, where it decided how every human
// edit appears in a brain's history from inside a private method no test could call.
export function commitAuthorFor(
	user: { name?: string | null; email?: string | null } | null | undefined,
	tokenEmail: string
): CommitAuthor | undefined {
	const email = (user?.email || tokenEmail || '').trim();
	if (!email) return undefined;
	const name = (user?.name || email).trim();
	return { name, email };
}

// The third attribution rule, for the GitHub identity path, where there is no
// app_users row to read an address off. GitHub's canonical noreply form is
// `<id>+<login>@users.noreply.github.com`, and using it is what links a commit to
// the person's profile without publishing a private address.
//
// The format is load-bearing and silent when wrong: a malformed address still
// commits, it just attributes to nobody, on every write that identity ever makes.
// It was written inline in a private method on McpSession and appeared exactly
// once in the codebase, so nothing would have caught a typo in it.
export function githubNoreplyAuthor(
	ghUserId: number,
	login: string | null | undefined
): CommitAuthor | undefined {
	const name = (login ?? '').trim();
	if (!name) return undefined;
	return { name, email: `${ghUserId}+${name}@users.noreply.github.com` };
}

// Upper bound on a single content scan: a sanity ceiling on memory and time for a
// pathologically large brain. Typical brains scan whole; truncation past it is
// surfaced to the caller. 5000 covers the largest brain measured (~3,900 pages).
export const MAX_SCAN_PAGES = 5000;

// ---------- the storage seam ----------
//
// Everything the tools do to a brain, as twelve operations plus the capabilities the
// backend declares. The only interface between the tool layer and where a brain
// physically lives.
//
// Not a general storage abstraction: it is the set of operations the tools already
// perform, in the shape they already perform them.
//
// branchRevision, repoWritePolicy, and listCommits are here rather than left as raw
// octokit calls in content paths. A raw octokit call compiles fine and fails at
// runtime on any other backend.

// How writes land in a repo. `branchProtected` drives the direct-vs-pull-request
// decision; a backend with no notion of protection reports false.
export interface RepoWritePolicy {
	defaultBranch: string;
	branchProtected: boolean;
	mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
}

// One entry of the brain's history, as view_activity renders it. `url` is optional
// (a brain on disk has nothing to link to) and so is `authorLogin` (only GitHub can
// supply an account name).
export interface CommitEntry {
	sha: string;
	message: string;
	authorName: string;
	authorLogin?: string;
	date: string;
	url?: string;
}

export interface WriteOpts {
	message: string;
	writes?: FileWrite[];
	deletes?: string[];
	base?: Revision; // the revision to write onto; pass when already fetched
	author?: CommitAuthor; // attribute the commit to the human, not the App
}

export interface CommitOrPROpts extends WriteOpts {
	writeMode: 'direct' | 'pull-request';
	defaultBranch: string;
	branchPrefix?: string; // PR branch name prefix, e.g. 'isomorphic/edit'
	prTitle?: string;
	prBody?: string;
	// PR mode: arm auto-merge on the opened PR, with this merge method.
	autoMerge?: boolean;
	mergeMethod?: 'MERGE' | 'SQUASH' | 'REBASE';
}

// What a backend can do beyond reading and writing files. Each implementation declares
// its own; callers branch on these, never on which implementation they hold.
export interface StoreCapabilities {
	// A multi-file write lands entirely or not at all.
	atomicWrite: boolean;
	// The backend can hold a change for review (GitHub pull requests), so
	// `writeMode: 'pull-request'` is available.
	proposals: boolean;
	// Cross-file change history, which listCommits reports.
	history: boolean;
}

// Thrown by a store asked for a write it cannot perform as configured.
export class UnsupportedWriteError extends Error {}

// Thrown when a file was not at the version a write was planned against.
export class WriteConflictError extends Error {
	override readonly name = 'WriteConflictError';
	constructor(readonly path: string) {
		super(`${path} changed since it was read. Read it again and retry the change.`);
	}
}

// Every store is built through this, so what a store declares is enforced for it: a
// store without `proposals` refuses a pull-request write before its own commitOrPR
// runs. Committing anyway would land a change the brain's config says needs review.
export function defineStore(store: BrainStore): BrainStore {
	if (store.capabilities.proposals) return store;
	return {
		...store,
		commitOrPR: async (loc, opts) => {
			if (opts.writeMode === 'pull-request') {
				throw new UnsupportedWriteError(
					'This brain is configured for pull-request writes, which its storage cannot hold for review. Set writes.mode to "direct" in .isomorphic.json, or serve this brain from GitHub.'
				);
			}
			return store.commitOrPR(loc, opts);
		}
	};
}

// What a write landed: the brain's new revision, and the new version tag of every
// file written, by path (the tag listTree reports for it from then on).
export interface WriteResult {
	revision: Revision;
	versions: Record<string, string>;
}

export interface BrainStore {
	readonly capabilities: StoreCapabilities;
	// branch: resolve THIS branch instead of asking the platform for the default
	// (callers pass config.defaultBranch), saving one round trip. Implementations
	// fall back to discovery when the named branch does not exist.
	getRevision(loc: BrainLocator, branch?: string): Promise<Revision>;
	// The `id` of the revision a named branch is at: what the index freshness guard compares.
	branchRevision(loc: BrainLocator, branch: string): Promise<string>;
	repoWritePolicy(loc: BrainLocator): Promise<RepoWritePolicy>;
	listTree(loc: BrainLocator, at: Revision, opts?: { extension?: string }): Promise<FileEntry[]>;
	fetchPages(
		loc: BrainLocator,
		entries: FileEntry[]
	): Promise<{ pages: PageContent[]; truncated: boolean }>;
	// The revision a write is planned against and committed onto. Direct mode, or PR mode
	// with no open Isomorphic pull request: the default branch. PR mode with one: that
	// pull request's branch, with `pr` set, so the write builds on the changes still
	// waiting there and commitOrPR appends to it.
	writeBase(
		loc: BrainLocator,
		opts: { defaultBranch: string; writeMode: 'direct' | 'pull-request' }
	): Promise<Revision>;
	// `version` is the tag listTree reports for the same file. `ref` pins the read to one
	// branch or revision. Write paths capture the revision first
	// so every file they derive a write from belongs to it.
	readFile(
		loc: BrainLocator,
		path: string,
		ref?: string
	): Promise<{ content: string; version: string } | null>;
	// One file's raw bytes as base64. Backs read_media; null when absent. `ref` as
	// for readFile.
	readBinary(loc: BrainLocator, path: string, ref?: string): Promise<BinaryContent | null>;
	findOpenConfigPr(loc: BrainLocator): Promise<string | undefined>;
	// Recent commits, newest first, optionally scoped to one path. Backs view_activity.
	listCommits(loc: BrainLocator, opts: { limit: number; path?: string }): Promise<CommitEntry[]>;
	// One bundle of writes and deletes onto `base` (default: the default branch).
	// Atomic when capabilities.atomicWrite.
	write(loc: BrainLocator, opts: WriteOpts): Promise<WriteResult>;
	commitOrPR(loc: BrainLocator, opts: CommitOrPROpts): Promise<WriteOutcome>;
}

export interface PageContent {
	path: string;
	content: string;
}

export interface WriteOutcome {
	// Set when the change landed as a PR (protected branch) rather than a direct
	// commit. Tools surface this so the user knows the edit is awaiting review.
	prUrl?: string;
	prNumber?: number;
	// PR mode only: did the change already merge (immediately, because nothing was
	// pending), and/or did we arm GitHub auto-merge (merges when checks go green)?
	merged?: boolean;
	autoMergeEnabled?: boolean;
	// PR mode only: the change joined the brain's already-open pull request rather
	// than opening one (see BrainStore.writeBase).
	appended?: boolean;
	// PR mode only: the commit this write added to the pull request's branch, so a
	// caller can read back what it wrote there (the editor's next sha).
	branchSha?: string;
	// Direct mode only: what the write landed. `revision.id` is in the same identifier
	// space branchRevision reports, and write-through records it with `versions`
	// (writeThroughIndex in brain-index.ts). Absent on the PR path, where the default
	// branch has not moved or moved by a merge this call does not know, and on a store
	// that leaves the index to reconcile on the next read.
	landed?: WriteResult;
}
