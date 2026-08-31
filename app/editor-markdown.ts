// Markdown <-> ProseMirror bridge for the WYSIWYG editor, tuned for the brain's
// conventions and extended with table support (prosemirror-tables).
//
// prosemirror-markdown's defaults drift in ways that matter here, so we override:
//   1. bullet lists serialize `*`; the brain uses `-`.
//   2. literal `[` / `]` get backslash-escaped, mangling `[[wikilinks]]`.
//   3. no table support at all — GFM tables were silently destroyed.
//
// Shared by the app (app/main.tsx) and the round-trip golden test so both exercise
// identical parse/serialize behavior.
//
// Note on fidelity: table *formatting* (dash counts, cell padding) normalizes on
// round-trip — content and rendering are preserved, but byte-identity for table
// pages is not achievable via parse->serialize. The golden test asserts semantic
// stability (re-parse and compare) for those.

// markdown-it 15 ships its own types and splits the two meanings of the name: the
// default export is the callable class (a VALUE), and MarkdownIt is exported
// separately as the instance TYPE. v14's @types package conflated them.
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import { Schema, type Node } from 'prosemirror-model';
import {
	schema as baseSchema,
	MarkdownParser,
	MarkdownSerializer,
	defaultMarkdownParser,
	defaultMarkdownSerializer,
	type MarkdownSerializerState
} from 'prosemirror-markdown';
import { tableNodes } from 'prosemirror-tables';

// ---------- schema: prosemirror-markdown base + tables + task items ----------

// Task lists (GFM `- [ ]` / `- [x]`) are ordinary bullet-list items carrying a
// `checked` attr: null = plain bullet, true/false = an unchecked/checked checkbox.
// This keeps them in the same bullet_list (matching GFM, where a task list is just
// a bullet list), so nesting/mixing plain and task items in one list Just Works.
const baseListItem = baseSchema.spec.nodes.get('list_item')!;
const taskListItem = {
	...baseListItem,
	attrs: { checked: { default: null } },
	toDOM(node: Node) {
		return node.attrs.checked == null
			? (['li', 0] as const)
			: ([
					'li',
					{ class: 'task-item', 'data-checked': node.attrs.checked ? 'true' : 'false' },
					0
				] as const);
	},
	parseDOM: [
		{
			tag: 'li',
			getAttrs: (dom: HTMLElement) => {
				const dc = dom.getAttribute('data-checked');
				return { checked: dc == null ? null : dc === 'true' };
			}
		}
	]
};

// Default new (editor-created) lists to `tight`, matching the brain's markdown
// convention. Without this, wrapInList mints loose lists (tight defaults to false),
// which serialize with a blank line between every item — rendering as big-gap lists
// and, for task lists, nesting the checkbox in a `<p>` so the bullet can't be hidden.
// Parsed lists keep the tightness read from their source, so this only affects new ones.
function tightList(name: 'bullet_list' | 'ordered_list') {
	const spec = baseSchema.spec.nodes.get(name)!;
	return { ...spec, attrs: { ...spec.attrs, tight: { default: true } } };
}

export const editorSchema = new Schema({
	nodes: baseSchema.spec.nodes
		.update('list_item', taskListItem)
		.update('bullet_list', tightList('bullet_list'))
		.update('ordered_list', tightList('ordered_list'))
		.append(tableNodes({ tableGroup: 'block', cellContent: 'inline+', cellAttributes: {} })),
	marks: baseSchema.spec.marks
});

// ---------- parser: markdown-it (commonmark + tables + task lists) ----------

// markdown-it doesn't understand GFM task-list markers. This core rule runs after
// block parsing but BEFORE inline parsing, so it can strip a leading `[ ] `/`[x] `
// off a list item's first paragraph (mutating the raw `.content`, before it's
// tokenized into `.children`) and stash the checked state on the `list_item_open`
// token for the ProseMirror parser to read as an attr.
function taskListPlugin(md: MarkdownItInstance) {
	md.core.ruler.before('inline', 'task-lists', (state) => {
		const toks = state.tokens;
		for (let i = 0; i < toks.length; i++) {
			if (toks[i].type !== 'list_item_open') continue;
			const para = toks[i + 1];
			const inline = toks[i + 2];
			if (!para || para.type !== 'paragraph_open') continue;
			if (!inline || inline.type !== 'inline') continue;
			const m = /^\[([ xX])\]\s+/.exec(inline.content);
			if (!m) continue;
			toks[i].meta = { ...(toks[i].meta || {}), taskChecked: m[1].toLowerCase() === 'x' };
			inline.content = inline.content.slice(m[0].length);
		}
		return false;
	});
}

const md = MarkdownIt('commonmark', { html: false }).enable('table').use(taskListPlugin);
const parser = new MarkdownParser(editorSchema, md, {
	...defaultMarkdownParser.tokens,
	// Carry the task-list marker (set by taskListPlugin) onto the list_item's attr.
	list_item: {
		block: 'list_item',
		getAttrs: (tok) => ({ checked: (tok.meta?.taskChecked ?? null) as boolean | null })
	},
	// markdown-it wraps rows in thead/tbody, which prosemirror-tables doesn't model;
	// ignore flattens both the _open and _close tokens (see prosemirror-markdown).
	table: { block: 'table' },
	thead: { ignore: true },
	tbody: { ignore: true },
	tr: { block: 'table_row' },
	th: { block: 'table_header' },
	td: { block: 'table_cell' }
});

export function parseMarkdown(mdText: string): Node | null {
	return parser.parse(mdText);
}

// ---------- serializer: base + bullet/table overrides ----------

// Render one cell's inline content to a single-line markdown string (pipes escaped).
// Wrap in an editorSchema paragraph (cell nodes belong to editorSchema); the
// serializer dispatches by node name, so defaultMarkdownSerializer handles it.
function serializeCell(cell: Node): string {
	const para = editorSchema.nodes.paragraph.createChecked(null, cell.content);
	const doc = editorSchema.nodes.doc.createChecked(null, [para]);
	return defaultMarkdownSerializer.serialize(doc).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|');
}

const serializer = new MarkdownSerializer(
	{
		...defaultMarkdownSerializer.nodes,
		// Emit `-` bullets (brain convention) instead of the default `*`, prefixing a
		// GFM `[ ]`/`[x]` marker for task items (list items with a `checked` attr).
		bullet_list(state: MarkdownSerializerState, node: Node) {
			state.renderList(node, '  ', (i) => {
				const checked = node.child(i).attrs.checked as boolean | null;
				const box = checked == null ? '' : checked ? '[x] ' : '[ ] ';
				return '- ' + box;
			});
		},
		// GFM table: header row, `| --- |` separator, then body rows.
		table(state: MarkdownSerializerState, node: Node) {
			node.forEach((row, _off, rowIdx) => {
				const cells: string[] = [];
				row.forEach((cell) => cells.push(serializeCell(cell)));
				state.write('| ' + cells.join(' | ') + ' |');
				state.ensureNewLine();
				if (rowIdx === 0) {
					state.write('| ' + cells.map(() => '---').join(' | ') + ' |');
					state.ensureNewLine();
				}
			});
			state.closeBlock(node);
		},
		// Handled by table(); present so the serializer never throws on them.
		table_row() {},
		table_header() {},
		table_cell() {}
	},
	defaultMarkdownSerializer.marks
);

export function serializeMarkdown(doc: Node): string {
	const out = serializer.serialize(doc);
	// Restore wikilinks: prosemirror-markdown escapes the literal brackets it emits
	// as `\[\[Page\]\]`. `[[ ]]` is the only bracket-pair syntax the brain uses, so
	// un-escaping these two sequences is safe and keeps wikilinks byte-stable.
	return out.replace(/\\\[\\\[/g, '[[').replace(/\\\]\\\]/g, ']]');
}
