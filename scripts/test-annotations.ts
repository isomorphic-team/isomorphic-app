// Golden test for tool ANNOTATIONS: what a host and the connector directory read
// off each tool before anything runs.
//
// Anthropic's directory rejects a tool that lacks `annotations.title`, or that
// lacks the hint that applies to it (`readOnlyHint: true` for a read,
// `destructiveHint` for a write). Claude uses the same hints to decide what may
// run without asking. Both are metadata, so nothing about a missing one fails at
// typecheck or at runtime: the tool works, and the listing is refused.
//
// Two halves:
//   • Every tool the suites register is listed through a real client over an
//     in-memory transport, so the assertion is on what actually reaches the wire
//     (the spread in `toolAnnotations` surviving `registerAppTool` and the SDK's
//     own shaping), not on the source.
//   • A scan of every registration site, so a tool registered somewhere this test
//     does not call still has to go through `toolAnnotations`. Three suites are
//     scan-only: whoami is inline in worker.ts, and connected-accounts.ts and
//     feedback.ts type their env with Workers ambients (KVNamespace, D1Database)
//     that the Node test tsconfig deliberately does not load.
//
//   pnpm test:annotations

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';

import { annotationProblems, toolAnnotations } from '../src/lib/tool-annotations.ts';
import { planCustomTools } from '../src/lib/custom-tools.ts';
import { registerAnalyticsTools } from '../src/tools/analytics.ts';
import { registerBrainApp } from '../src/tools/apps.ts';
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

const { check, done } = checker('annotation checks');

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
	await client.close();
}

console.log('\nregistration sites: nothing registers around the helper');
{
	// Same two shapes the usage test scans for. A registration this test did not
	// call above (see the header for which, and why) is held to the helper here.
	const dir = fileURLToPath(new URL('../src/tools/', import.meta.url));
	const files = [
		...readdirSync(dir)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => dir + f),
		fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
		fileURLToPath(new URL('../src/local.ts', import.meta.url))
	];
	const scanned = new Set<string>();
	const bare: string[] = [];
	// The tool's name, then everything between its config's `{` and its description.
	const call = /(?:registerAppTool\(\s*server,|server\.registerTool\()\s*/.source;
	const site = new RegExp(call + /'([a-z_]+)',\s*\{([\s\S]*?)description:/.source, 'g');
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
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
}

done();
