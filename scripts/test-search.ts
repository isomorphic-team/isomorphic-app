// Golden test for cross-brain search — PURE, no network. D1 is shimmed over
// node:sqlite from the real migrations.
//
// Two pieces of logic, both of which decide what one answer is allowed to contain:
//
//   searchTargets  — WHICH brains a search reaches. Get this wrong and one client's
//                    material appears in another client's conversation, or a legitimate
//                    search silently answers for one brain while claiming to span them.
//   searchIndex    — HOW hits are budgeted across those brains. The failure this exists
//                    to catch is not an error: it is a fan-out where the first brain
//                    fills a global cap and every later brain reports nothing, which
//                    reads as "the others have no matches" rather than "we stopped
//                    looking". Silent, plausible, and wrong.
//
//   pnpm test:search

import { DatabaseSync } from 'node:sqlite';
import { searchIndex } from '../src/lib/brain-index.ts';
import { searchTargets } from '../src/tools/librarian.ts';
import { applyMigrations } from '../src/local/d1-sqlite.ts';
import type { BrainContext } from '../src/tools/librarian.ts';
import type { AccessibleBrain } from '../src/lib/orgs.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

// ---- D1 shim over node:sqlite ----

const sqlite = new DatabaseSync(':memory:');
applyMigrations(sqlite);

function shimStatement(sql: string, params: unknown[] = []): any {
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
const db = { prepare: (sql: string) => shimStatement(sql) } as never;

function addPage(brainId: string, path: string, content: string) {
	sqlite
		.prepare(
			`INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)`
		)
		.run(brainId, path, path, `sha-${brainId}-${path}`, content);
}

// ---- fixtures: three brains, deliberately lopsided ----
//
// `acme/wiki` is the loud one: 60 pages that all mention the needle, more than enough to
// exhaust a 50-hit global cap on its own. `northwind/wiki` is the quiet one: three mentions, total.
// `private/wiki` exists in the same D1 and is never in anyone's accessible set, which
// is what makes "isolation" a real assertion rather than a tautology.

for (let i = 0; i < 60; i++) {
	addPage('acme/wiki', `wiki/acme-${String(i).padStart(2, '0')}.md`, `# Page\nthe kickoff plan\n`);
}
addPage('northwind/wiki', 'wiki/kickoff.md', '# Kickoff\nthe kickoff agenda\n');
addPage('northwind/wiki', 'wiki/notes/later.md', 'nothing here\nkickoff follow-up\n');
addPage('private/wiki', 'wiki/secret.md', '# Secret\nthe kickoff nobody may see\n');
// Literal-wildcard page, for the LIKE-escaping assertion.
addPage('acme/wiki', 'wiki/pct.md', 'growth was 50% last year\n');

const WIDE = { perBrain: 15, total: 50 };
const NARROW = { perBrain: 50, total: 50 };

console.log('\nsearchIndex: one brain');
{
	const hits = await searchIndex(db, ['northwind/wiki'], 'kickoff', undefined, NARROW);
	check('finds every matching line', hits.length === 3, `got ${hits.length}`);
	check(
		'reports the line number and the trimmed text',
		hits.some((h) => h.path === 'wiki/kickoff.md' && h.line === 1 && h.text === '# Kickoff') &&
			hits.some((h) => h.path === 'wiki/kickoff.md' && h.line === 2),
		JSON.stringify(hits)
	);
	check(
		'every hit names the brain it came from',
		hits.every((h) => h.brainId === 'northwind/wiki')
	);
	check(
		'no other brain leaks in',
		!hits.some((h) => h.brainId !== 'northwind/wiki'),
		JSON.stringify(hits.map((h) => h.brainId))
	);
}

console.log('\nsearchIndex: isolation is by brain, not by filtering afterwards');
{
	const hits = await searchIndex(db, ['acme/wiki', 'northwind/wiki'], 'kickoff', undefined, WIDE);
	check(
		'a brain absent from the list contributes nothing',
		!hits.some((h) => h.brainId === 'private/wiki'),
		'private/wiki matched the needle and must still be invisible'
	);
	const none = await searchIndex(db, [], 'kickoff', undefined, WIDE);
	check('no brains means no hits, and no query', none.length === 0);
}

console.log('\nsearchIndex: the prefix and the LIKE escape');
{
	const scoped = await searchIndex(db, ['northwind/wiki'], 'kickoff', 'wiki/notes/', NARROW);
	check(
		'prefix restricts to a subtree',
		scoped.length === 1 && scoped[0].path === 'wiki/notes/later.md',
		JSON.stringify(scoped)
	);
	// '%' is a LIKE wildcard: unescaped, "50%" would coarse-match every page and the
	// in-Worker line filter would then reject them all, so this passing by accident is
	// possible — assert the hit itself, not just the count.
	const pct = await searchIndex(db, ['acme/wiki'], '50%', undefined, NARROW);
	check(
		'a wildcard in the query is matched literally',
		pct.length === 1 && pct[0].path === 'wiki/pct.md',
		JSON.stringify(pct)
	);
}

console.log('\nsearchIndex: a loud brain cannot starve a quiet one');
{
	const hits = await searchIndex(db, ['acme/wiki', 'northwind/wiki'], 'kickoff', undefined, WIDE);
	const acme = hits.filter((h) => h.brainId === 'acme/wiki');
	const nw = hits.filter((h) => h.brainId === 'northwind/wiki');
	// THE REGRESSION. Under one global cap taken in path order, acme/wiki (40 matching
	// matching pages, sorted first) fills all 50 slots and northwind contributes zero — the
	// answer then says northwind has nothing to say about the kickoff, which is false.
	check('the quiet brain still reports its hits', nw.length === 3, `got ${nw.length}`);
	check('the loud brain is held to its own budget', acme.length === 15, `got ${acme.length}`);
	check('the global ceiling still holds', hits.length <= WIDE.total, `got ${hits.length}`);
}

console.log('\nsearchIndex: presentation order');
{
	const hits = await searchIndex(db, ['northwind/wiki', 'acme/wiki'], 'kickoff', undefined, WIDE);
	const firstOther = hits.findIndex((h) => h.brainId !== 'northwind/wiki');
	const lastFirst = hits.map((h) => h.brainId).lastIndexOf('northwind/wiki');
	check(
		'hits are grouped by brain, in the order the caller asked for them',
		lastFirst < firstOther,
		'selection is interleaved for fairness; output must not be'
	);
	const nw = hits.filter((h) => h.brainId === 'northwind/wiki');
	check(
		'and sorted by path, then line, within a brain',
		nw.every(
			(h, i) =>
				i === 0 || nw[i - 1].path < h.path || (nw[i - 1].path === h.path && nw[i - 1].line < h.line)
		),
		JSON.stringify(nw.map((h) => `${h.path}:${h.line}`))
	);
}

console.log('\nsearchIndex: one brain behaves exactly as it did before fan-out');
{
	// The two limits collapse when there is one brain, so a single-brain search must be
	// byte-identical to the pre-fan-out behaviour: path order, capped at the total.
	const hits = await searchIndex(db, ['acme/wiki'], 'kickoff', undefined, NARROW);
	check(
		'capped at the total, not at a smaller per-brain budget',
		hits.length === 50,
		`got ${hits.length}`
	);
	const paths = hits.map((h) => h.path);
	check(
		'still in path order',
		paths.every((p, i) => i === 0 || paths[i - 1] <= p)
	);
}

// ---- searchTargets: which brains a fan-out is allowed to reach ----

function ctxFor(id: string, label: string): BrainContext {
	return { brainId: id, activeBrain: { id, label } } as BrainContext;
}
function brain(id: string, name: string): AccessibleBrain {
	const [repo_owner, repo_name] = id.split('/');
	return { id, repo_owner, repo_name, name } as AccessibleBrain;
}

console.log('\nsearchTargets: the default never fans out');
{
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), undefined);
	check('with no wiring, a search reaches exactly the brain you are in', t.length === 1);
	check('and it is labelled', t[0].id === 'acme/wiki' && t[0].label === 'Acme', JSON.stringify(t));
}

console.log('\nsearchTargets: fanning out');
{
	const deps = {
		listBrains: async () => [
			brain('northwind/wiki', 'Northwind'),
			brain('acme/wiki', 'Acme'),
			brain('personal/brain', 'Personal')
		]
	};
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), deps);
	check('reaches every accessible brain', t.length === 3, JSON.stringify(t.map((x) => x.id)));
	// Leading matters twice over: the active brain wins the round-robin under the global
	// cap, and it reads first in the output.
	check('the active brain leads', t[0].id === 'acme/wiki', JSON.stringify(t.map((x) => x.id)));
	check(
		'and is not listed twice',
		t.filter((x) => x.id === 'acme/wiki').length === 1,
		JSON.stringify(t.map((x) => x.id))
	);
	check(
		'the others carry their display names',
		t.some((x) => x.id === 'northwind/wiki' && x.label === 'Northwind'),
		JSON.stringify(t)
	);
}

console.log('\nsearchTargets: degrading rather than failing');
{
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), {
		listBrains: async () => {
			throw new Error('D1 unavailable');
		}
	});
	// A search that can still answer for the brain you are IN must not fail because the
	// wider set could not be resolved.
	check(
		'a broken brain list falls back to the active brain',
		t.length === 1 && t[0].id === 'acme/wiki'
	);
}

console.log(
	failures === 0 ? '\nAll search checks passed.' : `\n${failures} search check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
