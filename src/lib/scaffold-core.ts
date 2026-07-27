// Brain repo scaffolding — runtime-portable core.
//
// This is the Worker-safe half of brain creation: it takes an installation-
// authed Octokit and builds the repo + initial scaffold entirely via the GitHub
// REST/Git Data API (no `node:fs`, no `node:crypto`). The MCP Worker calls this
// to auto-provision a brain on a user's first authenticated request; the Node
// bootstrap server calls the same code so the scaffold is byte-identical across
// both runtimes.
//
// File CONTENTS come from `brain-template.generated.ts` (codegen'd from
// `brain-template/` via `pnpm gen:templates`) so there's no filesystem read.
//
// Scaffold is built as ONE atomic commit (blobs inline in tree → tree → commit
// → ref update). If anything fails halfway, the repo's default branch stays at
// the auto-init commit — no partial state.

import type { Octokit } from 'octokit';
import {
	AGENTS_MD,
	README_MD,
	GITIGNORE,
	WIKI_LOG_MD,
	WIKI_OPEN_QUESTIONS_MD
} from './brain-template.generated.ts';

// The brain's role map, committed as `.isomorphic.json` so the new repo is
// self-describing: editable content lives under wiki/, immutable source material
// under source/, and the tool-maintained changelog at wiki/log.md. Neither folder
// has predefined SUBfolders — structure is arbitrary, grown as needed. (Brains
// without this file fall back to the wiki/ + raw/ defaults in brain-config.ts.)
const SCAFFOLD_CONFIG =
	JSON.stringify(
		{ paths: { 'wiki/': 'content', 'source/': 'source', 'wiki/log.md': 'log' } },
		null,
		2
	) + '\n';

interface FileEntry {
	path: string;
	content: string;
}

export function buildScaffoldFiles(): FileEntry[] {
	return [
		{ path: 'AGENTS.md', content: AGENTS_MD },
		{ path: 'README.md', content: README_MD },
		{ path: '.gitignore', content: GITIGNORE },
		{ path: '.isomorphic.json', content: SCAFFOLD_CONFIG },
		{ path: 'wiki/log.md', content: WIKI_LOG_MD },
		{ path: 'wiki/open-questions.md', content: WIKI_OPEN_QUESTIONS_MD },
		// A single empty source/ area for immutable source material (add files via
		// GitHub); .gitkeep because git doesn't track empty dirs.
		{ path: 'source/.gitkeep', content: '' }
	];
}

export interface CreatedBrain {
	owner: string;
	name: string;
	htmlUrl: string;
	commitSha: string;
}

// Commit the scaffold onto an already-created repo. Split out from repo creation
// so the provisioning path can scaffold a repo it just adopted (e.g. a prior
// partial run left the repo but no tenant row).
export async function scaffoldExistingRepo(
	octokit: Octokit,
	opts: { owner: string; repo: string; branch: string }
): Promise<string> {
	const { owner, repo, branch } = opts;

	// Base our scaffold tree on the auto-init commit's tree.
	const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
	const parentSha = ref.object.sha;
	const { data: parentCommit } = await octokit.rest.git.getCommit({
		owner,
		repo,
		commit_sha: parentSha
	});

	// Inline `content` tells GitHub to create blobs for us — one round trip per
	// file saved. `base_tree` layers on top of auto-init (our README.md overwrites
	// the auto-generated one).
	const files = buildScaffoldFiles();
	const { data: newTree } = await octokit.rest.git.createTree({
		owner,
		repo,
		base_tree: parentCommit.tree.sha,
		tree: files.map((f) => ({
			path: f.path,
			mode: '100644',
			type: 'blob',
			content: f.content
		}))
	});

	const { data: commit } = await octokit.rest.git.createCommit({
		owner,
		repo,
		message: 'Scaffold brain: AGENTS.md, README, .isomorphic.json, wiki/ and source/',
		tree: newTree.sha,
		parents: [parentSha]
	});

	await octokit.rest.git.updateRef({
		owner,
		repo,
		ref: `heads/${branch}`,
		sha: commit.sha
	});

	return commit.sha;
}

// Create the repo on an ORG (needs `administration: write`, only granted on org
// installs) and scaffold it. `auto_init` gives us a default branch + initial
// commit to parent the scaffold against.
export async function createAndScaffoldBrain(
	octokit: Octokit,
	opts: { org: string; name: string; description?: string }
): Promise<CreatedBrain> {
	const { data: repo } = await octokit.rest.repos.createInOrg({
		org: opts.org,
		name: opts.name,
		description: opts.description ?? 'Brain — LLM-maintained knowledge base',
		private: true,
		auto_init: true,
		has_issues: true,
		has_projects: false,
		has_wiki: false
	});

	const commitSha = await scaffoldExistingRepo(octokit, {
		owner: repo.owner.login,
		repo: repo.name,
		branch: repo.default_branch
	});

	return {
		owner: repo.owner.login,
		name: repo.name,
		htmlUrl: repo.html_url,
		commitSha
	};
}
