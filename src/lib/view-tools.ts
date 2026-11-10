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

import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/client';
import { normPagePath } from './write-target.ts';

// First line of each description stands alone: a host lists a view's tools by
// name plus the first 200 characters of the description, and fetches the rest
// only on lookup.
export const VIEW_TOOLS: ListToolsResult['tools'] = [
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
			"Open a page of the viewer's brain in this viewer, so the user sees it.\nTakes the page's repo path, such as wiki/projects/atlas.md. Naming the page already open reloads it, so use it after write_page to show the result.",
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Repo path of the page, such as wiki/index.md.' }
			},
			required: ['path'],
			additionalProperties: false
		}
	}
];

export type ViewToolCall = { tool: 'get_open_view' } | { tool: 'show_page'; path: string };

/** Whether a reload moved the page, as `refreshOutcome` (app/core/util.ts) decides it. */
export type RefreshOutcome = 'updated' | 'current' | 'unknown';

/** What the view is showing, as the result text describes it. */
export interface OpenViewSnapshot {
	brain: { id: string; label: string } | null;
	/** What is on screen, in words (`Files`, `a page`, `the editor`). */
	screen: string;
	/** An error screen is a failed call, not a description. */
	isError: boolean;
	path?: string;
	query?: string;
	/** The editor holds changes the user has not saved. */
	unsavedEdits: boolean;
	/** For an error screen: what it says went wrong. */
	error?: { headline: string; detail?: string };
}

// `arguments` arrives unvalidated: the handlers path skips schema checks, and the
// host may forward whatever the model sent.
export function parseViewToolCall(
	name: string,
	args: unknown
): { ok: true; call: ViewToolCall } | { ok: false; text: string } {
	if (name === 'get_open_view') return { ok: true, call: { tool: name } };
	if (name === 'show_page') {
		const raw = (args as { path?: unknown } | null | undefined)?.path;
		// A model copies paths out of prose and links, so `./wiki/a.md` arrives too.
		const path = typeof raw === 'string' ? normPagePath(raw.trim().replace(/^(\.\/)+/, '')) : '';
		if (!path)
			return {
				ok: false,
				text: 'Nothing was opened. Call show_page with the page path as a string.'
			};
		return { ok: true, call: { tool: 'show_page', path } };
	}
	return {
		ok: false,
		text: `This viewer has no tool named ${name}. Its tools are ${VIEW_TOOLS.map((t) => t.name).join(', ')}.`
	};
}

// Leaving the editor with unsaved changes asks the user to confirm. A tool call is
// not the user, so it does not get to answer that dialog for them: the call is
// refused and the model is told why.
export function blockedReason(call: ViewToolCall, view: OpenViewSnapshot): string | null {
	if (call.tool !== 'show_page' || !view.unsavedEdits) return null;
	return `Nothing changed. The user has unsaved edits to ${view.path ?? 'a page'} in this viewer; ask them to save or discard before the view moves.`;
}

function describe(view: OpenViewSnapshot): string {
	const lines = [
		view.brain ? `Brain: ${view.brain.label} (brain: "${view.brain.id}")` : 'Brain: none open',
		`Showing: ${view.screen}`
	];
	if (view.path) lines.push(`Path: ${view.path}`);
	if (view.query) lines.push(`Search: ${view.query}`);
	if (view.unsavedEdits) lines.push('The editor has unsaved changes.');
	if (view.error) {
		lines.push(`Error: ${view.error.headline}`);
		if (view.error.detail) lines.push(view.error.detail);
	}
	return lines.join('\n');
}

export function textResult(text: string, isError = false): CallToolResult {
	return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * The result for a view: what is on screen now, and after a reload whether the
 * page moved. A call that landed on the error screen failed, and is an error result.
 */
export function viewResult(view: OpenViewSnapshot, reload?: RefreshOutcome): CallToolResult {
	let text = describe(view);
	if (reload === 'current') text += '\nThe page had not changed.';
	if (reload === 'updated') text += '\nThe page changed and now shows the latest version.';
	return textResult(text, view.isError);
}
