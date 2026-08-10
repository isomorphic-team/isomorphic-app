import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { EditorState, type Command, type Transaction } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import type { MarkType, Node as PMNode, NodeType } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn } from 'prosemirror-commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { inputRules, InputRule } from 'prosemirror-inputrules';
import { history as pmHistory, undo, redo } from 'prosemirror-history';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import { editorSchema, parseMarkdown, serializeMarkdown } from '../editor-markdown.ts';
import { parseFrontmatter } from '../../src/lib/wiki.ts';
import { ImageNodeView, mediaHandlers, uploadsInFlight } from '../core/editor-media.ts';
import type { EditorApi } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { bump, show, brainArgs } from '../core/store.ts';
import { fetchPage } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { PageProperties } from './PageView.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Toolbar, ToolbarButton, ToolbarSeparator } from '../ui/index.ts';

// ---- editor command helpers (toolbar state + toggles) ----

const M = editorSchema.marks;
const N = editorSchema.nodes;

function markActive(state: EditorState, type: MarkType): boolean {
	const { from, $from, to, empty } = state.selection;
	return empty
		? !!type.isInSet(state.storedMarks || $from.marks())
		: state.doc.rangeHasMark(from, to, type);
}

function blockActive(
	state: EditorState,
	type: NodeType,
	attrs: Record<string, unknown> = {}
): boolean {
	const { $from, to } = state.selection;
	return to <= $from.end() && $from.parent.hasMarkup(type, attrs);
}

// Toggle a heading level, flipping back to a paragraph when already active.
function toggleHeading(level: number): Command {
	return (state, dispatch, view) => {
		const active = blockActive(state, N.heading, { level });
		const cmd = active ? setBlockType(N.paragraph) : setBlockType(N.heading, { level });
		return cmd(state, dispatch, view);
	};
}

// ---- task lists (checkboxes) ----

// The list_item enclosing the selection, plus its document position, or null.
function nearestListItem(state: EditorState): { node: PMNode; pos: number } | null {
	const { $from } = state.selection;
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type === N.list_item) return { node: $from.node(d), pos: $from.before(d) };
	}
	return null;
}

// True when the selection sits inside a task item (a list_item with a `checked` attr).
function inTaskItem(state: EditorState): boolean {
	return nearestListItem(state)?.node.attrs.checked != null;
}

// Toggle the current block between a task list and plain text. Inside a list item:
// flip it to/from a task item (checked=null ⇄ false). Outside a list: wrap in a
// bullet list and mark the wrapped items as tasks in one transaction.
const toggleTaskList: Command = (state, dispatch, view) => {
	const li = nearestListItem(state);
	if (li) {
		if (dispatch) {
			const next = li.node.attrs.checked == null ? false : null;
			dispatch(state.tr.setNodeMarkup(li.pos, undefined, { ...li.node.attrs, checked: next }));
		}
		return true;
	}
	// Wrap into a bullet list, then mark every wrapped item as a task, in one tr.
	const markAsTask = (tr: Transaction) => {
		const { from, to } = tr.selection;
		tr.doc.nodesBetween(from, to, (node, pos) => {
			if (node.type === N.list_item)
				tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
		});
		dispatch!(tr);
	};
	return wrapInList(N.bullet_list)(state, dispatch && markAsTask, view);
};

// Enter inside a task item: split as usual, but reset the freshly-created item to
// unchecked (an inherited checked=true would pre-tick the new line, which is wrong).
const splitTaskItem: Command = (state, dispatch, view) => {
	const wasTask = inTaskItem(state);
	return splitListItem(N.list_item)(
		state,
		dispatch &&
			((tr) => {
				if (wasTask) {
					const $f = tr.selection.$from;
					for (let d = $f.depth; d > 0; d--) {
						if ($f.node(d).type === N.list_item) {
							tr.setNodeMarkup($f.before(d), undefined, { ...$f.node(d).attrs, checked: false });
							break;
						}
					}
				}
				dispatch(tr);
			}),
		view
	);
};

// Typing `[] `, `[ ] ` or `[x] ` at the start of a list item turns it into a task item.
const taskInputRule = new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
	const li = nearestListItem(state);
	if (!li) return null;
	const checked = /x/i.test(match[1] || '');
	return state.tr
		.delete(start, end)
		.setNodeMarkup(li.pos, undefined, { ...li.node.attrs, checked });
});

// nodeView: render task items with a real (clickable) checkbox; leave plain list
// items to ProseMirror's default rendering. Clicking the box writes the new state
// back as a transaction so it round-trips through the markdown serializer.
class ListItemView implements NodeView {
	dom: HTMLElement;
	contentDOM: HTMLElement;
	private checkbox?: HTMLInputElement;
	constructor(
		private node: PMNode,
		view: EditorView,
		getPos: () => number | undefined
	) {
		this.dom = document.createElement('li');
		if (node.attrs.checked == null) {
			// Plain bullet: the <li> is its own content host, default markers apply.
			this.contentDOM = this.dom;
			return;
		}
		this.dom.classList.add('task-item');
		this.dom.dataset.checked = node.attrs.checked ? 'true' : 'false';
		this.checkbox = document.createElement('input');
		this.checkbox.type = 'checkbox';
		this.checkbox.checked = node.attrs.checked;
		this.checkbox.contentEditable = 'false';
		// Don't let clicking the box move the editor selection or lose focus.
		this.checkbox.addEventListener('mousedown', (e) => e.preventDefault());
		this.checkbox.addEventListener('change', () => {
			const pos = getPos();
			if (pos == null) return;
			view.dispatch(
				view.state.tr.setNodeMarkup(pos, undefined, {
					...this.node.attrs,
					checked: this.checkbox!.checked
				})
			);
		});
		this.contentDOM = document.createElement('div');
		this.contentDOM.className = 'task-content';
		this.dom.append(this.checkbox, this.contentDOM);
	}
	// Reuse the DOM for checked⇄unchecked changes; force a rebuild when an item
	// crosses the plain⇄task boundary (its structure differs).
	update(node: PMNode): boolean {
		if (node.type !== this.node.type) return false;
		if ((this.node.attrs.checked == null) !== (node.attrs.checked == null)) return false;
		this.node = node;
		if (this.checkbox) {
			this.checkbox.checked = !!node.attrs.checked;
			this.dom.dataset.checked = node.attrs.checked ? 'true' : 'false';
		}
		return true;
	}
}

// Shared handle to the live edit session so the top navbar can host the formatting
// toolbar + a Save button while the editing surface itself stays in the body. The
// editor populates `view`; EditView populates save/cancel/saving. Each editor
// transaction bump()s the store so the header toolbar's active states stay in sync.
const editCtl: {
	view: EditorView | null;
	saving: boolean;
	save: () => void;
	cancel: () => void;
} = { view: null, saving: false, save: () => {}, cancel: () => {} };

function EditorToolbar({ view }: { view: EditorView | null }) {
	// Empty spacer (no box) while the editor initializes, so the navbar row doesn't jump.
	if (!view) return <div class="h-7" />;
	const state = view.state;
	const run = (command: Command) => (e: Event) => {
		e.preventDefault(); // mousedown+preventDefault keeps the selection in the editor
		command(view.state, view.dispatch, view);
		view.focus();
	};
	// `active` is passed only by the TOGGLES (bold, headings, blockquote…), and is
	// forwarded as aria-pressed. The commands (undo, redo, wrap-in-list) leave it
	// undefined so no aria-pressed is emitted for them — see ToolbarButton.
	// aria-label is explicit because most labels are bare glyphs ("•", "↶", "❝")
	// that a screen reader would otherwise announce literally.
	const Btn = ({
		label,
		cmd,
		active,
		title
	}: {
		label: preact.ComponentChildren;
		cmd: Command;
		active?: boolean;
		title: string;
	}) => (
		<ToolbarButton pressed={active} title={title} aria-label={title} onMouseDown={run(cmd)}>
			{label}
		</ToolbarButton>
	);
	const Sep = () => <ToolbarSeparator />;
	return (
		<Toolbar label="Formatting">
			<Btn
				label={<b>B</b>}
				cmd={toggleMark(M.strong)}
				active={markActive(state, M.strong)}
				title="Bold (⌘B)"
			/>
			<Btn
				label={<i>I</i>}
				cmd={toggleMark(M.em)}
				active={markActive(state, M.em)}
				title="Italic (⌘I)"
			/>
			<Btn
				label={<span class="font-mono text-xs">{'</>'}</span>}
				cmd={toggleMark(M.code)}
				active={markActive(state, M.code)}
				title="Inline code"
			/>
			<Sep />
			<Btn
				label="H1"
				cmd={toggleHeading(1)}
				active={blockActive(state, N.heading, { level: 1 })}
				title="Heading 1"
			/>
			<Btn
				label="H2"
				cmd={toggleHeading(2)}
				active={blockActive(state, N.heading, { level: 2 })}
				title="Heading 2"
			/>
			<Btn
				label="H3"
				cmd={toggleHeading(3)}
				active={blockActive(state, N.heading, { level: 3 })}
				title="Heading 3"
			/>
			<Sep />
			<Btn label="•" cmd={wrapInList(N.bullet_list)} title="Bullet list" />
			<Btn label="1." cmd={wrapInList(N.ordered_list)} title="Numbered list" />
			<Btn label="☑" cmd={toggleTaskList} active={inTaskItem(state)} title="Checklist" />
			<Btn
				label="❝"
				cmd={wrapIn(N.blockquote)}
				active={blockActive(state, N.blockquote)}
				title="Blockquote"
			/>
			<Sep />
			<Btn label="↶" cmd={undo} title="Undo (⌘Z)" />
			<Btn label="↷" cmd={redo} title="Redo (⌘⇧Z)" />
		</Toolbar>
	);
}

function MarkdownEditor({
	initialMarkdown,
	pagePath,
	apiRef
}: {
	initialMarkdown: string;
	/** The page being edited: attachments land beside it, and relative image hrefs
	    resolve against it. */
	pagePath: string;
	apiRef: { current: EditorApi | null };
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const doc = parseMarkdown(initialMarkdown);
		const item = N.list_item;
		const plugins = [
			columnResizing(),
			tableEditing(),
			pmHistory(),
			inputRules({ rules: [taskInputRule] }),
			keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
			// List editing: Enter splits an item (resetting a new task item to
			// unchecked), Tab / Shift-Tab nest / un-nest.
			keymap({
				Enter: splitTaskItem,
				Tab: sinkListItem(item),
				'Shift-Tab': liftListItem(item),
				'Mod-[': liftListItem(item),
				'Mod-]': sinkListItem(item)
			}),
			keymap(baseKeymap)
		];
		const state = doc
			? EditorState.create({ doc, plugins })
			: EditorState.create({ schema: editorSchema, plugins });
		const view = new EditorView(hostRef.current!, {
			state,
			// Paste and drop, Obsidian-style: no widget, the editor itself is the target.
			...mediaHandlers(pagePath),
			nodeViews: {
				list_item: (node, v, getPos) => new ListItemView(node, v, getPos),
				// Without this every image in the editor is a broken glyph: the markdown
				// carries a RELATIVE href and the iframe has no origin serving the brain.
				image: (node) => new ImageNodeView(node, pagePath)
			},
			// bump() re-renders the navbar toolbar so its active states track the selection.
			dispatchTransaction(tr) {
				view.updateState(view.state.apply(tr));
				bump();
			}
		});
		apiRef.current = { getMarkdown: () => serializeMarkdown(view.state.doc) };
		editCtl.view = view; // the navbar toolbar binds to this
		bump();
		return () => {
			view.destroy();
			apiRef.current = null;
			editCtl.view = null;
			bump();
		};
	}, []);
	// No box, no toolbar (it lives in the navbar): the prose sits directly on the page.
	return (
		<div
			ref={hostRef}
			class="prose max-w-none [&_.ProseMirror]:min-h-[60vh] [&_.ProseMirror]:outline-none"
		/>
	);
}

function EditView({ state }: { state: { path: string; markdown: string; sha: string } }) {
	// Edit the body only; frontmatter is split off and re-attached server-side, but
	// still shown (Notion-style) as a bare properties block at the top for context.
	const { frontmatter, body } = parseFrontmatter(state.markdown);
	const apiRef = useRef<EditorApi | null>(null);
	const [saving, setSaving] = useState(false);
	async function save() {
		// The real guard, not just a disabled button: Save also lives in the navbar, and
		// a page saved mid-upload links to a file the brain does not have yet.
		if (uploadsInFlight()) {
			toast('Still adding an image — try again in a moment.', true);
			return;
		}
		setSaving(true);
		try {
			const result = await callTool('write_page', {
				path: state.path,
				content: apiRef.current?.getMarkdown() ?? body,
				sha: state.sha,
				...brainArgs()
			});
			if (result.isError) {
				toast(firstText(result), true);
				setSaving(false);
				return;
			}
			toast('Saved ✓');
			// Swap to the page only once the fresh content is in hand — keep the editor
			// on screen during the brief re-fetch so there's no loading spinner / blink.
			try {
				const fresh = await fetchPage(state.path);
				show({ kind: 'page', path: state.path, markdown: fresh }, { push: false });
			} catch {
				show(
					{ kind: 'page', path: state.path, markdown: apiRef.current?.getMarkdown() ?? body },
					{ push: false }
				);
			}
		} catch (e) {
			toast(`Save failed: ${e}`, true);
			setSaving(false);
		}
	}
	function cancel() {
		// Instant return to the page from the content we already hold — no re-fetch, so
		// no loading spinner / breadcrumb blink. (Edits are discarded, so the original
		// markdown we opened with is exactly what the page should show.)
		show({ kind: 'page', path: state.path, markdown: state.markdown }, { push: false });
	}

	// Publish save/cancel + the saving flag to the navbar (which renders the top Save
	// button next to the formatting toolbar). bump() so the header reflects state.
	useEffect(() => {
		editCtl.save = save;
		editCtl.cancel = cancel;
		editCtl.saving = saving;
		bump();
	}, [saving, state.path, state.sha]);

	// Re-read on every render; the root subscribes to the store and uploadOne bumps it.
	const uploading = uploadsInFlight();

	return (
		<div>
			<PageProperties fm={frontmatter} />
			<MarkdownEditor initialMarkdown={body} pagePath={state.path} apiRef={apiRef} />
			{/* A matching Save at the end for long pages — plain buttons, no boxed footer. */}
			<div class="mt-8 flex items-center gap-1">
				{/* Saving is blocked while an attachment is still uploading. The image node
				    is already in the document, so a save now would commit a page linking to
				    a file the brain does not have yet. */}
				<Button variant="subtle" size="sm" onClick={save} disabled={saving || uploading}>
					{saving ? 'Saving…' : uploading ? 'Adding image…' : 'Save'}
				</Button>
				<Button variant="ghost" size="sm" onClick={cancel}>
					Cancel
				</Button>
			</div>
			{/* One line, not a widget. Obsidian needs no affordance because dragging a file
			    into a document is desktop muscle memory; an iframe inside a chat client has
			    not earned that assumption, so it says so once and takes no space. */}
			<p class="mt-2 text-xs text-muted">Paste or drop an image to add it to this page.</p>
		</div>
	);
}

export {
	EditView,
	MarkdownEditor,
	EditorToolbar,
	editCtl,
	M,
	N,
	markActive,
	blockActive,
	toggleHeading
};

declare module '../core/view-registry.ts' {
	interface ViewProps {
		edit: { path: string; markdown: string; sha: string };
	}
}

export default defineView('edit', (v) => <EditView state={v} />, {
	// Save is the one affirmative action, so it is the one `primary` in the bar.
	actions: () => [
		{
			key: 'save',
			label: editCtl.saving ? 'Saving…' : 'Save',
			primary: true,
			disabled: editCtl.saving,
			onClick: () => editCtl.save()
		},
		{ key: 'cancel', label: 'Cancel', onClick: () => editCtl.cancel() }
	]
});
