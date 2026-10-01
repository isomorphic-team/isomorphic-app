// pnpm test:annotations
//
// Tool ANNOTATIONS: what a host and the connector directory read off each tool
// before anything runs. Anthropic's directory rejects a tool without
// `annotations.title` or without the hint that applies to it, and Claude uses the
// same hints to decide what runs without asking. Both are metadata, so a missing
// one fails nowhere else: the tool works, and the listing is refused.
//
// This battery exists to catch:
//   1. A tool listed without `annotations.title`, with one that differs from its
//      `title`, or a write with no explicit `destructiveHint`. Checked on what a
//      real client receives over an in-memory transport, so the spread in
//      `toolAnnotations` has to survive `registerAppTool` and the SDK's shaping.
//   2. A registration site that sets a bare `title:` instead of spreading
//      `toolAnnotations`, including sites this script cannot call. Five tools are
//      scan-only: whoami is inline in worker.ts, and connected-accounts.ts and
//      feedback.ts type their env with Workers ambients (KVNamespace, D1Database)
//      that the Node test tsconfig does not load.
//   3. A new suite joining the scan-only set silently instead of being registered
//      here.
//   4. A change to the hint on the tools where it was a judgement call.
//   5. A widget tool (every `registerAppTool` site, in every suite) without
//      `_meta.ui.resourceUri` naming the served app, or a plain tool carrying one.
//      Without it a host renders nothing; with one on a plain tool, every call
//      renders a widget.
//   6. Other tool-surface fields a host reads: no `execution` field in tools/list
//      (claude.ai web refuses the whole connector over it), and the retry guidance
//      on the three write tools, which must name the failure class ("FAILS WITHOUT
//      A RESULT", a gateway error) rather than only a timeout, because a caller
//      does not apply "times out" guidance to a 502.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';

import { annotationProblems, toolAnnotations } from '../src/lib/tool-annotations.ts';
import { planCustomTools } from '../src/lib/custom-tools.ts';
import { registerAnalyticsTools } from '../src/tools/analytics.ts';
import { registerBrainApp, BRAIN_APP_URI } from '../src/tools/apps.ts';
import { registerBrainAccessTools } from '../src/tools/brain-access.ts';
import { registerBrainTools } from '../src/tools/brains.ts';
import { registerCoreTools } from '../src/tools/core.ts';
import { registerCustomTools } from '../src/tools/custom.ts';
import { registerImportTools } from '../src/tools/importer.ts';
import { registerLibrarianTools } from '../src/tools/librarian.ts';
import { registerMediaTools } from '../src/tools/media.ts';
import { registerMemberTools } from '../src/tools/members.ts';
import { registerOrgOnboardingTools } from '../src/tools/org-onboarding.ts';

import { checker } from './check.ts';
import { registeredWidgetToolNames } from './doc-refs.ts';

const { check, done } = checker('annotation checks');

// Every registration site: src/tools/, plus the tools registered inline in the two
// runtimes.
const toolsDir = fileURLToPath(new URL('../src/tools/', import.meta.url));
const SOURCES = [
	...readdirSync(toolsDir)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => toolsDir + f),
	fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
	fileURLToPath(new URL('../src/local.ts', import.meta.url))
].map((file) => ({ file, src: readFileSync(file, 'utf8') }));
const WIDGET_TOOLS = new Set(SOURCES.flatMap(({ src }) => registeredWidgetToolNames(src)));

// The `ui` half of a tool's `_meta`, or {} when it has none.
function uiMeta(tool: unknown): Record<string, unknown> {
	return (tool as { _meta?: { ui?: Record<string, unknown> } })._meta?.ui ?? {};
}

console.log('\nthe rule itself');
{
	const read = toolAnnotations('Read a thing', 'read');
	check('a read carries its title in annotations', read.annotations.title === 'Read a thing');
	check('...and the top-level title is the same string', read.title === read.annotations.title);
	check('...and is readOnly', read.annotations.readOnlyHint === true);
	check('...and passes', annotationProblems(read).length === 0);

	const write = toolAnnotations('Delete a thing', 'destructive');
	check(
		'a destructive tool says so explicitly',
		write.annotations.readOnlyHint === false && write.annotations.destructiveHint === true
	);
	const add = toolAnnotations('Create a thing', 'additive');
	check(
		'an additive one is a write that declares itself non-destructive',
		add.annotations.readOnlyHint === false && add.annotations.destructiveHint === false
	);
	check('both pass', annotationProblems(write).length + annotationProblems(add).length === 0);

	// The shape this repo had before: a top-level title and a bare readOnlyHint.
	const before = annotationProblems({ title: 'X', annotations: { readOnlyHint: true } });
	check('a title with no annotations.title is refused', before.includes('no annotations.title'));
	// And the shape every write tool had: a title and no hint at all.
	const unhinted = annotationProblems({ title: 'X', annotations: { title: 'X' } });
	check('a write with no hint is refused', unhinted.length === 1, unhinted.join(', '));
	const drift = { title: 'X', annotations: { title: 'Y', readOnlyHint: true } };
	const drifted = annotationProblems(drift);
	check('titles that disagree are refused', drifted.length === 1, drifted.join(', '));
}

console.log('\ntools/list: every registered tool, as a host receives it');
const listed = new Set<string>();
{
	// Registration never resolves a context; only a handler would, and none runs.
	const nope = (() => {
		throw new Error('registration must not need a context');
	}) as never;
	const server = new McpServer({ name: 'annotations-probe', version: '0' });
	registerCoreTools(server, nope);
	registerLibrarianTools(server, nope);
	registerImportTools(server, nope);
	registerMediaTools(server, nope);
	registerBrainApp(server, nope, { webBaseUrl: 'https://brain.example' });
	registerAnalyticsTools(server, nope);
	registerMemberTools(server, nope);
	registerBrainAccessTools(server, nope, { webBaseUrl: 'https://brain.example' });
	registerOrgOnboardingTools(server, nope, nope, {} as never);
	registerBrainTools(server, {
		multiUser: true,
		getContext: nope,
		orgContext: nope,
		listOrgs: nope,
		listBrains: nope,
		activeBrainId: () => undefined,
		setActiveBrain: nope,
		invalidateConfig: () => {},
		analyticsEnabled: true,
		db: {} as never,
		webBaseUrl: 'https://brain.example'
	});
	// A brain-authored tool: its title comes from the page, at runtime.
	const { defs } = planCustomTools([
		{
			path: 'wiki/tools/standup-digest.md',
			content: '---\ndescription: Summarize this week.\n---\nSummarize the week.'
		}
	]);
	registerCustomTools(server, nope, defs);

	const client = new Client({ name: 'annotations-probe', version: '0' });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([client.connect(ct), server.connect(st)]);
	const { tools } = await client.listTools();

	check('found the tool surface', tools.length > 30, `listed ${tools.length}`);
	const custom = tools.filter((t) => t.name.startsWith('tool_'));
	check('a brain-authored tool is among them', custom.length === 1, `${custom.length}`);
	const bad: string[] = [];
	for (const t of tools) {
		listed.add(t.name);
		const problems = annotationProblems(t as never);
		if (problems.length) bad.push(`${t.name}: ${problems.join(', ')}`);
	}
	check('every tool carries a title and its hint', bad.length === 0, bad.join('; '));
	const writes = custom.filter((t) => t.annotations?.readOnlyHint !== true);
	check('no brain-authored tool is advertised as a write', writes.length === 0);
	// The ones whose hint was a judgement call, pinned so a change is deliberate.
	const hint = (n: string) => tools.find((t) => t.name === n)?.annotations;
	for (const n of ['write_page', 'move_page', 'delete_page', 'share_brain', 'remove_member']) {
		check(`${n} is destructive`, hint(n)?.destructiveHint === true);
	}
	for (const n of ['read_page', 'search_pages', 'view_page', 'brains']) {
		check(`${n} is read-only`, hint(n)?.readOnlyHint === true);
	}

	console.log('\ntools/list: the widget link');
	const widgets = tools.filter((t) => WIDGET_TOOLS.has(t.name));
	for (const n of ['view_page', 'analytics', 'brain_access', 'members']) {
		check(
			`${n} is listed as a widget tool`,
			widgets.some((t) => t.name === n)
		);
	}
	const unlinked = widgets.filter((t) => uiMeta(t).resourceUri !== BRAIN_APP_URI);
	check(
		`every widget tool (${widgets.length} listed) links to BRAIN_APP_URI`,
		widgets.length > 8 && unlinked.length === 0,
		unlinked.map((t) => `${t.name}→${String(uiMeta(t).resourceUri)}`).join(', ')
	);
	// A brain-authored `tool_` page may declare itself a widget, so only first-party
	// tools are held to this.
	const linkedPlain = tools.filter(
		(t) =>
			!WIDGET_TOOLS.has(t.name) &&
			!t.name.startsWith('tool_') &&
			uiMeta(t).resourceUri !== undefined
	);
	check(
		'no plain first-party tool carries a resourceUri',
		linkedPlain.length === 0,
		linkedPlain.map((t) => t.name).join(', ')
	);

	console.log('\ntools/list: the other fields a host reads');
	check(
		'tools/list carries no `execution` field',
		tools.every((t) => !('execution' in t) || t.execution === undefined),
		JSON.stringify(tools.map((t) => t.execution))
	);
	for (const name of ['write_page', 'move_page', 'delete_page']) {
		const description = tools.find((t) => t.name === name)?.description ?? '';
		check(
			`${name} names the failure class, not just a timeout`,
			description.includes('FAILS WITHOUT A RESULT'),
			description.slice(-160)
		);
		check(`${name} names a gateway error explicitly`, description.includes('gateway error'));
		check(
			`${name} tells the caller to verify before retrying`,
			/before retrying/.test(description)
		);
	}
	await client.close();
}

console.log('\nregistration sites: nothing registers around the helper');
{
	// Same two shapes the usage test scans for. A registration this test did not
	// call above (see the header for which, and why) is held to the helper here.
	const scanned = new Set<string>();
	const bare: string[] = [];
	// The tool's name, then everything between its config's `{` and its description.
	const call = /(?:registerAppTool\(\s*server,|server\.registerTool\()\s*/.source;
	const site = new RegExp(call + /'([a-z_]+)',\s*\{([\s\S]*?)description:/.source, 'g');
	for (const { src } of SOURCES) {
		for (const m of src.matchAll(site)) {
			scanned.add(m[1]);
			if (!m[2].includes('...toolAnnotations(')) bare.push(m[1]);
		}
	}
	check('found the registration sites', scanned.size > 30, `found ${scanned.size}`);
	const spreads = 'every site spreads toolAnnotations before its description';
	check(spreads, bare.length === 0, bare.join(', '));
	const unlisted = [...scanned].filter((n) => !listed.has(n)).sort();
	// Pinned, so a NEW suite has to be registered above rather than quietly joining
	// the scan-only set.
	const SCAN_ONLY = ['connected_accounts', 'link_identity', 'submit_feedback', 'unlink_identity'];
	const expected = [...SCAN_ONLY, 'whoami'].sort().join(', ');
	check(
		'the only tools not listed above are the scan-only suites',
		unlisted.join(', ') === expected,
		`not listed: ${unlisted.join(', ') || 'none'}; register its suite above`
	);

	// A scan-only widget tool is held to the widget link at its registration site:
	// the config between its name and its handler names BRAIN_APP_URI.
	const scanOnlyWidgets = unlisted.filter((n) => WIDGET_TOOLS.has(n));
	check(
		'connected_accounts is a scan-only widget tool',
		scanOnlyWidgets.includes('connected_accounts'),
		scanOnlyWidgets.join(', ')
	);
	const link = /_meta:\s*\{\s*ui:\s*\{\s*resourceUri:\s*BRAIN_APP_URI\s*\}\s*\}/;
	const unlinkedSites = scanOnlyWidgets.filter((n) => {
		const at = new RegExp(
			`registerAppTool\\(\\s*server,\\s*'${n}',\\s*\\{([\\s\\S]*?)\\n\\t*\\},\\s*async`
		);
		const config = SOURCES.map(({ src }) => at.exec(src)?.[1]).find((c) => c !== undefined);
		return !config || !link.test(config);
	});
	check(
		'every scan-only widget tool links to BRAIN_APP_URI at its site',
		unlinkedSites.length === 0,
		unlinkedSites.join(', ')
	);
}

done();
