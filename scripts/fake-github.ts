// A fake GitHub for batteries that drive the REAL githubStore adapter (and through it
// fetchPages' GraphQL batching) without a network. It implements only the octokit
// surface that adapter touches, serves `pages` at `head`, and counts every call.
//
// `.isomorphic.json` exists at a revision when `configFilesByRef` holds that ref: it
// is then a blob in the tree and readable through getContent, which records the ref
// it was asked for in `configReadRefs`. `heads/missing` 404s, so a branch fallback has
// a real miss to take.
//
// Writes (createTree, createCommit, updateRef) apply to `pages` and move `head`. A
// written page's sha is git's own blob id, computed with node:crypto, so a battery can
// check the adapter's version tags against git rather than against the adapter.

import { createHash } from 'node:crypto';

export interface FakePage {
	path: string;
	sha: string;
	content: string;
}

export interface FakeGithubCalls {
	graphql: number;
	reposGet: number;
	getBranch: number;
	getContent: number;
	getRef: number;
	getCommit: number;
	getTree: number;
}

export interface FakeGithub {
	/** Pass to githubStore(). */
	octokit: never;
	pages: FakePage[];
	head: string;
	calls: FakeGithubCalls;
	configFilesByRef: Map<string, string>;
	configReadRefs: string[];
	/** Every GitHub round trip so far, summed across endpoints. */
	callCount(): number;
}

// git's object id for a blob: SHA-1 over `blob <bytes>\0<content>`.
export function realGitBlobSha(content: string): string {
	const body = Buffer.from(content, 'utf8');
	return createHash('sha1')
		.update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
		.digest('hex');
}

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

export function fakeGithub(): FakeGithub {
	const gh: FakeGithub = {
		octokit: undefined as never,
		pages: [],
		head: 'commit-0',
		calls: {
			graphql: 0,
			reposGet: 0,
			getBranch: 0,
			getContent: 0,
			getRef: 0,
			getCommit: 0,
			getTree: 0
		},
		configFilesByRef: new Map(),
		configReadRefs: [],
		callCount: () => Object.values(gh.calls).reduce((a, b) => a + b, 0)
	};
	const { calls } = gh;
	let commits = 0;

	gh.octokit = {
		graphql: async (_query: string, variables: Record<string, string>) => {
			calls.graphql++;
			const byOid = new Map(gh.pages.map((p) => [p.sha, p]));
			const repository: Record<string, { text: string; isTruncated: boolean } | null> = {};
			for (const [k, v] of Object.entries(variables)) {
				if (!k.startsWith('o')) continue;
				const p = byOid.get(v);
				repository[`b${k.slice(1)}`] = p ? { text: p.content, isTruncated: false } : null;
			}
			return { repository };
		},
		rest: {
			repos: {
				get: async () => {
					calls.reposGet++;
					return {
						data: { default_branch: 'main', allow_squash_merge: true, allow_merge_commit: true }
					};
				},
				getBranch: async () => {
					calls.getBranch++;
					return { data: { protected: false } };
				},
				getContent: async ({ path, ref }: { path: string; ref?: string }) => {
					calls.getContent++;
					if (path === '.isomorphic.json') {
						const at = ref ?? gh.head;
						gh.configReadRefs.push(at);
						const content = gh.configFilesByRef.get(at);
						if (content !== undefined) {
							return {
								data: {
									type: 'file',
									content: Buffer.from(content).toString('base64'),
									sha: `config-${at}`
								}
							};
						}
					}
					throw notFound();
				}
			},
			git: {
				getRef: async ({ ref }: { ref: string }) => {
					calls.getRef++;
					if (ref === 'heads/missing') throw notFound();
					return { data: { object: { sha: gh.head } } };
				},
				getCommit: async () => {
					calls.getCommit++;
					return { data: { tree: { sha: `tree-${gh.head}` } } };
				},
				getTree: async () => {
					calls.getTree++;
					const tree = gh.pages.map((p) => ({ type: 'blob', path: p.path, sha: p.sha }));
					if (gh.configFilesByRef.has(gh.head)) {
						tree.push({ type: 'blob', path: '.isomorphic.json', sha: `config-${gh.head}` });
					}
					return { data: { tree } };
				},
				createTree: async ({
					tree
				}: {
					tree: { path: string; content?: string; sha?: string | null }[];
				}) => {
					for (const e of tree) {
						gh.pages = gh.pages.filter((p) => p.path !== e.path);
						if (e.sha === null) continue;
						if (e.content === undefined) throw new Error('binary writes are not faked');
						gh.pages.push({ path: e.path, sha: realGitBlobSha(e.content), content: e.content });
					}
					return { data: { sha: `tree-pending` } };
				},
				createCommit: async () => ({ data: { sha: `commit-w${++commits}` } }),
				updateRef: async ({ sha }: { sha: string }) => {
					gh.head = sha;
					return { data: {} };
				},
				getBlob: async () => {
					throw new Error('getBlob should not be needed (no oversized blobs in this fixture)');
				}
			}
		}
	} as never;

	return gh;
}
