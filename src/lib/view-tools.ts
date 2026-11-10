// The tools the open brain viewer offers the model: MCP Apps "app tools", which a
// host lists from the view itself (`tools/list` over the postMessage bridge) and
// calls while the user has that view open. They change what THIS view shows and
// nothing else; content writes stay server tools (`write_page`), and these let the
// model show the user the result.
//
// Pure, so the deciding half runs in a node test: the definitions, argument checks,
// the unsaved-edits guard and the text each result carries. The view wires them to
// its navigation in app/core/view-tools.ts.
//
// THE DEFINITIONS ARE CONSTANT. A host saves "Always allow" against a tool as
// defined; changing a name, title, description or schema asks the user again. State
// that changes (the open path) belongs in results, never in a description.

/** One app tool, in the `tools/list` shape a view returns. */
export interface ViewToolDef {
	name: string;
	title: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, { type: 'string'; description: string }>;
		required?: string[];
		additionalProperties: false;
	};
}

// First line of each description stands alone: a host lists a view's tools by
// name plus the first 200 characters of the description, and fetches the rest
// only on lookup.
export const VIEW_TOOLS: readonly ViewToolDef[] = [
	{
		name: 'get_open_view',
		title: 'See what is open',
		description:
			'Report what the user has open in this Isomorphic viewer: the brain, the screen, and the page path if one is open.\nCall it before acting on "this page" or "what I am looking at". It reads nothing from the brain; use read_page for the content.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'show_page',
		title: 'Show a page',
		description:
			"Open a page of the viewer's brain in this viewer, so the user sees it.\nTakes the page's repo path, such as wiki/projects/atlas.md. Use after writing a page to show the result, or to point the user at one page.",
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Repo path of the page, such as wiki/index.md.' }
			},
			required: ['path'],
			additionalProperties: false
		}
	},
	{
		name: 'show_search',
		title: 'Show search results',
		description:
			"Run a search in this viewer and show the user the matching pages of the viewer's brain.\nThe results appear on screen for the user to open; use search_pages when you need the hits yourself.",
		inputSchema: {
			type: 'object',
			properties: { query: { type: 'string', description: 'Words to search for.' } },
			required: ['query'],
			additionalProperties: false
		}
	},
	{
		name: 'reload_view',
		title: 'Reload the view',
		description:
			'Reload what this viewer shows from the brain, so changes made since it opened appear.\nUse after write_page, edit, move or delete changed the page or files on screen.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	}
];

export type ViewToolCall =
	| { tool: 'get_open_view' }
	| { tool: 'show_page'; path: string }
	| { tool: 'show_search'; query: string }
	| { tool: 'reload_view' };

/** What the view is showing, as the result text describes it. */
export interface OpenViewSnapshot {
	brain: { id: string; label: string } | null;
	/** The view kind (`page`, `edit`, `browse`, `search`, `error`, ...). */
	kind: string;
	path?: string;
	sha?: string;
	query?: string;
	/** The editor holds changes the user has not saved. */
	unsavedEdits: boolean;
	/** For `error`: what the screen says went wrong. */
	error?: { headline: string; detail?: string };
}

export type Parsed = { ok: true; call: ViewToolCall } | { ok: false; text: string };

// `arguments` arrives unvalidated: the handlers path skips schema checks, and the
// host may forward whatever the model sent.
export function parseViewToolCall(name: string, args: unknown): Parsed {
	const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
	switch (name) {
		case 'get_open_view':
		case 'reload_view':
			return { ok: true, call: { tool: name } };
		case 'show_page': {
			const path = typeof a.path === 'string' ? normalizePath(a.path) : '';
			if (!path)
				return {
					ok: false,
					text: 'Nothing was opened. Call show_page with the page path as a string.'
				};
			return { ok: true, call: { tool: 'show_page', path } };
		}
		case 'show_search': {
			const query = typeof a.query === 'string' ? a.query.trim() : '';
			if (!query)
				return {
					ok: false,
					text: 'Nothing was searched. Call show_search with a non-empty query.'
				};
			return { ok: true, call: { tool: 'show_search', query } };
		}
		default:
			return {
				ok: false,
				text: `This viewer has no tool named ${name}. Its tools are ${VIEW_TOOLS.map((t) => t.name).join(', ')}.`
			};
	}
}

// A model copies paths out of prose, links and its own earlier calls, so it sends
// `/wiki/a.md` and `./wiki/a.md` for `wiki/a.md`. Repo paths have no leading slash.
function normalizePath(p: string): string {
	return p.trim().replace(/^(\.\/|\/)+/, '');
}

// Leaving the editor with unsaved changes asks the user to confirm. A tool call is
// not the user, so it does not get to answer that dialog for them: the call is
// refused and the model is told why.
export function blockedReason(call: ViewToolCall, view: OpenViewSnapshot): string | null {
	if (call.tool === 'get_open_view' || !view.unsavedEdits) return null;
	return `Nothing changed. The user has unsaved edits to ${view.path ?? 'a page'} in this viewer; ask them to save or discard before the view moves.`;
}

const KIND_LABEL: Record<string, string> = {
	page: 'a page',
	edit: 'the editor',
	asset: 'an attachment',
	browse: 'the file tree',
	search: 'search results',
	graph: 'the link graph',
	activity: 'recent changes',
	review: 'the data review',
	'brain-access': 'sharing settings',
	members: 'the member list',
	analytics: 'usage analytics',
	brains: 'the brain list',
	settings: 'account settings',
	more: 'the More menu',
	loading: 'a loading screen',
	error: 'an error'
};

/** The result text for a view: what is on screen now. */
export function describeOpenView(view: OpenViewSnapshot): string {
	const lines: string[] = [];
	lines.push(
		view.brain ? `Brain: ${view.brain.label} (brain: "${view.brain.id}")` : 'Brain: none open'
	);
	lines.push(`Showing: ${KIND_LABEL[view.kind] ?? view.kind}`);
	if (view.path) lines.push(`Path: ${view.path}`);
	if (view.query) lines.push(`Search: ${view.query}`);
	if (view.kind === 'edit')
		lines.push(
			view.unsavedEdits ? 'The editor has unsaved changes.' : 'The editor has no unsaved changes.'
		);
	if (view.error) {
		lines.push(`Error: ${view.error.headline}`);
		if (view.error.detail) lines.push(view.error.detail);
	}
	return lines.join('\n');
}

/**
 * The result of a call that moved the view. An action that landed on the error
 * screen failed, and says so as an error result rather than as a description.
 */
export function actionResult(
	view: OpenViewSnapshot,
	before?: { path?: string; sha?: string }
): { text: string; isError: boolean } {
	if (view.kind === 'error') return { text: describeOpenView(view), isError: true };
	let text = describeOpenView(view);
	if (before?.sha && view.sha && before.path === view.path)
		text +=
			before.sha === view.sha
				? '\nThe page had not changed.'
				: '\nThe page changed and now shows the latest version.';
	return { text, isError: false };
}
