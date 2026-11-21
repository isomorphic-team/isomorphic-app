// Golden test for search relevance — what a query matches, and what comes back
// first. Pure and offline: the ranking half runs on a corpus written by hand, the
// SQL half on D1 shimmed over node:sqlite. No network, no GitHub.
//
//   pnpm test:search
//
// Why this file exists (docs/design/search-relevance.md): search took the whole query
// as one opaque substring, ordered rows by path, and capped only the total hit count.
// So a question-shaped query matched nothing whatever the brain contained,
// alphabetical position stood in for relevance, and one page could eat the entire
// budget. Each section below pins one of those three, and asserts the FAILING
// direction as well — a check that passes against the old engine too is testing
// neither engine.

import {
	elisionNote,
	mergeBrainResults,
	rankPages,
	scorePage,
	signalsFromContent,
	tokenizeQuery,
	type SearchResult
} from '../src/lib/search.ts';
import { d1Index, indexFor, searchBrains } from '../src/lib/brain-index.ts';
import { reachableBrains, searchTargets, type BrainContext } from '../src/tools/librarian.ts';
import type { AccessibleBrain } from '../src/lib/orgs.ts';
import { INDEX_MIGRATIONS_DIR, localD1 } from '../src/local/d1-sqlite.ts';
import { searchIndexFts } from '../src/lib/search-fts-index.ts';
import { HL_CLOSE, HL_OPEN, linesFromHighlight } from '../src/lib/search-fts.ts';
import { timedSearch, type SearchLog } from '../src/lib/search-engine.ts';

import { checker } from './check.ts';

const { check, done } = checker('search checks');

// ------------------------------------------------- the pure helpers that remain ----
//
// The query tokenizer feeds FTS5. scorePage, rankPages and signalsFromContent rank pages
// held in memory; the consolidation pass uses them to find a page's nearest neighbours.

{
	const q = tokenizeQuery('What is our referral fee for the partners');
	check(
		'tokenizeQuery drops filler words and keeps the rest in order',
		q.terms.join() === 'referral,fee,partners',
		q.terms.join()
	);
	check(
		'tokenizeQuery keeps at most six terms',
		tokenizeQuery('alpha bravo charlie delta echo foxtrot golf hotel').terms.length === 6
	);
	check('tokenizeQuery lowercases the phrase', tokenizeQuery('Day Rate').phrase === 'day rate');

	const page = (path: string, title: string, content: string) => ({ path, title, content });
	const terms = tokenizeQuery('referral fee payout');
	const signals = [
		page('wiki/stuffed.md', 'Notes', 'referral referral referral referral referral referral'),
		page('wiki/real.md', 'Notes', 'The referral fee has a monthly payout.')
	].map((p) => signalsFromContent(p, terms));
	check(
		'rankPages puts the page holding more of the terms above one repeating a single term',
		rankPages(signals, terms.terms, terms.bigrams)[0]?.path === 'wiki/real.md'
	);
	const one = tokenizeQuery('budget');
	const [inBody, inTitle] = [
		page('wiki/a.md', 'Notes', 'Quarterly budget review.'),
		page('wiki/z.md', 'Budget', 'Quarterly budget review.')
	].map((p) => signalsFromContent(p, one));
	check(
		'scorePage counts a title match above a body match alone',
		scorePage(inTitle, one.terms, one.bigrams) > scorePage(inBody, one.terms, one.bigrams)
	);

	const shown = {
		hits: [],
		terms: ['x'],
		pagesMatched: 5,
		pagesShown: 2,
		linesElided: 4,
		budgetHit: false
	};
	const note = elisionNote(shown, { max: 50, perPage: 3 });
	check(
		'elisionNote says how many lines and pages were left out',
		note.includes('4 more on these pages') && note.includes('3 other page(s) also matched'),
		note
	);
	check(
		'elisionNote is empty when nothing was left out',
		elisionNote({ ...shown, pagesMatched: 2, linesElided: 0 }, { max: 50, perPage: 3 }) === ''
	);
}

// The index database's schema, where the full-text table lives.
const { db, sqlite } = localD1(':memory:', INDEX_MIGRATIONS_DIR);
const BRAIN = 'example-org/brain';

// ------------------------------------------------------------ across brains ----
//
// Two decisions, both of which fail SILENTLY rather than loudly, which is why each has
// its failing direction asserted:
//
//   searchTargets      WHICH brains a search reaches. Wrong, and one client's material
//                      appears in another client's conversation, or a search claims to
//                      span brains while quietly answering for one.
//   mergeBrainResults  HOW the global ceiling is spent across those brains. The failure
//                      is a fan-out where the first brain fills the cap and every later
//                      brain reports nothing, which reads as "the others have no
//                      matches" rather than "we stopped looking".

function result(paths: string[], budgetHit = false): SearchResult {
	return {
		hits: paths.map((path, i) => ({ path, line: i + 1, text: path })),
		terms: ['x'],
		pagesMatched: paths.length,
		pagesShown: paths.length,
		linesElided: 0,
		budgetHit
	};
}

{
	// The loud brain has 40 hits of its own; the quiet one has 3. A ceiling of 20 taken
	// in order would be spent entirely on the loud one.
	const loud = result(Array.from({ length: 40 }, (_, i) => `wiki/loud-${i}.md`));
	const quiet = result(['wiki/q1.md', 'wiki/q2.md', 'wiki/q3.md']);
	const m = mergeBrainResults(
		[
			{ brainId: 'acme/wiki', result: loud },
			{ brainId: 'northwind/wiki', result: quiet }
		],
		20
	);
	const nw = m.hits.filter((h) => h.brainId === 'northwind/wiki');
	check('the quiet brain keeps every one of its hits under the ceiling', nw.length === 3);
	check('the ceiling holds', m.hits.length === 20, `${m.hits.length}`);
	check('and hitting it is reported', m.budgetHit);
	// Grouped for reading, in the caller's order, even though selection interleaved.
	const ids = m.hits.map((h) => h.brainId);
	check(
		'hits are grouped by brain, caller order',
		ids.lastIndexOf('acme/wiki') < ids.indexOf('northwind/wiki'),
		JSON.stringify(ids)
	);
	const loudOut = m.hits.filter((h) => h.brainId === 'acme/wiki').map((h) => h.path);
	check(
		"within a brain the engine's rank order survives",
		loudOut.every((p, i) => p === `wiki/loud-${i}.md`),
		JSON.stringify(loudOut)
	);
	check('pagesMatched sums across brains', m.pagesMatched === 43, `${m.pagesMatched}`);
}

{
	// One brain: the identity. This is what keeps the single-brain search byte-identical
	// to what it was before fan-out existed.
	const one = result(['wiki/b.md', 'wiki/a.md', 'wiki/c.md']);
	const m = mergeBrainResults([{ brainId: 'acme/wiki', result: one }], 50);
	check(
		'one brain comes back exactly as ranked',
		JSON.stringify(m.hits.map((h) => h.path)) ===
			JSON.stringify(['wiki/b.md', 'wiki/a.md', 'wiki/c.md'])
	);
	check('and no budget is reported hit', !m.budgetHit);
	check(
		"a brain's own budgetHit is carried through",
		mergeBrainResults([{ brainId: 'x', result: result(['a'], true) }], 50).budgetHit
	);
	check('no brains, no hits', mergeBrainResults([], 50).hits.length === 0);
}

{
	// Through the real SQL path, three brains in one D1, deliberately lopsided. The
	// third brain matches the needle and is in nobody's list, which is what makes
	// isolation an assertion rather than a tautology.
	sqlite.prepare('DELETE FROM brain_pages').run();
	const ins = sqlite.prepare(
		'INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)'
	);
	for (let i = 0; i < 60; i++) {
		const path = `wiki/acme-${String(i).padStart(2, '0')}.md`;
		ins.run('acme/wiki', path, `Page ${i}`, 'sha-' + path, '# Page\nthe kickoff plan\n');
	}
	ins.run('northwind/wiki', 'wiki/kickoff.md', 'Kickoff', 's1', '# Kickoff\nthe kickoff agenda\n');
	ins.run(
		'northwind/wiki',
		'wiki/notes/later.md',
		'Later',
		's2',
		'nothing here\nkickoff follow-up\n'
	);
	ins.run(
		'private/wiki',
		'wiki/secret.md',
		'Secret',
		's3',
		'# Secret\nthe kickoff nobody may see\n'
	);

	const wide = await searchBrains(
		['acme/wiki', 'northwind/wiki'].map(d1Index(db)),
		'kickoff',
		undefined,
		{
			perBrain: 15,
			total: 50
		}
	);
	check(
		'a brain absent from the list contributes nothing',
		!wide.hits.some((h) => h.brainId === 'private/wiki')
	);
	const nw = wide.hits.filter((h) => h.brainId === 'northwind/wiki');
	const acme = wide.hits.filter((h) => h.brainId === 'acme/wiki');
	check('the quiet brain still reports its hits', nw.length >= 2, `got ${nw.length}`);
	check('the loud brain is held to its own budget', acme.length === 15, `got ${acme.length}`);
	check(
		'every hit names its brain',
		wide.hits.every((h) => h.brainId)
	);
	check(
		'per-brain results ride along for per-brain notes',
		wide.perBrain.get('northwind/wiki')?.pagesMatched === 2,
		`${wide.perBrain.get('northwind/wiki')?.pagesMatched}`
	);
	check('the terms are reported once', wide.terms.includes('kickoff'), JSON.stringify(wide.terms));

	const scoped = await searchBrains(['northwind/wiki'].map(d1Index(db)), 'kickoff', 'wiki/notes/', {
		perBrain: 50,
		total: 50
	});
	check(
		'prefix restricts to a subtree, per brain',
		scoped.hits.length === 1 && scoped.hits[0].path === 'wiki/notes/later.md',
		JSON.stringify(scoped.hits)
	);
	const none = await searchBrains([].map(d1Index(db)), 'kickoff', undefined, {
		perBrain: 50,
		total: 50
	});
	check('no brains means no hits', none.hits.length === 0);
}

// reachableBrains: whose pages a report of findings may quote.
{
	const opened: string[] = [];
	const openIndex = ((brainId: string) => {
		opened.push(brainId);
		return { pageShas: async () => new Map([['a.md', `sha-${brainId}`]]) };
	}) as unknown as BrainContext['openIndex'];
	const row = (id: string, name: string) =>
		({ id, brain_id: `brain-${id}`, repo_owner: 'o', repo_name: id, name }) as AccessibleBrain;
	const deps = { listBrains: async () => [row('legal', 'Legal'), row('handbook', 'Handbook')] };

	const got = await reachableBrains(['brain-handbook', 'brain-closed'], deps, openIndex);
	check(
		'findings may quote exactly the wanted brains the caller can open',
		got.size === 1 &&
			got.get('brain-handbook')?.handle === 'handbook' &&
			got.get('brain-handbook')?.shas.get('a.md') === 'sha-brain-handbook',
		JSON.stringify([...got])
	);
	check(
		'only those brains have their index read',
		JSON.stringify(opened) === JSON.stringify(['brain-handbook'])
	);
	check(
		'with no brain list, no other brain is reachable',
		(await reachableBrains(['brain-handbook'], undefined, openIndex)).size === 0
	);
	check(
		'nor when the brain list cannot be read',
		(
			await reachableBrains(
				['brain-handbook'],
				{
					listBrains: async () => {
						throw new Error('down');
					}
				},
				openIndex
			)
		).size === 0
	);
	opened.length = 0;
	check(
		'and nothing is looked up when no finding names another brain',
		(await reachableBrains([], deps, openIndex)).size === 0 && opened.length === 0
	);
}

// searchTargets: which brains a fan-out is allowed to reach.
// The index key (`brain_id`) and the handle differ on purpose, so a target built from
// the wrong one is visible.
const keyOf = (id: string) => `brain-${id.replace('/', '-')}`;
function ctxFor(id: string, label: string): BrainContext {
	return { brainId: keyOf(id), activeBrain: { id, label } } as BrainContext;
}
function brain(id: string, name: string): AccessibleBrain {
	const [repo_owner, repo_name] = id.split('/');
	return { id, brain_id: keyOf(id), repo_owner, repo_name, name } as AccessibleBrain;
}

{
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), undefined);
	check('with no wiring, a search reaches exactly the brain you are in', t.length === 1);
	check(
		'and it is labelled',
		t[0].handle === 'acme/wiki' && t[0].label === 'Acme',
		JSON.stringify(t)
	);
	check(
		'it searches the index under the brain_id, not the handle',
		t[0].key === 'brain-acme-wiki',
		JSON.stringify(t)
	);
}

{
	const deps = {
		listBrains: async () => [
			brain('northwind/wiki', 'Northwind'),
			brain('acme/wiki', 'Acme'),
			brain('personal/brain', 'Personal')
		]
	};
	const t = await searchTargets(ctxFor('acme/wiki', 'Acme'), deps);
	check(
		'fanning out reaches every accessible brain',
		t.length === 3,
		JSON.stringify(t.map((x) => x.handle))
	);
	// Leading matters twice over: the active brain wins the round-robin under the global
	// cap, and it reads first in the output.
	check(
		'the active brain leads',
		t[0].handle === 'acme/wiki',
		JSON.stringify(t.map((x) => x.handle))
	);
	check(
		'and is not listed twice',
		t.filter((x) => x.handle === 'acme/wiki').length === 1,
		JSON.stringify(t.map((x) => x.handle))
	);
	check(
		'the others carry their index key, handle and display name',
		t.some(
			(x) =>
				x.key === 'brain-northwind-wiki' && x.handle === 'northwind/wiki' && x.label === 'Northwind'
		),
		JSON.stringify(t)
	);
}

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
		t.length === 1 && t[0].handle === 'acme/wiki'
	);
}

// ------------------------------------------------------------------- FTS5 ----
//
// searchIndexFts answers the same contract through SQLite FTS5. Coverage still decides
// first; BM25 (rare terms count for more, title weighted) orders within a coverage band,
// and porter stemming lets a plural find a singular. node:sqlite ships FTS5, so this
// runs the real thing.

{
	const fts = [
		...Array.from({ length: 6 }, (_, i) => ({
			path: `wiki/updates/update-${i}.md`,
			title: `Update ${i}`,
			content: `# Update ${i}\nThe project moved forward this week.`
		})),
		{
			path: 'wiki/vendors/northwind.md',
			title: 'Shortlist',
			content: '# Shortlist\nNorthwind vendor shortlist.'
		},
		{
			path: 'wiki/vendors/both.md',
			title: 'Kickoff',
			content: `# Kickoff\n${'Long notes from the session. '.repeat(40)}\nProject kickoff with Northwind.`
		},
		{
			path: 'wiki/vendors/heavy.md',
			title: 'Heavy',
			content: '# Heavy\nNorthwind Northwind Northwind Northwind Northwind Northwind.'
		},
		{
			path: 'wiki/finance/referral.md',
			title: 'Referral',
			content:
				'---\ntype: policy\n---\n# Referral\n\nThe referral fee is 10 percent.\nPaid monthly.'
		},
		{ path: 'wiki/feedback.md', title: 'Feedback', content: 'Customer feedback log.' },
		{ path: 'wiki/a-notes.md', title: 'Notes', content: 'Quarterly budget review.' },
		{ path: 'wiki/z-q3.md', title: 'Budget', content: 'Quarterly budget review.' }
	];
	// The index database's schema, where the full-text table and its triggers live.
	const { db, sqlite } = localD1(':memory:', INDEX_MIGRATIONS_DIR);
	for (const p of fts) {
		sqlite
			.prepare(
				'INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES (?, ?, ?, ?, ?)'
			)
			.run(BRAIN, p.path, p.title, 'sha-' + p.path, p.content);
	}

	const rare = await searchIndexFts(db, BRAIN, 'northwind project', undefined, 50);
	const order = [...new Set(rare.hits.map((h) => h.path))];
	check(
		'fts: a page holding every term ranks first',
		order[0] === 'wiki/vendors/both.md',
		JSON.stringify(order)
	);
	check(
		'fts: within a coverage band the rare term outranks the common one',
		order.indexOf('wiki/vendors/northwind.md') <
			order.findIndex((p) => p.startsWith('wiki/updates/')),
		JSON.stringify(order)
	);

	const stem = await searchIndexFts(db, BRAIN, 'fees', undefined, 50);
	check(
		'fts: a plural query finds the singular, on the right line',
		stem.hits[0]?.path === 'wiki/finance/referral.md' &&
			stem.hits.some((h) => h.line === 6 && h.text === 'The referral fee is 10 percent.'),
		JSON.stringify(stem.hits)
	);

	// "north" is not the stem of "Northwind" and no page holds it as a word, so only the
	// prefix retry can find it.
	const partial = await searchIndexFts(db, BRAIN, 'north', undefined, 50);
	check(
		'fts: a search no page matches as words matches as the starts of words',
		partial.hits.some((h) => h.path === 'wiki/vendors/northwind.md'),
		JSON.stringify(partial.hits)
	);
	const whole = await searchIndexFts(db, BRAIN, 'fee', undefined, 50);
	check(
		'fts: a term some page holds as a word is not widened to a prefix',
		whole.hits.length > 0 && whole.hits.every((h) => h.path === 'wiki/finance/referral.md'),
		JSON.stringify(whole.hits)
	);

	const titled = await searchIndexFts(db, BRAIN, 'budget', undefined, 50);
	check(
		'fts: a title match counts, breaking a tie that path order would break the other way',
		titled.hits[0]?.path === 'wiki/z-q3.md',
		JSON.stringify(titled.hits)
	);

	const scoped = await searchIndexFts(db, BRAIN, 'northwind', 'wiki/vendors/both', 50);
	check(
		'fts: a prefix restricts to a subtree',
		scoped.hits.length > 0 && scoped.hits.every((h) => h.path.startsWith('wiki/vendors/both')),
		JSON.stringify(scoped.hits)
	);

	let threw = false;
	try {
		await searchIndexFts(db, BRAIN, 'NEAR( "budget 50% AND OR *', undefined, 50);
	} catch {
		threw = true;
	}
	check('fts: query text is never read as FTS5 syntax', !threw);

	check(
		'fts: highlight lines strip the markers and keep line numbers',
		JSON.stringify(
			linesFromHighlight(
				`a\n${HL_OPEN}x${HL_CLOSE} and ${HL_OPEN}y${HL_CLOSE}\nb ${HL_OPEN}x${HL_CLOSE}`
			)
		) ===
			JSON.stringify([
				{ line: 2, text: 'x and y', matched: 2 },
				{ line: 3, text: 'b x', matched: 1 }
			])
	);
}

// ------------------------------------------------------------ the search log ----
//
// timedSearch returns the engine's result and logs a line that names no query, path
// or brain.
{
	const result: SearchResult = {
		hits: [{ path: 'wiki/secret.md', line: 1, text: 'secret text' }],
		terms: ['alpha', 'beta'],
		pagesMatched: 1,
		pagesShown: 1,
		linesElided: 0,
		budgetHit: false
	};
	const lines: SearchLog[] = [];
	let clock = 0;
	const got = await timedSearch(
		async () => {
			clock += 42;
			return result;
		},
		(l) => void lines.push(l),
		() => clock
	);
	check("log: the result is the engine's", got === result);
	check(
		'log: one line with the term count, pages matched and time taken',
		lines.length === 1 && lines[0].terms === 2 && lines[0].pages === 1 && lines[0].ms === 42,
		JSON.stringify(lines)
	);
	check(
		'log: the line carries no query term, path or line text',
		!/alpha|beta|\.md|secret/.test(JSON.stringify(lines)),
		JSON.stringify(lines)
	);
	check(
		'log: a log that throws does not cost the answer',
		(await timedSearch(
			async () => result,
			() => {
				throw new Error('log sink down');
			}
		)) === result
	);
	let threw = false;
	try {
		await timedSearch(
			async () => {
				throw new Error('index unavailable');
			},
			(l) => void lines.push(l)
		);
	} catch {
		threw = true;
	}
	check('log: a failing search reaches the caller', threw);

	// The wiring: a deployment's index is its INDEX_DB, searched by FTS5. "fees" finds
	// "fee" only by stemming.
	const { db: own, sqlite: ownSql } = localD1(':memory:', INDEX_MIGRATIONS_DIR);
	ownSql
		.prepare(
			"INSERT INTO brain_pages (brain_id, path, title, blob_sha, content) VALUES ('b', 'wiki/fee.md', 'Fee', 's', 'The fee is ten.')"
		)
		.run();
	const realLog = console.log;
	console.log = () => {};
	let answered: SearchResult;
	let symbols: SearchResult;
	try {
		answered = await indexFor({ INDEX_DB: own })('b').search('fees', undefined, 50);
		symbols = await indexFor({ INDEX_DB: own })('b').search('%% __', undefined, 50);
	} finally {
		console.log = realLog;
	}
	check(
		"wiring: a brain's index answers from FTS5 in INDEX_DB",
		answered.hits[0]?.path === 'wiki/fee.md',
		JSON.stringify(answered.hits)
	);
	check('wiring: a query of symbols alone finds nothing', symbols.hits.length === 0);
}

done();
