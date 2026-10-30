// Golden test for the consolidation detector (src/lib/consolidate.ts): which
// tensions fire, which deliberately stay silent, and the dismissal ledger that keeps
// a judgment call from being re-raised forever. Pure — no D1, no GitHub.
// Run: pnpm test:consolidate
//
// Every check is asserted in BOTH directions. A detector that only ever fires is not
// a detector, and the silent cases are the ones that decide whether the queue is
// worth reading: a brain consistently on README.md is consistent, a two-page folder
// with no note is a shape rather than a gap, and two pages sharing a vocabulary are
// not two pages sharing a story.
import {
	computeTensions,
	tensionFindings,
	MAX_DUP_PAGES,
	type Tension,
	type TensionInput
} from '../src/lib/consolidate.ts';
import { parseIdentityFields } from '../src/lib/brain-config.ts';
import {
	parseReviewLedger,
	serializeReviewLedger,
	filterDismissed,
	dismissFinding,
	undismissFinding,
	renderFindings,
	findingKey,
	importKey,
	importFindings,
	parseImportKey,
	isImportKey
} from '../src/lib/findings.ts';

import { checker } from './check.ts';

const { check, done } = checker('consolidate checks');

const page = (path: string, title = path.split('/').pop()!.replace(/\.md$/, '')) => ({
	path,
	title
});
const kinds = (ts: Tension[]) => ts.map((t) => t.kind);
const of = (ts: Tension[], kind: string) => ts.filter((t) => t.kind === kind);

// ---------- islands and orphans ----------
{
	const ts = computeTensions({
		pages: [page('wiki/a.md'), page('wiki/b.md'), page('wiki/c.md'), page('wiki/d.md')],
		edges: [
			{ source: 'wiki/b.md', target: 'wiki/c.md' } // b has outbound, c has inbound
		]
	});
	const islands = of(ts, 'island').map((t) => t.paths[0]);
	const orphans = of(ts, 'orphan').map((t) => t.paths[0]);
	check('island: no links either way fires', islands.includes('wiki/a.md'));
	check('island: d with no links fires', islands.includes('wiki/d.md'));
	check('orphan: outbound only is an orphan, not an island', orphans.includes('wiki/b.md'));
	check('orphan: b is not also reported as an island', !islands.includes('wiki/b.md'));
	check(
		'silent: a page with inbound links is neither',
		![...islands, ...orphans].includes('wiki/c.md')
	);
}

// A folder note is reachable by clicking its folder, so "nothing links to it" is not
// the same defect it is for a concept page.
{
	const ts = computeTensions({
		pages: [page('wiki/things/index.md'), page('wiki/things/one.md')],
		edges: [{ source: 'wiki/things/index.md', target: 'wiki/things/one.md' }]
	});
	check(
		'silent: an unlinked folder note is not an island or orphan',
		!kinds(ts).some((k) => k === 'island' || k === 'orphan')
	);
}

// A self-link must not rescue a page from island status.
{
	const ts = computeTensions({
		pages: [page('wiki/a.md')],
		edges: [{ source: 'wiki/a.md', target: 'wiki/a.md' }]
	});
	check('island: a self-link does not count as a link', of(ts, 'island').length === 1);
}

// ---------- note-less folders ----------
{
	const three = computeTensions({
		pages: [page('wiki/f/a.md'), page('wiki/f/b.md'), page('wiki/f/c.md')],
		edges: []
	});
	check('note-less-folder: 3 pages with no note fires', of(three, 'note-less-folder').length === 1);

	const two = computeTensions({
		pages: [page('wiki/f/a.md'), page('wiki/f/b.md')],
		edges: []
	});
	check(
		'silent: 2 pages with no note is a shape, not a gap',
		of(two, 'note-less-folder').length === 0
	);

	const withNote = computeTensions({
		pages: [page('wiki/f/index.md'), page('wiki/f/a.md'), page('wiki/f/b.md'), page('wiki/f/c.md')],
		edges: []
	});
	check(
		'silent: a folder with a note is not note-less',
		of(withNote, 'note-less-folder').length === 0
	);

	const readmeNote = computeTensions({
		pages: [
			page('wiki/f/README.md'),
			page('wiki/f/a.md'),
			page('wiki/f/b.md'),
			page('wiki/f/c.md')
		],
		edges: []
	});
	check(
		'silent: README.md counts as the folder note',
		of(readmeNote, 'note-less-folder').length === 0
	);
}

// ---------- hollow folder notes ----------
{
	const hollow = computeTensions({
		pages: [page('wiki/f/index.md'), page('wiki/f/a.md'), page('wiki/f/b.md')],
		edges: []
	});
	check(
		'hollow-folder-note: a note linking to no sibling fires',
		of(hollow, 'hollow-folder-note').length === 1
	);

	const linked = computeTensions({
		pages: [page('wiki/f/index.md'), page('wiki/f/a.md'), page('wiki/f/b.md')],
		edges: [{ source: 'wiki/f/index.md', target: 'wiki/f/a.md' }]
	});
	check(
		'silent: a note linking to any sibling is doing its job',
		of(linked, 'hollow-folder-note').length === 0
	);

	// One sibling is not a listing worth having.
	const single = computeTensions({
		pages: [page('wiki/f/index.md'), page('wiki/f/a.md')],
		edges: []
	});
	check(
		'silent: a note with one sibling is not hollow',
		of(single, 'hollow-folder-note').length === 0
	);

	// An inbound link to the note is not the note listing anything.
	const inboundOnly = computeTensions({
		pages: [page('wiki/f/index.md'), page('wiki/f/a.md'), page('wiki/f/b.md')],
		edges: [{ source: 'wiki/f/a.md', target: 'wiki/f/index.md' }]
	});
	check(
		'hollow-folder-note: inbound links do not make a note a listing',
		of(inboundOnly, 'hollow-folder-note').length === 1
	);
}

// ---------- folder-note convention ----------
{
	const mixed = computeTensions({
		pages: [page('wiki/a/index.md'), page('wiki/b/README.md')],
		edges: []
	});
	const conv = of(mixed, 'folder-note-convention');
	check('folder-note-convention: a mixed brain fires', conv.length === 1);
	check(
		'folder-note-convention: names the minority form, not the preferred one',
		conv[0]?.paths.length === 1 && conv[0].paths[0] === 'wiki/b/README.md',
		JSON.stringify(conv[0]?.paths)
	);

	const consistent = computeTensions({
		pages: [page('wiki/a/README.md'), page('wiki/b/README.md')],
		edges: []
	});
	check(
		'silent: a brain consistently on README.md is consistent',
		of(consistent, 'folder-note-convention').length === 0
	);
}

// ---------- folder-echo page ----------
{
	const echo = computeTensions({
		pages: [page('wiki/exit-readiness/exit-readiness.md'), page('wiki/exit-readiness/other.md')],
		edges: []
	});
	check(
		'folder-echo-page: a page named after its folder fires',
		of(echo, 'folder-echo-page').length === 1
	);

	const noEcho = computeTensions({
		pages: [page('wiki/exit-readiness/index.md'), page('wiki/exit-readiness/other.md')],
		edges: []
	});
	check(
		'silent: the folder note itself is not an echo',
		of(noEcho, 'folder-echo-page').length === 0
	);
}

// ---------- near-duplicate ----------
// Same story told twice, versus two pages in one domain sharing vocabulary. The
// threshold has to separate these, so both are asserted.
{
	const shared =
		'The engagement runs in three phases. Phase one is a diagnostic across six dimensions. ' +
		'Phase two builds the roadmap with the leadership team. Phase three hands the systems over ' +
		'so the client teams run them unassisted without further help from us.';
	const dupA = `# Engagement shape\n\n${shared}\n\nThe cadence is weekly.`;
	const dupB = `# How an engagement runs\n\n${shared}\n\nThe cadence is reviewed monthly.`;
	const dup = computeTensions({
		pages: [page('wiki/a.md'), page('wiki/b.md')],
		edges: [],
		contents: new Map([
			['wiki/a.md', dupA],
			['wiki/b.md', dupB]
		])
	});
	check('near-duplicate: the same story twice fires', of(dup, 'near-duplicate').length === 1);

	const distinct = computeTensions({
		pages: [page('wiki/a.md'), page('wiki/b.md')],
		edges: [],
		contents: new Map([
			[
				'wiki/a.md',
				'# AI maturity\n\nSix dimensions scored from one to five, baselined at the start of an engagement and re-scored at exit against the same evidence standard.'
			],
			[
				'wiki/b.md',
				'# Partner economics\n\nHow partners are paid: an hourly rate basis, a bench carried between engagements, and the open question of a retainer unit that nothing prices yet.'
			]
		])
	});
	check(
		'silent: a shared vocabulary is not a shared story',
		of(distinct, 'near-duplicate').length === 0
	);

	const noContents = computeTensions({
		pages: [page('wiki/a.md'), page('wiki/b.md')],
		edges: []
	});
	check(
		'near-duplicate: skipped entirely when no contents are supplied',
		of(noContents, 'near-duplicate').length === 0
	);
}

// ---------- near-duplicate: templated folders ----------
// Pages built from one template share most of their bigrams and say different things.
{
	const template =
		'## Background summary\n\nEngagement history reviewed quarterly against contract terms, ' +
		'renewal dates tracked inside account planning, primary stakeholders listed below alongside ' +
		'preferred meeting cadence, escalation contacts recorded separately, invoices reconciled monthly.';
	const unique = (n: number) =>
		Array.from({ length: 16 }, (_, i) => `topic${n}x${i} detail${n}y${i}`).join(' ');
	const pathsFor = (n: number) => Array.from({ length: n }, (_, i) => `wiki/people/p${i}.md`);
	const paths = pathsFor(8);
	const contents = new Map(paths.map((p, i) => [p, `${template}\n\n${unique(i)}`]));
	const templated = computeTensions({ pages: paths.map((p) => page(p)), edges: [], contents });
	check(
		'near-duplicate: a folder of templated pages about different entities is silent',
		of(templated, 'near-duplicate').length === 0
	);

	const story = unique(100);
	const twins = new Map(contents);
	twins.set(paths[2], `${template}\n\n${story}\nFirst closing line here.`);
	twins.set(paths[5], `${template}\n\n${story}\nAnother different ending.`);
	const both = of(
		computeTensions({ pages: paths.map((p) => page(p)), edges: [], contents: twins }),
		'near-duplicate'
	);
	check(
		'near-duplicate: two pages telling one story inside that folder still fire',
		both.length === 1 && both[0].paths.join() === [paths[2], paths[5]].join(),
		JSON.stringify(both)
	);

	const stubs = pathsFor(40);
	const stubContents = new Map(
		stubs.map((p, i) => [p, `${i < 12 ? template : ''}\n\n${unique(i)}`])
	);
	check(
		'near-duplicate: a template on a minority of the folder is still a template',
		of(
			computeTensions({ pages: stubs.map((p) => page(p)), edges: [], contents: stubContents }),
			'near-duplicate'
		).length === 0
	);

	const small = pathsFor(5);
	const smallFolder = of(
		computeTensions({
			pages: small.map((p) => page(p)),
			edges: [],
			contents: new Map(small.map((p, i) => [p, i < 2 ? `# t\n\n${story}` : unique(i)]))
		}),
		'near-duplicate'
	);
	check(
		'near-duplicate: a few pages telling one story are not a template',
		smallFolder.length === 1,
		JSON.stringify(smallFolder)
	);

	const thin = pathsFor(8);
	const thinTensions = computeTensions({
		pages: thin.map((p) => page(p)),
		edges: [],
		contents: new Map(
			thin.map((p, i) => [
				p,
				`${template}\n\n${i < 2 ? 'Shared closing words only.' : `Sign off ${i} here.`}`
			])
		)
	});
	check(
		'near-duplicate: pages with next to nothing past the template are not compared',
		of(thinTensions, 'near-duplicate').length === 0
	);

	const huge = Array.from({ length: 1500 }, (_, i) => `wiki/big/p${i}.md`);
	const hugeContents = new Map(huge.map((p, i) => [p, `${template}\n\n${unique(i)}`]));
	hugeContents.set(huge[100], `${template}\n\n${story}\nFirst closing line here.`);
	hugeContents.set(huge[1400], `${template}\n\n${story}\nAnother different ending.`);
	const started = Date.now();
	const hugeDup = of(
		computeTensions({ pages: huge.map((p) => page(p)), edges: [], contents: hugeContents }),
		'near-duplicate'
	);
	check(
		'near-duplicate: past the old 400-page cap, the planted pair and nothing else',
		hugeDup.length === 1 && MAX_DUP_PAGES >= huge.length,
		JSON.stringify(hugeDup.slice(0, 3))
	);
	check('near-duplicate: that pass stays quick', Date.now() - started < 5000);
}

// ---------- same-identifier ----------
{
	const fields = (rows: Record<string, Record<string, string[]>>) =>
		new Map(Object.entries(rows).map(([p, f]) => [p, new Map(Object.entries(f))]));
	const pages = ['wiki/a.md', 'wiki/b.md', 'wiki/c.md'].map((p) => page(p));
	const run = (
		f: Record<string, Record<string, string[]>>,
		extra: Partial<TensionInput> = {},
		ps = pages
	) =>
		of(
			computeTensions({
				pages: ps,
				edges: [],
				fields: fields(f),
				identityFields: ['email'],
				...extra
			}),
			'same-identifier'
		);

	const two = run({ 'wiki/a.md': { email: ['x@e.co'] }, 'wiki/b.md': { email: ['x@e.co'] } });
	check('same-identifier: two pages sharing an email, one tension', two.length === 1);
	check(
		'same-identifier: the key is kind plus sorted paths',
		two[0]?.key === findingKey('same-identifier', ['wiki/b.md', 'wiki/a.md'])
	);
	check('same-identifier: the value is the evidence', two[0]?.evidence[0] === 'email: x@e.co');

	const three = run({
		'wiki/a.md': { email: ['x@e.co'] },
		'wiki/b.md': { email: ['x@e.co'] },
		'wiki/c.md': { email: ['x@e.co'] }
	});
	check(
		'same-identifier: three pages sharing one, one tension',
		three.length === 1 && three[0].paths.length === 3
	);
	check(
		'same-identifier: a list-valued field matches on any element',
		run({
			'wiki/a.md': { email: ['old@e.co', 'x@e.co'] },
			'wiki/b.md': { email: ['x@e.co'] }
		}).length === 1
	);
	check(
		'same-identifier: case and whitespace do not hide an email',
		run({ 'wiki/a.md': { email: [' X@E.co '] }, 'wiki/b.md': { email: ['x@e.co'] } }).length === 1
	);
	check(
		'same-identifier: different values are silent',
		run({ 'wiki/a.md': { email: ['x@e.co'] }, 'wiki/b.md': { email: ['y@e.co'] } }).length === 0
	);
	check(
		'same-identifier: an empty value is not an identifier',
		run({ 'wiki/a.md': { email: [' '] }, 'wiki/b.md': { email: [' '] } }).length === 0
	);

	const crm = { 'wiki/a.md': { crm_id: ['AbC'] }, 'wiki/b.md': { crm_id: ['AbC'] } };
	check(
		'same-identifier: a field declared in config fires',
		run(crm, { identityFields: ['email', 'crm_id'] }).length === 1
	);
	check('same-identifier: an undeclared field does not', run(crm).length === 0);
	check(
		'same-identifier: a declared field compares exactly',
		run(
			{ 'wiki/a.md': { crm_id: ['AbC'] }, 'wiki/b.md': { crm_id: ['abc'] } },
			{ identityFields: ['crm_id'] }
		).length === 0
	);
	check(
		'same-identifier: two fields shared by one pair are one tension',
		run(
			{
				'wiki/a.md': { email: ['x@e.co'], crm_id: ['1'] },
				'wiki/b.md': { email: ['x@e.co'], crm_id: ['1'] }
			},
			{ identityFields: ['email', 'crm_id'] }
		).length === 1
	);

	const noteAndOutside = [page('wiki/a.md'), page('wiki/index.md'), page('ops/team.md')];
	check(
		'same-identifier: a folder note or a page outside the content roots does not count',
		run(
			{
				'wiki/a.md': { email: ['x@e.co'] },
				'wiki/index.md': { email: ['x@e.co'] },
				'ops/team.md': { email: ['x@e.co'] }
			},
			{ isContent: (p) => p.startsWith('wiki/') },
			noteAndOutside
		).length === 0
	);
	check(
		'same-identifier: a tool-maintained page does not count',
		run(
			{ 'wiki/a.md': { email: ['x@e.co'] }, 'wiki/b.md': { email: ['x@e.co'] } },
			{ toolMaintained: (p) => p === 'wiki/b.md' }
		).length === 0
	);

	check(
		'config: email always counts, declared keys add to it',
		JSON.stringify(parseIdentityFields({ review: { identityFields: [' crm_id ', 7, ''] } })) ===
			JSON.stringify(['email', 'crm_id'])
	);
	check(
		'config: no declaration is email alone',
		JSON.stringify(parseIdentityFields({})) === JSON.stringify(['email'])
	);
}

// ---------- tool-maintained pages are never candidates ----------
{
	const ts = computeTensions({
		pages: [page('wiki/log.md'), page('wiki/a.md')],
		edges: [],
		toolMaintained: (p) => p === 'wiki/log.md'
	});
	check(
		'tool-maintained: log.md is never a tension',
		!ts.some((t) => t.paths.includes('wiki/log.md'))
	);
}

// ---------- the ledger ----------
{
	check('ledger: null parses to empty', parseReviewLedger(null).dismissed.length === 0);
	check('ledger: blank parses to empty', parseReviewLedger('   ').dismissed.length === 0);
	check(
		'ledger: rows without a key are dropped',
		parseReviewLedger('{"dismissed":[{"why":"x"},{"key":"k","why":"y","at":"z"}]}').dismissed
			.length === 1
	);

	const base = parseReviewLedger(null);
	const once = dismissFinding(base, 'island:wiki/a.md', 'kept on purpose', '2026-08-31');
	const twice = dismissFinding(once, 'island:wiki/a.md', 'again', '2026-09-01');
	check('ledger: dismiss is idempotent on the key', twice.dismissed.length === 1);
	check(
		'ledger: round-trips through serialize',
		parseReviewLedger(serializeReviewLedger(once)).dismissed[0].key === 'island:wiki/a.md'
	);
	check(
		'ledger: undismiss forgets the decision so the finding returns',
		undismissFinding(once, 'island:wiki/a.md').dismissed.length === 0
	);

	const ts = computeTensions({ pages: [page('wiki/a.md'), page('wiki/b.md')], edges: [] });
	const kept = filterDismissed(tensionFindings(ts), once);
	check('ledger: the dismissed finding is gone', !kept.some((f) => f.key === 'island:wiki/a.md'));
	check(
		'ledger: everything else survives',
		kept.some((f) => f.key === 'island:wiki/b.md')
	);
}

// ---------- keys are an interface ----------
// A dismissal is stored against a key, so the key has to keep meaning the same thing.
// Order-independence matters for the pair findings: `dup:a|b` and `dup:b|a` are the
// same finding, and a run that emitted them in the other order must not resurrect a
// dismissal.
{
	check(
		'key: identity order does not change the key',
		findingKey('near-duplicate', ['wiki/b.md', 'wiki/a.md']) ===
			findingKey('near-duplicate', ['wiki/a.md', 'wiki/b.md'])
	);
	check(
		'key: a single identity needs no array',
		findingKey('island', 'wiki/a.md') === 'island:wiki/a.md'
	);

	// Import findings route to the importer's own per-source ledger, so `resolve` has
	// to be able to tell them apart and recover both halves.
	const k = importKey('vendors', 'acme:corp:1');
	check('key: an import key is recognised', isImportKey(k));
	check('key: a consolidation key is not', !isImportKey('island:wiki/a.md'));
	check(
		'key: the source and record key round-trip, record keys may contain colons',
		parseImportKey(k)?.source === 'vendors' && parseImportKey(k)?.recordKey === 'acme:corp:1',
		JSON.stringify(parseImportKey(k))
	);
	check('key: a malformed import key parses to nothing', parseImportKey('import:novalue') === null);
}

// ---------- the report is capped, and says so ----------
// A silently truncated list reads as "that is all of them", which is the failure that
// makes a long report worse than a short one.
{
	const many = Array.from({ length: 12 }, (_, i) => ({
		key: `island:wiki/${String(i).padStart(2, '0')}.md`,
		headline: `- page ${i}`,
		weight: i
	}));
	const r = renderFindings(many, 5);
	check('render: caps at the limit', r.shown === 5 && r.hidden === 7);
	check('render: says how many it withheld', r.text.includes('and 7 more'));
	check(
		'render: never asks the caller to raise a limit validate does not take',
		!/raise the limit/i.test(r.text) && r.text.includes('resolve'),
		r.text
	);
	check('render: highest weight first', r.text.indexOf('page 11') < r.text.indexOf('page 7'));
	check('render: every finding carries its key', r.text.includes('[island:wiki/11.md]'));

	const few = renderFindings(many.slice(0, 3), 5);
	check('render: no truncation note when nothing was withheld', !few.text.includes('more'));
}

// The dismissal design rests entirely on this: a key derived from the wording of a
// headline would resurrect every dismissed tension the moment a page was retitled.
{
	const before = computeTensions({ pages: [{ path: 'wiki/a.md', title: 'Old name' }], edges: [] });
	const after = computeTensions({
		pages: [{ path: 'wiki/a.md', title: 'A totally new name' }],
		edges: []
	});
	check(
		'key: stable when the title (and so the headline) changes',
		before[0].key === after[0].key,
		`${before[0].key} vs ${after[0].key}`
	);
	check('key: headlines did differ', before[0].headline !== after[0].headline);
}

// ---------- ranking ----------
{
	const ts = computeTensions({
		pages: [page('wiki/f/a.md'), page('wiki/f/b.md'), page('wiki/f/c.md')],
		edges: [{ source: 'wiki/f/a.md', target: 'wiki/f/b.md' }]
	});
	const weights = ts.map((t) => t.weight);
	check(
		'ranking: returned in descending weight',
		weights.every((w, i) => i === 0 || weights[i - 1] >= w),
		JSON.stringify(weights)
	);
}

// Pending import questions become findings with the importer's namespaced key, so
// the one resolve verb answers them, and they outrank structure notes.
{
	const f = importFindings('crm', [
		{ key: 'acme', kind: 'needs-decision', reason: 'no page claims this key' },
		{
			key: 'globex',
			kind: 'proposed-deletion',
			path: 'wiki/customers/globex.md',
			reason: 'gone from the source'
		}
	]);
	check('import: one finding per pending question', f.length === 2);
	check(
		'import: keyed so resolve routes it to the source ledger',
		f[0].key === importKey('crm', 'acme') && parseImportKey(f[0].key)?.source === 'crm'
	);
	check(
		'import: a deletion names the page and both answers',
		f[1].headline.includes('wiki/customers/globex.md') && f[1].headline.includes('suppress the key')
	);
	check(
		'import: a decision states the reason',
		f[0].headline === '- "acme": no page claims this key'
	);
	check(
		'import: outweighs structure advisories (weight 4)',
		f.every((x) => x.weight === 4)
	);
	check('import: nothing pending, nothing reported', importFindings('crm', []).length === 0);
}

done();
