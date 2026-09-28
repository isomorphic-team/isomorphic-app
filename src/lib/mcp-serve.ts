// Serving one request to /mcp in either protocol era. The Worker and the local
// runtime both call `serveMcp`, so `pnpm test:protocol` covers the path production
// runs.
//
// TWO ERAS, ONE SERVER. A request carrying the 2026-07-28 per-request envelope is
// answered by the SDK's `createMcpHandler`; anything else is 2025-era traffic and
// goes to the stateless Streamable HTTP transport. `isLegacyRequest`
// is the SDK's own classifier, so the split can never disagree with the entry.
//
// Why the 2025 leg is not the entry's built-in fallback: that fallback builds its
// transport without `enableJsonResponse`, which would move every existing client
// from a JSON reply to an SSE one. Both legs answer with JSON here.
//
// Worker-safe: `@modelcontextprotocol/server`'s root is runtime-neutral.

import {
	createMcpHandler,
	isJsonContentType,
	isLegacyRequest,
	WebStandardStreamableHTTPServerTransport,
	type McpServer,
	type ServerOptions
} from '@modelcontextprotocol/server';

/**
 * Options every McpServer here is constructed with.
 *
 * `listChanged: false` because nothing can ever be pushed: each request gets a
 * fresh server that is gone when it answers. On 2026-07-28 a client that sees
 * `listChanged: true` opens a `subscriptions/listen` SSE stream to wait for
 * changes, which on a Worker is a held-open connection that never carries an
 * event. A changed brain-authored tool reaches the host on its next `tools/list`,
 * which is what the write tools already tell the model.
 */
export function serverOptions(instructions: string): ServerOptions {
	return {
		instructions,
		capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }
	};
}

export type McpEra = 'legacy' | 'modern';

export interface Served {
	response: Response;
	/** Absent when the request was refused before it could be classified. */
	era?: McpEra;
	/**
	 * What the 2025 transport reported, for the Worker's log line. Never sent. The
	 * modern leg's refusals carry their reason in the JSON-RPC body instead.
	 */
	error?: string;
}

// The server built for each in-flight modern request, looked up by the factory.
// `createMcpHandler` hands its factory the same Request object passed to `fetch`.
const serverFor = new WeakMap<Request, McpServer>();

// One handler per isolate rather than per request: it holds no per-request state,
// and constructing one in `json` mode logs a warning each time. `json` matches the
// legacy leg: no tool here emits progress or logs mid-call, and a host can tear
// down a long-lived stream before an async result arrives.
let modern: ReturnType<typeof createMcpHandler> | undefined;
function modernHandler(): ReturnType<typeof createMcpHandler> {
	modern ??= createMcpHandler(
		({ requestInfo }) => {
			const server = requestInfo && serverFor.get(requestInfo);
			if (!server) throw new Error('serveMcp: no server registered for this request');
			return server;
		},
		{ legacy: 'reject', responseMode: 'json' }
	);
	return modern;
}

/** Serve one request to /mcp with a server already built for it. */
export async function serveMcp(request: Request, server: McpServer): Promise<Served> {
	// Only POST carries JSON-RPC here. GET would open the optional server-to-client
	// stream, which a per-request server cannot feed (and on Workers the SDK's GET
	// handling hangs until the runtime kills it); DELETE ends a session there is
	// none of. 405 is what the spec gives a client to fall back to POST-only.
	if (request.method !== 'POST') {
		return {
			response: new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
		};
	}
	// The modern leg does no content-type check of its own, so it is done here for
	// both. An HTML form can only POST three content types, none of them JSON.
	if (!isJsonContentType(request.headers.get('content-type'))) {
		return {
			response: new Response('Unsupported Media Type: POST /mcp takes application/json', {
				status: 415
			})
		};
	}

	if (await isLegacyRequest(request)) {
		let error: string | undefined;
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		transport.onerror = (e) => {
			error = e instanceof Error ? e.message : String(e);
		};
		await server.connect(transport);
		return { response: await transport.handleRequest(request), era: 'legacy', error };
	}

	serverFor.set(request, server);
	try {
		return { response: await modernHandler().fetch(request), era: 'modern' };
	} finally {
		serverFor.delete(request);
	}
}
