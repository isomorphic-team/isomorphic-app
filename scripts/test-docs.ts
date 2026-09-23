// Golden test for what the prose says about the code. CLAUDE.md, the `.claude/rules/`
// files, the reference docs, the brain template and every comment and string in `src/`
// name files, symbols, tools and constants; when the code moves and the prose does not,
// an agent reading it does the wrong thing with confidence. This checks the claims a
// machine can check:
//
//   1. a repo path in backticks exists, and a relative markdown link resolves
//   2. a camelCase / PascalCase / SCREAMING_SNAKE name in backticks is in the code
//   3. a tool-shaped word (`verb_noun`) is a registered tool, or its line says it retired
//   4. a quoted constant (`` `NAME` (5000) ``) matches its literal in the source
//   5. each `.claude/rules/` file has `paths:`, and every glob matches a tracked file
//   6. each design doc opens with a `Status:` from a fixed set
//
// It cannot see a sentence that became false while every name in it still exists; that
// is what the "fix the sentence in the same change" rule in CLAUDE.md is for. Design
// docs and the roadmap are records of proposals, so only (6) applies to them.
//
//   pnpm test:docs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';

import { checker } from './check.ts';
import {
	codeSpans,
	constantClaims,
	constantValue,
	designStatus,
	expandBraces,
	globsMatch,
	NOT_TOOLS,
	registeredToolNames,
	relativeLinks,
	repoPathIn,
	RETIREMENT_WORDS,
	rulesFor,
	rulesPaths,
	symbolIn,
	toolShapedWords
} from './doc-refs.ts';

const { check, done } = checker('docs checks');
const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

// ---------- the extractors, pinned ----------

console.log('\nextractors');
{
	const md = 'a `src/lib/x.ts` b\n```\n`src/nope.ts`\n```\n`y`';
	check(
		'code spans skip fenced blocks',
		JSON.stringify(codeSpans(md)) ===
			JSON.stringify([
				{ text: 'src/lib/x.ts', line: 1 },
				{ text: 'y', line: 5 }
			])
	);
	check(
		'links keep relative targets and drop schemes and anchors',
		JSON.stringify(
			relativeLinks('[a](docs/x.md#h) [b](https://x) [c](#top)').map((l) => l.target)
		) === JSON.stringify(['docs/x.md'])
	);
	check(
		'a repo path is recognized',
		repoPathIn('src/lib/orgs.ts:1441')?.path === 'src/lib/orgs.ts'
	);
	check('a bare source filename is recognized as bare', repoPathIn('librarian.ts')?.bare === true);
	check('a brain path is not a repo path', repoPathIn('wiki/tools/x.md') === null);
	check('a glob is not a repo path', repoPathIn('src/lib/{a,b}.ts') === null);
	check('a bare markdown filename is a brain page', repoPathIn('index.md') === null);
	check('camelCase is a symbol', symbolIn('effectiveBrainRole()') === 'effectiveBrainRole');
	check('PascalCase with two humps is a symbol', symbolIn('BrainStore') === 'BrainStore');
	check('SCREAMING_SNAKE is a symbol', symbolIn('MAX_SCAN_PAGES') === 'MAX_SCAN_PAGES');
	check('a plain word is not a symbol', symbolIn('brains') === null && symbolIn('Brain') === null);
	check(
		'tool-shaped words are found',
		toolShapedWords('call resolve_import, then read_page')
			.map((w) => w.name)
			.join() === 'resolve_import,read_page'
	);
	check(
		'registrations in both shapes are found',
		registeredToolNames(
			"registerAppTool(server, 'view_page', {})\nserver.registerTool('read_page', {})"
		).join() === 'view_page,read_page'
	);
	const claims = constantClaims('`MAX_SCAN_PAGES` (1500) and `LIMIT` (5 MB) and `CAP` = 2,000.');
	check(
		'a constant claim is read, and a unit conversion is not one',
		JSON.stringify(claims.map((c) => [c.name, c.value])) ===
			JSON.stringify([
				['MAX_SCAN_PAGES', 1500],
				['CAP', 2000]
			])
	);
	check(
		'a constant literal is read from source',
		constantValue('export const MAX_SCAN_PAGES = 5_000;', 'MAX_SCAN_PAGES') === 5000 &&
			constantValue('const X = 2 * 60_000;', 'X') === undefined
	);
	const rules = '---\npaths:\n  - "src/lib/{orgs,invites}.ts"\n  - app/**\n---\n# t';
	check(
		'rules paths are read from frontmatter',
		JSON.stringify(rulesPaths(rules)) === JSON.stringify(['src/lib/{orgs,invites}.ts', 'app/**'])
	);
	check('a rules file without frontmatter has no paths', rulesPaths('# t').length === 0);
	check(
		'brace alternatives expand, nested too',
		JSON.stringify(expandBraces('src/{a,b}/{x,y}.ts')) ===
			JSON.stringify(['src/a/x.ts', 'src/a/y.ts', 'src/b/x.ts', 'src/b/y.ts'])
	);
	check(
		'globs match with braces and double stars',
		globsMatch(['src/lib/{orgs,invites}.ts'], 'src/lib/invites.ts') &&
			globsMatch(['app/**'], 'app/views/X.tsx') &&
			!globsMatch(['src/lib/{orgs,invites}.ts'], 'src/lib/usage.ts')
	);
	check(
		'rulesFor names each covering file with what it matched',
		JSON.stringify(
			rulesFor(
				[
					{ file: 'a.md', globs: ['src/**'] },
					{ file: 'b.md', globs: ['app/**'] }
				],
				['src/x.ts', 'README.md']
			)
		) === JSON.stringify([{ file: 'a.md', matched: ['src/x.ts'] }])
	);
	check(
		'a design status must come from the fixed set',
		designStatus('# T\n\nStatus: **Partly built.** x') === 'partly built' &&
			designStatus('# T\n\n- Status: Phase 1 is built') === null &&
			designStatus('# T\nno status') === null
	);
}

// ---------- the repository ----------

const git = (args: string[]) =>
	execFileSync('git', args, { cwd: new URL('.', root), encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
// Tracked plus new-but-unignored, so a file added in this change counts before it is
// committed. `.claude/rules/` is listed explicitly: a local exclude can hide it.
const files = [
	...new Set([
		...git(['ls-files', '--cached', '--others', '--exclude-standard']),
		...git(['ls-files', '--cached', '--others', '.claude/rules'])
	])
];
const fileSet = new Set(files);
const dirSet = new Set(
	files.flatMap((p) => {
		const parts = p.split('/');
		return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
	})
);
const baseSet = new Set(files.map((p) => basename(p)));
// Generated locally and gitignored, and still correct to name.
const GENERATED = new Set(['wrangler.jsonc', '.dev.vars']);

const codeFiles = files.filter(
	(p) =>
		/^(src|app|scripts|dev|tests|migrations|\.github)\//.test(p) &&
		!/\.generated\.|dev\/bundle\.js|dev\/fixtures\.json/.test(p)
);
const code = [...codeFiles, 'package.json', 'wrangler.template.jsonc', 'playwright.config.ts']
	.map((p) => read(p))
	.join('\n');

// Every identifier the code contains, so a symbol check is a set lookup.
const identifiers = new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);

const tools = new Set(
	files
		.filter((p) => /^src\/(tools\/[^/]+|worker)\.ts$/.test(p))
		.flatMap((p) => registeredToolNames(read(p)))
);

// Current reference: what an agent or a contributor acts on.
const referenceDocs = files.filter(
	(p) =>
		/^(CLAUDE|README|CONTRIBUTING|SECURITY|GOVERNANCE)\.md$/.test(p) ||
		(/^docs\/[^/]+\.md$/.test(p) && p !== 'docs/roadmap.md') ||
		/^docs\/ops\/.+\.md$/.test(p) ||
		/^\.claude\/rules\/.+\.md$/.test(p) ||
		/^brain-template\/.+\.md$/.test(p) ||
		p === 'dev/README.md'
);

function toolProblem(name: string, lineText: string): string | null {
	if (tools.has(name) || NOT_TOOLS.has(name)) return null;
	if (RETIREMENT_WORDS.test(lineText)) return null;
	return `\`${name}\` is not a registered tool`;
}

console.log(`\nthe ${tools.size} registered tools were found`);
check('found the tool surface', tools.size > 20, `found ${tools.size}`);

console.log(`\nreference docs (${referenceDocs.length}) name things that exist`);
for (const doc of referenceDocs) {
	const text = read(doc);
	const problems: string[] = [];
	for (const { text: span, line } of codeSpans(text)) {
		const path = repoPathIn(span);
		if (path && !GENERATED.has(path.path)) {
			const ok = path.bare
				? baseSet.has(path.path)
				: fileSet.has(path.path) || dirSet.has(path.path.replace(/\/$/, ''));
			if (!ok) problems.push(`:${line} \`${span}\` does not exist`);
		}
		const symbol = symbolIn(span);
		if (symbol && !identifiers.has(symbol)) {
			problems.push(`:${line} \`${symbol}\` is not in the code`);
		}
	}
	for (const { target, line } of relativeLinks(text)) {
		const resolved = normalize(join(dirname(doc), target)).replace(/\/$/, '');
		if (!fileSet.has(resolved) && !dirSet.has(resolved) && !GENERATED.has(resolved)) {
			problems.push(`:${line} link to ${target} does not resolve`);
		}
	}
	for (const { name, line, text: lineText } of toolShapedWords(text)) {
		const p = toolProblem(name, lineText);
		if (p) problems.push(`:${line} ${p}`);
	}
	for (const claim of constantClaims(text)) {
		const actual = constantValue(code, claim.name);
		if (actual !== undefined && actual !== claim.value) {
			problems.push(
				`:${claim.line} \`${claim.name}\` says ${claim.value}, the code says ${actual}`
			);
		}
	}
	check(doc, problems.length === 0, '\n      ' + problems.join('\n      '));
}

console.log('\nsource names only tools that exist');
for (const file of files.filter((p) => /^src\/.+\.ts$/.test(p) && !/\.generated\./.test(p))) {
	const problems = toolShapedWords(read(file))
		.map(({ name, line, text }) => {
			const p = toolProblem(name, text);
			return p ? `:${line} ${p}` : null;
		})
		.filter(Boolean);
	if (problems.length) check(file, false, '\n      ' + problems.join('\n      '));
}
check(
	'every source file was scanned',
	files.some((p) => p === 'src/worker.ts')
);

console.log('\nrules files load for files that exist');
const rulesFiles = files.filter((p) => /^\.claude\/rules\/.+\.md$/.test(p));
check('there are rules files', rulesFiles.length > 0);
for (const file of rulesFiles) {
	const globs = rulesPaths(read(file));
	const dead = globs.flatMap(expandBraces).filter((g) => !files.some((f) => globsMatch([g], f)));
	check(
		`${file} has paths, and each matches a file`,
		globs.length > 0 && dead.length === 0,
		globs.length ? `no file matches ${dead.join(', ')}` : 'no `paths:` frontmatter'
	);
}

console.log('\ndesign docs declare a status');
for (const file of files.filter((p) => /^docs\/design\/.+\.md$/.test(p))) {
	check(
		file,
		designStatus(read(file)) !== null,
		'open with `Status: <built | partly built | in implementation | proposed | draft | decided | superseded | abandoned>`'
	);
}

done();
