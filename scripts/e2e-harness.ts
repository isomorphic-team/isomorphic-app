// The scaffolding the end-to-end batteries share (e2e-librarian.ts, e2e-import.ts).
//
// A scratch brain on either backend, an in-memory MCP client wired to real tool
// handlers, and the waits that only GitHub needs:
//
//   - offline (default): the fs + git BrainStore in a temp directory, no network.
//   - `--github`: a scratch repo on the platform org, from `.dev.vars` (repo root, or
//     DEV_VARS_PATH) with the platform App creds + PLATFORM_ORG /
//     PLATFORM_INSTALLATION_ID. Every repo it creates is deleted in `cleanup`,
//     success or failure.
//
// GitHub's refs and contents reads are eventually consistent for a short window after
// a write; the fs store commits synchronously. So `replicationLag` and `settledHead`
// wait only in GitHub mode, and `eventually` returns as soon as its condition holds.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Octokit } from 'octokit';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { installationOctokit } from '../src/lib/github.ts';
import { createAndScaffoldBrain, buildScaffoldFiles } from '../src/lib/scaffold-core.ts';
import { githubStore, type BrainStore } from '../src/lib/brain-repo.ts';
import { ensureGitRepo, fsBrainStore } from '../src/local/brain-store-fs.ts';
import { readDevVars } from '../src/persist.ts';

export const GITHUB_MODE = process.argv.includes('--github');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The pause a GitHub write needs before a read sees it. No-op offline.
export async function replicationLag(ms = 1500): Promise<void> {
	if (GITHUB_MODE) await sleep(ms);
}

// Poll until `pred` holds or `ms` runs out, and return the last value either way.
export async function eventually<T>(
	fn: () => Promise<T>,
	pred: (v: T) => boolean,
	ms = 15000
): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T = await fn();
	while (!pred(last) && Date.now() < deadline) {
		await sleep(1500);
		last = await fn();
	}
	return last;
}

export interface ScratchBrain {
	store: BrainStore;
	repoArgs: { owner: string; repo: string };
	brainId: string;
	// The repo name, or the temp directory's basename offline.
	name: string;
	// The platform-org client. GitHub mode only.
	octokit?: Octokit;
	// Scaffold another repo on the platform org and delete it in `cleanup`. GitHub mode only.
	scaffoldRepo(name: string, description: string): Promise<void>;
	// Delete this repo in `cleanup` as well. A no-op offline.
	deleteOnCleanup(name: string): void;
	headSha(): Promise<string>;
	// The head once it has stopped moving. Offline that is the head now.
	settledHead(): Promise<string>;
	cleanup(): Promise<void>;
}

const AUTHOR = { name: 'E2E', email: 'e2e@localhost' };

// `prefix` names the repo or temp directory (`brain-<battery>-e2e`).
export async function scratchBrain(prefix: string, description: string): Promise<ScratchBrain> {
	if (GITHUB_MODE) return githubScratchBrain(prefix, description);

	const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
	const name = basename(dir);
	console.log(`Creating scratch brain in ${dir} …`);
	await ensureGitRepo(dir, AUTHOR);
	const store = fsBrainStore({ dir, author: AUTHOR });
	const repoArgs = { owner: 'local', repo: name };
	// The same scaffold the GitHub path gets, from the same pure builder, so both
	// backends start from a byte-identical brain.
	await store.commitFiles(repoArgs, { message: 'Scaffold brain', writes: buildScaffoldFiles() });
	const headSha = async () => (await store.getHead(repoArgs)).commitSha;
	return {
		store,
		repoArgs,
		brainId: `local/${name}`,
		name,
		scaffoldRepo: async () => {
			throw new Error('scaffoldRepo needs --github');
		},
		deleteOnCleanup: () => {},
		headSha,
		settledHead: headSha,
		cleanup: async () => {
			// Retried: git's auto gc can detach into the background after a commit and
			// still be writing under `.git`, and a plain recursive rm then fails
			// ENOTEMPTY. Node retries exactly that error.
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	};
}

async function githubScratchBrain(prefix: string, description: string): Promise<ScratchBrain> {
	const devVars = await readDevVars(process.env.DEV_VARS_PATH);
	const org = devVars.PLATFORM_ORG;
	const installationId = Number(devVars.PLATFORM_INSTALLATION_ID);
	if (!org || !installationId) throw new Error('PLATFORM_ORG / PLATFORM_INSTALLATION_ID missing');
	const octokit = await installationOctokit(
		{
			appId: Number(devVars.GITHUB_APP_ID),
			privateKeyBase64: devVars.GITHUB_APP_PRIVATE_KEY_BASE64
		},
		installationId
	);
	const name = `${prefix}-${Date.now().toString(36)}`;
	const toDelete: string[] = [];
	const scaffoldRepo = async (repo: string, desc: string) => {
		console.log(`Creating scratch repo ${org}/${repo} …`);
		toDelete.push(repo);
		return createAndScaffoldBrain(octokit, { org, name: repo, description: desc });
	};
	const brain = await scaffoldRepo(name, description);
	const store = githubStore(octokit);
	const repoArgs = { owner: brain.owner, repo: brain.name };
	const headSha = async () => (await store.getHead(repoArgs)).commitSha;
	return {
		store,
		repoArgs,
		brainId: `${brain.owner}/${brain.name}`,
		name,
		octokit,
		scaffoldRepo: async (repo, desc) => void (await scaffoldRepo(repo, desc)),
		deleteOnCleanup: (repo) => void toDelete.push(repo),
		headSha,
		settledHead: async () => {
			let prev = await headSha();
			for (let i = 0; i < 5; i++) {
				await sleep(1200);
				const next = await headSha();
				if (next === prev) return next;
				prev = next;
			}
			return prev;
		},
		cleanup: async () => {
			for (const repo of toDelete) {
				console.log(`\nDeleting scratch repo ${org}/${repo} …`);
				try {
					await octokit.rest.repos.delete({ owner: org, repo });
					console.log('Deleted.');
				} catch (err) {
					console.log(
						`Could not delete (${(err as { status?: number }).status}), delete manually: https://github.com/${org}/${repo}/settings`
					);
				}
			}
		}
	};
}

export interface CallResult {
	isError: boolean;
	// Every text block, joined: what an agent reads.
	text: string;
	// What the app reads, and what a host that receives it hands the model instead.
	sc: Record<string, unknown>;
}

export interface Connected {
	client: Client;
	call(tool: string, args: Record<string, unknown>): Promise<CallResult>;
	close(): Promise<void>;
}

// Connect an in-memory client to `server`, whose tools are already registered.
export async function connect(server: McpServer, name = 'e2e'): Promise<Connected> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name, version: '0.0.0' });
	await client.connect(clientTransport);
	return {
		client,
		async call(tool, args) {
			const res = (await client.callTool({ name: tool, arguments: args })) as {
				isError?: boolean;
				content?: { type: string; text?: string }[];
				structuredContent?: Record<string, unknown>;
			};
			return {
				isError: !!res.isError,
				text: (res.content ?? [])
					.filter((c) => c.type === 'text')
					.map((c) => c.text ?? '')
					.join('\n'),
				sc: res.structuredContent ?? {}
			};
		},
		async close() {
			await client.close();
			await server.close();
		}
	};
}
