// Golden test for the loading-line engine. Pure: no DOM, no clock.
//
//   pnpm test:loading
//
// What is actually at risk here is not "does a joke render". It is that a phrase
// naming something the widget does not know renders anyway. A loading line is the one
// piece of copy in the app nobody reviews before a user sees it, it is drawn on the
// path where the app knows LEAST (a cold open has no brain list, no tree, no org), and
// its failure mode is a customer reading "Asking undefined…" while they wait. So the
// eligibility rule gets walked exhaustively, from the templates themselves rather than
// from a list copied beside them: a new template with a new slot is covered the moment
// it is written.
//
// The second thing pinned here is the WIRING, for the same reason test:usage scans the
// tool sources: `task` is optional on the loading view (it has to be, or the type would
// otherwise be a breaking change to every call site at once), so an omitted one is not
// a type error. It is a screen that quietly falls back to the generic pool and stops
// naming anything the user is looking at, which is invisible in review and invisible in
// a screenshot.

import { readFileSync } from 'node:fs';
import {
	loadingLines,
	possessive,
	clip,
	groupDigits,
	hashSeed,
	MAX_LINES,
	WARM,
	POOL,
	POOL_BY_TASK,
	type LoadingTask,
	type LoadingFacts
} from '../src/lib/loading-lines.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
	}
}

const TASKS = Object.keys(WARM) as LoadingTask[];
const FULL: LoadingFacts = {
	brain: 'Acme Ops',
	org: 'Acme Labs',
	subject: 'Weekly Sync',
	pages: 1234
};

console.log('\nEvery task, with nothing known (the cold open):');
{
	// The worst case is the common one: the app self-boots with no brain list, no tree
	// and no org, and this is the state most likely to ship untested because a
	// developer's own session always has all four.
	for (const task of TASKS) {
		const lines = loadingLines(task, {});
		const bad = lines.filter((l) => /[{}]/.test(l) || /undefined|NaN/.test(l) || /\s\s/.test(l));
		check(
			`${task}: ${lines.length} usable line(s), no empty slots`,
			lines.length > 0 && bad.length === 0,
			bad.join(' | ')
		);
	}
}

console.log('\nA slot is a requirement, not a default:');
{
	// Walk every template in the file, discover its own slots, and confirm it is
	// excluded from a rotation missing any of them. Discovering the slots from the
	// template means a new one cannot be forgotten here.
	const ALL_SLOTS = ['brain', 'org', 'orgs', 'subject', 'pages'] as const;
	const factFor = (slot: string): LoadingFacts =>
		slot === 'orgs' ? { org: FULL.org } : { [slot]: FULL[slot as keyof LoadingFacts] };

	let templates = 0;
	let slotted = 0;
	let leaks = 0;
	for (const task of TASKS) {
		for (const template of [...WARM[task], ...(POOL_BY_TASK[task] ?? []), ...POOL]) {
			templates++;
			const slots = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
			if (!slots.length) continue;
			slotted++;
			for (const slot of slots) {
				// Everything the template needs EXCEPT this one slot.
				const partial: LoadingFacts = {};
				for (const other of slots) if (other !== slot) Object.assign(partial, factFor(other));
				const lines = loadingLines(task, partial);
				// The rendered form of this template cannot appear, since one value is missing.
				if (lines.some((l) => /[{}]/.test(l))) leaks++;
				const withAll = loadingLines(task, FULL);
				const rendered = withAll.find((l) =>
					l.startsWith(template.slice(0, template.indexOf('{')))
				);
				if (rendered && lines.includes(rendered) && template.includes(`{${slot}}`)) {
					// A line that renders identically with and without the slot's value would
					// mean the slot was optional after all.
					if (rendered.includes(String(FULL[slot as keyof LoadingFacts] ?? ''))) leaks++;
				}
			}
		}
	}
	check(`walked ${templates} templates, ${slotted} of them slotted`, slotted > 0);
	check('no template renders without every value it names', leaks === 0, `${leaks} leak(s)`);
	check(
		'every slot in the templates is one the engine can fill',
		[...WARM.files, ...WARM.search, ...POOL]
			.flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
			.every((s) => (ALL_SLOTS as readonly string[]).includes(s))
	);
}

console.log('\nWhen the facts ARE there, the lines use them:');
{
	const page = loadingLines('page', FULL).join(' | ');
	check('a page wait names the page', page.includes('Weekly Sync'), page);
	const files = loadingLines('files', FULL).join(' | ');
	check('a tree wait names the brain', files.includes('Acme Ops'), files);
	check('and the page count, grouped', files.includes('1,234'), files);
	check('and the org, possessively', files.includes('Acme Labs’'), files);
	const search = loadingLines('search', { ...FULL, subject: 'quarterly planning' }).join(' | ');
	check('a search names the query', search.includes('quarterly planning'), search);
}

console.log('\nShape of a rotation:');
{
	for (const task of TASKS) {
		const lines = loadingLines(task, FULL);
		check(
			`${task}: ≤ ${MAX_LINES} lines, no repeats, all trailing off`,
			lines.length <= MAX_LINES &&
				new Set(lines).size === lines.length &&
				lines.every((l) => l.endsWith('…') && l.length > 2),
			lines.join(' | ')
		);
	}
	// Specific before playful: the second thing a user reads should be about their own
	// brain, not a joke about a library. Only a wait that outlives that earns the pool.
	const first = loadingLines('page', FULL)[0];
	check('the first line after the label is the specific one', first.includes('Weekly Sync'), first);
	check('the pool is never reached first when a fact is known', !POOL.includes(first), first);
}

console.log('\nDeterminism:');
{
	const a = loadingLines('page', FULL).join('|');
	const b = loadingLines('page', FULL).join('|');
	check('same wait, same rotation', a === b);
	const other = loadingLines('page', { ...FULL, subject: 'Vendor List' }).join('|');
	check('a different page reads differently', other !== a);
	const seeded = loadingLines('page', FULL, 99).join('|');
	check('an explicit seed changes the order', seeded !== a);
	check('the hash is stable across runs', hashSeed('files|Acme') === hashSeed('files|Acme'));
}

console.log('\nThe small pure helpers:');
{
	check('possessive: Acme → Acme’s', possessive('Acme') === 'Acme’s');
	check(
		'possessive: a name ending in s takes the bare apostrophe',
		possessive('Acme Labs') === 'Acme Labs’'
	);
	check('groupDigits: 999 stays 999', groupDigits(999) === '999');
	check('groupDigits: 1234 → 1,234', groupDigits(1234) === '1,234');
	check('groupDigits: 1234567 → 1,234,567', groupDigits(1234567) === '1,234,567');
	// A wait is a glance. A 200-character page title would push the line off screen and
	// make the wait look broken rather than busy.
	const long = clip('x'.repeat(200));
	check('clip: a long subject is cut and marked', long.length <= 36 && long.endsWith('…'));
	check('clip: a short one is untouched', clip('Weekly Sync') === 'Weekly Sync');
	const clipped = loadingLines('page', { subject: 'y'.repeat(300) });
	check(
		'a long subject cannot produce a long line',
		clipped.every((l) => l.length <= 60),
		clipped.join(' | ')
	);
}

console.log('\nAn empty brain says nothing about its size:');
{
	// 0 is a number, and a template that trusted `typeof pages === 'number'` would
	// cheerfully render "Counting 0 pages…" over a brain that is simply new: the
	// screen where the app most needs to look competent.
	for (const pages of [0, -3, undefined]) {
		const lines = loadingLines('files', { brain: 'Fresh', pages: pages as number | undefined });
		check(
			`pages=${pages}: no count is claimed`,
			!lines.some((l) => /\d/.test(l)),
			lines.join(' | ')
		);
	}
}

console.log('\nWiring: every loading state in the app declares its task:');
{
	// `task` is optional on the view, so an omission typechecks. This is the check that
	// makes a missing one loud.
	const sources = ['app/core/actions.ts', 'app/main.tsx', 'app/core/store.ts'];
	let sites = 0;
	const untasked: string[] = [];
	for (const file of sources) {
		const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		for (const m of src.matchAll(/kind: 'loading'/g)) {
			sites++;
			// The object literal a loading view is built from, generously bounded: every
			// call site in the app fits well inside this.
			const window = src.slice(m.index, m.index + 260);
			if (!/\btask: '/.test(window))
				untasked.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
		}
	}
	check(`found ${sites} loading state(s) across the app`, sites >= 15);
	check('all of them name a task', untasked.length === 0, untasked.join(', '));
	// And every task the app names is one the engine has phrases for.
	const named = new Set<string>();
	for (const file of sources) {
		const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		for (const m of src.matchAll(/\btask: '([a-z]+)'/g)) named.add(m[1]);
	}
	const unknown = [...named].filter((t) => !TASKS.includes(t as LoadingTask));
	check(
		`the app names ${named.size} distinct task(s), all known`,
		unknown.length === 0,
		unknown.join(', ')
	);
	// Every task carries enough to fill a rotation of its own before falling back.
	const thin = TASKS.filter((t) => WARM[t].length < 2);
	check('every task has at least two lines of its own', thin.length === 0, thin.join(', '));
}

console.log(
	failures === 0 ? '\nAll loading-line checks passed.\n' : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
