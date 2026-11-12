// The GitHub BrainStore: a brain is a repository, a revision a commit, a version tag
// a git blob id. Runtime-portable (Worker-safe, no node:*).
//
// A write is one Git Data API commit, as in scaffold-core.ts: blobs inline in a tree,
// then a commit, then a ref update. If anything fails halfway the branch ref never
// moves, so there is no partial state.

import type { Octokit } from 'octokit';
import { coalescedPrText } from './change-record.ts';
import { base64ToUtf8 } from './wiki.ts';
import {
	defineStore,
	gitBlobSha,
	MAX_SCAN_PAGES,
	validCommitAuthor,
	type BinaryContent,
	type BrainStore,
	type CommitAuthor,
	type CommitEntry,
	type WriteResult,
	type FileWrite,
	type Revision,
	type PageContent,
	type PendingPr,
	type BrainLocator,
	type RepoWritePolicy,
	type FileEntry,
	type WriteOutcome
} from './brain-repo.ts';

// What choosePendingPr needs from one entry of GitHub's open pull request list.
export interface OpenPrSummary {
	number: number;
	baseRef: string;
	headRef: string;
	// The repository the head branch lives in; null when that fork was deleted.
	headRepo: string | null;
}

// Branch prefixes Isomorphic opens pull requests from (`branchPrefix` callers).
export const PR_BRANCH_PREFIX = 'isomorphic/';
// configure_brain's pull request is reviewed on its own (findOpenConfigPr), so
// content writes never join it.
const CONFIG_PR_PREFIX = 'isomorphic/configure';

// Which open pull requests content writes may join, newest first: Isomorphic's own
// branches in this repository, against the default branch. Every write branches from
// the default branch otherwise, so two writes inside one pull request's lifetime
// produce two pull requests, the second built without the first's changes.
export function pendingPrCandidates(
	prs: readonly OpenPrSummary[],
	opts: { defaultBranch: string; repoFullName: string }
): OpenPrSummary[] {
	const full = opts.repoFullName.toLowerCase();
	return prs
		.filter(
			(p) =>
				p.baseRef === opts.defaultBranch &&
				p.headRepo?.toLowerCase() === full &&
				p.headRef.startsWith(PR_BRANCH_PREFIX) &&
				!p.headRef.startsWith(CONFIG_PR_PREFIX)
		)
		.sort((a, b) => b.number - a.number);
}

// How many blob texts to pull per GraphQL request. Each aliased `object` field is
// cheap, but keep batches bounded so a single response stays a sane size and well
// under GitHub's GraphQL node/complexity limits. ceil(pages / this) = subrequests.
const GRAPHQL_BLOB_BATCH = 100;

// The GitHub implementation: the functions below, bound to one authenticated Octokit.
// An App installation token and a plain access token work the same here.
export function githubStore(octokit: Octokit): BrainStore {
	return defineStore({
		capabilities: { atomicWrite: true, proposals: true, history: true },
		getRevision: (repo, branch) => getRevision(octokit, repo, branch),
		writeBase: (repo, opts) => writeBase(octokit, repo, opts),
		branchRevision: (repo, branch) => branchRevision(octokit, repo, branch),
		repoWritePolicy: (repo) => repoWritePolicy(octokit, repo),
		listTree: (repo, at, opts) => listTree(octokit, repo, at, opts),
		fetchPages: (repo, entries) => fetchPages(octokit, repo, entries),
		readFile: (repo, path, ref) => readFile(octokit, repo, path, ref),
		readBinary: (repo, path, ref) => readBinary(octokit, repo, path, ref),
		findOpenConfigPr: (repo) => findOpenConfigPr(octokit, repo),
		listCommits: (repo, opts) => listCommits(octokit, repo, opts),
		write: (repo, opts) => commitFiles(octokit, repo, opts),
		commitOrPR: (repo, opts) => commitOrPR(octokit, repo, opts)
	});
}

// branch: skip the repos.get default-branch discovery and resolve the named branch
// directly (callers pass config.defaultBranch, which the write-policy probe already
// learned). A 404 on the named branch falls back to discovery — the repo's default
// was renamed, or the probe failed earlier and config guessed 'main'.
async function getRevision(
	octokit: Octokit,
	repo: BrainLocator,
	branch?: string
): Promise<Revision> {
	if (branch) {
		try {
			const { data: ref } = await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
			const { data: commit } = await octokit.rest.git.getCommit({
				...repo,
				commit_sha: ref.object.sha
			});
			return { branch, id: ref.object.sha, snapshot: commit.tree.sha };
		} catch (err) {
			if ((err as { status?: number })?.status !== 404) throw err;
		}
	}
	const { data: repoData } = await octokit.rest.repos.get(repo);
	const resolved = repoData.default_branch;
	const { data: ref } = await octokit.rest.git.getRef({ ...repo, ref: `heads/${resolved}` });
	const { data: commit } = await octokit.rest.git.getCommit({
		...repo,
		commit_sha: ref.object.sha
	});
	return { branch: resolved, id: ref.object.sha, snapshot: commit.tree.sha };
}

// See BrainStore.writeBase. A pull request GitHub reports as conflicting is skipped:
// writes stacked on it could never merge. Any failure to list falls back to the
// default branch, which is how every write behaved before pull requests were joined.
async function writeBase(
	octokit: Octokit,
	repo: BrainLocator,
	opts: { defaultBranch: string; writeMode: 'direct' | 'pull-request' }
): Promise<Revision> {
	if (opts.writeMode === 'pull-request') {
		const pending = await findPendingPr(octokit, repo, opts.defaultBranch).catch(() => null);
		if (pending) return pending;
	}
	return getRevision(octokit, repo, opts.defaultBranch);
}

// How many candidates writeBase asks GitHub about before giving up on joining one.
const MAX_PENDING_PR_PROBES = 3;

async function findPendingPr(
	octokit: Octokit,
	repo: BrainLocator,
	defaultBranch: string
): Promise<Revision | null> {
	const { data: open } = await octokit.rest.pulls.list({
		...repo,
		state: 'open',
		base: defaultBranch,
		per_page: 100
	});
	const candidates = pendingPrCandidates(
		open.map((p) => ({
			number: p.number,
			baseRef: p.base.ref,
			headRef: p.head.ref,
			headRepo: p.head.repo?.full_name ?? null
		})),
		{ defaultBranch, repoFullName: `${repo.owner}/${repo.repo}` }
	);
	for (const c of candidates.slice(0, MAX_PENDING_PR_PROBES)) {
		const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: c.number });
		if (pr.state !== 'open' || pr.mergeable === false) continue;
		const { data: commit } = await octokit.rest.git.getCommit({
			...repo,
			commit_sha: pr.head.sha
		});
		return {
			branch: pr.head.ref,
			id: pr.head.sha,
			snapshot: commit.tree.sha,
			pr: {
				number: pr.number,
				url: pr.html_url,
				nodeId: pr.node_id,
				title: pr.title,
				body: pr.body ?? '',
				behind: pr.mergeable_state === 'behind',
				autoMerge: Boolean(pr.auto_merge)
			}
		};
	}
	return null;
}

// The commit a named branch points at. getRevision resolves the repo's DEFAULT branch;
// the content index's freshness guard compares against the brain's configured branch,
// which need not be the same.
async function branchRevision(
	octokit: Octokit,
	repo: BrainLocator,
	branch: string
): Promise<string> {
	const { data } = await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
	return data.object.sha;
}

// The repo's default branch, whether it is protected, and which merge method to use
// when a write lands as a pull request. Throws on failure; resolveWritePolicy in
// brain-config.ts decides what a failure means (it falls back to direct writes).
async function repoWritePolicy(octokit: Octokit, repo: BrainLocator): Promise<RepoWritePolicy> {
	const { data: r } = await octokit.rest.repos.get(repo);
	const defaultBranch = r.default_branch;
	// Prefer squash (one clean commit per edit bundle), then merge, then rebase.
	const mergeMethod = r.allow_squash_merge
		? 'SQUASH'
		: r.allow_merge_commit
			? 'MERGE'
			: r.allow_rebase_merge
				? 'REBASE'
				: 'MERGE';
	// `.protected` on the branch object needs no admin permission (unlike the
	// /protection endpoint), so this works with plain contents access.
	const { data: br } = await octokit.rest.repos.getBranch({ ...repo, branch: defaultBranch });
	return { defaultBranch, branchProtected: Boolean(br.protected), mergeMethod };
}

// Recent commits, newest first. One call, no per-blob fanout; `path` scopes it to one
// page's history. `commit.author` is always populated (our attribution work sets it);
// `author` is the linked GitHub account, absent for non-GitHub members.
async function listCommits(
	octokit: Octokit,
	repo: BrainLocator,
	opts: { limit: number; path?: string }
): Promise<CommitEntry[]> {
	const { data } = await octokit.rest.repos.listCommits({
		...repo,
		per_page: opts.limit,
		...(opts.path ? { path: opts.path } : {})
	});
	return data.map((c) => ({
		sha: c.sha,
		message: c.commit.message ?? '',
		authorName: c.commit.author?.name ?? c.author?.login ?? 'Unknown',
		authorLogin: c.author?.login ?? undefined,
		date: c.commit.author?.date ?? c.commit.committer?.date ?? '',
		url: c.html_url
	}));
}

// The URL of an open "configure" PR (from configure_brain) for this repo, if any.
// Used to show a pending-review state and to avoid opening a duplicate PR when the
// repo's default branch is protected. Best-effort — never throws.
async function findOpenConfigPr(octokit: Octokit, repo: BrainLocator): Promise<string | undefined> {
	try {
		const { data } = await octokit.rest.pulls.list({ ...repo, state: 'open', per_page: 50 });
		return data.find((p) => p.head?.ref?.startsWith('isomorphic/configure'))?.html_url;
	} catch {
		return undefined;
	}
}

// Full recursive tree of blobs ending in `opts.extension` (default ".md"; "*" for all).
async function listTree(
	octokit: Octokit,
	repo: BrainLocator,
	at: Revision,
	opts: { extension?: string } = {}
): Promise<FileEntry[]> {
	const { data: tree } = await octokit.rest.git.getTree({
		...repo,
		tree_sha: at.snapshot,
		recursive: 'true'
	});
	const ext = opts.extension ?? '.md';
	return tree.tree
		.filter((e) => e.type === 'blob' && e.path && (ext === '*' || e.path.endsWith(ext)))
		.map((e) => ({ path: e.path!, version: e.sha! }));
}

// Fetch the contents of many pages by blob sha. Batched through GraphQL — one
// request pulls up to GRAPHQL_BLOB_BATCH blob texts via aliased `object(oid:)`
// fields, so a whole-brain scan costs ceil(pages / batch) subrequests instead of
// one per page. Capped at MAX_SCAN_PAGES as a sanity bound; `truncated` tells the
// caller the scan was partial.
async function fetchPages(
	octokit: Octokit,
	repo: BrainLocator,
	entries: FileEntry[]
): Promise<{ pages: PageContent[]; truncated: boolean }> {
	const take = entries.slice(0, MAX_SCAN_PAGES);
	const pages: PageContent[] = [];
	// GraphQL caps blob `text` for very large files (returns isTruncated=true with a
	// partial body). Those are rare for wiki pages, but fetching partial content would
	// silently drop links near the end — so re-read any truncated blob in full via REST.
	const oversized: FileEntry[] = [];

	for (let start = 0; start < take.length; start += GRAPHQL_BLOB_BATCH) {
		const batch = take.slice(start, start + GRAPHQL_BLOB_BATCH);
		// Build one query with N aliased blob reads: b0…bN-1, each keyed to a blob oid
		// passed as a typed variable (GitObjectID) — never string-interpolated, so no
		// injection surface. A bad/missing oid resolves that alias to null (not a
		// top-level error), so one odd entry can't fail the whole batch.
		const varDecls = batch.map((_, i) => `$o${i}: GitObjectID!`).join(', ');
		const fields = batch
			.map((_, i) => `b${i}: object(oid: $o${i}) { ... on Blob { text isTruncated } }`)
			.join('\n');
		const query = `query ($owner: String!, $repo: String!, ${varDecls}) {
			repository(owner: $owner, name: $repo) {
				${fields}
			}
		}`;
		const variables: Record<string, string> = { owner: repo.owner, repo: repo.repo };
		batch.forEach((e, i) => (variables[`o${i}`] = e.version));

		const data = await octokit.graphql<{
			repository: Record<string, { text?: string | null; isTruncated?: boolean } | null>;
		}>(query, variables);

		const repository = data?.repository ?? {};
		batch.forEach((e, i) => {
			const blob = repository[`b${i}`];
			// text is null for binary blobs; skip those rather than pushing garbage.
			// (We only ever pass .md entries, so this is a belt-and-suspenders guard.)
			if (!blob || typeof blob.text !== 'string') return;
			if (blob.isTruncated) oversized.push(e);
			else pages.push({ path: e.path, content: blob.text });
		});
	}

	// Full re-read of any blob GraphQL truncated (rare). One REST call each, but only
	// for oversized pages, so the common path stays batched.
	for (const e of oversized) {
		const { data } = await octokit.rest.git.getBlob({ ...repo, file_sha: e.version });
		pages.push({ path: e.path, content: base64ToUtf8(data.content) });
	}

	return { pages, truncated: entries.length > take.length };
}

// Read one file at HEAD via the contents API. Returns null when absent.
async function readFile(
	octokit: Octokit,
	repo: BrainLocator,
	path: string,
	ref?: string
): Promise<{ content: string; sha: string } | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ ...repo, path, ...(ref && { ref }) });
		if (Array.isArray(data) || data.type !== 'file') return null;
		return { content: base64ToUtf8(data.content), sha: data.sha };
	} catch (err) {
		if ((err as { status?: number })?.status === 404) return null;
		throw err;
	}
}

// One file's bytes, base64, without ever decoding them to a string. The contents API
// carries the bytes inline for small files, which is the common case (an attachment is
// capped well below the 1 MB inline ceiling); above that it returns metadata with the
// content omitted, so fall through to the blob API using the sha it did return.
async function readBinary(
	octokit: Octokit,
	repo: BrainLocator,
	path: string,
	ref?: string
): Promise<BinaryContent | null> {
	let sha: string;
	let size: number;
	try {
		const { data } = await octokit.rest.repos.getContent({ ...repo, path, ...(ref && { ref }) });
		if (Array.isArray(data) || data.type !== 'file') return null;
		sha = data.sha;
		size = data.size;
		// `encoding` is 'none' when GitHub declined to inline the content.
		if (data.encoding === 'base64' && data.content) {
			return { contentBase64: data.content.replace(/\n/g, ''), sha, size };
		}
	} catch (err) {
		if ((err as { status?: number })?.status === 404) return null;
		throw err;
	}
	const { data: blob } = await octokit.rest.git.getBlob({ ...repo, file_sha: sha });
	return { contentBase64: blob.content.replace(/\n/g, ''), sha, size };
}

type TreeParam = NonNullable<Parameters<Octokit['rest']['git']['createTree']>[0]>['tree'][number];

// The tree entries for one commit's bundle, shared by both write paths so a direct
// commit and a PR commit can never build the tree differently.
//
// A utf-8 write rides inline in the tree, so a whole page bundle still costs one
// request. A base64 write cannot: createTree decodes inline `content` as UTF-8, so
// binary has to become a blob first and be referenced by sha. That costs one extra
// subrequest per binary file, which is bounded by how many attachments are in the
// bundle (in practice, one).
async function buildTreeEntries(
	octokit: Octokit,
	repo: BrainLocator,
	writes: FileWrite[] = [],
	deletes: string[] = []
): Promise<{ tree: TreeParam[]; versions: Record<string, string> }> {
	const tree: TreeParam[] = [];
	const versions: Record<string, string> = {};
	for (const w of writes) {
		if (w.encoding === 'base64') {
			const { data: blob } = await octokit.rest.git.createBlob({
				...repo,
				content: w.content,
				encoding: 'base64'
			});
			tree.push({ path: w.path, mode: '100644', type: 'blob', sha: blob.sha });
			versions[w.path] = blob.sha;
		} else {
			tree.push({ path: w.path, mode: '100644', type: 'blob', content: w.content });
			versions[w.path] = await gitBlobSha(w.content);
		}
	}
	for (const path of deletes) {
		tree.push({ path, mode: '100644', type: 'blob', sha: null });
	}
	return { tree, versions };
}

// One atomic commit: all writes and deletes land together or not at all.
// `deletes` entries that don't exist in the tree are ignored by GitHub.
// The returned sha is internal plumbing — never surface it to the user.
async function commitFiles(
	octokit: Octokit,
	repo: BrainLocator,
	opts: {
		message: string;
		writes?: FileWrite[];
		deletes?: string[];
		base?: Revision;
		author?: CommitAuthor; // attribute the commit to the human, not the App
	}
): Promise<WriteResult> {
	const base = opts.base ?? (await getRevision(octokit, repo));

	const { tree, versions } = await buildTreeEntries(octokit, repo, opts.writes, opts.deletes);

	const { data: newTree } = await octokit.rest.git.createTree({
		...repo,
		base_tree: base.snapshot,
		tree
	});
	const author = validCommitAuthor(opts.author);
	const { data: commit } = await octokit.rest.git.createCommit({
		...repo,
		message: opts.message,
		tree: newTree.sha,
		parents: [base.id],
		// committer is filled from author when omitted, so blame shows the human.
		...(author && { author })
	});
	await octokit.rest.git.updateRef({
		...repo,
		ref: `heads/${base.branch}`,
		sha: commit.sha
	});
	return {
		revision: { id: commit.sha, branch: base.branch, snapshot: newTree.sha },
		versions
	};
}

// Arm GitHub auto-merge on a freshly-opened PR: it merges automatically once the
// repo's required checks/approvals pass. Handles the two non-happy cases:
//   - PR is already mergeable (no pending required checks) → merge it now.
//   - repo has auto-merge disabled (or it's otherwise unavailable) → leave the PR
//     open for a human; the caller reports the URL.
async function armAutoMerge(
	octokit: Octokit,
	repo: BrainLocator,
	pr: { node_id: string; number: number },
	mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE'
): Promise<{ merged?: boolean; autoMergeEnabled?: boolean }> {
	try {
		// NB: @octokit/graphql reserves `method` (among url/headers/query/…) as a
		// parameter name, so the GraphQL variable must NOT be called `method`.
		await octokit.graphql(
			`mutation ($id: ID!, $mergeMethod: PullRequestMergeMethod!) {
				enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod }) {
					pullRequest { number }
				}
			}`,
			{ id: pr.node_id, mergeMethod }
		);
		return { autoMergeEnabled: true };
	} catch (err) {
		const msg = String((err as { message?: string })?.message ?? err);
		// Already green / nothing to wait on → just merge it now.
		if (/clean status|not in the correct state/i.test(msg)) {
			try {
				await octokit.rest.pulls.merge({
					...repo,
					pull_number: pr.number,
					merge_method: mergeMethod.toLowerCase() as 'merge' | 'squash' | 'rebase'
				});
				return { merged: true };
			} catch {
				return {};
			}
		}
		// Auto-merge disabled on the repo, or some other issue → leave PR open.
		return {};
	}
}

// Land a multi-file bundle either directly (updateRef on the default branch) or,
// on a protected branch, as a PR: same tree/commit, but on a fresh branch with a
// pull request opened against the default branch. This is the single write
// chokepoint the librarian + editor tools call so branch-protection handling
// lives in one place. `base` is the revision to write onto (writeBase).
async function commitOrPR(
	octokit: Octokit,
	repo: BrainLocator,
	opts: {
		writeMode: 'direct' | 'pull-request';
		defaultBranch: string;
		message: string;
		writes?: FileWrite[];
		deletes?: string[];
		base?: Revision;
		branchPrefix?: string; // PR branch name prefix, e.g. 'isomorphic/edit'
		prTitle?: string;
		prBody?: string;
		// PR mode: arm auto-merge on the opened PR, with this merge method.
		autoMerge?: boolean;
		mergeMethod?: 'MERGE' | 'SQUASH' | 'REBASE';
		// Attribute the commit to the human who made the change (both modes).
		author?: CommitAuthor;
	}
): Promise<WriteOutcome> {
	const base = opts.base ?? (await getRevision(octokit, repo, opts.defaultBranch));
	if (opts.writeMode === 'direct') {
		const landed = await commitFiles(octokit, repo, {
			message: opts.message,
			writes: opts.writes,
			deletes: opts.deletes,
			base,
			author: opts.author
		});
		return { landed };
	}

	// PR mode: build the identical tree/commit as commitFiles, but land it on a new
	// branch and open a PR instead of moving the default ref.
	const { tree } = await buildTreeEntries(octokit, repo, opts.writes, opts.deletes);
	const { data: newTree } = await octokit.rest.git.createTree({
		...repo,
		base_tree: base.snapshot,
		tree
	});
	const author = validCommitAuthor(opts.author);
	const { data: commit } = await octokit.rest.git.createCommit({
		...repo,
		message: opts.message,
		tree: newTree.sha,
		parents: [base.id],
		...(author && { author })
	});
	if (base.pr) return appendToPendingPr(octokit, repo, base, base.pr, commit.sha, opts);

	// crypto.randomUUID keeps retries/concurrent edits from colliding on the branch.
	const branch =
		`${opts.branchPrefix ?? 'isomorphic/change'}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 250);
	await octokit.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.sha });
	const { data: pr } = await octokit.rest.pulls.create({
		...repo,
		title: opts.prTitle ?? opts.message.split('\n')[0],
		body: opts.prBody ?? '',
		head: branch,
		base: opts.defaultBranch
	});

	let autoMergeResult: { merged?: boolean; autoMergeEnabled?: boolean } = {};
	if (opts.autoMerge) {
		autoMergeResult = await armAutoMerge(
			octokit,
			repo,
			{ node_id: pr.node_id, number: pr.number },
			opts.mergeMethod ?? 'MERGE'
		);
	}
	return { prUrl: pr.html_url, prNumber: pr.number, branchSha: commit.sha, ...autoMergeResult };
}

// Land `commitSha` (whose parent is the pull request's head) on the brain's open pull
// request: fast-forward its branch, retitle it to cover every change it now holds,
// bring it up to date with the default branch when it has fallen behind, and arm
// auto-merge if it is not armed yet. Only the ref update can fail the write; the rest
// is best effort, because the change has already landed on the pull request.
async function appendToPendingPr(
	octokit: Octokit,
	repo: BrainLocator,
	base: Revision,
	pr: PendingPr,
	commitSha: string,
	opts: {
		message: string;
		prTitle?: string;
		autoMerge?: boolean;
		mergeMethod?: 'MERGE' | 'SQUASH' | 'REBASE';
	}
): Promise<WriteOutcome> {
	try {
		await octokit.rest.git.updateRef({
			...repo,
			ref: `heads/${base.branch}`,
			sha: commitSha,
			force: false
		});
	} catch (err) {
		const status = (err as { status?: number })?.status;
		if (status === 422 || status === 409)
			throw new Error(
				`Pull request #${pr.number} changed while this write was being prepared, so nothing was written. Retry the same call.`
			);
		throw err;
	}
	const text = coalescedPrText(pr, opts.prTitle ?? opts.message.split('\n')[0]);
	await octokit.rest.pulls
		.update({ ...repo, pull_number: pr.number, title: text.title, body: text.body })
		.catch(() => {});
	if (pr.behind) {
		await octokit.rest.pulls
			.updateBranch({ ...repo, pull_number: pr.number, expected_head_sha: commitSha })
			.catch(() => {});
	}
	let autoMergeResult: { merged?: boolean; autoMergeEnabled?: boolean } = pr.autoMerge
		? { autoMergeEnabled: true }
		: {};
	if (opts.autoMerge && !pr.autoMerge) {
		autoMergeResult = await armAutoMerge(
			octokit,
			repo,
			{ node_id: pr.nodeId, number: pr.number },
			opts.mergeMethod ?? 'MERGE'
		);
	}
	return {
		prUrl: pr.url,
		prNumber: pr.number,
		appended: true,
		branchSha: commitSha,
		...autoMergeResult
	};
}
