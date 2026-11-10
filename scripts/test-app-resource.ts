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
//   pnpm test:app-resource

import { Client } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { registerBrainApp, BRAIN_APP_URI, GLOBAL_ENTRY_POINT } from '../src/tools/apps.ts';
import {
	VIEW_TOOLS,
	parseViewToolCall,
	blockedReason,
	viewResult,
	type OpenViewSnapshot
} from '../src/lib/view-tools.ts';

import { checker } from './check.ts';

const { check, done } = checker('app-resource checks');

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
	const res = await client.readResource({ uri: stale });
	const item = res.contents[0];
	check('a stale hash still resolves, serving the current bytes', bodyText(item).length > 0);
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

	// The global entry point lists the app where people open it without asking the
	// model. A host lists one app per marked tool, so exactly one tool carries it, and
	// it opens with `{}`: a required input would list an app nobody can open.
	const [entryKey] = Object.keys(GLOBAL_ENTRY_POINT);
	const marked = tools.filter(
		(t) =>
			JSON.stringify((t._meta as Record<string, unknown> | undefined)?.[entryKey]) ===
			JSON.stringify(GLOBAL_ENTRY_POINT[entryKey as keyof typeof GLOBAL_ENTRY_POINT])
	);
	check(
		'exactly one tool is a global entry point, and it is browse_brain',
		marked.length === 1 && marked[0].name === 'browse_brain',
		marked.map((t) => t.name).join(', ')
	);
	const entry = marked[0];
	check(
		'...it opens with {} (no required input)',
		!!entry && (entry.inputSchema.required ?? []).length === 0,
		JSON.stringify(entry?.inputSchema.required)
	);
	check(
		'...and is visible to the model (a host lists only model-callable entry points)',
		!!entry &&
			(uiMeta(entry).visibility === undefined ||
				(uiMeta(entry).visibility as string[]).includes('model'))
	);
	check(
		'...and has a title the host can display, 60 characters or fewer',
		!!entry?.title && entry.title.length <= 60,
		entry?.title
	);
}

await client.close();

// THE VIEW'S APP TOOLS (src/lib/view-tools.ts). A host refuses a whole view's tools
// over one bad definition, and saves "Always allow" against a definition, so the
// limits and the guard are pinned here; the browser half is tests/ui/view-tools.spec.ts.
console.log('\nview tools: the contract a host lists from the open view');
{
	const names = VIEW_TOOLS.map((t) => t.name);
	check('names are unique', new Set(names).size === names.length, names.join(', '));
	check(
		'names fit the host limit (letters, digits, . _ -; 128 chars)',
		names.every((n) => /^[A-Za-z0-9._-]{1,128}$/.test(n))
	);
	check(
		'every input schema is an object at the root',
		VIEW_TOOLS.every((t) => t.inputSchema.type === 'object')
	);
	check(
		'every first description line stands alone within 200 characters',
		VIEW_TOOLS.every((t) => {
			const first = (t.description ?? '').split('\n')[0];
			return first.length > 0 && first.length <= 200;
		}),
		VIEW_TOOLS.map((t) => (t.description ?? '').split('\n')[0].length).join(', ')
	);
	check(
		'every tool has a title for the approval prompt',
		VIEW_TOOLS.every((t) => !!t.title)
	);

	const p = parseViewToolCall('show_page', { path: ' ./wiki/a.md ' });
	check(
		'show_page normalizes a leading ./ or / and whitespace',
		p.ok && p.call.tool === 'show_page' && p.call.path === 'wiki/a.md',
		JSON.stringify(p)
	);
	check('show_page without a path is refused', !parseViewToolCall('show_page', {}).ok);
	check(
		'show_page with a non-string path is refused',
		!parseViewToolCall('show_page', { path: 3 }).ok
	);
	check('an unknown tool is refused', !parseViewToolCall('write_page', {}).ok);
	check('missing arguments read as {}', parseViewToolCall('get_open_view', undefined).ok);

	const dirty: OpenViewSnapshot = {
		brain: null,
		screen: 'the editor',
		isError: false,
		path: 'wiki/a.md',
		unsavedEdits: true
	};
	const show = { tool: 'show_page', path: 'wiki/b.md' } as const;
	check('a move away from unsaved edits is refused', blockedReason(show, dirty) !== null);
	check('...but reading the view is not', blockedReason({ tool: 'get_open_view' }, dirty) === null);
	check(
		'a saved editor can be moved',
		blockedReason(show, { ...dirty, unsavedEdits: false }) === null
	);

	const page: OpenViewSnapshot = {
		brain: { id: 'b-1', label: 'Acme' },
		screen: 'a page',
		isError: false,
		path: 'wiki/a.md',
		unsavedEdits: false
	};
	const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
	const d = textOf(viewResult(page));
	check('the description names the brain handle', d.includes('brain: "b-1"'), d);
	check('...and the path', d.includes('Path: wiki/a.md'), d);
	check(
		'a reload that moved the page says so',
		textOf(viewResult(page, 'updated')).includes('changed and')
	);
	check(
		'a reload that did not says that',
		textOf(viewResult(page, 'current')).includes('had not changed')
	);
	check(
		'a reload with no verdict claims nothing',
		!/changed/.test(textOf(viewResult(page, 'unknown')))
	);
	const err = viewResult({
		...page,
		screen: 'an error',
		isError: true,
		error: { headline: "Couldn't load" }
	});
	check(
		'landing on the error screen is an error result',
		!!err.isError && textOf(err).includes("Couldn't load")
	);
}

done();
