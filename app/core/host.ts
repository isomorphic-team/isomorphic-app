// MCP host bridge: the App instance, host-context plumbing, display-mode state, and
// the thin callTool / firstText helpers. Display mode lives here because it's owned by
// the host context and only ever written by this module (applyHostContext / setDisplayMode).

import {
	App,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	type McpUiHostContext
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DisplayMode } from './types.ts';
import { bump } from './store.ts';
import { toast } from './toast.tsx';

const app = new App({ name: 'Isomorphic Brain', version: '0.2.0' });

let displayMode: DisplayMode = 'inline';
let availableModes: DisplayMode[] = [];

function applyHostContext(ctx: McpUiHostContext) {
	if (ctx.theme) applyDocumentTheme(ctx.theme);
	if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
	if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
	if (ctx.availableDisplayModes) availableModes = ctx.availableDisplayModes as DisplayMode[];
	if (ctx.displayMode && ctx.displayMode !== displayMode) {
		displayMode = ctx.displayMode as DisplayMode;
	}
	bump();
	// Default to INLINE — the app opens as a bounded card in the chat column, not a
	// full-page takeover. Users can go fullscreen via the display-mode menu when they
	// want the room (e.g. long editing sessions). (We used to auto-request fullscreen
	// here; that made every open a full-page view, which buried the conversation.)
}

// Ask the host to switch display mode (inline / fullscreen / pip). The host
// echoes the actual mode back via host-context-changed; we optimistically set it
// too so the toggle feels immediate.
async function setDisplayMode(mode: DisplayMode) {
	if (!availableModes.includes(mode)) return;
	try {
		const res = await app.requestDisplayMode({ mode });
		displayMode = (res?.mode as DisplayMode) ?? mode;
		bump();
	} catch (e) {
		toast(`Couldn't switch to ${mode}: ${e}`, true);
	}
}

// Cycle the header button through whichever modes the host actually advertises,
// in a stable order. A host may expose only a subset (e.g. inline + fullscreen).
const MODE_ORDER: DisplayMode[] = ['inline', 'fullscreen', 'pip'];
const MODE_ICON: Record<DisplayMode, string> = { inline: '▭', fullscreen: '⤢', pip: '❐' };
const MODE_LABEL: Record<DisplayMode, string> = {
	inline: 'Inline',
	fullscreen: 'Fullscreen',
	pip: 'Pop-out'
};
function availableModeList(): DisplayMode[] {
	return MODE_ORDER.filter((m) => availableModes.includes(m));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	return app.callServerTool({ name, arguments: args });
}

function firstText(result: CallToolResult): string {
	const block = (result.content ?? []).find((b) => b.type === 'text');
	return block && 'text' in block ? String(block.text) : '';
}

export {
	app,
	displayMode,
	availableModes,
	applyHostContext,
	setDisplayMode,
	MODE_ORDER,
	MODE_ICON,
	MODE_LABEL,
	availableModeList,
	callTool,
	firstText
};
