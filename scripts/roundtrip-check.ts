// Round-trip golden test for the WYSIWYG editor's markdown bridge.
//
//   pnpm test:roundtrip
//
// Loading a page into the editor and saving it must not corrupt content the user
// didn't touch. This parses each fixture to a ProseMirror doc and serializes back,
// asserting either byte-stability or (for constructs whose formatting legitimately
// normalizes — tables, emphasis markers) semantic stability: re-parsing the output
// yields an equal doc. Exits non-zero on any structural drift.

import { parseMarkdown, serializeMarkdown } from '../app/editor-markdown.ts';

const FIXTURES: Record<string, string> = {
	'headings + bullets + blockquote': `# Vision

> A one-line quote.

Intro paragraph with **bold** and \`code\`.

## Themes

- **First.** Point one.
- **Second.** Point two.
`,
	wikilinks: `See [[Brand Voice]] and [[Some Page|an alias]] for context.
`,
	'gfm table': `| Banned | Why | Use instead |
|--------|-----|-------------|
| Unlock | Consultant-speak | Specific verbs |
| Synergy | Exhausted | Describe the change |
`,
	'emphasis marker': `Placeholder _(none yet)_ here.
`,
	'nested list + link': `- Top
  - Nested one
  - Nested two

A [real link](https://example.com) inline.
`,
	'task list': `- [ ] Draft the RFC
- [x] Gather feedback
- Not a task, just a bullet
`,
	'task list with formatting + link': `- [ ] Review [[Brand Voice]] with **care**
- [x] Ship the [changelog](https://example.com)
`
};

let failed = 0;
for (const [name, body] of Object.entries(FIXTURES)) {
	const src = body.trim();
	const doc = parseMarkdown(src);
	const out = doc ? serializeMarkdown(doc).trim() : null;
	const byteStable = out === src;
	const reparsed = out != null ? parseMarkdown(out) : null;
	const semanticStable = !!doc && !!reparsed && doc.eq(reparsed);
	const ok = byteStable || semanticStable;
	if (!ok) failed++;
	const tag = byteStable ? 'BYTE ✓' : semanticStable ? 'SEMANTIC ✓' : 'DRIFT ✗';
	console.log(`${tag.padEnd(11)} ${name}`);
	if (!ok) {
		console.log('  --- in  ---\n' + src.replace(/^/gm, '  '));
		console.log('  --- out ---\n' + (out ?? '(parse failed)').replace(/^/gm, '  '));
	}
}

console.log(failed ? `\n${failed} fixture(s) drifted.` : '\nAll fixtures stable.');
process.exit(failed ? 1 : 0);
