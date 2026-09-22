// Golden test for serving both MCP protocol eras (src/lib/mcp-serve.ts). Offline:
// real SDK clients talk HTTP to `serveMcp` in-process through a fetch function,
// which is the SDK's own recommended way to exercise 2026-07-28 without sockets.
// The in-memory transport cannot: it links 2025-era instances only.
//
// What this pins, all of it decided in `serveMcp`:
//   - a 2026-07-28 client and a 2025 client both reach the same tools and the
//     ui:// app resource, through one endpoint
//   - an auto-negotiating client (what a current host sends) lands on 2026-07-28
//   - both eras answer with JSON, never an SSE stream, and hold no session
//   - the server advertises listChanged: false, so a 2026 client does not open a
//     subscriptions/listen stream that a per-request Worker can never feed
//   - a non-JSON POST is refused before either leg sees it
//
//   pnpm test:protocol

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { serveMcp, serverOptions, type McpEra } from '../src/lib/mcp-serve.ts';
import { registerBrainApp, BRAIN_APP_URI } from '../src/tools/apps.ts';
import { checker } from './check.ts';

const { check, done } = checker('protocol checks');

const URL_ = new URL('http://protocol.test/mcp');

// A fresh server per request, as the Worker builds one.
function build(): McpServer {
	const server = new McpServer({ name: 'protocol-probe', version: '0' }, serverOptions('probe'));
	server.registerTool(
		'echo',
		{ description: 'Echo a word', inputSchema: z.object({ word: z.string() }) },
		async ({ word }) => ({ content: [{ type: 'text' as const, text: `echo ${word}` }] })
	);
	// The app registration never calls getContext.
	registerBrainApp(server, (() => {
		throw new Error('no brain in this test');
	}) as never);
	return server;
}

interface Seen {
	eras: (McpEra | undefined)[];
	contentTypes: string[];
	sessionIds: (string | null)[];
}

function transportFor(seen: Seen): StreamableHTTPClientTransport {
	return new StreamableHTTPClientTransport(URL_, {
		fetch: async (url, init) => {
			const request = new Request(url, init);
			const served = await serveMcp(request, build());
			// A 2025 client also tries GET for the optional server-to-client stream;
			// that is refused (below) and is not a JSON-RPC exchange.
			if (request.method !== 'POST') return served.response;
			seen.eras.push(served.era);
			if (served.response.status !== 202) {
				seen.contentTypes.push(served.response.headers.get('content-type') ?? '');
			}
			seen.sessionIds.push(served.response.headers.get('mcp-session-id'));
			return served.response;
		}
	});
}

type Negotiation = 'legacy' | 'auto' | { pin: '2026-07-28' };

async function exercise(label: string, mode: Negotiation, expectEra: McpEra): Promise<void> {
	console.log(`\n${label}`);
	const seen: Seen = { eras: [], contentTypes: [], sessionIds: [] };
	const client = new Client(
		{ name: 'protocol-client', version: '0' },
		mode === 'legacy' ? {} : { versionNegotiation: { mode } }
	);
	await client.connect(transportFor(seen));

	check(
		`negotiates the ${expectEra} era`,
		client.getProtocolEra() === expectEra,
		client.getProtocolEra()
	);

	const caps = client.getServerCapabilities();
	check(
		'advertises tools.listChanged: false',
		caps?.tools?.listChanged === false,
		JSON.stringify(caps?.tools)
	);
	check(
		'advertises resources.listChanged: false',
		caps?.resources?.listChanged === false,
		JSON.stringify(caps?.resources)
	);

	const tools = await client.listTools();
	const names = tools.tools.map((t) => t.name);
	check('tools/list reaches the registered tools', names.includes('echo'), names.join(','));

	const out = await client.callTool({ name: 'echo', arguments: { word: 'hi' } });
	const text = (out.content as { type: string; text?: string }[])[0]?.text;
	check('tools/call runs the handler with its arguments', text === 'echo hi', text);

	const app = await client.readResource({ uri: BRAIN_APP_URI });
	const body = (app.contents[0] as { text?: string } | undefined)?.text ?? '';
	check('the ui:// app resource is readable', body.includes('<html') || body.includes('<!doctype'));

	const served = seen.eras.filter((e) => e !== undefined);
	check(
		`every exchange was routed to the ${expectEra} leg`,
		served.length > 0 && served.every((e) => e === expectEra),
		JSON.stringify(seen.eras)
	);
	check(
		'every reply is JSON, never an SSE stream',
		seen.contentTypes.length > 0 &&
			seen.contentTypes.every((c) => c.startsWith('application/json')),
		JSON.stringify(seen.contentTypes)
	);
	check(
		'no reply opens a session',
		seen.sessionIds.every((s) => s === null)
	);
	await client.close();
}

await exercise('2026-07-28, pinned', { pin: '2026-07-28' }, 'modern');
await exercise('auto-negotiated (what a current host does)', 'auto', 'modern');
await exercise('2025, the default client', 'legacy', 'legacy');

console.log('\nrefusals');
{
	for (const method of ['GET', 'DELETE']) {
		const res = (await serveMcp(new Request(URL_, { method }), build())).response;
		check(
			`${method} is refused with 405 and Allow: POST`,
			res.status === 405 && res.headers.get('allow') === 'POST',
			String(res.status)
		);
	}

	const served = await serveMcp(
		new Request(URL_, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: '{"jsonrpc":"2.0","id":1,"method":"ping"}'
		}),
		build()
	);
	check('a non-JSON POST is refused with 415', served.response.status === 415);
	check('...before either leg classified it', served.era === undefined);

	// A body claiming the 2026 era without the standard headers belongs to the
	// modern leg, which refuses it. Routing it to the 2025 leg would serve a
	// malformed modern request as if it were an old one.
	const claim = await serveMcp(
		new Request(URL_, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }
			})
		}),
		build()
	);
	check('an enveloped request is routed to the modern leg', claim.era === 'modern');
	check(
		'...which refuses it for missing headers rather than serving it',
		claim.response.status === 400,
		String(claim.response.status)
	);
}

done();
