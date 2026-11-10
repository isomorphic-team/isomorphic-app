// Runs the view's app tools (src/lib/view-tools.ts) against this view's navigation.
// The contract, the guard and the result text are decided there; this file only
// reads the store into a snapshot and calls the same actions a click would.

import type { CallToolResult } from '@modelcontextprotocol/client';
import {
	VIEW_TOOLS,
	parseViewToolCall,
	blockedReason,
	textResult,
	viewResult,
	type OpenViewSnapshot
} from '../../src/lib/view-tools.ts';
import type { View } from './types.ts';
import { currentView, activeBrain, hasUnsavedEdits } from './store.ts';
import { activeDestination, DEST_META } from './nav.ts';
import { navigateTo, reloadPage } from './actions.ts';

// A view that is a destination reads as the destination's own label ("Files"). The
// rest are named here.
const SCREEN: Partial<Record<View['kind'], string>> = {
	page: 'a page',
	edit: 'the editor',
	asset: 'an attachment',
	more: 'the More menu',
	loading: 'a loading screen',
	error: 'an error'
};

function snapshot(): OpenViewSnapshot {
	const v = currentView;
	const dest = activeDestination(v.kind);
	return {
		brain: activeBrain,
		screen: dest ? DEST_META[dest].label : (SCREEN[v.kind] ?? v.kind),
		isError: v.kind === 'error',
		unsavedEdits: hasUnsavedEdits(),
		...(v.kind === 'page' || v.kind === 'edit' || v.kind === 'asset' ? { path: v.path } : {}),
		...(v.kind === 'search' && v.query ? { query: v.query } : {}),
		...(v.kind === 'error' ? { error: { headline: v.headline, detail: v.detail } } : {})
	};
}

// The host lists these rarely and they never change, so the list is built once.
const LIST = { tools: VIEW_TOOLS };
export function listViewTools() {
	return LIST;
}

export async function callViewTool(name: string, args: unknown): Promise<CallToolResult> {
	const parsed = parseViewToolCall(name, args);
	if (!parsed.ok) return textResult(parsed.text, true);
	const { call } = parsed;
	const blocked = blockedReason(call, snapshot());
	if (blocked) return textResult(blocked, true);
	if (call.tool === 'get_open_view') return viewResult(snapshot());

	// The page already on screen is reloaded in place, the way its refresh control
	// does it, rather than reopened through a loading screen.
	if (currentView.kind === 'page' && currentView.path === call.path) {
		try {
			const outcome = await reloadPage();
			return viewResult(snapshot(), outcome ?? undefined);
		} catch (e) {
			return textResult(`Couldn't reload ${call.path}: ${e}`, true);
		}
	}
	await navigateTo(call.path);
	return viewResult(snapshot());
}
