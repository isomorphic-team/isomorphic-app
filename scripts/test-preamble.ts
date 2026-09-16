// Golden test for the /mcp REQUEST PREAMBLE — pure, no network, no bindings.
//
// Two things in front of the MCP SDK decide how a request fares before any tool
// handler runs, and issue #50 is what both of them cost when they are wrong.
//
//   WHAT A REQUEST NEEDS. Every POST used to resolve a brain first: a KV read, a
//   tenant lookup, an installation-token mint (a GitHub round trip) and an index
//   freshness check, all to discover the brain's own `tools/` pages. `initialize`
//   is answered from the static tool surface and needs none of it — and it is the
//   connect, the one request a user cannot retry past. The reported session failed
//   to connect at all. So the skip has to be exactly right in both directions:
//   skipping `tools/list` would hide a brain's own tools, and NOT skipping
//   `initialize` puts four I/O hops in the handshake.
//
//   WHAT A FAILURE SAYS. Nothing in that preamble sits inside a tool handler, so
//   the SDK's error mapping never sees it and workers-oauth-provider does not
//   catch it either: a throw left the Worker with no reply, which upstream reads
//   as an invalid response and reports as a bare gateway error. The report
//   carried four ray ids and nothing to join them against.
//
// Also pins the RETRY GUIDANCE on the three write tools. A caller that reads
// "if this call TIMES OUT" does not apply it to a 502, which is the exact
// mistake the issue documents, and the wording is a string literal no other
// battery would notice changing.
//
//   pnpm test:preamble

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	peekJsonRpc,
	needsBrainPreamble,
	jsonRpcError,
	describeRequest
} from '../src/lib/mcp-preamble.ts';
import { registerLibrarianTools, type BrainContext } from '../src/tools/librarian.ts';
import type { TenantOpts } from '../src/lib/orgs.ts';

import { checker } from './check.ts';

const { check, done } = checker('preamble checks');

const req = (method: string, id: number | string = 1) =>
	JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
const note = (method: string) => JSON.stringify({ jsonrpc: '2.0', method });

// ---------------------------------------------------------------------------
// peekJsonRpc: read the payload without consuming it
// ---------------------------------------------------------------------------
console.log('\npeekJsonRpc');
{
	const one = peekJsonRpc(req('tools/call', 7));
	check(
		'a single request yields its method and id',
		one.methods[0] === 'tools/call' && one.id === 7
	);
	check('…and reports itself parsed', one.parsed);

	const batch = peekJsonRpc(`[${req('initialize', 1)},${note('notifications/initialized')}]`);
	check('a batch yields every method', batch.methods.length === 2, batch.methods.join(','));
	check('…and the FIRST id present', batch.id === 1);

	const notif = peekJsonRpc(note('notifications/initialized'));
	check('a notification has no id', notif.id === null && notif.parsed);

	// The id is what lets a failure answer the caller at all, so a string id must
	// survive as a string: JSON-RPC allows either, and coercing one to a number
	// would address the reply to a request that does not exist.
	check('a string id stays a string', peekJsonRpc(req('ping', 'abc')).id === 'abc');

	// Anything unreadable must report itself unparsed rather than guess, because
	// every caller below treats "unparsed" as "assume the request needs everything".
	check('malformed JSON is unparsed', !peekJsonRpc('{not json').parsed);
	check('a bare scalar is unparsed', !peekJsonRpc('42').parsed);
	check('an empty body is unparsed', !peekJsonRpc('').parsed);
	check('null is unparsed', !peekJsonRpc('null').parsed);

	// A response-shaped body names no method. It must not throw, and must not
	// invent one.
	const resp = peekJsonRpc(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }));
	check('a response names no method', resp.parsed && resp.methods.length === 0);
}

// ---------------------------------------------------------------------------
// needsBrainPreamble: the skip, in both directions
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// describeRequest: what the Worker logs about a refused or slow request
// ---------------------------------------------------------------------------
// The SDK's request schema is strict, so a client one protocol version ahead is
// answered 400 for a field the SDK has never seen, and the only way to learn WHICH
// field is a log line naming the message's shape. Names only: the body may carry a
// page's content or a token, and none of it may reach the log.
console.log('\ndescribeRequest');
{
	const secret = 'ghp_SECRETVALUE';
	const body = `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"x","arguments":{"t":"${secret}"}},"novel":"${secret}"}`;
	const peek = peekJsonRpc(body);
	check(
		"the peek records each message's top-level key names, sorted",
		JSON.stringify(peek.shapes) ===
			JSON.stringify([['id', 'jsonrpc', 'method', 'novel', 'params']]),
		JSON.stringify(peek.shapes)
	);
	const line = describeRequest(peek, {
		status: 400,
		ms: 1424.6,
		error: 'Parse error: Invalid JSON-RPC message'
	});
	check(
		'the line names the method, status, timing and shape',
		line ===
			'mcp 400 1425ms tools/call [id+jsonrpc+method+novel+params] Parse error: Invalid JSON-RPC message',
		line
	);
	check('and carries no value from the body', !line.includes(secret));
	check(
		'an unparsed body says so rather than crashing the log',
		describeRequest(peekJsonRpc('not json'), { status: 400, ms: 1 }) === 'mcp 400 1ms (unparsed) []'
	);
	check(
		'a batch lists every shape',
		peekJsonRpc(
			'[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","method":"notifications/b"}]'
		).shapes.length === 2
	);
}

console.log('\nneedsBrainPreamble');
{
	const needs = (body: string) => needsBrainPreamble(peekJsonRpc(body));

	check('initialize skips it', !needs(req('initialize')));
	check('ping skips it', !needs(req('ping')));
	check('notifications/initialized skips it', !needs(note('notifications/initialized')));
	check(
		'a batch of only skippable methods skips it',
		!needs(`[${req('initialize')},${note('notifications/x')}]`)
	);

	// The other direction is the one that would silently break a feature rather
	// than slow one down: a brain's own tools/ pages are part of the list.
	check('tools/list NEEDS it', needs(req('tools/list')));
	check('tools/call NEEDS it', needs(req('tools/call')));
	check('resources/read NEEDS it', needs(req('resources/read')));
	check('prompts/list NEEDS it', needs(req('prompts/list')));

	// Conservative on both unknowns.
	check('an unrecognised method NEEDS it', needs(req('tools/something-new')));
	check('an unparsed body NEEDS it', needs('{not json'));
	check(
		'a batch mixing skippable and not NEEDS it',
		needs(`[${req('initialize')},${req('tools/list', 2)}]`)
	);
}

// ---------------------------------------------------------------------------
// jsonRpcError: the reply a preamble failure makes instead of nothing
// ---------------------------------------------------------------------------
console.log('\njsonRpcError');
{
	const parsed = JSON.parse(jsonRpcError(5, 'boom', 'a31bdcabeceabd1f'));
	check('is a JSON-RPC 2.0 envelope', parsed.jsonrpc === '2.0');
	check('answers the request it failed', parsed.id === 5);
	check('reports an internal error', parsed.error.code === -32603);
	check('carries the message', parsed.error.message === 'boom');
	// The ray id is the entire point: the report that opened issue #50 listed four
	// of them and there was no way to join them to anything we had logged.
	check('carries the ray id', parsed.error.data.ray === 'a31bdcabeceabd1f');

	const noRay = JSON.parse(jsonRpcError(null, 'boom'));
	check('omits data when there is no ray', noRay.error.data === undefined);
	check('a null id stays null', noRay.id === null);
}

// ---------------------------------------------------------------------------
// The retry guidance on the write tools
// ---------------------------------------------------------------------------
console.log('\nwrite-tool retry guidance');
{
	const configs = new Map<string, { description?: string }>();
	const server = {
		registerTool: (name: string, cfg: { description?: string }) => configs.set(name, cfg)
	} as unknown as McpServer;
	// Registration stores handlers; it never resolves a context, so this getContext
	// exists only to satisfy the signature.
	const getContext = (_opts?: TenantOpts): Promise<BrainContext> => {
		throw new Error('registration must not resolve a context');
	};
	registerLibrarianTools(server, getContext);

	for (const name of ['write_page', 'move_page', 'delete_page']) {
		const description = configs.get(name)?.description ?? '';
		check(`${name} is registered with a description`, description.length > 0);
		// A 502 is not a timeout, and the guidance that mattered was filed under
		// the word that did not cover it.
		check(
			`${name} names the failure CLASS, not just a timeout`,
			description.includes('FAILS WITHOUT A RESULT'),
			description.slice(-160)
		);
		check(`${name} names a gateway error explicitly`, description.includes('gateway error'));
		check(
			`${name} no longer says only "TIMES OUT"`,
			!description.includes('TIMES OUT'),
			description.slice(-160)
		);
		check(
			`${name} still tells the caller to verify before retrying`,
			/before retrying/.test(description)
		);
	}
}

done();
