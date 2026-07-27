// Manual end-to-end battery for the bulk importer (sync_records / resolve_import).
//
// NOT wired into CI (per the test-harness skip list — no real-GitHub E2E in CI).
// Run by hand when the import path changes:
//
//   pnpm exec tsx scripts/e2e-import.ts
//
// Mirrors e2e-librarian.ts: requires `.dev.vars` with platform App creds +
// PLATFORM_ORG / PLATFORM_INSTALLATION_ID, creates a scratch brain repo on the
// platform org, drives the REAL tool handlers through an in-memory MCP client,
// and deletes the repo afterwards (success or failure). The content index runs
// on a real SQLite database via node:sqlite (Node 22+), shimmed to the D1
// surface brain-index uses — so ensureFresh / key discovery run for real.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerImportTools } from '../src/tools/importer.ts';
import { registerLibrarianTools } from '../src/tools/librarian.ts';
import { installationOctokit } from '../src/lib/github.ts';
import { createAndScaffoldBrain } from '../src/lib/scaffold-core.ts';
import { loadBrainConfig } from '../src/lib/brain-config.ts';
import { ledgerPath } from '../src/lib/brain-import.ts';
import { utf8ToBase64, base64ToUtf8 } from '../src/lib/wiki.ts';

// ---- env from .dev.vars (values may be quoted) ----
const devVarsPath = process.env.DEV_VARS_PATH ?? new URL('../.dev.vars', import.meta.url).pathname;
const devVars: Record<string, string> = {};
for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
	if (!m) continue;
	devVars[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
}
const org = devVars.PLATFORM_ORG;
const installationId = Number(devVars.PLATFORM_INSTALLATION_ID);
if (!org || !installationId) throw new Error('PLATFORM_ORG / PLATFORM_INSTALLATION_ID missing');

const octokit = await installationOctokit(
	{ appId: Number(devVars.GITHUB_APP_ID), privateKeyBase64: devVars.GITHUB_APP_PRIVATE_KEY_BASE64 },
	installationId
);

// ---- D1 shim over node:sqlite (only the surface brain-index uses) ----
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../src/db/index-schema.sql', import.meta.url), 'utf8'));
function shimStatement(sql: string, params: unknown[] = []) {
	return {
		bind: (...p: unknown[]) => shimStatement(sql, p),
		first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
		all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
		run: async () => {
			sqlite.prepare(sql).run(...(params as []));
			return { success: true };
		}
	};
}
const db = {
	prepare: (sql: string) => shimStatement(sql),
	batch: async (stmts: { run: () => Promise<unknown> }[]) => {
		for (const s of stmts) await s.run();
		return [];
	}
} as never;

// ---- scratch repo ----
const name = `brain-import-e2e-${Date.now().toString(36)}`;
console.log(`Creating scratch brain ${org}/${name} …`);
const brain = await createAndScaffoldBrain(octokit, {
	org,
	name,
	description: 'Import E2E test — safe to delete'
});
const repoArgs = { owner: brain.owner, repo: brain.name };
const brainId = `${brain.owner}/${brain.name}`;

// ---- in-memory MCP client wired to the real handlers ----
const server = new McpServer({ name: 'import-e2e', version: '0.0.0' });
const getContext = async () => ({
	octokit,
	repoArgs,
	role: 'owner' as const,
	config: await loadBrainConfig(octokit, repoArgs),
	author: undefined,
	db,
	brainId,
	activeBrain: { id: brainId, label: name }
});
registerImportTools(server, getContext);
registerLibrarianTools(server, getContext); // for validate (pending-decision surfacing)
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(clientTransport);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

interface CallResult {
	isError: boolean;
	text: string;
	sc: Record<string, unknown>;
}
async function call(tool: string, args: Record<string, unknown>): Promise<CallResult> {
	const r = (await client.callTool({ name: tool, arguments: args })) as {
		isError?: boolean;
		content?: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
	};
	return {
		isError: !!r.isError,
		text: r.content?.find((c) => c.type === 'text')?.text ?? '',
		sc: r.structuredContent ?? {}
	};
}

// Direct GitHub helpers for simulating a human curator.
async function ghRead(path: string): Promise<{ content: string; sha: string } | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ ...repoArgs, path });
		if (Array.isArray(data) || data.type !== 'file') return null;
		return { content: base64ToUtf8(data.content), sha: data.sha };
	} catch {
		return null;
	}
}
async function ghWrite(path: string, content: string, message: string) {
	const existing = await ghRead(path);
	await octokit.rest.repos.createOrUpdateFileContents({
		...repoArgs,
		path,
		message,
		content: utf8ToBase64(content),
		...(existing ? { sha: existing.sha } : {})
	});
}
async function ghDelete(path: string, message: string) {
	const existing = await ghRead(path);
	if (!existing) throw new Error(`cannot delete missing ${path}`);
	await octokit.rest.repos.deleteFile({ ...repoArgs, path, message, sha: existing.sha });
}
async function headSha(): Promise<string> {
	const { data } = await octokit.rest.git.getRef({ ...repoArgs, ref: 'heads/main' });
	return data.object.sha;
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
	await sleep(1500);
	const adaFile = await ghRead(ada.path);
	check(
		'page exists with source_key + body',
		!!adaFile?.content.includes('source_key: ada@e2e.example') &&
			!!adaFile?.content.includes('Seeded bio for Ada.')
	);
	const ledger1 = await ghRead(ledgerPath(SOURCE));
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
	await ghWrite(ada.path, curated, 'Human curation');
	await sleep(1500);
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
	await sleep(1500);
	const adaAfter = await ghRead(ada.path);
	check('human field survives', !!adaAfter?.content.includes('notes: prefers morning meetings'));
	check('human prose survives', !!adaAfter?.content.includes('Curator note: verified 2026-07.'));
	check(
		'source-owned field updated',
		!!adaAfter?.content.includes('email: ada.lovelace@e2e.example')
	);

	// 4. Consolidation: human deletes the dupe page → no resurrection.
	console.log('no resurrection:');
	await ghDelete(dupe.path, 'Consolidate duplicate org');
	await sleep(1500);
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
	await sleep(1500);
	check('dupe page still gone', (await ghRead(dupe.path)) === null);
	const ledgerPending = await ghRead(ledgerPath(SOURCE));
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
	r = await call('resolve_import', {
		source: SOURCE,
		decisions: [{ key: dupe.key, action: 'suppress' }]
	});
	check('suppress applied', !r.isError, r.text);
	await sleep(1500);
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
	await ghWrite(
		'wiki/people/helen-keller.md',
		'---\ntitle: Helen Keller\ntype: Contact\n---\n\nHand-written page, made in the app.\n',
		'Human-created page'
	);
	await sleep(1500);
	r = await call('resolve_import', {
		source: SOURCE,
		decisions: [
			{ key: 'helen@e2e.example', action: 'alias', alias_to: 'wiki/people/helen-keller.md' }
		]
	});
	check('alias applied', !r.isError, r.text);
	await sleep(1500);
	const helen = await ghRead('wiki/people/helen-keller.md');
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
	await sleep(1500);
	const helenAfter = await ghRead('wiki/people/helen-keller.md');
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
	check('grace page still exists', (await ghRead(grace.path)) !== null);
	r = await call('resolve_import', {
		source: SOURCE,
		decisions: [{ key: grace.key, action: 'delete' }]
	});
	check('delete decision applied', !r.isError, r.text);
	await sleep(1500);
	check('grace page removed', (await ghRead(grace.path)) === null);
	const ledgerFinal = await ghRead(ledgerPath(SOURCE));
	const pendingFinal = ledgerFinal
		? (JSON.parse(ledgerFinal.content).pending as { key: string }[])
		: [];
	check(
		'delete decision cleared its pending entry',
		!!ledgerFinal && !pendingFinal.some((q) => q.key === grace.key)
	);

	// 8. Adoption: bind an existing hand-made page (the adopt-an-ETL-seeded-brain path).
	console.log('adoption:');
	await ghWrite(
		'wiki/people/ivan-petrov.md',
		'---\ntitle: Ivan Petrov\ntype: Contact\nnotes: met at HIMSS\n---\n\nHand-written, predates import keys.\n',
		'Human-created page (pre-key era)'
	);
	await sleep(1500);
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
	await sleep(1500);
	const ivanAfter = await ghRead(ivan.path);
	check(
		'adopted page: key bound, fields merged, human content intact',
		!!ivanAfter?.content.includes('source_key: ivan@e2e.example') &&
			!!ivanAfter?.content.includes('email: ivan@e2e.example') &&
			!!ivanAfter?.content.includes('notes: met at HIMSS') &&
			!!ivanAfter?.content.includes('Hand-written, predates import keys.')
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

	if (failures) {
		console.error(`\n${failures} check(s) FAILED`);
		process.exitCode = 1;
	} else {
		console.log('\nAll import E2E checks passed.');
	}
} finally {
	console.log(`Deleting scratch repo ${org}/${name} …`);
	try {
		await octokit.rest.repos.delete(repoArgs);
		console.log('Deleted.');
	} catch (err) {
		console.error(
			`Could not delete (${(err as { status?: number }).status}) — delete manually: https://github.com/${org}/${name}/settings`
		);
	}
}
