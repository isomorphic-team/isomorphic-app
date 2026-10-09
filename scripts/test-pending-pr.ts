// Golden test for how PR-mode writes share one open pull request (BrainStore.writeHead,
// commitOrPR's append path, src/lib/brain-repo.ts) and the text that pull request
// carries (coalescedPrText, src/lib/change-record.ts). The GitHub store runs against
// an in-memory fake of the few REST calls it makes, so no network is touched.
//
//   pnpm test:pending-pr
//
// What it exists to catch:
//   1. A SECOND PULL REQUEST. A write while an Isomorphic pull request is open must
//      land on that pull request's branch, not open another one from the default
//      branch that lacks the first change.
//   2. A WRITE PLANNED WITHOUT THE PENDING CHANGE. writeHead must hand back the pull
//      request's head, so a read pinned to it sees what is waiting there.
//   3. JOINING THE WRONG PULL REQUEST: a human's branch, a fork, another base,
//      configure_brain's own pull request, or one GitHub reports as conflicting.
//   4. A STRANDED PULL REQUEST. One that fell behind the default branch is updated
//      after the append, or "require branches to be up to date" holds it forever.
//   5. A LOST CONCURRENT WRITE. A branch that moved under the write fails the write
//      (non-forced ref update) instead of overwriting the other commit.
//   6. A TITLE THAT DESCRIBES ONE CHANGE when the pull request holds several.

import { createHash } from 'node:crypto';
import type { Octokit } from 'octokit';
import {
	githubStore,
	pendingPrCandidates,
	type OpenPrSummary,
	type RepoRef
} from '../src/lib/brain-repo.ts';
import { coalescedPrText } from '../src/lib/change-record.ts';
import { checker } from './check.ts';

const { check, done } = checker('pending-pr checks');

// ---------- pendingPrCandidates ----------

const repoFullName = 'example-org/brain';
const pr = (
	number: number,
	headRef: string,
	extra: Partial<OpenPrSummary> = {}
): OpenPrSummary => ({
	number,
	baseRef: 'main',
	headRef,
	headRepo: repoFullName,
	...extra
});
const picked = pendingPrCandidates(
	[
		pr(3, 'isomorphic/update-aaaa'),
		pr(9, 'isomorphic/edit-bbbb'),
		pr(10, 'feature/human-branch'),
		pr(11, 'isomorphic/configure-cccc'),
		pr(12, 'isomorphic/update-dddd', { headRepo: 'someone/fork' }),
		pr(13, 'isomorphic/update-eeee', { baseRef: 'develop' }),
		pr(14, 'isomorphic/update-ffff', { headRepo: null }),
		pr(15, 'isomorphic/update-gggg', { headRepo: 'Example-Org/Brain' })
	],
	{ defaultBranch: 'main', repoFullName }
).map((p) => p.number);
check(
	"only Isomorphic's own branches in this repo against the default branch, newest first",
	JSON.stringify(picked) === JSON.stringify([15, 9, 3]),
	JSON.stringify(picked)
);

// ---------- coalescedPrText ----------

const once = coalescedPrText(
	{
		title: 'Add Team Training',
		body: 'Create `wiki/a.md`. Proposed via the Isomorphic brain tools.'
	},
	'Update CHANGELOG.md'
);
check(
	'first append retitles to cover both',
	once.title === 'Add Team Training and 1 more change',
	once.title
);
check(
	'first append lists both changes',
	once.body.includes('- Add Team Training\n- Update CHANGELOG.md'),
	once.body
);
const twice = coalescedPrText(
	{ title: 'edited by a human', body: `Reviewer note above.\n\n${once.body}` },
	'Move  wiki/a.md\n→ wiki/b.md'
);
check(
	'second append extends the list',
	twice.title === 'Add Team Training and 2 more changes',
	twice.title
);
check(
	'an appended title is flattened to one list line',
	twice.body.includes('- Move wiki/a.md → wiki/b.md'),
	twice.body
);

// ---------- the store, over a fake GitHub ----------

type Tree = Map<string, string>;
interface FakePr {
	number: number;
	head: string;
	base: string;
	title: string;
	body: string;
	mergeable: boolean | null;
	mergeable_state: string;
	auto_merge: object | null;
	state: 'open';
}

function blobSha(content: string) {
	return createHash('sha1').update(content).digest('hex');
}

function fakeGitHub() {
	const trees = new Map<string, Tree>();
	const commits = new Map<string, { tree: string; parents: string[] }>();
	const refs = new Map<string, string>();
	const prs: FakePr[] = [];
	const calls: string[] = [];
	let n = 0;
	const id = (k: string) => `${k}${++n}`.padEnd(40, '0');
	const putTree = (t: Tree) => {
		const sha = id('t');
		trees.set(sha, t);
		return sha;
	};
	const putCommit = (tree: string, parents: string[]) => {
		const sha = id('c');
		commits.set(sha, { tree, parents });
		return sha;
	};
	const root = putCommit(putTree(new Map([['wiki/log.md', '# Log\n']])), []);
	refs.set('main', root);
	let failList = false;

	const prData = (p: FakePr) => ({
		number: p.number,
		html_url: `https://github.example/pull/${p.number}`,
		node_id: `PR_${p.number}`,
		title: p.title,
		body: p.body,
		state: p.state,
		mergeable: p.mergeable,
		mergeable_state: p.mergeable_state,
		auto_merge: p.auto_merge,
		base: { ref: p.base },
		head: { ref: p.head, sha: refs.get(p.head)!, repo: { full_name: repoFullName } }
	});
	const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

	const octokit = {
		rest: {
			git: {
				getRef: async ({ ref }: { ref: string }) => {
					const sha = refs.get(ref.replace(/^heads\//, ''));
					if (!sha) throw notFound();
					return { data: { object: { sha } } };
				},
				getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
					data: { tree: { sha: commits.get(commit_sha)!.tree } }
				}),
				createBlob: async () => {
					throw new Error('no binary writes in this battery');
				},
				createTree: async ({
					base_tree,
					tree
				}: {
					base_tree: string;
					tree: { path: string; content?: string; sha?: string | null }[];
				}) => {
					const t = new Map(trees.get(base_tree));
					for (const e of tree) {
						if (e.sha === null) t.delete(e.path);
						else t.set(e.path, e.content ?? '');
					}
					return { data: { sha: putTree(t) } };
				},
				createCommit: async ({ tree, parents }: { tree: string; parents: string[] }) => ({
					data: { sha: putCommit(tree, parents) }
				}),
				createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
					calls.push('createRef');
					refs.set(ref.replace(/^refs\/heads\//, ''), sha);
					return { data: {} };
				},
				updateRef: async ({ ref, sha, force }: { ref: string; sha: string; force: boolean }) => {
					calls.push('updateRef');
					const branch = ref.replace(/^heads\//, '');
					if (!force && !commits.get(sha)!.parents.includes(refs.get(branch)!))
						throw Object.assign(new Error('Update is not a fast forward'), { status: 422 });
					refs.set(branch, sha);
					return { data: {} };
				}
			},
			repos: {
				getContent: async ({ path, ref }: { path: string; ref?: string }) => {
					const commit = ref && commits.has(ref) ? ref : refs.get(ref ?? 'main');
					const content = commit ? trees.get(commits.get(commit)!.tree)!.get(path) : undefined;
					if (content === undefined) throw notFound();
					return {
						data: {
							type: 'file',
							sha: blobSha(content),
							size: content.length,
							encoding: 'base64',
							content: Buffer.from(content).toString('base64')
						}
					};
				}
			},
			pulls: {
				list: async () => {
					calls.push('pulls.list');
					if (failList) throw new Error('rate limited');
					return { data: prs.filter((p) => p.state === 'open').map(prData) };
				},
				get: async ({ pull_number }: { pull_number: number }) => ({
					data: prData(prs.find((p) => p.number === pull_number)!)
				}),
				create: async ({ head, base, title, body }: Record<string, string>) => {
					calls.push('pulls.create');
					const p: FakePr = {
						number: prs.length + 1,
						head,
						base,
						title,
						body,
						mergeable: null,
						mergeable_state: 'unknown',
						auto_merge: null,
						state: 'open'
					};
					prs.push(p);
					return { data: prData(p) };
				},
				update: async ({
					pull_number,
					title,
					body
				}: {
					pull_number: number;
					title: string;
					body: string;
				}) => {
					calls.push('pulls.update');
					Object.assign(
						prs.find((p) => p.number === pull_number)!,
						{ title, body }
					);
					return { data: {} };
				},
				updateBranch: async ({
					pull_number,
					expected_head_sha
				}: {
					pull_number: number;
					expected_head_sha: string;
				}) => {
					calls.push(
						`pulls.updateBranch#${pull_number}@${expected_head_sha === refs.get(prs[pull_number - 1].head)}`
					);
					return { data: {} };
				}
			}
		},
		graphql: async (_q: string, vars: { id: string }) => {
			calls.push(`graphql:${vars.id}`);
			const p = prs.find((x) => `PR_${x.number}` === vars.id)!;
			p.auto_merge = {};
			return {};
		}
	};
	return {
		octokit: octokit as unknown as Octokit,
		prs,
		refs,
		calls,
		// Another write lands on `branch` first.
		advanceBranch: (branch: string) => {
			const tip = refs.get(branch)!;
			const t = new Map(trees.get(commits.get(tip)!.tree));
			t.set('wiki/concurrent.md', 'theirs\n');
			refs.set(branch, putCommit(putTree(t), [tip]));
		},
		setFailList: (v: boolean) => (failList = v),
		// Someone merges unrelated work into main, leaving open pull requests behind.
		advanceMain: () => {
			const tip = refs.get('main')!;
			const t = new Map(trees.get(commits.get(tip)!.tree));
			t.set('wiki/other.md', 'other\n');
			refs.set('main', putCommit(putTree(t), [tip]));
		}
	};
}

const repo: RepoRef = { owner: 'example-org', repo: 'brain' };
const prMode = { defaultBranch: 'main', writeMode: 'pull-request' as const };
const writeOpts = (prTitle: string) => ({
	...prMode,
	message: prTitle,
	branchPrefix: 'isomorphic/update',
	prTitle,
	prBody: `${prTitle}. Proposed via the Isomorphic brain tools.`,
	autoMerge: true,
	mergeMethod: 'SQUASH' as const
});

async function storeChecks() {
	const gh = fakeGitHub();
	const store = githubStore(gh.octokit);

	const direct = await store.writeHead(repo, { defaultBranch: 'main', writeMode: 'direct' });
	check('direct mode writes on the default branch', direct.branch === 'main' && !direct.pr);
	check('direct mode never lists pull requests', !gh.calls.includes('pulls.list'));

	// First write: nothing open, so it opens pull request #1.
	const h1 = await store.writeHead(repo, prMode);
	check('PR mode with nothing open starts from the default branch', h1.branch === 'main' && !h1.pr);
	const first = await store.commitOrPR(repo, {
		...writeOpts('Add Team Training'),
		head: h1,
		writes: [{ path: 'wiki/a.md', content: 'v1\n' }]
	});
	check('the first write opens a pull request', first.prNumber === 1 && !first.appended);
	check(
		'and reports the commit it put on that branch',
		first.branchSha === gh.refs.get(gh.prs[0].head)
	);

	// Second write: joins #1, planned against its branch.
	const h2 = await store.writeHead(repo, prMode);
	check(
		'writeHead returns the open pull request',
		h2.pr?.number === 1 && h2.branch === gh.prs[0].head
	);
	const seen = await store.readFile(repo, 'wiki/a.md', h2.commitSha);
	check('a read pinned to that head sees the pending change', seen?.content === 'v1\n');
	const opened = gh.calls.filter((c) => c === 'pulls.create').length;
	const second = await store.commitOrPR(repo, {
		...writeOpts('Update CHANGELOG.md'),
		head: h2,
		writes: [{ path: 'wiki/log.md', content: '# Log\n- two\n' }]
	});
	check(
		'the second write opens no pull request',
		gh.calls.filter((c) => c === 'pulls.create').length === opened
	);
	check('it lands on pull request #1', second.prNumber === 1 && second.appended === true);
	const tip = await store.readFile(repo, 'wiki/a.md', gh.prs[0].head);
	const log = await store.readFile(repo, 'wiki/log.md', gh.prs[0].head);
	check(
		'the branch holds both changes',
		tip?.content === 'v1\n' && log?.content === '# Log\n- two\n'
	);
	check(
		'the pull request is retitled',
		gh.prs[0].title === 'Add Team Training and 1 more change',
		gh.prs[0].title
	);
	check(
		'auto-merge armed on open is not re-armed',
		gh.calls.filter((c) => c.startsWith('graphql')).length === 1
	);
	check(
		'the default branch did not move',
		(await store.readFile(repo, 'wiki/a.md', 'main')) === null
	);

	// Behind: main moved, so the append also updates the branch.
	gh.advanceMain();
	gh.prs[0].mergeable_state = 'behind';
	const h3 = await store.writeHead(repo, prMode);
	await store.commitOrPR(repo, {
		...writeOpts('Update A'),
		head: h3,
		writes: [{ path: 'wiki/a.md', content: 'v2\n' }]
	});
	check(
		'a pull request behind the default branch is updated after the append',
		gh.calls.includes('pulls.updateBranch#1@true'),
		gh.calls.join(' ')
	);
	gh.prs[0].mergeable_state = 'clean';

	// Concurrent write: the branch moved between writeHead and the commit.
	const h4 = await store.writeHead(repo, prMode);
	gh.advanceBranch(h4.branch);
	const theirs = gh.refs.get(h4.branch);
	const titleBefore = gh.prs[0].title;
	let threw = '';
	try {
		await store.commitOrPR(repo, {
			...writeOpts('Update B'),
			head: h4,
			writes: [{ path: 'wiki/b.md', content: 'b\n' }]
		});
	} catch (err) {
		threw = String((err as Error).message);
	}
	check(
		'a branch that moved fails the write with a retry instruction',
		/changed while this write/.test(threw),
		threw
	);
	check('and keeps the commit that landed first', gh.refs.get(h4.branch) === theirs);
	check('and leaves the pull request text alone', gh.prs[0].title === titleBefore);

	// A conflicting pull request is not joined.
	gh.prs[0].mergeable = false;
	const h5 = await store.writeHead(repo, prMode);
	check('a conflicting pull request is skipped', h5.branch === 'main' && !h5.pr);
	gh.prs[0].mergeable = null;

	// Listing fails: behave as before, from the default branch.
	gh.setFailList(true);
	const h6 = await store.writeHead(repo, prMode);
	check(
		'a failed pull request listing falls back to the default branch',
		h6.branch === 'main' && !h6.pr
	);
	gh.setFailList(false);
}

try {
	await storeChecks();
} catch (err) {
	check('store checks ran', false, String((err as Error)?.stack ?? err));
}
done();
