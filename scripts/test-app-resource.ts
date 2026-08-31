// Golden test for the ui:// app resource's HOST contract. Offline, no network:
// a real McpServer talking to a real Client over an in-memory transport, so the
// assertions are on what a host actually receives rather than on a stub.
//
// WHAT DECIDES THE APP'S CHROME IS METADATA, and metadata is invisible to
// typecheck once it is a Record<string, unknown> on the way out. Two facts ride
// this resource and both fail silently when dropped:
//
//   prefersBorder: whether the HOST draws a card around the app. Unspecified,
//   the default is per-platform: Claude renders borderless on web and BORDERED on
//   mobile, and the app draws its own bordered card inline, so the unspecified
//   default put a border inside a border on phones and nowhere else. Nothing
//   errors; it just looks wrong on the platform least likely to be open while
//   the code is written.
//
//   resourceUri: the link from a tool to the app. A tool pointing at a URI the
//   server does not serve renders as "problem displaying content", which reads as
//   a host bug rather than as a typo.
//
// The versioned template is asserted separately from the concrete resource. It is
// the path a session takes AFTER a deploy changed the bundle hash, so it is the
// registration nobody looks at while working, and it carries the same contract.
//
//   pnpm test:appmeta

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBrainApp, BRAIN_APP_URI } from '../src/tools/apps.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

// A resource content item is text OR blob; the app bundle is always text.
function bodyText(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	return typeof text === 'string' ? text : '';
}

// The UI half of a resource's or tool's _meta, whatever shape it arrived in.
function uiMeta(x: unknown): Record<string, unknown> {
	const meta = (x as { _meta?: { ui?: Record<string, unknown> } } | undefined)?._meta;
	return meta?.ui ?? {};
}

const server = new McpServer({ name: 'app-resource-probe', version: '0' });
// Registration never calls getContext; only a tool handler would, and none run here.
registerBrainApp(server, (() => {
	throw new Error('the resource contract must not need a brain');
}) as never);

const client = new Client({ name: 'app-resource-probe', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct), server.connect(st)]);

console.log('\nresources/list: what a host reviews at connection time');
{
	const { resources } = await client.listResources();
	const entry = resources.find((r) => r.uri === BRAIN_APP_URI);
	check(
		'the app bundle is advertised at BRAIN_APP_URI',
		!!entry,
		`saw ${resources.length} resource(s)`
	);
	check(
		'it declares the MCP App mime type',
		entry?.mimeType === 'text/html;profile=mcp-app',
		String(entry?.mimeType)
	);
	// Explicitly false, not merely present: the app draws its own inline border, so
	// the host must not draw a second one. Flipping this to true is a real design
	// change and has to move app/main.tsx's border in the same commit.
	check(
		'...and asks the host NOT to draw its own card',
		uiMeta(entry).prefersBorder === false,
		String(uiMeta(entry).prefersBorder)
	);
	// The versioned catch-all is deliberately unlisted, so only the concrete URI is
	// discoverable and the hash-based cache bust keeps working.
	check(
		'the versioned catch-all stays out of the listing',
		resources.length === 1,
		`${resources.length} listed`
	);
}

console.log('\nresources/read: what the host renders from');
{
	const res = await client.readResource({ uri: BRAIN_APP_URI });
	const item = res.contents[0];
	check('the read serves the bundle at the URI asked for', item?.uri === BRAIN_APP_URI);
	check('the app HTML comes back', bodyText(item).length > 0);
	// The content item wins over the listing entry when both carry _meta.ui, so this
	// is the one a host reads at render time.
	check(
		'...carrying prefersBorder on the CONTENT ITEM',
		uiMeta(item).prefersBorder === false,
		String(uiMeta(item).prefersBorder)
	);
}

console.log('\nthe post-deploy path: a hash this build never minted');
{
	const stale = 'ui://isomorphic-mind/brain-app.staleHash0.html';
	check('the stale hash differs from the current one', stale !== BRAIN_APP_URI);
	const res = await client.readResource({ uri: stale });
	const item = res.contents[0];
	check('...it still resolves, serving the current bytes', bodyText(item).length > 0);
	check('...at the URI the host asked for', item?.uri === stale);
	check(
		'...with the same border preference',
		uiMeta(item).prefersBorder === false,
		String(uiMeta(item).prefersBorder)
	);
}

console.log('\ntools/list: every widget tool points at a resource that exists');
{
	const { tools } = await client.listTools();
	check('registerBrainApp registered its tools', tools.length > 0, `${tools.length} tools`);
	const wrong = tools.filter((t) => uiMeta(t).resourceUri !== BRAIN_APP_URI);
	check(
		'...and all of them link to BRAIN_APP_URI',
		wrong.length === 0,
		wrong.map((t) => `${t.name}→${String(uiMeta(t).resourceUri)}`).join(', ')
	);
	// registerAppTool mirrors the nested key onto the deprecated flat one for older
	// hosts. Dropping that mirror costs nothing at typecheck and un-mounts the app
	// on any host still reading it.
	const unmirrored = tools.filter(
		(t) => (t._meta as Record<string, unknown> | undefined)?.['ui/resourceUri'] !== BRAIN_APP_URI
	);
	check(
		'...and carry the legacy flat key for older hosts',
		unmirrored.length === 0,
		unmirrored.map((t) => t.name).join(', ')
	);
}

await client.close();

console.log(
	failures === 0 ? '\nAll app-resource checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
