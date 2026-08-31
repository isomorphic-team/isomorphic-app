// Golden test for the import planner (src/lib/brain-import.ts): upsert-by-key,
// field-level merge, resurrection guard, deletion proposals, idempotency.
// Pure — no D1, no GitHub. Run: pnpm test:import
import {
	plan,
	planDecisions,
	parseLedger,
	serializeLedger,
	EMPTY_LEDGER,
	type ClaimedPage,
	type ImportLedger,
	type ImportRecord
} from '../src/lib/brain-import.ts';
import { parseFrontmatter } from '../src/lib/wiki.ts';

import { checker } from './check.ts';

const { check, done } = checker('import checks');

const TODAY = '2026-07-23';
const SOURCE_OWNED = ['title', 'type', 'email', 'roles', 'organization'];

// A curated page: human body prose, human-added `notes` field, and a retitle.
const adaPage: ClaimedPage = {
	path: 'people/ada-king.md', // moved by a curator since import
	keys: ['ada@acme.example'],
	content: [
		'---',
		'title: Ada King',
		'type: Contact',
		'email: ada@acme.example',
		'notes: prefers morning meetings', // human-owned — never touched
		'source_key: ada@acme.example',
		'---',
		'',
		'Human-written prose that must survive every import.'
	].join('\n')
};

// The canonical org page that CLAIMED a duplicate's key via source_keys.
const acmePage: ClaimedPage = {
	path: 'orgs/acme.md',
	keys: ['acme-health', 'advent-health-dupe'],
	content: [
		'---',
		'title: Acme Health',
		'type: Health System',
		'source_key: acme-health',
		'source_keys:',
		'  - advent-health-dupe',
		'---',
		'',
		'Org prose.'
	].join('\n')
};

const ledger: ImportLedger = {
	version: 1,
	imported: ['ada@acme.example', 'acme-health', 'advent-health-dupe', 'gone@acme.example'],
	suppressed: ['spam@acme.example'],
	pending: []
};

function run() {
	console.log('planner:');

	const records: ImportRecord[] = [
		// unchanged (same values the page already has)
		{
			key: 'ada@acme.example',
			fields: { title: 'Ada King', type: 'Contact', email: 'ada@acme.example' }
		},
		// new record → create
		{
			key: 'grace@acme.example',
			path: 'people/grace-hopper.md',
			fields: {
				title: 'Grace Hopper',
				type: 'Contact',
				email: 'grace@acme.example',
				roles: ['CTO']
			},
			body: 'Seeded bio.'
		},
		// previously imported, page deleted by a human → question, not create
		{ key: 'gone@acme.example', path: 'people/gone.md', fields: { title: 'Gone Person' } },
		// suppressed by human decision
		{ key: 'spam@acme.example', path: 'people/spam.md', fields: { title: 'Spam' } },
		// aliased duplicate — the canonical page claims it → treated as that page
		{ key: 'advent-health-dupe', fields: { title: 'Acme Health', type: 'Health System' } },
		// new record missing path → error
		{ key: 'nopath@acme.example', fields: { title: 'No Path' } }
	];

	const p1 = plan({
		records,
		manifest: records.map((r) => r.key), // note: acme-health absent → proposed deletion
		sourceOwned: SOURCE_OWNED,
		claimed: [adaPage, acmePage],
		ledger,
		today: TODAY
	});

	check('unchanged record produces no write', p1.unchanged.includes('ada@acme.example'));
	const create = p1.writes.find((w) => w.key === 'grace@acme.example');
	check(
		'new key creates at the given path',
		create?.kind === 'create' && create.path === 'people/grace-hopper.md'
	);
	check(
		'create carries source_key binding + body',
		!!create &&
			create.content.includes('source_key: grace@acme.example') &&
			create.content.includes('Seeded bio.')
	);
	check(
		'resurrection guard: deleted page → needsDecision',
		p1.needsDecision.some((d) => d.key === 'gone@acme.example') &&
			!p1.writes.some((w) => w.key === 'gone@acme.example')
	);
	check('suppressed key skipped', p1.suppressed.includes('spam@acme.example'));
	check(
		'aliased key resolves to canonical page (unchanged)',
		p1.unchanged.includes('advent-health-dupe')
	);
	check(
		'create without path is an error',
		p1.errors.some((e) => e.key === 'nopath@acme.example')
	);
	check(
		'key in brain but absent from manifest → proposed deletion, not delete',
		p1.proposedDeletions.some((d) => d.key === 'acme-health' && d.path === 'orgs/acme.md')
	);
	check('ledger gains the new key', p1.ledgerAfter.imported.includes('grace@acme.example'));

	// Field-level merge: source updates its fields, never the human's.
	const p2 = plan({
		records: [
			{
				key: 'ada@acme.example',
				fields: { title: 'Ada King', email: 'ada.king@acme.example', favorite_color: 'green' }
			}
		],
		sourceOwned: SOURCE_OWNED,
		claimed: [adaPage],
		ledger,
		today: TODAY
	});
	const upd = p2.writes.find((w) => w.key === 'ada@acme.example');
	check(
		'changed source-owned field updates',
		upd?.kind === 'update' && upd.changedFields.join() === 'email'
	);
	check('update lands at the CURRENT (moved) path', upd?.path === 'people/ada-king.md');
	const updFm = upd ? parseFrontmatter(upd.content) : null;
	check('human-owned field survives', updFm?.frontmatter?.notes === 'prefers morning meetings');
	check('non-source-owned record field ignored', !upd?.content.includes('favorite_color'));
	check(
		'human body prose survives',
		!!upd?.content.includes('Human-written prose that must survive every import.')
	);
	check('updated date bumped', updFm?.frontmatter?.updated === TODAY);

	// Idempotency: apply p2's write, re-plan → nothing.
	const applied: ClaimedPage = { ...adaPage, content: upd!.content };
	const p3 = plan({
		records: [{ key: 'ada@acme.example', fields: { email: 'ada.king@acme.example' } }],
		sourceOwned: SOURCE_OWNED,
		claimed: [applied],
		ledger,
		today: TODAY
	});
	check(
		're-import of applied state is a no-op',
		p3.writes.length === 0 && p3.unchanged.length === 1
	);

	// No manifest → no deletion proposals (mid-chunk call).
	const p4 = plan({
		records: [],
		sourceOwned: SOURCE_OWNED,
		claimed: [acmePage],
		ledger,
		today: TODAY
	});
	check('no manifest → no deletion proposals', p4.proposedDeletions.length === 0);

	// Duplicate key in one batch → error, second occurrence dropped.
	const p5 = plan({
		records: [
			{ key: 'x@x.example', path: 'people/x.md', fields: { title: 'X' } },
			{ key: 'x@x.example', path: 'people/x2.md', fields: { title: 'X2' } }
		],
		sourceOwned: SOURCE_OWNED,
		claimed: [],
		ledger: EMPTY_LEDGER,
		today: TODAY
	});
	check(
		'duplicate key in batch → one create + one error',
		p5.writes.length === 1 && p5.errors.length === 1
	);

	console.log('adoption + clobber guard:');
	const handmade = [
		'---',
		'title: Ivan Petrov',
		'type: Contact',
		'notes: met at HIMSS',
		'---',
		'',
		'Hand-written page that predates import keys.'
	].join('\n');
	const ivanRecord: ImportRecord = {
		key: 'ivan@acme.example',
		path: 'people/ivan-petrov.md',
		fields: { title: 'Ivan Petrov', type: 'Contact', email: 'ivan@acme.example' }
	};
	// Without adopt_existing: the clobber guard refuses.
	const guarded = plan({
		records: [ivanRecord],
		sourceOwned: SOURCE_OWNED,
		claimed: [],
		ledger: EMPTY_LEDGER,
		existingPaths: new Set(['people/ivan-petrov.md']),
		today: TODAY
	});
	check(
		'create at an existing unclaimed path errors (never overwrites)',
		guarded.writes.length === 0 &&
			guarded.errors.some((e) => e.key === ivanRecord.key && e.error.includes('adopt_existing'))
	);
	// With adoption: bind + merge, body preserved.
	const adopted = plan({
		records: [ivanRecord],
		sourceOwned: SOURCE_OWNED,
		claimed: [],
		ledger: EMPTY_LEDGER,
		existingPaths: new Set(['people/ivan-petrov.md']),
		adoptable: new Map([['people/ivan-petrov.md', handmade]]),
		today: TODAY
	});
	const aw = adopted.writes[0];
	check(
		'adoption binds the key',
		aw?.kind === 'adopt' && aw.content.includes('source_key: ivan@acme.example')
	);
	check('adoption merges source-owned fields', !!aw?.content.includes('email: ivan@acme.example'));
	check(
		'adoption preserves human field + body',
		!!aw?.content.includes('notes: met at HIMSS') &&
			!!aw?.content.includes('Hand-written page that predates import keys.')
	);
	check('adopted key joins the ledger', adopted.ledgerAfter.imported.includes(ivanRecord.key));
	// A path bound to a DIFFERENT key is never hijacked, even in adopt mode.
	const hijack = plan({
		records: [{ ...ivanRecord, path: 'people/ada-king.md' }],
		sourceOwned: SOURCE_OWNED,
		claimed: [adaPage],
		ledger: EMPTY_LEDGER,
		existingPaths: new Set(['people/ada-king.md']),
		adoptable: new Map([['people/ada-king.md', adaPage.content]]),
		today: TODAY
	});
	check(
		'path bound to another key errors even in adopt mode',
		hijack.writes.length === 0 &&
			hijack.errors.some((e) => e.error.includes('DIFFERENT source key'))
	);

	console.log('pending (persisted questions):');
	check(
		'sync persists its open questions into the ledger',
		p1.ledgerAfter.pending.some(
			(q) => q.key === 'gone@acme.example' && q.kind === 'needs-decision'
		) &&
			p1.ledgerAfter.pending.some((q) => q.key === 'acme-health' && q.kind === 'proposed-deletion')
	);
	// Chunk safety: a manifest-less call touching OTHER keys must not clobber a
	// prior call's proposed deletions, but refreshes needs-decision for its own.
	const chunk = plan({
		records: [{ key: 'ada@acme.example', fields: { title: 'Ada King' } }],
		sourceOwned: SOURCE_OWNED,
		claimed: [adaPage],
		ledger: p1.ledgerAfter,
		today: TODAY
	});
	check(
		'chunk call preserves prior proposals + unrelated questions',
		chunk.ledgerAfter.pending.some(
			(q) => q.key === 'acme-health' && q.kind === 'proposed-deletion'
		) && chunk.ledgerAfter.pending.some((q) => q.key === 'gone@acme.example')
	);
	// Determinism: identical state → identical bytes (no ledger churn commit).
	// (The first sync's create has landed by now, so its page is claimed.)
	const gracePage: ClaimedPage = {
		path: 'people/grace-hopper.md',
		keys: ['grace@acme.example'],
		content: create!.content
	};
	const again = plan({
		records,
		manifest: records.map((r) => r.key),
		sourceOwned: SOURCE_OWNED,
		claimed: [adaPage, acmePage, gracePage],
		ledger: p1.ledgerAfter,
		today: TODAY
	});
	check(
		'identical re-sync produces byte-identical ledger',
		serializeLedger(again.ledgerAfter) === serializeLedger(p1.ledgerAfter)
	);

	console.log('decisions:');
	const d1 = planDecisions({
		decisions: [
			{ key: 'gone@acme.example', action: 'suppress' },
			{ key: 'acme-health', action: 'delete' },
			{ key: 'orphan-key', action: 'alias', alias_to: 'people/ada-king.md' },
			{ key: 'spam@acme.example', action: 'recreate' },
			{ key: 'ada@acme.example', action: 'alias', alias_to: 'orgs/acme.md' }, // bound elsewhere → error
			{ key: 'no-page-key', action: 'delete' } // nothing claims it → error
		],
		claimed: [adaPage, acmePage],
		ledger,
		today: TODAY
	});
	check('suppress lands in ledger', d1.ledgerAfter.suppressed.includes('gone@acme.example'));
	check('delete resolves key → page path', d1.deletes.includes('orgs/acme.md'));
	check(
		'deleted key STAYS in ledger (no auto-resurrect later)',
		d1.ledgerAfter.imported.includes('acme-health')
	);
	const aliasWrite = d1.writes.find((w) => w.path === 'people/ada-king.md');
	const aliasFm = aliasWrite ? parseFrontmatter(aliasWrite.content).frontmatter : null;
	check(
		'alias adds key to source_keys and preserves the page',
		Array.isArray(aliasFm?.source_keys) &&
			aliasFm.source_keys.includes('orphan-key') &&
			!!aliasWrite?.content.includes('Human-written prose that must survive every import.')
	);
	check('aliased key joins the ledger', d1.ledgerAfter.imported.includes('orphan-key'));
	check(
		'recreate forgets the key entirely',
		!d1.ledgerAfter.suppressed.includes('spam@acme.example') &&
			!d1.ledgerAfter.imported.includes('spam@acme.example')
	);
	check(
		'alias of an already-bound key errors',
		d1.errors.some((e) => e.key === 'ada@acme.example')
	);
	check(
		'delete of an unclaimed key errors',
		d1.errors.some((e) => e.key === 'no-page-key')
	);

	// The loop closes: after suppress + alias, a re-sync stops asking.
	const resynced = plan({
		records: [
			{ key: 'gone@acme.example', path: 'people/gone.md', fields: { title: 'Gone' } },
			{ key: 'orphan-key', fields: { title: 'Ada King' } }
		],
		sourceOwned: SOURCE_OWNED,
		claimed: [{ ...adaPage, keys: [...adaPage.keys, 'orphan-key'], content: aliasWrite!.content }],
		ledger: d1.ledgerAfter,
		today: TODAY
	});
	check(
		'post-decisions re-sync is quiet (suppressed skipped, alias unchanged)',
		resynced.suppressed.includes('gone@acme.example') &&
			resynced.unchanged.includes('orphan-key') &&
			resynced.needsDecision.length === 0 &&
			resynced.writes.length === 0
	);

	console.log('ledger:');
	const round = parseLedger(serializeLedger(p1.ledgerAfter));
	check(
		'ledger round-trips',
		round.imported.includes('grace@acme.example') && round.suppressed.includes('spam@acme.example')
	);
	check('absent ledger file → empty ledger', parseLedger(null).imported.length === 0);
	let threw = false;
	try {
		parseLedger('{not json');
	} catch {
		threw = true;
	}
	check('corrupt ledger throws (never guess — guessing resurrects deletions)', threw);

	done();
}

run();
