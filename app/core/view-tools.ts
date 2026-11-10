// Runs the view's app tools (src/lib/view-tools.ts) against this view's navigation.
// The contract, the guard and the result text are decided there; this file only
// reads the store into a snapshot and calls the same actions a click would.

import type { CallToolResult } from '@modelcontextprotocol/client';
import {
	VIEW_TOOLS,
	parseViewToolCall,
	blockedReason,
	describeOpenView,
	actionResult,
	type OpenViewSnapshot,
	type ViewToolCall
} from '../../src/lib/view-tools.ts';
import { currentView, activeBrain, editDirty, show } from './store.ts';
import { navigateTo, runSearch, refreshBrowse, fetchPage, pageView } from './actions.ts';

function snapshot(): OpenViewSnapshot {
	const v = currentView;
	const snap: OpenViewSnapshot = {
		brain: activeBrain ? { id: activeBrain.id, label: activeBrain.label } : null,
		kind: v.kind,
		unsavedEdits: v.kind === 'edit' && editDirty
	};
	if (v.kind === 'page' || v.kind === 'edit' || v.kind === 'asset') snap.path = v.path;
	if ((v.kind === 'page' || v.kind === 'edit') && v.sha) snap.sha = v.sha;
	if (v.kind === 'search' && v.query) snap.query = v.query;
	if (v.kind === 'error') snap.error = { headline: v.headline, detail: v.detail };
	return snap;
}

function text(t: string, isError = false): CallToolResult {
	return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

async function reload(): Promise<CallToolResult> {
	const v = currentView;
	if (v.kind === 'page') {
		const before = { path: v.path, sha: v.sha };
		try {
			show(pageView(v.path, await fetchPage(v.path)), { push: false });
		} catch (e) {
			return text(`Couldn't reload ${v.path}: ${e}`, true);
		}
		const r = actionResult(snapshot(), before);
		return text(r.text, r.isError);
	}
	if (v.kind === 'browse') {
		await refreshBrowse();
		return text(describeOpenView(snapshot()));
	}
	if (v.kind === 'search' && v.query) {
		await runSearch(v.query, v.scope);
		const r = actionResult(snapshot());
		return text(r.text, r.isError);
	}
	return text(`Nothing to reload.\n${describeOpenView(snapshot())}`);
}

async function run(call: ViewToolCall): Promise<CallToolResult> {
	switch (call.tool) {
		case 'get_open_view':
			return text(describeOpenView(snapshot()));
		case 'show_page': {
			await navigateTo(call.path);
			const r = actionResult(snapshot());
			return text(r.text, r.isError);
		}
		case 'show_search': {
			await runSearch(call.query);
			const r = actionResult(snapshot());
			return text(r.text, r.isError);
		}
		case 'reload_view':
			return reload();
	}
}

export function listViewTools() {
	return { tools: VIEW_TOOLS.map((t) => ({ ...t })) };
}

export async function callViewTool(name: string, args: unknown): Promise<CallToolResult> {
	const parsed = parseViewToolCall(name, args);
	if (!parsed.ok) return text(parsed.text, true);
	const blocked = blockedReason(parsed.call, snapshot());
	if (blocked) return text(blocked, true);
	return run(parsed.call);
}
