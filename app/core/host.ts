// The host seam: everything the app needs from whatever is hosting it.
//
// TWO hosts. In Claude the app is an MCP App in a sandboxed iframe talking
// over AppBridge; on the web it is the same bundle in a tab talking to `/mcp`
// over fetch with a session cookie. Every difference between them lives in this
// file, so a view never asks which one it is running in.
//
// Nothing outside this module touches the `App` instance, which is what makes
// "swap this file and the bundle runs anywhere" true.

import {
	App,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	type McpUiHostContext
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { DisplayMode } from './types.ts';
import { bump } from './store.ts';
import { toast } from './toast.tsx';
import { isWebHost, webCallTool } from './host-web.ts';
// The text block of a result. Lives with the payload parsers; re-exported from this
// seam because every view that toasts a tool's reply already imports it from here.
import { firstText } from '../../src/lib/tool-payloads.ts';

const app = new App({ name: 'Isomorphic Brain', version: '0.2.0' });

// Fixed for the life of the page: the Worker decides which host is serving.
const web = isWebHost();
export function isWeb(): boolean {
	return web;
}

// A TAB OWNS ITS WINDOW, so the web host starts in fullscreen semantics: fill the
// viewport, no height cap, no card border, the wide column. Left at 'inline' the
// same bundle would render as the chat-column card inside a browser tab: a 560px
// rounded box scrolling within itself on the browser's default page background.
// The MCP host starts inline and moves through host-context events.
let displayMode: DisplayMode = web ? 'fullscreen' : 'inline';
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
	// No display-mode request here: the app opens INLINE, a bounded card in the chat
	// column, and the user goes fullscreen through the display-mode menu. Requesting
	// fullscreen on open would bury the conversation.
}

// On the web there is no host context to inherit, so the app follows the
// browser's own preference and keeps following it. A tab is already the size it
// is going to be, which is why no display mode is advertised below.
function applyWebTheme() {
	// Marks the document as the web host for the stylesheet: the page background
	// outside the app's root (overscroll, the moment before the root mounts) is the
	// app's own, not the browser's default. Web only, because in the MCP App the
	// document behind the card is the host's, and the card's rounded corners show
	// it through.
	document.documentElement.classList.add('web');
	const query = window.matchMedia('(prefers-color-scheme: dark)');
	const paint = () => {
		applyDocumentTheme(query.matches ? 'dark' : 'light');
		bump();
	};
	paint();
	query.addEventListener('change', paint);
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

// The modes the header's display-mode menu (DisplayMenu in main.tsx) offers: whichever
// the host actually advertises, in a stable order. A host may expose only a subset
// (e.g. inline + fullscreen). On the web that list is empty, so the menu does not
// render at all.
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
	if (web) return webCallTool(name, args);
	return app.callServerTool({ name, arguments: args });
}

// Open a URL outside the app. In Claude that is a host request (the iframe is
// sandboxed and cannot navigate the top window); on the web it is an ordinary
// new tab, with `noopener` so the opened page cannot reach back through
// `window.opener`.
function openLink(url: string) {
	if (web) window.open(url, '_blank', 'noopener,noreferrer');
	else app.openLink({ url });
}

// What the app wants to be told about. The MCP host pushes all of these; the
// web host pushes none, because a tab has no conversation attached to it.
export interface HostEvents {
	onToolResult: (result: unknown) => void;
	onError: (message: string) => void;
	// The host announced a tool call, so a result is on its way.
	onResultComing: () => void;
	// It is not coming after all.
	onResultCancelled: () => void;
}

export function registerHostEvents(events: HostEvents) {
	if (web) return;
	app.onhostcontextchanged = applyHostContext;
	app.onerror = (e) => events.onError(String(e));
	app.ontoolresult = events.onToolResult as typeof app.ontoolresult;
	// One-shot events, registered before connect(): the host may send them the
	// moment the handshake completes.
	app.ontoolinput = events.onResultComing;
	app.ontoolinputpartial = events.onResultComing;
	app.ontoolcancelled = events.onResultCancelled;
}

// Finish whatever handshake this host needs before the app draws real content.
// The web host has none, so it resolves immediately and the caller goes straight
// to opening the page the URL asked for.
async function connectHost(): Promise<void> {
	if (web) {
		applyWebTheme();
		return;
	}
	await app.connect();
	const ctx = app.getHostContext();
	if (ctx) applyHostContext(ctx);
}

export {
	displayMode,
	availableModes,
	applyHostContext,
	setDisplayMode,
	connectHost,
	openLink,
	MODE_ORDER,
	MODE_ICON,
	MODE_LABEL,
	availableModeList,
	callTool,
	firstText
};
