// pnpm test:instructions
//
// The server's `instructions`: the text a host loads once per connection and the model
// reads before any tool. A host cuts it at a fixed length and shows the model only what
// comes before the cut, so guidance past the limit is never read, and nothing fails.
//
// This battery exists to catch:
//   1. SERVER_INSTRUCTIONS growing past SERVER_INSTRUCTIONS_LIMIT, the length Claude Code
//      shows the model.
//   2. A tool-shaped name in the instructions that no first-party registration provides
//      (a renamed or retired tool the text still steers toward).
//   3. The guidance the instructions exist for going missing: when to reach for the
//      brain, read_page against view_page, the write rules, the active brain, per-brain
//      access, and the Open Knowledge Format conventions.
//   4. Text written for one host. Any MCP client can connect (Claude, ChatGPT, others), so
//      the instructions and the scaffolded brain's AGENTS.md and README.md name none of
//      them. Tool descriptions are held to the same rule in `pnpm test:annotations`.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_LIMIT } from '../src/lib/server-instructions.ts';
import { HOST_NAMES } from '../src/lib/tool-annotations.ts';
import { checker } from './check.ts';
import { NOT_TOOLS, registeredToolNames, toolShapedWords } from './doc-refs.ts';

const { check, done } = checker('instructions checks');

console.log('\nlength');
check(
	`SERVER_INSTRUCTIONS fits in ${SERVER_INSTRUCTIONS_LIMIT} characters`,
	SERVER_INSTRUCTIONS.length <= SERVER_INSTRUCTIONS_LIMIT,
	`${SERVER_INSTRUCTIONS.length} characters`
);
check('the limit is the 4,096 Claude Code applies', SERVER_INSTRUCTIONS_LIMIT === 4096);

console.log('\ntool names');
{
	const toolsDir = fileURLToPath(new URL('../src/tools/', import.meta.url));
	const sources = [
		...readdirSync(toolsDir)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => toolsDir + f),
		fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
		fileURLToPath(new URL('../src/local.ts', import.meta.url))
	];
	const registered = new Set(sources.flatMap((f) => registeredToolNames(readFileSync(f, 'utf8'))));
	check('found the registered tools', registered.size > 30, `${registered.size}`);
	const named = toolShapedWords(SERVER_INSTRUCTIONS).filter((w) => !NOT_TOOLS.has(w.name));
	check('the instructions name tools', named.length > 5, `${named.length}`);
	const unknown = [...new Set(named.map((w) => w.name).filter((n) => !registered.has(n)))];
	check('every tool they name is registered', unknown.length === 0, unknown.join(', '));
}

console.log('\nthe guidance');
{
	const has = (label: string, needle: string | RegExp) =>
		check(
			label,
			typeof needle === 'string'
				? SERVER_INSTRUCTIONS.includes(needle)
				: needle.test(SERVER_INSTRUCTIONS)
		);
	has('answer from the brain first', 'ANSWER FROM THE BRAIN FIRST');
	has('read_page is for the model, view_page for the user', 'Use read_page (not view_page)');
	has('write only when asked', 'WRITE ONLY WHEN ASKED');
	has('a write is already a commit', 'no separate save or commit step');
	has(
		'partial edits over a full `content` rewrite',
		/`content`[^.]*replaces the whole body[^.]*`edits`/
	);
	has('`brain` targets one call without switching', '`brain`');
	has('search every brain with scope "all"', 'scope: "all"');
	has('access is per brain', 'ACCESS IS PER BRAIN');
	has('one page per concept, with a type', /ONE PAGE = ONE CONCEPT[^]*`type:`/);
	has('folder notes are index.md', '<folder>/index.md');
	has('tidying is a validate/resolve loop', /validate[^]*resolve[^]*"dismiss"/);
}

console.log('\nno host named');
{
	const named = (text: string) => text.match(HOST_NAMES)?.[0];
	check('the instructions name no host', !named(SERVER_INSTRUCTIONS), named(SERVER_INSTRUCTIONS));
	for (const file of ['AGENTS.md', 'README.md']) {
		const text = readFileSync(
			fileURLToPath(new URL(`../brain-template/${file}`, import.meta.url)),
			'utf8'
		);
		check(`brain-template/${file} names no host`, !named(text), named(text));
	}
}

done();
