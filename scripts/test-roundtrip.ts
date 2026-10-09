// Round-trip golden test for the WYSIWYG editor's markdown bridge.
//
//   pnpm test:roundtrip
//
// Loading a page into the editor and saving it must not corrupt content the user
// didn't touch. Each fixture is parsed to a ProseMirror doc and serialized back,
// and must come out in its expected mode:
//
//   byte      the output is the input, byte for byte. Most fixtures: a changed
//             bullet character or an escaped [[wikilink]] is semantically equal
//             but rewrites every page the editor saves.
//   semantic  re-parsing the output yields an equal doc. Only for constructs whose
//             formatting legitimately normalizes (table padding, emphasis markers).

import { parseMarkdown, serializeMarkdown } from '../app/editor-markdown.ts';

import { checker } from './check.ts';

type Mode = 'byte' | 'semantic';

const FIXTURES: Record<string, { mode: Mode; body: string }> = {
	'headings + bullets + blockquote': {
		mode: 'byte',
		body: `# Vision

> A one-line quote.

Intro paragraph with **bold** and \`code\`.

## Themes

- **First.** Point one.
- **Second.** Point two.
`
	},
	wikilinks: {
		mode: 'byte',
		body: `See [[Brand Voice]] and [[Some Page|an alias]] for context.
`
	},
	'gfm table': {
		mode: 'semantic',
		body: `| Banned | Why | Use instead |
|--------|-----|-------------|
| Unlock | Consultant-speak | Specific verbs |
| Synergy | Exhausted | Describe the change |
`
	},
	'emphasis marker': {
		mode: 'semantic',
		body: `Placeholder _(none yet)_ here.
`
	},
	'nested list + link': {
		mode: 'byte',
		body: `- Top
  - Nested one
  - Nested two

A [real link](https://example.com) inline.
`
	},
	'task list': {
		mode: 'byte',
		body: `- [ ] Draft the RFC
- [x] Gather feedback
- Not a task, just a bullet
`
	},
	'task list with formatting + link': {
		mode: 'byte',
		body: `- [ ] Review [[Brand Voice]] with **care**
- [x] Ship the [changelog](https://example.com)
`
	}
};

const { check, done } = checker('round-trip checks');

for (const [name, { mode, body }] of Object.entries(FIXTURES)) {
	const src = body.trim();
	const doc = parseMarkdown(src);
	const out = doc ? serializeMarkdown(doc).trim() : null;
	const reparsed = out != null ? parseMarkdown(out) : null;
	const ok = mode === 'byte' ? out === src : !!doc && !!reparsed && doc.eq(reparsed);
	const detail = `\n  --- in  ---\n${src.replace(/^/gm, '  ')}\n  --- out ---\n${(out ?? '(parse failed)').replace(/^/gm, '  ')}`;
	check(`${mode} stable: ${name}`, ok, detail);
}

done();
