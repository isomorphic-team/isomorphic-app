// End-to-end battery for the bulk importer (sync_records / resolve).
//
// Drives the REAL tool handlers through an in-memory MCP client. By default the brain
// is the fs + git BrainStore in a temp directory: offline, no credentials, and in CI.
// `--github` runs the identical assertions against a real scratch repo, by hand, when
// the GitHub adapter's side of the import path changes:
//
//   pnpm test:e2e-import                              (local, offline, in CI)
//   pnpm exec tsx scripts/e2e-import.ts --github      (real GitHub, by hand)
//
// The scratch brain, the client and the GitHub-only waits come from e2e-harness.ts.
// In both modes the content index runs on a real SQLite database via node:sqlite,
// shimmed to the D1 surface brain-index uses, so ensureFresh / key discovery run for
// real.
import { McpServer } from '@modelcontextprotocol/server';
import { registerImportTools } from '../src/tools/importer.ts';
import { importKey } from '../src/lib/findings.ts';
import { registerLibrarianTools } from '../src/tools/librarian.ts';
import { loadBrainConfig } from '../src/lib/brain-config.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { ledgerPath } from '../src/lib/brain-import.ts';
import { checker } from './check.ts';
import { connect, replicationLag, scratchBrain } from './e2e-harness.ts';

const { db } = localD1();
const brain = await scratchBrain('brain-import-e2e', 'Importer E2E test, safe to delete');
const { store, repoArgs, brainId, name, headSha } = brain;

const server = new McpServer({ name: 'import-e2e', version: '0.0.0' });
const getContext = async () => ({
	store,
	repoArgs,
	role: 'owner' as const,
	orgRole: 'owner' as const,
	config: await loadBrainConfig(store, repoArgs),
	author: undefined,
	db,
	brainId,
	activeBrain: { id: brainId, label: name }
});
registerImportTools(server, getContext);
registerLibrarianTools(server, getContext); // for validate (pending-decision surfacing)
const { call } = await connect(server);

const { check, done } = checker('import E2E checks');

// A human curator editing the brain OUTSIDE our tools. Expressed through the store
// so it works against either backend, and so these edits look exactly like the ones
// the importer's no-resurrection rule has to respect.
async function readPage(path: string): Promise<{ content: string; sha: string } | null> {
	return store.readFile(repoArgs, path);
}
async function humanWrite(path: string, content: string, message: string) {
	await store.commitFiles(repoArgs, { message, writes: [{ path, content }] });
}
async function humanDelete(path: string, message: string) {
	if (!(await readPage(path))) throw new Error(`cannot delete missing ${path}`);
	await store.commitFiles(repoArgs, { message, deletes: [path] });
}

const SOURCE = 'e2e-feed';
const OWNED = ['title', 'type', 'email', 'sector'];
const ada = {
	key: 'ada@e2e.example',
	path: 'wiki/people/ada-lovelace.md',
	fields: { title: 'Ada Lovelace', type: 'Contact', email: 'ada@e2e.example' },
	body: 'Seeded bio for Ada.'
};
const grace = {
	key: 'grace@e2e.example',
	path: 'wiki/people/grace-hopper.md',
	fields: { title: 'Grace Hopper', type: 'Contact', email: 'grace@e2e.example' }
};
const acme = {
	key: 'org-acme',
	path: 'wiki/orgs/acme.md',
	fields: { title: 'Acme Health', type: 'Health System', sector: 'Providers' }
};
const dupe = {
	key: 'org-acme-dupe',
	path: 'wiki/orgs/acme-dupe.md',
	fields: { title: 'ACME Health (dupe)', type: 'Health System', sector: 'Providers' }
};
const allKeys = [ada.key, grace.key, acme.key, dupe.key];

try {
	// 1. Initial import: four creates.
	console.log('\ninitial import:');
	let r = await call('sync_records', {
		source: SOURCE,
		records: [ada, grace, acme, dupe],
		source_owned: OWNED,
		manifest: allKeys
	});
	check('first sync succeeds', !r.isError, r.text);
	check(
		'4 created',
		Array.isArray(r.sc.created) && (r.sc.created as unknown[]).length === 4,
		r.text
	);
	await replicationLag();
	const adaFile = await readPage(ada.path);
	check(
		'page exists with source_key + body',
		!!adaFile?.content.includes('source_key: ada@e2e.example') &&
			!!adaFile?.content.includes('Seeded bio for Ada.')
	);
	const ledger1 = await readPage(ledgerPath(SOURCE));
	check(
		'ledger committed with all keys',
		!!ledger1 && allKeys.every((k) => ledger1.content.includes(k))
	);

	// 2. Idempotency: same call again → no commit.
	console.log('idempotency:');
	const shaBefore = await headSha();
	r = await call('sync_records', {
		source: SOURCE,
		records: [ada, grace, acme, dupe],
		source_owned: OWNED,
		manifest: allKeys
	});
	check('re-sync reports in-sync', !r.isError && r.text.includes('already in sync'), r.text);
	check('no commit happened', (await headSha()) === shaBefore);

	// 3. Human curation survives a field update.
	console.log('human edits survive:');
	const curated = adaFile!.content
		.replace('---\n\n', '---\n\n> Curator note: verified 2026-07.\n\n')
		.replace('type: Contact', 'type: Contact\nnotes: prefers morning meetings');
	await humanWrite(ada.path, curated, 'Human curation');
	await replicationLag();
	r = await call('sync_records', {
		source: SOURCE,
		records: [{ ...ada, fields: { ...ada.fields, email: 'ada.lovelace@e2e.example' } }],
		source_owned: OWNED
	});
	check(
		'changed email updates',
		!r.isError &&
			(r.sc.updated as { changedFields: string[] }[])?.[0]?.changedFields.join() === 'email',
		r.text
	);
	await replicationLag();
	const adaAfter = await readPage(ada.path);
	check('human field survives', !!adaAfter?.content.includes('notes: prefers morning meetings'));
	check('human prose survives', !!adaAfter?.content.includes('Curator note: verified 2026-07.'));
	check(
		'source-owned field updated',
		!!adaAfter?.content.includes('email: ada.lovelace@e2e.example')
	);

	// 4. Consolidation: human deletes the dupe page → no resurrection.
	console.log('no resurrection:');
	await humanDelete(dupe.path, 'Consolidate duplicate org');
	await replicationLag();
	r = await call('sync_records', {
		source: SOURCE,
		records: [dupe],
		source_owned: OWNED,
		manifest: allKeys
	});
	check(
		'deleted page → needsDecision, not recreate',
		!r.isError && (r.sc.needsDecision as { key: string }[])?.some((d) => d.key === dupe.key),
		r.text
	);
	await replicationLag();
	check('dupe page still gone', (await readPage(dupe.path)) === null);
	const ledgerPending = await readPage(ledgerPath(SOURCE));
	check(
		'question persisted in the ledger',
		!!ledgerPending?.content.includes('"pending"') && !!ledgerPending?.content.includes(dupe.key)
	);
	r = await call('validate', {});
	check(
		'validate surfaces the pending decision',
		!r.isError && r.text.includes('decision(s) pending') && r.text.includes(dupe.key),
		r.text
	);

	// 5. Suppress the dupe key → re-sync goes quiet.
	console.log('suppress:');
	r = await call('resolve', {
		decisions: [{ finding: importKey(SOURCE, dupe.key), action: 'suppress' }]
	});
	check('suppress applied', !r.isError, r.text);
	await replicationLag();
	r = await call('validate', {});
	check('answered question leaves validate', !r.isError && !r.text.includes(dupe.key), r.text);
	r = await call('sync_records', { source: SOURCE, records: [dupe], source_owned: OWNED });
	check(
		'suppressed key skipped on re-sync',
		!r.isError &&
			(r.sc.suppressed as string[])?.includes(dupe.key) &&
			(r.sc.needsDecision as unknown[])?.length === 0,
		r.text
	);

	// 6. Alias: a human-authored page adopts a source key.
	console.log('alias adoption:');
	await humanWrite(
		'wiki/people/helen-keller.md',
		'---\ntitle: Helen Keller\ntype: Contact\n---\n\nHand-written page, made in the app.\n',
		'Human-created page'
	);
	await replicationLag();
	r = await call('resolve', {
		decisions: [
			{
				finding: importKey(SOURCE, 'helen@e2e.example'),
				action: 'alias',
				alias_to: 'wiki/people/helen-keller.md'
			}
		]
	});
	check('alias applied', !r.isError, r.text);
	await replicationLag();
	const helen = await readPage('wiki/people/helen-keller.md');
	check('page claims the key via source_keys', !!helen?.content.includes('helen@e2e.example'));
	r = await call('sync_records', {
		source: SOURCE,
		records: [
			{
				key: 'helen@e2e.example',
				fields: { title: 'Helen Keller', type: 'Contact', email: 'helen@e2e.example' }
			}
		],
		source_owned: OWNED
	});
	check(
		'record now UPDATES the adopted page (no create)',
		!r.isError &&
			(r.sc.created as unknown[])?.length === 0 &&
			(r.sc.updated as { path: string }[])?.some((u) => u.path === 'wiki/people/helen-keller.md'),
		r.text
	);
	await replicationLag();
	const helenAfter = await readPage('wiki/people/helen-keller.md');
	check(
		'adopted page keeps prose, gains email',
		!!helenAfter?.content.includes('Hand-written page') &&
			!!helenAfter?.content.includes('email: helen@e2e.example')
	);

	// 7. Deletion proposal + delete decision.
	console.log('proposed deletion:');
	const manifestWithoutGrace = [ada.key, acme.key, dupe.key, 'helen@e2e.example'];
	r = await call('sync_records', {
		source: SOURCE,
		records: [],
		source_owned: OWNED,
		manifest: manifestWithoutGrace
	});
	check(
		'absent key → proposed, page untouched',
		!r.isError && (r.sc.proposedDeletions as { key: string }[])?.some((d) => d.key === grace.key),
		r.text
	);
	check('grace page still exists', (await readPage(grace.path)) !== null);
	r = await call('resolve', {
		decisions: [{ finding: importKey(SOURCE, grace.key), action: 'delete' }]
	});
	check('delete decision applied', !r.isError, r.text);
	await replicationLag();
	check('grace page removed', (await readPage(grace.path)) === null);
	const ledgerFinal = await readPage(ledgerPath(SOURCE));
	const pendingFinal = ledgerFinal
		? (JSON.parse(ledgerFinal.content).pending as { key: string }[])
		: [];
	check(
		'delete decision cleared its pending entry',
		!!ledgerFinal && !pendingFinal.some((q) => q.key === grace.key)
	);

	// 8. Adoption: bind an existing hand-made page (the adopt-an-ETL-seeded-brain path).
	console.log('adoption:');
	await humanWrite(
		'wiki/people/ivan-petrov.md',
		'---\ntitle: Ivan Petrov\ntype: Contact\nnotes: met at HIMSS\n---\n\nHand-written, predates import keys.\n',
		'Human-created page (pre-key era)'
	);
	await replicationLag();
	const ivan = {
		key: 'ivan@e2e.example',
		path: 'wiki/people/ivan-petrov.md',
		fields: { title: 'Ivan Petrov', type: 'Contact', email: 'ivan@e2e.example' }
	};
	r = await call('sync_records', { source: SOURCE, records: [ivan], source_owned: OWNED });
	check(
		'clobber guard refuses without adopt_existing',
		!r.isError &&
			(r.sc.errors as { error: string }[])?.some((e) => e.error.includes('adopt_existing')),
		r.text
	);
	r = await call('sync_records', {
		source: SOURCE,
		records: [ivan],
		source_owned: OWNED,
		adopt_existing: true
	});
	check(
		'adopt_existing binds the page',
		!r.isError && (r.sc.adopted as unknown[])?.length === 1,
		r.text
	);
	await replicationLag();
	const ivanAfter = await readPage(ivan.path);
	check(
		'adopted page carries its source_key',
		!!ivanAfter?.content.includes('source_key: ivan@e2e.example'),
		ivanAfter?.content
	);
	r = await call('sync_records', { source: SOURCE, records: [ivan], source_owned: OWNED });
	check(
		'post-adoption re-sync is a clean no-op',
		!r.isError && r.text.includes('already in sync'),
		r.text
	);

	// 9. dry_run never writes.
	console.log('dry run:');
	const shaDry = await headSha();
	r = await call('sync_records', {
		source: SOURCE,
		records: [
			{ key: 'new@e2e.example', path: 'wiki/people/new.md', fields: { title: 'New Person' } }
		],
		source_owned: OWNED,
		dry_run: true
	});
	check('dry run plans a create', !r.isError && (r.sc.created as unknown[])?.length === 1, r.text);
	check('dry run writes nothing', (await headSha()) === shaDry);

	// Inside the try on purpose: `done()` sets process.exitCode rather than exiting,
	// so the finally below still deletes the scratch brain.
	done();
} finally {
	await brain.cleanup();
}
