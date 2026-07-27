// Brain repo git operations — runtime-portable (Worker-safe, no node:*).
//
// The design rule these helpers serve: THE USER NEVER SEES GIT. Tools speak
// in saves and pages; this module hides the version-control mechanics. The
// core primitive is `commitFiles()` — one atomic commit for a multi-file
// bundle (page + index + log), mirroring how real AI-maintained wikis change:
// the unit of work is the bundle, never a single file.
//
// Same Git Data API pattern as scaffold-core.ts: blobs inline in tree → tree
// → commit → ref update. If anything fails halfway, the branch ref never
// moves — no partial state.

import type { Octokit } from 'octokit';
import { base64ToUtf8 } from './wiki.ts';

// Type alias (not interface) so it picks up an implicit index signature and
// stays assignable to octokit's RequestParameters.
export type RepoRef = {
	owner: string;
	repo: string;
};

export interface Head {
	branch: string;
	commitSha: string;
	treeSha: string;
}

export interface TreeEntry {
	path: string;
	sha: string;
}

export interface FileWrite {
	path: string;
	content: string;
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

// Upper bound on a single content scan. This is NOT a subrequest limit anymore —
// fetchPages batches blob reads through GraphQL (see below), so a scan costs
// ceil(pages / GRAPHQL_BLOB_BATCH) subrequests, not one per page. The cap is now
// just a sanity ceiling on memory/time for a pathologically huge brain; typical
// brains scan whole. Truncation past it is still surfaced to the caller.
// 5000: covers the derived-views PRD's AC-5 (~4,000-page brain — the largest we have measured is
// ~3,900 pages, which the previous 1500 silently truncated) at ~50 GraphQL
// subrequests for a full build; incremental reindexes only fetch changed pages.
export const MAX_SCAN_PAGES = 5000;

// How many blob texts to pull per GraphQL request. Each aliased `object` field is
// cheap, but keep batches bounded so a single response stays a sane size and well
// under GitHub's GraphQL node/complexity limits. ceil(pages / this) = subrequests.
const GRAPHQL_BLOB_BATCH = 100;

export async function getHead(octokit: Octokit, repo: RepoRef): Promise<Head> {
	const { data: repoData } = await octokit.rest.repos.get(repo);
	const branch = repoData.default_branch;
	const { data: ref } = await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
	const { data: commit } = await octokit.rest.git.getCommit({
		...repo,
		commit_sha: ref.object.sha
	});
	return { branch, commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

// The URL of an open "configure" PR (from configure_brain) for this repo, if any.
// Used to show a pending-review state and to avoid opening a duplicate PR when the
// repo's default branch is protected. Best-effort — never throws.
export async function findOpenConfigPr(
	octokit: Octokit,
	repo: RepoRef
): Promise<string | undefined> {
	try {
		const { data } = await octokit.rest.pulls.list({ ...repo, state: 'open', per_page: 50 });
		return data.find((p) => p.head?.ref?.startsWith('isomorphic/configure'))?.html_url;
	} catch {
		return undefined;
	}
}

// Full recursive tree of markdown files (plus anything else if `all`).
export async function listTree(
	octokit: Octokit,
	repo: RepoRef,
	head: Head,
	opts: { extension?: string } = {}
): Promise<TreeEntry[]> {
	const { data: tree } = await octokit.rest.git.getTree({
		...repo,
		tree_sha: head.treeSha,
		recursive: 'true'
	});
	const ext = opts.extension ?? '.md';
	return tree.tree
		.filter((e) => e.type === 'blob' && e.path && (ext === '*' || e.path.endsWith(ext)))
		.map((e) => ({ path: e.path!, sha: e.sha! }));
}

export interface PageContent {
	path: string;
	content: string;
}

// Fetch the contents of many pages by blob sha. Batched through GraphQL — one
// request pulls up to GRAPHQL_BLOB_BATCH blob texts via aliased `object(oid:)`
// fields — so a whole-brain scan costs ceil(pages / batch) subrequests instead of
// one per page (the old ceiling that pinned scans to 40). Capped at MAX_SCAN_PAGES
// as a sanity bound; `truncated` tells the caller the scan was partial.
export async function fetchPages(
	octokit: Octokit,
	repo: RepoRef,
	entries: TreeEntry[]
): Promise<{ pages: PageContent[]; truncated: boolean }> {
	const take = entries.slice(0, MAX_SCAN_PAGES);
	const pages: PageContent[] = [];
	// GraphQL caps blob `text` for very large files (returns isTruncated=true with a
	// partial body). Those are rare for wiki pages, but fetching partial content would
	// silently drop links near the end — so re-read any truncated blob in full via REST.
	const oversized: TreeEntry[] = [];

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
		batch.forEach((e, i) => (variables[`o${i}`] = e.sha));

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
		const { data } = await octokit.rest.git.getBlob({ ...repo, file_sha: e.sha });
		pages.push({ path: e.path, content: base64ToUtf8(data.content) });
	}

	return { pages, truncated: entries.length > take.length };
}

// Read one file at HEAD via the contents API. Returns null when absent.
export async function readFile(
	octokit: Octokit,
	repo: RepoRef,
	path: string
): Promise<{ content: string; sha: string } | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ ...repo, path });
		if (Array.isArray(data) || data.type !== 'file') return null;
		return { content: base64ToUtf8(data.content), sha: data.sha };
	} catch (err) {
		if ((err as { status?: number })?.status === 404) return null;
		throw err;
	}
}

// One atomic commit: all writes and deletes land together or not at all.
// `deletes` entries that don't exist in the tree are ignored by GitHub.
// The returned sha is internal plumbing — never surface it to the user.
export async function commitFiles(
	octokit: Octokit,
	repo: RepoRef,
	opts: {
		message: string;
		writes?: FileWrite[];
		deletes?: string[];
		head?: Head; // pass when already fetched to save round trips
		author?: CommitAuthor; // attribute the commit to the human, not the App
	}
): Promise<{ sha: string; head: Head }> {
	const head = opts.head ?? (await getHead(octokit, repo));

	type TreeParam = NonNullable<Parameters<Octokit['rest']['git']['createTree']>[0]>['tree'][number];
	const tree: TreeParam[] = [
		...(opts.writes ?? []).map((w) => ({
			path: w.path,
			mode: '100644' as const,
			type: 'blob' as const,
			content: w.content
		})),
		...(opts.deletes ?? []).map((path) => ({
			path,
			mode: '100644' as const,
			type: 'blob' as const,
			sha: null
		}))
	];

	const { data: newTree } = await octokit.rest.git.createTree({
		...repo,
		base_tree: head.treeSha,
		tree
	});
	const author = validCommitAuthor(opts.author);
	const { data: commit } = await octokit.rest.git.createCommit({
		...repo,
		message: opts.message,
		tree: newTree.sha,
		parents: [head.commitSha],
		// committer is filled from author when omitted, so blame shows the human.
		...(author && { author })
	});
	await octokit.rest.git.updateRef({
		...repo,
		ref: `heads/${head.branch}`,
		sha: commit.sha
	});
	return {
		sha: commit.sha,
		head: { branch: head.branch, commitSha: commit.sha, treeSha: newTree.sha }
	};
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
}

// Arm GitHub auto-merge on a freshly-opened PR: it merges automatically once the
// repo's required checks/approvals pass. Handles the two non-happy cases:
//   - PR is already mergeable (no pending required checks) → merge it now.
//   - repo has auto-merge disabled (or it's otherwise unavailable) → leave the PR
//     open for a human; the caller reports the URL.
async function armAutoMerge(
	octokit: Octokit,
	repo: RepoRef,
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
// lives in one place. `head` should be the default branch's head.
export async function commitOrPR(
	octokit: Octokit,
	repo: RepoRef,
	opts: {
		writeMode: 'direct' | 'pull-request';
		defaultBranch: string;
		message: string;
		writes?: FileWrite[];
		deletes?: string[];
		head?: Head;
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
	const head = opts.head ?? (await getHead(octokit, repo));
	if (opts.writeMode === 'direct') {
		await commitFiles(octokit, repo, {
			message: opts.message,
			writes: opts.writes,
			deletes: opts.deletes,
			head,
			author: opts.author
		});
		return {};
	}

	// PR mode: build the identical tree/commit as commitFiles, but land it on a new
	// branch and open a PR instead of moving the default ref.
	type TreeParam = NonNullable<Parameters<Octokit['rest']['git']['createTree']>[0]>['tree'][number];
	const tree: TreeParam[] = [
		...(opts.writes ?? []).map((w) => ({
			path: w.path,
			mode: '100644' as const,
			type: 'blob' as const,
			content: w.content
		})),
		...(opts.deletes ?? []).map((path) => ({
			path,
			mode: '100644' as const,
			type: 'blob' as const,
			sha: null
		}))
	];
	const { data: newTree } = await octokit.rest.git.createTree({
		...repo,
		base_tree: head.treeSha,
		tree
	});
	const author = validCommitAuthor(opts.author);
	const { data: commit } = await octokit.rest.git.createCommit({
		...repo,
		message: opts.message,
		tree: newTree.sha,
		parents: [head.commitSha],
		...(author && { author })
	});
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
	return { prUrl: pr.html_url, prNumber: pr.number, ...autoMergeResult };
}
