// What a POST /mcp is actually asking for, decided before the MCP SDK sees it.
//
// Every request to /mcp used to pay for full brain resolution before anyone
// looked at the JSON-RPC method: `loadCustomTools` resolves a tenant (D1 rows
// plus an installation-token mint, a GitHub round trip), calls `ensureFresh`
// (another GitHub round trip, sometimes an incremental reindex), and fetches a
// blob per `tools/` page. `initialize` needs none of it — it is answered from
// the static tool surface — and `initialize` is the connect, which is the one
// request a user cannot retry past. Issue #50 reported a session that failed to
// connect at all with a gateway error, so the handshake is the path that most
// needs to be cheap.
//
// Pure and Worker-safe: no `node:*`, no bindings, no I/O. The Worker peeks the
// body once, asks the two functions below, and hands the same bytes to the
// transport.

export interface JsonRpcPeek {
	/** Every method named in the payload. A batch names several; a response names none. */
	methods: string[];
	/** The first request id present, so a failure can still answer the caller. */
	id: string | number | null;
	/** False when the body was not JSON-RPC we recognise — callers stay conservative. */
	parsed: boolean;
}

const UNPARSED: JsonRpcPeek = { methods: [], id: null, parsed: false };

// Methods answered entirely from the static tool surface, needing no brain.
// `ping` and `initialize` are the whole set on purpose: `tools/list` DOES need
// the brain, because a brain's own `tools/` pages are part of the list it
// returns, and every `tools/call` obviously does.
const BRAIN_FREE_METHODS = new Set(['initialize', 'ping']);

// Notifications carry no id and expect no reply; none of ours reads a brain.
function isNotification(method: string): boolean {
	return method.startsWith('notifications/');
}

/**
 * Read the methods and the first id out of a JSON-RPC body without consuming
 * the request. Never throws: an unreadable body reports `parsed: false`, which
 * every caller treats as "assume it needs everything".
 */
export function peekJsonRpc(body: string): JsonRpcPeek {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return UNPARSED;
	}
	const items = Array.isArray(payload) ? payload : [payload];
	const methods: string[] = [];
	let id: string | number | null = null;
	let sawMessage = false;
	for (const item of items) {
		if (!item || typeof item !== 'object') continue;
		const msg = item as { method?: unknown; id?: unknown };
		sawMessage = true;
		if (typeof msg.method === 'string') methods.push(msg.method);
		if (id === null && (typeof msg.id === 'string' || typeof msg.id === 'number')) id = msg.id;
	}
	if (!sawMessage && !Array.isArray(payload)) return UNPARSED;
	return { methods, id, parsed: true };
}

/**
 * Does serving this request require resolving the caller's brain (and with it
 * the custom-tool roster)? True unless every method in the payload is answered
 * from the static surface. Conservative in both unknown directions: an
 * unparsed body and an unrecognised method both mean yes.
 */
export function needsBrainPreamble(peek: JsonRpcPeek): boolean {
	if (!peek.parsed) return true;
	return !peek.methods.every((m) => BRAIN_FREE_METHODS.has(m) || isNotification(m));
}

/**
 * A JSON-RPC error object for a request that failed before the SDK could
 * answer it. `data.ray` carries Cloudflare's ray id so a report can be matched
 * to a log line: issue #50 arrived with four ray ids and nothing to join them
 * against, because an exception thrown out of the handler leaves no reply at
 * all.
 */
export function jsonRpcError(
	id: string | number | null,
	message: string,
	ray?: string | null
): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		error: {
			code: -32603,
			message,
			...(ray ? { data: { ray } } : {})
		}
	});
}
