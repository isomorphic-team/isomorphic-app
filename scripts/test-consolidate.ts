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
import { computeTensions, tensionFindings, type Tension } from '../src/lib/consolidate.ts';
import {
	parseReviewLedger,
	serializeReviewLedger,
	filterDismissed,
	dismissFinding,
	undismissFinding,
	renderFindings,
	findingKey,
	importKey,
	parseImportKey,
	isImportKey
} from '../src/lib/findings.ts';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

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

console.log(failures === 0 ? '\nAll consolidate checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
