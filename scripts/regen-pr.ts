// pnpm regen:pr <number> [--push] — regenerate the codegen'd artifacts on a pull
// request branch, for the one case where the author cannot do it themselves.
//
// WHY THIS EXISTS. `src/lib/app-bundle.generated.ts` is the app UI bundled by esbuild,
// and esbuild INLINES the dependencies the UI imports. So the committed bundle changes
// when zod or markdown-it changes, not only when app/ changes. Dependabot writes
// package.json and the lockfile and nothing else, so every bump of a bundled package
// arrives with a stale bundle and fails ci.yml's "Generated artifacts in sync with
// source" step. The bot cannot fix that: it does not run repository code. A maintainer
// has to regenerate and push the result, and this is that operation.
//
// It is deliberately NOT a workflow. Regenerating means installing and bundling a
// dependency version nobody has reviewed yet, and doing that automatically would need a
// token with write access to this repository, on a public repo, at the say-so of a bot
// pull request. That is the supply-chain shape the dependency scanning exists to defend
// against, so the trigger stays a human who has read the diff. (Pushing from Actions
// would not even work: a GITHUB_TOKEN push does not re-trigger checks, so the pull
// request would keep showing the failure it had just fixed.)
//
// SAFE BY CONSTRUCTION: the work happens in a throwaway `git worktree` under the system
// temp directory. Your checkout is never switched, never stashed, and never touched.
//
// Usage:
//   pnpm regen:pr 55            # regenerate + commit in a temp worktree, show the diff
//   pnpm regen:pr 55 --push     # ...and push it to the pull request branch
//
// Default is LOCAL ONLY: nothing leaves the machine until you pass --push. Re-running
// against an already-regenerated branch is a no-op, so retrying is safe.
//
// NOTE: pushing to a Dependabot branch makes Dependabot stop rebasing that pull
// request. That is the intended end state (you are about to merge it), but it does mean
// regenerating is the LAST step, after the rest of the review has settled.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENERATED = ['src/lib/app-bundle.generated.ts', 'src/lib/brain-template.generated.ts'];

function run(cmd: string, args: string[], cwd?: string): string {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
	if (r.status !== 0) {
		const detail = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
		throw new Error(`${cmd} ${args.join(' ')} failed:\n${detail}`);
	}
	return (r.stdout ?? '').trim();
}

function step(cmd: string, args: string[], cwd: string) {
	console.log(`  $ ${cmd} ${args.join(' ')}`);
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

const argv = process.argv.slice(2);
const push = argv.includes('--push');
const pr = argv.find((a) => /^\d+$/.test(a));

if (!pr) {
	console.error('usage: pnpm regen:pr <pull-request-number> [--push]');
	process.exit(2);
}

// Resolve the branch through gh rather than taking it as an argument: the number is
// what a maintainer has in front of them, and resolving it proves the pull request is
// real and readable with the currently active account before anything else runs.
const meta = JSON.parse(
	run('gh', ['pr', 'view', pr, '--json', 'headRefName,title,isCrossRepository'])
) as { headRefName: string; title: string; isCrossRepository: boolean };

if (meta.isCrossRepository) {
	// A fork's branch is not ours to push to, and pushing would need the contributor to
	// have allowed maintainer edits. Say so now rather than failing at the push.
	console.error(`PR #${pr} comes from a fork. Ask the author to run 'pnpm gen:app' and commit.`);
	process.exit(1);
}

console.log(`\nPR #${pr}  ${meta.title}`);
console.log(`branch    ${meta.headRefName}\n`);

const dir = mkdtempSync(join(tmpdir(), 'isomorphic-regen-'));
try {
	regenerate(dir);
} finally {
	// Deregister the worktree before removing the directory: dropping the directory on
	// its own leaves a stale entry in `git worktree list` that blocks the next run.
	//
	// This runs through a `finally` around a CALL rather than around the body itself
	// because the body returns early on both of its no-push paths, and an early
	// `process.exit()` inside a try block skips `finally` entirely. The first version
	// did exactly that and leaked a worktree per run.
	spawnSync('git', ['worktree', 'remove', '--force', dir], { encoding: 'utf8' });
	rmSync(dir, { recursive: true, force: true });
}

function regenerate(dir: string) {
	run('git', ['fetch', 'origin', meta.headRefName]);
	// --detach so the temp worktree never claims the branch name, which would stop your
	// own checkout from using it. The push below names an explicit refspec instead.
	run('git', ['worktree', 'add', '--detach', dir, 'FETCH_HEAD']);

	console.log('installing and regenerating (this is the dependency version under review)\n');
	step('pnpm', ['install', '--frozen-lockfile'], dir);
	step('pnpm', ['gen:templates'], dir);
	step('pnpm', ['gen:app'], dir);

	const dirty = run('git', ['status', '--porcelain', '--', ...GENERATED], dir);
	if (!dirty) {
		console.log(`\nNothing to do: the generated files on ${meta.headRefName} already match.`);
		return;
	}

	console.log('\n' + run('git', ['diff', '--stat', '--', ...GENERATED], dir));

	run('git', ['add', '--', ...GENERATED], dir);
	run(
		'git',
		[
			'commit',
			'-m',
			'build: regenerate the app bundle for the dependency bump',
			'-m',
			`The bundle inlines the packages the UI imports, so a dependency bump changes it. Dependabot writes only package.json and the lockfile, so it cannot run codegen. Regenerated with 'pnpm regen:pr ${pr}'.`
		],
		dir
	);

	if (!push) {
		console.log(`\nCommitted locally. Re-run with --push to send it to ${meta.headRefName}.`);
		return;
	}

	run('git', ['push', 'origin', `HEAD:refs/heads/${meta.headRefName}`], dir);
	console.log(`\nPushed to ${meta.headRefName}. CI will re-run on PR #${pr}.`);
}
