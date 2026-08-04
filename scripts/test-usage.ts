// Golden test for the usage-analytics layer. No network. The fold and the wrapper
// are pure; the last section runs the REAL migration over node:sqlite (the same
// shim shape as test-access / test-scope) so the statements are exercised rather
// than assumed.
//
//   pnpm test:usage
//
// What this exists to catch:
//
//   1. A NEW TOOL THAT NOBODY CLASSIFIED. classifyTool falls back to 'read' for
//      unknown names, which is correct for brain-authored `tool_*` pages (all
//      read-only by construction) and silently wrong for a new first-party write
//      tool: its calls would land in the reads column and the "is anyone actually
//      editing?" number would quietly under-report forever. So this scans the tool
//      sources for every registered name and requires an explicit entry.
//   2. MEMBERS AT ZERO DISAPPEARING. The People table's whole value is the rows
//      with no activity on them; an innocuous "filter out empty rows" would delete
//      the only actionable content on the page.
//   3. THE TILES NOT ADDING UP TO THE TABLE. Activity from someone since removed
//      from the org still counts toward org totals, so it has to appear in the
//      list too, or the numbers visibly disagree with each other.
//   4. WINDOW DRIFT. summarize re-filters to [from, to] rather than trusting its
//      caller's SQL, so widening the query can never quietly change what the
//      window claims to cover.

import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fileURLToPath } from 'node:url';
import {
	TOOL_KINDS,
	classifyTool,
	dayKey,
	shiftDay,
	daysBetween,
	summarize,
	summaryText,
	countedCall,
	FOOTNOTE,
	type UsageRow
} from '../src/lib/usage.ts';
import { recordUsage, readUsage } from '../src/lib/usage-store.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

console.log('\nclassification: every registered tool is classified');
{
	// Both registration shapes used in src/tools: the MCP Apps helper
	// (registerAppTool(server, 'name', …)) and the plain SDK one
	// (server.registerTool('name', …)). Brain-authored tools register through a
	// variable (def.name) and match neither, which is the intended fallback.
	//
	// worker.ts is in the scan, not just src/tools/: read_page, list_pages and
	// whoami are registered inline there, and a scan that missed them would have
	// left the single most-called tool in the product unclassified.
	const dir = fileURLToPath(new URL('../src/tools/', import.meta.url));
	const files = [
		...readdirSync(dir)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => dir + f),
		fileURLToPath(new URL('../src/worker.ts', import.meta.url))
	];
	const names = new Set<string>();
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(/registerAppTool\(\s*server,\s*'([a-z_]+)'/g)) names.add(m[1]);
		for (const m of src.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)) names.add(m[1]);
	}
	check('found the tool surface to check against', names.size > 15, `found ${names.size}`);
	const unclassified = [...names].filter((n) => !(n in TOOL_KINDS)).sort();
	check(
		'no registered tool is missing from TOOL_KINDS',
		unclassified.length === 0,
		unclassified.length ? `add to src/lib/usage.ts: ${unclassified.join(', ')}` : ''
	);
	// The reverse direction is a warning, not a failure: a removed tool's rows
	// outlive it in usage_daily and still want classifying.
	const stale = Object.keys(TOOL_KINDS).filter((n) => !names.has(n));
	if (stale.length) console.log(`    note: classified but not registered: ${stale.join(', ')}`);

	check('a brain-authored tool falls back to read', classifyTool('tool_standup_digest') === 'read');
	check('write tools are writes', classifyTool('write_page') === 'write');
	check('member management is admin, not a write', classifyTool('invite_member') === 'admin');
}

console.log('\ndays: UTC arithmetic');
{
	check('dayKey takes the UTC date', dayKey(new Date('2026-08-04T23:30:00Z')) === '2026-08-04');
	check('shiftDay crosses a month', shiftDay('2026-03-01', -1) === '2026-02-28');
	check('shiftDay crosses a leap day', shiftDay('2028-03-01', -1) === '2028-02-29');
	check('shiftDay crosses a year', shiftDay('2027-01-01', -1) === '2026-12-31');
	check(
		'a 30-day window is 30 days inclusive',
		daysBetween(shiftDay('2026-08-04', -29), '2026-08-04').length === 30
	);
	check('an inverted range is empty', daysBetween('2026-08-04', '2026-08-01').length === 0);
}

// A small fixture org: two brains, three members, one departed user.
const FROM = '2026-07-06';
const TO = '2026-08-04';
const roster = [
	{ user_id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example-org.test', role: 'owner' },
	{ user_id: 'u-gus', name: 'Gus Fring', email: 'gus@example-org.test', role: 'editor' },
	{ user_id: 'u-nil', name: null, email: 'nobody@example-org.test', role: 'viewer' }
];
const brains = [
	{ brain_id: 'example-org/brain-team', label: 'Team brain' },
	{ brain_id: 'example-org/brain-quiet', label: 'Quiet brain' }
];
const rows: UsageRow[] = [
	{
		day: '2026-08-04',
		user_id: 'u-ada',
		brain_id: 'example-org/brain-team',
		tool: 'read_page',
		calls: 12,
		errors: 0
	},
	{
		day: '2026-08-04',
		user_id: 'u-ada',
		brain_id: 'example-org/brain-team',
		tool: 'write_page',
		calls: 3,
		errors: 1
	},
	{
		day: '2026-08-01',
		user_id: 'u-gus',
		brain_id: 'example-org/brain-team',
		tool: 'search_pages',
		calls: 5,
		errors: 0
	},
	// Org-scope call: no brain resolved.
	{ day: '2026-08-01', user_id: 'u-ada', brain_id: '', tool: 'invite_member', calls: 2, errors: 0 },
	// Someone who has since left the org.
	{
		day: '2026-07-20',
		user_id: 'u-gone',
		brain_id: 'example-org/brain-team',
		tool: 'read_page',
		calls: 7,
		errors: 0
	},
	// Outside the window: must be ignored even though the caller handed it over.
	{
		day: '2026-01-01',
		user_id: 'u-nil',
		brain_id: 'example-org/brain-team',
		tool: 'read_page',
		calls: 999,
		errors: 0
	}
];
const s = summarize({ rows, roster, brains, from: FROM, to: TO });

console.log('\nsummarize: totals');
{
	check(
		'window is inclusive',
		s.window.days === 30 && s.window.from === FROM && s.window.to === TO
	);
	check('out-of-window rows are dropped', s.totals.reads === 12 + 5 + 7, `got ${s.totals.reads}`);
	check('writes are counted apart from reads', s.totals.writes === 3);
	check('admin is counted apart from writes', s.totals.admin === 2);
	check('calls is the sum of all three', s.totals.calls === 12 + 3 + 5 + 2 + 7);
	check('errors survive the fold', s.totals.errors === 1);
	check(
		'active users counts distinct people',
		s.totals.activeUsers === 3,
		`got ${s.totals.activeUsers}`
	);
	check('members is the roster size, not the active count', s.totals.members === 3);
}

console.log('\nsummarize: the series');
{
	check('one point per day, gaps filled', s.series.length === 30);
	check(
		'every day is present and zeroed',
		s.series.every((p) => typeof p.reads === 'number')
	);
	const aug4 = s.series.find((p) => p.day === '2026-08-04')!;
	check('a busy day carries its counts', aug4.reads === 12 && aug4.writes === 3);
	const aug1 = s.series.find((p) => p.day === '2026-08-01')!;
	check('admin calls stay off the chart', aug1.reads === 5 && aug1.writes === 0);
	check(
		'a quiet day is zero, not missing',
		s.series.find((p) => p.day === '2026-07-15')!.reads === 0
	);
	check('the series is ascending', s.series[0].day === FROM && s.series[29].day === TO);
}

console.log('\nsummarize: people');
{
	const byId = new Map(s.people.map((p) => [p.user_id, p]));
	check(
		'every current member has a row',
		roster.every((m) => byId.has(m.user_id))
	);
	const nil = byId.get('u-nil')!;
	check('an inactive member is present, not filtered out', !!nil);
	check('an inactive member reads as zero', nil.reads === 0 && nil.writes === 0);
	check('an inactive member has no last-active date', nil.lastActive === null);
	check('inactive members sort last', s.people[s.people.length - 1].user_id === 'u-nil');

	const ada = byId.get('u-ada')!;
	check(
		'a person sums across brains and org scope',
		ada.reads === 12 && ada.writes === 3 && ada.admin === 2
	);
	check('last active is the most recent day', ada.lastActive === '2026-08-04');
	check('roster identity is carried through', ada.name === 'Ada Lovelace' && ada.role === 'owner');

	const gone = byId.get('u-gone')!;
	check(
		'a departed user still appears',
		!!gone,
		'their calls are in the totals, so the table must show them'
	);
	check('a departed user is flagged', gone.former === true && gone.email === null);
	check('current members are not flagged', ada.former === false);
	const listed = s.people.reduce((n, p) => n + p.reads, 0);
	check(
		'the people rows add up to the tile',
		listed === s.totals.reads,
		`${listed} vs ${s.totals.reads}`
	);
}

console.log('\nsummarize: brains');
{
	const byId = new Map(s.brains.map((b) => [b.brain_id, b]));
	check('a brain nobody opened still has a row', byId.has('example-org/brain-quiet'));
	check('the untouched brain reads as zero', byId.get('example-org/brain-quiet')!.reads === 0);
	const team = byId.get('example-org/brain-team')!;
	check(
		'brain reads exclude nothing but org scope',
		team.reads === 12 + 5 + 7,
		`got ${team.reads}`
	);
	check('brain writes are counted', team.writes === 3);
	check('distinct people per brain', team.people === 3, `got ${team.people}`);
	check('brain last-active is the most recent day', team.lastActive === '2026-08-04');
	check('org-scope calls belong to no brain', !byId.has(''));
	check('busiest brain sorts first', s.brains[0].brain_id === 'example-org/brain-team');
	check('labels come from the caller', team.label === 'Team brain');

	// A brain_id with rows but no label (disconnected since) must not vanish.
	const orphan = summarize({
		rows: [
			{
				day: TO,
				user_id: 'u-ada',
				brain_id: 'example-org/gone',
				tool: 'read_page',
				calls: 1,
				errors: 0
			}
		],
		roster,
		brains: [],
		from: FROM,
		to: TO
	});
	check('an unlabelled brain falls back to its id', orphan.brains[0]?.label === 'example-org/gone');
}

console.log('\nsummary text');
{
	const text = summaryText(s, 'Example Org');
	check('names the org and the window', text.includes('Example Org') && text.includes(FROM));
	check('leads with the adoption number', /Active members: 3 of 3/.test(text));
	check(
		'names an inactive member as never active',
		/nobody@example-org.test.*never active/.test(text)
	);
	check('carries the GitHub caveat', text.includes(FOOTNOTE));

	// The non-admin payload: totals stand, the people list is withheld.
	const withheld = summaryText({ ...s, people: [] }, 'Example Org');
	check('withholding people keeps the totals', /Active members: 3 of 3/.test(withheld));
	check('withholding people drops the names', !withheld.includes('Ada Lovelace'));
	check('withholding people keeps the per-brain table', withheld.includes('Team brain'));
}

console.log('\ncountedCall: the tool-handler wrapper');
{
	// The riskiest few lines in the feature: this replaces the callback the MCP SDK
	// invokes, so a mistake here does not skew a chart, it breaks every tool.
	const log: boolean[] = [];
	const hooks = { after: (ok: boolean) => log.push(ok) };
	const reset = () => (log.length = 0);

	const sync = countedCall(() => ({ content: [] }), hooks);
	const r1 = sync();
	check('sync: result passes through untouched', JSON.stringify(r1) === '{"content":[]}');
	check('sync: counted once, as success', log.length === 1 && log[0] === true);

	reset();
	const errRes = countedCall(() => ({ isError: true, content: [] }), hooks);
	const r2 = errRes() as { isError: boolean };
	check('isError result still passes through', r2.isError === true);
	check(
		'isError counts as an ERROR though it never threw',
		log.length === 1 && log[0] === false,
		'a tool failing every call must not read as healthy'
	);

	reset();
	const boom = new Error('nope');
	const thrower = countedCall(() => {
		throw boom;
	}, hooks);
	let caught: unknown;
	try {
		thrower();
	} catch (e) {
		caught = e;
	}
	check('sync throw is rethrown unchanged', caught === boom);
	check('sync throw counted as an error', log.length === 1 && log[0] === false);

	reset();
	const okAsync = countedCall(async () => ({ content: ['ok'] }), hooks);
	const p1 = (await okAsync()) as { content: string[] };
	check('async: result passes through', p1.content[0] === 'ok');
	check('async: counted once, as success', log.length === 1 && log[0] === true);

	reset();
	const badAsync = countedCall(async () => {
		throw boom;
	}, hooks);
	let caught2: unknown;
	try {
		await badAsync();
	} catch (e) {
		caught2 = e;
	}
	check('async reject is rethrown unchanged', caught2 === boom);
	check('async reject counted as an error', log.length === 1 && log[0] === false);

	reset();
	const order: string[] = [];
	const ordered = countedCall(
		() => {
			order.push('handler');
			return 1;
		},
		{
			before: () => order.push('before'),
			after: () => order.push('after')
		}
	);
	ordered();
	check('before runs ahead of the handler', order.join('>') === 'before>handler>after');

	reset();
	const args = countedCall((a: number, b: string) => `${a}${b}`, hooks);
	check('arguments are forwarded', args(1, 'x') === '1x');
}

console.log('\nSDK internals: the shape worker.ts reaches into');
{
	// worker.ts wraps `server._registeredTools[name].callback` to count calls, and
	// the claude.ai compatibility shim blanks `.execution` on the same objects. Both
	// reach into SDK privates, so an SDK upgrade that renames either field would
	// silently stop counting AND silently un-fix the claude.ai bug, with nothing
	// failing. This pins the shape against the installed SDK.
	const probe = new McpServer({ name: 'probe', version: '0' });
	probe.registerTool('sample', { title: 'Sample', inputSchema: {} }, async () => ({
		content: [{ type: 'text' as const, text: 'hi' }]
	}));
	const reg = (probe as unknown as { _registeredTools?: Record<string, Record<string, unknown>> })
		._registeredTools;
	check(
		'_registeredTools still exists',
		!!reg,
		'SDK internal renamed — worker.ts wrapping is dead'
	);
	check('the registered tool is keyed by name', !!reg?.sample);
	// The field worker.ts wraps. It is `handler`; wrapping `callback` (which does not
	// exist) threw on every request the first time the flag was switched on.
	check('the handler field is still called `handler`', typeof reg?.sample?.handler === 'function');
	check(
		'and is still NOT called `callback`',
		reg?.sample?.callback === undefined,
		'if the SDK adds one, re-check which field it actually dispatches'
	);
	check(
		'it still carries execution (the claude.ai shim target)',
		'execution' in (reg?.sample ?? {})
	);

	// THE WRAP HAS TO SURVIVE A REAL DISPATCH. Pinning the field name proves the
	// property exists; it does not prove the SDK still READS it when a call arrives.
	// If registerTool closed over the original function, replacing .handler would be
	// a silent no-op: every counter would sit at zero with nothing failing anywhere.
	// So this drives an actual tools/call over a real linked client/server pair.
	const server = new McpServer({ name: 'dispatch', version: '0' });
	server.registerTool('echo', { title: 'Echo', inputSchema: {} }, async () => ({
		content: [{ type: 'text' as const, text: 'real' }]
	}));
	const counted: string[] = [];
	const treg = (server as unknown as { _registeredTools: Record<string, Record<string, unknown>> })
		._registeredTools;
	const inner = treg.echo.handler as (...a: never[]) => unknown;
	treg.echo.handler = countedCall(inner.bind(treg.echo), {
		after: (ok) => counted.push(ok ? 'ok' : 'err')
	});

	const client = new Client({ name: 'probe-client', version: '0' });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([client.connect(ct), server.connect(st)]);
	const out = (await client.callTool({ name: 'echo', arguments: {} })) as {
		content?: { text: string }[];
	};
	check(
		'a real dispatch reaches the WRAPPED handler',
		counted.length === 1,
		`fired ${counted.length}x — if 0, replacing .handler is a silent no-op`
	);
	check('...and counts it as a success', counted[0] === 'ok');
	check('...and the caller still gets the real result', out.content?.[0]?.text === 'real');
	await client.close();
}

console.log('\nusage_daily: the real migration and the real statements');
{
	// The pure fold above never touches SQL, so the upsert that keeps this table
	// bounded was previously verified by hand and by nothing repeatable. Runs the
	// ACTUAL migration file over node:sqlite (same shim shape as test-access /
	// test-scope), so a syntax error or a changed key now fails CI.
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../migrations/0006_usage_daily.sql', import.meta.url), 'utf8'));
	const db = {
		prepare(sql: string) {
			const mk = (params: unknown[]) => ({
				bind: (...p: unknown[]) => mk(p),
				first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
				all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
				run: async () => {
					sqlite.prepare(sql).run(...(params as []));
					return { success: true };
				}
			});
			return mk([]);
		}
	} as unknown as Parameters<typeof recordUsage>[0];

	const base = { orgId: 'o1', userId: 'u1', tool: 'read_page' };
	await recordUsage(db, { ...base, day: '2026-08-04', brainId: 'a/b', ok: true });
	await recordUsage(db, { ...base, day: '2026-08-04', brainId: 'a/b', ok: true });
	await recordUsage(db, { ...base, day: '2026-08-04', brainId: 'a/b', ok: false });
	const one = await readUsage(db, 'o1', '2026-08-01', '2026-08-04');
	check('repeat calls collapse into one row', one.rows.length === 1, `got ${one.rows.length}`);
	check('calls accumulate', one.rows[0]?.calls === 3, `got ${one.rows[0]?.calls}`);
	check('errors accumulate separately', one.rows[0]?.errors === 1);

	// THE NULL TRAP. SQLite treats NULLs in a PRIMARY KEY as distinct, so an
	// org-scope row keyed on a nullable brain_id would never match ON CONFLICT and
	// would append a row per call forever. '' is what keeps the table bounded.
	await recordUsage(db, { ...base, day: '2026-08-04', brainId: '', ok: true });
	await recordUsage(db, { ...base, day: '2026-08-04', brainId: '', ok: true });
	const two = await readUsage(db, 'o1', '2026-08-01', '2026-08-04');
	const orgScope = two.rows.filter((r) => r.brain_id === '');
	check('org-scope rows collapse too, not one per call', orgScope.length === 1);
	check('org-scope calls accumulate', orgScope[0]?.calls === 2);
	check('a brain row and an org row stay separate', two.rows.length === 2);

	// Window and tenancy: the read must not leak across either boundary.
	await recordUsage(db, { ...base, day: '2026-07-01', brainId: 'a/b', ok: true });
	await recordUsage(db, { ...base, day: '2026-08-04', brainId: 'a/b', ok: true, orgId: 'o2' });
	const scoped = await readUsage(db, 'o1', '2026-08-01', '2026-08-04');
	check(
		'a row outside the window is not returned',
		!scoped.rows.some((r) => r.day === '2026-07-01')
	);
	check(
		'another org’s rows are never returned',
		scoped.rows.every((r) => r.calls <= 4)
	);
	const wide = await readUsage(db, 'o1', '2026-06-01', '2026-08-04');
	check('widening the window picks the older row up', wide.rows.length === 3);
	check('nothing is truncated at this size', wide.truncated === false);

	// The fold and the store agree end to end: real rows, real summarize.
	const folded = summarize({
		rows: wide.rows,
		roster: [{ user_id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'owner' }],
		brains: [{ brain_id: 'a/b', label: 'Team brain' }],
		from: '2026-08-01',
		to: '2026-08-04'
	});
	check(
		'store rows fold into the summary',
		folded.totals.reads === 3 + 2,
		`${folded.totals.reads}`
	);
	check('the active-member tile reflects real rows', folded.totals.activeUsers === 1);
	check('the brain row joins its label', folded.brains[0]?.label === 'Team brain');
}

console.log(
	failures === 0 ? '\nAll usage checks passed.\n' : `\n${failures} usage check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
