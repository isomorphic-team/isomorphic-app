// Which `.claude/rules/` files describe the code a change touches. CI runs it on every
// pull request and posts the answer as a notice and in the job summary, so the author
// and the reviewer see which rules files to reread before merging: a change that makes
// one of their sentences false fixes that sentence in the same pull request. It reports
// and never fails; `pnpm test:docs` is the check that fails.
//
//   git diff --name-only origin/main... | pnpm exec tsx scripts/rules-for-change.ts
//   pnpm exec tsx scripts/rules-for-change.ts src/lib/orgs.ts app/core/nav.ts

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';

import { rulesFor, rulesPaths } from './doc-refs.ts';

const rulesDir = new URL('../.claude/rules/', import.meta.url);
const rules = readdirSync(rulesDir)
	.filter((f) => f.endsWith('.md'))
	.sort()
	.map((f) => ({
		file: `.claude/rules/${f}`,
		globs: rulesPaths(readFileSync(new URL(f, rulesDir), 'utf8'))
	}));

const fromArgs = process.argv.slice(2);
const changed = (fromArgs.length ? fromArgs : readFileSync(0, 'utf8').split('\n'))
	.map((p) => p.trim())
	.filter(Boolean);

const hits = rulesFor(rules, changed).filter((h) => !changed.includes(h.file));
const lines = hits.length
	? [
			'### Rules files covering this change',
			'',
			'This change touches code these files describe. If it makes a sentence in one of them false, fix the sentence in this pull request.',
			'',
			...hits.map(
				(h) =>
					`- \`${h.file}\` (${h.matched.slice(0, 5).join(', ')}${h.matched.length > 5 ? `, and ${h.matched.length - 5} more` : ''})`
			)
		]
	: ['### Rules files covering this change', '', 'None.'];

console.log(lines.join('\n'));
if (process.env.GITHUB_ACTIONS) {
	for (const h of hits) {
		console.log(
			`::notice title=Reread ${h.file}::This change touches ${h.matched.length} file(s) it describes.`
		);
	}
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
