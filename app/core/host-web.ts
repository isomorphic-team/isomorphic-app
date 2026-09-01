// The web host: the same app bundle, in a browser tab, talking to the same MCP
// tool handlers over `fetch` instead of over AppBridge.
//
// This is the whole port. `McpSession` reads identity from `props`, and the
// Worker builds those from an Auth.js session cookie when a `/mcp` POST carries
// no Bearer token, so nothing downstream changes: tenant resolution,
// `effectiveBrainRole`, the two-scope gating and usage analytics are the code
// that already runs. The web app is structurally incapable of doing something
// the connector cannot, which is the property worth protecting.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// The Worker stamps this onto the page it serves at `/b/...`. A flag rather
// than "wait for an AppBridge handshake and see if it times out": the host is a
// fact known at serve time, and inferring it from a timeout makes every web
// boot pay a delay and makes a slow host look like a browser.
export function isWebHost(): boolean {
	return (
		typeof window !== 'undefined' && (window as { __ISO_WEB__?: boolean }).__ISO_WEB__ === true
	);
}

let nextId = 1;

// One tool call, one POST. There is no session to establish: the transport is
// stateless (`sessionIdGenerator: undefined`), so every request builds a fresh
// `McpServer` and a bare `tools/call` is answered without an `initialize`
// first. Verified against the real handlers; see `docs/references.md`.
export async function webCallTool(
	name: string,
	args: Record<string, unknown>
): Promise<CallToolResult> {
	const res = await fetch('/mcp', {
		method: 'POST',
		// The Auth.js cookie IS the credential. Same-origin only, which is also
		// what makes the Origin check on the Worker side sufficient against CSRF.
		credentials: 'same-origin',
		headers: {
			// Not negotiable, and not obvious: the transport refuses the request
			// with 406 unless the client accepts BOTH, even though
			// `enableJsonResponse: true` means the answer is always JSON and no
			// stream is ever opened.
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: nextId++,
			method: 'tools/call',
			params: { name, arguments: args }
		})
	});

	// The session expired or was never there. Send the person to sign in and
	// come back to the page they were on, rather than showing a tool error for
	// what is really a logged-out browser.
	if (res.status === 401) {
		const to = `${location.pathname}${location.search}`;
		location.href = `/auth/signin?callbackUrl=${encodeURIComponent(to)}`;
		// Never resolves: the navigation is already underway, and resolving with
		// an error would paint a failure over a page that is leaving.
		return new Promise<CallToolResult>(() => {});
	}
	if (!res.ok) throw new Error(`${name} failed (${res.status})`);

	const envelope = await readEnvelope(res);
	if (envelope.error) throw new Error(envelope.error.message || `${name} failed`);
	return (envelope.result ?? { content: [] }) as CallToolResult;
}

interface JsonRpcEnvelope {
	result?: unknown;
	error?: { code?: number; message?: string };
}

// Read one JSON-RPC response. Normally a plain JSON body, but the transport is
// allowed to answer as SSE, so a `text/event-stream` reply is unwrapped rather
// than handed to `JSON.parse` as-is.
async function readEnvelope(res: Response): Promise<JsonRpcEnvelope> {
	const type = res.headers.get('content-type') ?? '';
	const body = await res.text();
	if (!type.includes('text/event-stream')) return JSON.parse(body) as JsonRpcEnvelope;
	for (const line of body.split('\n')) {
		if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim()) as JsonRpcEnvelope;
	}
	throw new Error('Empty response from the server.');
}

// Back and forward.
//
// The app is one document that never navigates, so a browser history move arrives
// only as this event: without a handler, Back leaves the app rather than returning
// to the previous page. The counterpart is `syncAddressBar` in store.ts, which is
// what puts the entries there in the first place.
//
// The handler navigates with `push: false`, since the browser has ALREADY moved —
// pushing here would re-add the entry it just left and make Back a no-op.
export function registerWebNavigation(onNavigate: (target: WebTarget) => void): void {
	addEventListener('popstate', () => {
		const target = parseWebPath(location.pathname);
		if (target) onNavigate(target);
	});
}

// What a `/b/...` URL means is decided in ONE place, which the Worker uses to
// serve the shell and the app uses to open the right page. Two parsers is how a
// link ends up opening a different page than the one it names.
import { parseWebPath, type WebTarget } from '../../src/lib/web-app.ts';
export {
	parseWebPath,
	webPathFor,
	WEB_TOOL_ROUTING,
	type WebTarget,
	type WebRouting
} from '../../src/lib/web-app.ts';
