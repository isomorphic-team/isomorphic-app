// Golden test for the Claude Code hooks (`scripts/agent-hooks.ts`, wired in
// `.claude/settings.json`). No network.
//
//   pnpm test:hooks
//
// What this exists to catch:
//
//   1. A GUARD THAT STOPPED GUARDING. Each refusal is a rule CLAUDE.md states; the
//      hook is what makes it hold in a session that skimmed past it. So each is pinned
//      both ways: the dangerous form is refused, the everyday neighbour is not.
//   2. A HOOK THAT BLOCKS BY ACCIDENT. A PreToolUse hook runs before every edit and
//      command, so a false positive stalls every session in the repo.
//   3. SETTINGS AND SCRIPT DRIFTING APART. A mode renamed in one and not the other
//      turns a guard into a silent no-op, so the wiring is read from the settings file.
//   4. THE REAL PROCESS. Exit 2 with the reason on stderr is the contract Claude Code
//      reads; the last section runs the script the way the hook does.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GEN_APP, GEN_TEMPLATES, generatorsFor, refuseCommand, refuseEdit } from './agent-hooks.ts';
import { checker } from './check.ts';

const { check, done } = checker('hooks checks');
const root = fileURLToPath(new URL('..', import.meta.url));

console.log('\nedits: generated files and committed migrations are refused');
check('wrangler.jsonc', refuseEdit('wrangler.jsonc', false) !== null);
check('the template is editable', refuseEdit('wrangler.template.jsonc', true) === null);
check('the app bundle', refuseEdit('src/lib/app-bundle.generated.ts', true) !== null);
check('the view registry', refuseEdit('app/views/registry.generated.ts', true) !== null);
check(
	'the brain template module',
	refuseEdit('src/lib/brain-template.generated.ts', true) !== null
);
check(
	'a source file beside them is editable',
	refuseEdit('src/lib/brain-policy.ts', true) === null
);
check('a committed migration', refuseEdit('migrations/0009_brain_invitations.sql', true) !== null);
check('a new migration is editable', refuseEdit('migrations/0099_add-thing.sql', false) === null);
check('reference SQL is editable', refuseEdit('src/db/schema.sql', true) === null);
check(
	'the refusal names the way forward',
	refuseEdit('src/lib/app-bundle.generated.ts', true)!.includes('pnpm gen:app')
);

console.log('\ncommands: remote D1 writes and force-added secrets are refused');
const refused = [
	'wrangler d1 migrations apply platform-db --remote',
	'pnpm exec wrangler d1 execute platform-db --remote --command "DELETE FROM x"',
	'npx wrangler d1 execute platform-db --command "select 1" --remote',
	'pnpm test && wrangler d1 migrations apply platform-db --remote',
	'git add -f wrangler.jsonc',
	'git add --force .dev.vars src/x.ts'
];
for (const c of refused) check(`refuses: ${c}`, refuseCommand(c) !== null);
const allowed = [
	'pnpm db:migrate',
	'wrangler d1 migrations apply platform-db --local',
	'wrangler d1 migrations list platform-db --remote',
	'wrangler d1 execute platform-db --local --command "select 1"',
	'pnpm setup:config',
	'git add wrangler.template.jsonc',
	'git add -f .claude/settings.json',
	'git add -A && git commit -m "Generated wrangler.jsonc stays ignored"',
	'grep -rn -- "--remote" docs/ops/d1-migrations.md'
];
for (const c of allowed) check(`allows: ${c}`, refuseCommand(c) === null);

console.log('\nstop: the generators a change calls for');
const names = (changed: string[]) =>
	generatorsFor(changed)
		.map((g) => g.script)
		.join(',');
check('an app view', names(['app/views/BrowseView.tsx']) === 'gen:app');
check('a src/lib module the app imports', names(['src/lib/brain-policy.ts']) === 'gen:app');
check('a lockfile bump (bundled dependencies)', names(['pnpm-lock.yaml']) === 'gen:app');
check('a brain-template page', names(['brain-template/AGENTS.md']) === 'gen:templates');
check('both', names(['app/main.tsx', 'brain-template/index.md']) === 'gen:app,gen:templates');
check('a Worker-only change needs none', names(['src/worker.ts', 'docs/x.md']) === '');
check(
	'generated output alone triggers nothing',
	names([...GEN_APP.outputs, ...GEN_TEMPLATES.outputs]) === ''
);

console.log('\nsettings: every hook runs a mode the script has');
const settings = JSON.parse(
	readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8')
);
const wired = new Map<string, string>();
for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
	for (const entry of entries as { matcher?: string; hooks: { command: string }[] }[]) {
		for (const h of entry.hooks) {
			const mode = /agent-hooks\.ts"?\s+(\S+)/.exec(h.command)?.[1];
			if (mode) wired.set(mode, `${event}:${entry.matcher ?? ''}`);
		}
	}
}
check(
	'pre-edit on Edit and Write',
	/^PreToolUse:.*\bEdit\b.*\bWrite\b/.test(wired.get('pre-edit') ?? '')
);
check('pre-bash on Bash', wired.get('pre-bash') === 'PreToolUse:Bash');
check('stop on Stop', wired.get('stop')?.startsWith('Stop:') === true);
check(
	'secrets are not read into context',
	(settings.permissions?.deny ?? []).includes('Read(./.dev.vars)')
);

console.log('\nthe process: exit 2 and a reason on stderr, the way the hook runs it');
function run(mode: string, input: object) {
	return spawnSync(process.execPath, ['scripts/agent-hooks.ts', mode], {
		cwd: root,
		input: JSON.stringify(input),
		encoding: 'utf8',
		env: { ...process.env, CLAUDE_PROJECT_DIR: root }
	});
}
const edit = run('pre-edit', {
	tool_input: { file_path: `${root}src/lib/app-bundle.generated.ts` }
});
check(
	'an absolute generated path blocks',
	edit.status === 2 && edit.stderr.includes('gen:app'),
	edit.stderr
);
const ok = run('pre-edit', { tool_input: { file_path: 'src/lib/usage.ts' } });
check('a source path passes', ok.status === 0, ok.stderr);
const committed = execFileSync('git', ['ls-files', 'migrations'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	.find((p) => p.endsWith('.sql'))!;
const mig = run('pre-edit', { tool_input: { file_path: committed } });
check('a committed migration blocks through git', mig.status === 2, mig.stderr);
const bash = run('pre-bash', {
	tool_input: { command: 'wrangler d1 migrations apply platform-db --remote' }
});
check(
	'a remote migration blocks',
	bash.status === 2 && bash.stderr.includes('deploy.yml'),
	bash.stderr
);
check(
	'a local one passes',
	run('pre-bash', { tool_input: { command: 'pnpm db:migrate' } }).status === 0
);
check('a second stop never loops', run('stop', { stop_hook_active: true }).status === 0);

done();
