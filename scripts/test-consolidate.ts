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
import { parseIdentityFields, parseOrgChecks, withOrgChecks } from '../src/lib/brain-config.ts';
import {
	ORG_PASS_EVERY_MS,
	orgPassBrains,
	countOrgChecks,
	orgChecksStatusText,
	type OrgChecksStatus,
	orgPassDue,
	orgPassOrder,
	orgPassStart
} from '../src/lib/org-pass.ts';
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

import {
	canSeeFinding,
	conflictKey,
	isStale,
	queueReport,
	readFindings,
	scrubSensitive,
	staleNote,
	upsertFindings,
	clusterFindings,
	expandClusterDecisions,
	normalizeFactLabel,
	otherBrainIds,
	otherPageRef,
	readFactLabels,
	valuesOnPages,
	linkedAnswers,
	type QueueFinding
} from '../src/lib/review-queue.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import type { D1Database } from '@cloudflare/workers-types';
import type { Role } from '../src/lib/orgs.ts';
import {
	MAX_COMPARED_BRAINS,
	againstRefusal,
	brainsToCompare,
	resolveComparison,
	unopenedNote,
	type ComparedBrain,
	contradictionCoverage,
	reviewCheckRefusal,
	orgChecksRefusal,
	againstIs
} from '../src/lib/review-checks.ts';
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

	check(
		'config: a brain takes part in organization checks only when its charter says true',
		parseOrgChecks({ charter: { orgChecks: true } }) &&
			!parseOrgChecks({}) &&
			!parseOrgChecks({ charter: {} }) &&
			!parseOrgChecks({ charter: { orgChecks: 'true' } }) &&
			!parseOrgChecks({ charter: { orgChecks: 1 } })
	);
	const existing = JSON.stringify({ paths: { 'docs/': 'content' }, charter: { owns: ['rates'] } });
	const on = withOrgChecks(existing, true);
	check(
		'config: opting in sets the one field and keeps the rest of the file',
		'content' in on &&
			JSON.stringify(JSON.parse(on.content)) ===
				JSON.stringify({
					paths: { 'docs/': 'content' },
					charter: { owns: ['rates'], orgChecks: true }
				}) &&
			on.content.endsWith('\n')
	);
	const fromNothing = withOrgChecks(null, true);
	check(
		'config: a brain with no config file gets one holding only the charter',
		'content' in fromNothing &&
			JSON.stringify(JSON.parse(fromNothing.content)) ===
				JSON.stringify({ charter: { orgChecks: true } })
	);
	check(
		'config: asking for what the file already says changes nothing',
		'unchanged' in withOrgChecks(null, false) &&
			'unchanged' in withOrgChecks('content' in on ? on.content : '', true)
	);
	const off = withOrgChecks('content' in on ? on.content : '', false);
	check(
		'config: opting out writes false',
		'content' in off && JSON.parse(off.content).charter.orgChecks === false
	);
	check(
		'config: a file that is not a JSON object is left alone',
		'problem' in withOrgChecks('{ not json', true) && 'problem' in withOrgChecks('[]', true)
	);
}

// ---------- the scheduled organization pass: which brains, and which next ----------
{
	const brain = (brainId: string, orgChecks = true) => ({ brainId, config: { orgChecks } });
	const picked = orgPassBrains([brain('c'), brain('a'), brain('b', false)]);
	check(
		'org pass: covers the brains that take part, in a stable order',
		picked.brains.map((b) => b.brainId).join() === 'a,c' && picked.leftOut.length === 0
	);
	check(
		'org pass: one brain taking part is nothing to compare',
		orgPassBrains([brain('a'), brain('b', false)]).brains.length === 0 &&
			orgPassBrains([]).brains.length === 0
	);
	const crowd = orgPassBrains(
		Array.from({ length: MAX_COMPARED_BRAINS + 3 }, (_, i) =>
			brain(`b${String(i).padStart(2, '0')}`)
		)
	);
	check(
		'org pass: more brains than one pass compares are cut, and the rest named',
		crowd.brains.length === MAX_COMPARED_BRAINS + 1 &&
			crowd.leftOut.map((b) => b.brainId).join() === 'b21,b22'
	);

	// What the person who opts a brain in is told about its organization.
	const rows = ['a', 'b', 'c', 'd'].map((brain_id) => ({ brain_id }));
	const counted = await countOrgChecks(rows, { brainId: 'a', on: true }, async (r) => {
		if (r.brain_id === 'a') throw new Error('the brain just written is not read back');
		if (r.brain_id === 'd') throw new Error('unreachable');
		return r.brain_id === 'b';
	});
	check(
		'org checks: the count is the brains that take part, the one just set as given',
		counted.takingPart === 2 && counted.unread === 1,
		JSON.stringify(counted)
	);
	check(
		'org checks: a brain just opted out is not counted',
		(await countOrgChecks(rows.slice(0, 2), { brainId: 'a', on: false }, async () => true))
			.takingPart === 1
	);
	const told = (s: Partial<OrgChecksStatus>) =>
		orgChecksStatusText({
			orgLabel: 'Acme',
			takingPart: 3,
			unread: 0,
			entitled: true,
			modelKey: true,
			...s
		});
	check(
		'org checks: with two brains, the feature and a key, the reply says they run',
		/^In Acme, 3 brains take part\. The scheduled checks run across them/.test(told({})) &&
			!/do not run/.test(told({ takingPart: 2 })),
		told({})
	);
	check(
		'org checks: one brain alone waits for a second',
		/1 brain takes part\. The scheduled checks do not run until a second brain takes part\.$/.test(
			told({ takingPart: 1 })
		),
		told({ takingPart: 1 })
	);
	check(
		'org checks: an organization without the feature is told so',
		/do not run until Acme has the contradictions check\.$/.test(told({ entitled: false })),
		told({ entitled: false })
	);
	check(
		'org checks: everything missing is named at once',
		/until a second brain takes part, and Acme has the contradictions check, and this deployment has a model key\.$/.test(
			told({ takingPart: 1, entitled: false, modelKey: false })
		)
	);
	check(
		'org checks: brains that could not be read are said to be uncounted',
		/2 brains could not be read and are not counted\./.test(told({ unread: 2 })) &&
			/1 brain could not be read and is not counted\./.test(told({ unread: 1 }))
	);

	const T = 1_000_000_000_000;
	const done = (finishedAt: number) => ({ status: 'done' as const, startedAt: 0, finishedAt });
	check(
		'org pass: a brain never checked, or with a pass under way or stopped, has a step to take',
		orgPassDue(null, T) &&
			orgPassDue({ status: 'running', startedAt: T, finishedAt: null }, T) &&
			orgPassDue({ status: 'stopped', startedAt: T, finishedAt: null }, T)
	);
	check(
		'org pass: a finished pass stands for a day',
		!orgPassDue(done(T - ORG_PASS_EVERY_MS + 1), T) && orgPassDue(done(T - ORG_PASS_EVERY_MS), T)
	);
	check(
		'org checks now: only for contradictions, never fresh, and only with a model key',
		/only applies to check "contradictions"/.test(
			orgChecksRefusal('sensitive-data', false, true) ?? ''
		) &&
			/`fresh` does not apply/.test(orgChecksRefusal('contradictions', true, true) ?? '') &&
			/needs a model key/.test(orgChecksRefusal('contradictions', undefined, false) ?? '') &&
			orgChecksRefusal('contradictions', undefined, true) === null &&
			againstIs(' Organization ', 'organization') &&
			!againstIs('organization-wiki', 'organization') &&
			!againstIs(undefined, 'organization')
	);
	{
		const decided = [
			{ finding: 'conflict:a', action: 'dismiss' },
			{ finding: 'conflict:b', action: 'undismiss' }
		];
		check(
			'linked findings: a ledger write that landed carries each answer to the other brain',
			JSON.stringify(linkedAnswers(decided, {})) ===
				JSON.stringify([
					{ key: 'conflict:a', dismissed: true },
					{ key: 'conflict:b', dismissed: false }
				]) && linkedAnswers(decided, { prUrl: 'u', merged: true }).length === 2
		);
		check(
			'linked findings: one still waiting in a pull request carries nothing',
			linkedAnswers(decided, { prUrl: 'u' }).length === 0 &&
				linkedAnswers(decided, { prUrl: 'u', merged: false }).length === 0
		);
	}
	check(
		'org pass: asked for now, a finished pass stands only as long as it is told to',
		orgPassDue(done(T - 1000), T, 1000) &&
			!orgPassDue(done(T - 999), T, 1000) &&
			orgPassOrder([{ brain: 'a', run: done(T - 1000) }], T, 1000).length === 1 &&
			orgPassOrder([{ brain: 'a', run: done(T - 1000) }], T).length === 0
	);
	const order = orgPassOrder(
		[
			{ brain: 'old', run: done(T - 3 * ORG_PASS_EVERY_MS) },
			{ brain: 'recent', run: done(T - 10) },
			{ brain: 'new', run: null },
			{ brain: 'older', run: done(T - 5 * ORG_PASS_EVERY_MS) },
			{ brain: 'midway', run: { status: 'running' as const, startedAt: T - 5, finishedAt: null } }
		],
		T
	);
	check(
		'org pass: passes under way go first, then brains never checked, then the longest finished',
		order.join() === 'midway,new,older,old',
		order.join()
	);
	const hour = 60 * 60 * 1000;
	check(
		'org pass: where a run starts among the organizations moves on each hour',
		orgPassStart(3, 0) === 0 &&
			orgPassStart(3, hour) === 1 &&
			orgPassStart(3, 3 * hour) === 0 &&
			orgPassStart(0, hour) === 0
	);
}

// ---------- the findings queue ----------
{
	const a = 'wiki/a.md';
	const b = 'wiki/b.md';
	const rate = await conflictKey([a, b], ['$95', '$120']);
	check(
		'queue key: the pair is sorted and the values order does not matter',
		rate === (await conflictKey([b, a], ['$120', '$95'])) && rate.startsWith(`conflict:${a}|${b}:`),
		rate
	);
	check(
		'queue key: a second fact on the same pair gets its own key',
		rate !== (await conflictKey([a, b], ['2026-01-01', '2026-02-01']))
	);
	check(
		'queue key: a changed value is a new disagreement',
		rate !== (await conflictKey([a, b], ['$95', '$130']))
	);
	check(
		'queue key: case, spacing and edge punctuation do not change it',
		(await conflictKey([a, b], ['Acme  Teams', 'slack'])) ===
			(await conflictKey([a, b], ['acme teams.', '"Slack"']))
	);
	check(
		'queue key: another pair with the same values is its own finding',
		rate !== (await conflictKey([a, 'wiki/c.md'], ['$95', '$120']))
	);
	check(
		'queue key: a page against itself has one path',
		(await conflictKey([a, a], ['$95', '$120'])).startsWith(`conflict:${a}:`)
	);

	const pages = new Map([
		[a, 'The rate is $95.'],
		[b, 'The rate is $120.']
	]);
	check(
		'queue key: values quoted from their pages pass',
		valuesOnPages(
			[
				{ path: a, value: '$95' },
				{ path: b, value: '$120' }
			],
			pages
		)
	);
	check(
		'queue key: a value not on its page fails',
		!valuesOnPages([{ path: a, value: '$120' }], pages)
	);
	check('queue key: a missing page fails', !valuesOnPages([{ path: 'x', value: '$1' }], pages));

	const can = (kind: string, role: Role, isAuthor = false) =>
		canSeeFinding(kind, { role, isAuthor });
	check(
		'queue visibility: consolidation findings reach editors, not viewers',
		can('conflict', 'editor') && can('duplicate', 'editor') && !can('conflict', 'viewer')
	);
	check(
		'queue visibility: policy findings reach admins and the author only',
		can('policy', 'admin') &&
			can('policy', 'owner') &&
			can('policy', 'viewer', true) &&
			!can('policy', 'editor')
	);
	check(
		'queue visibility: an unknown kind gets the narrowest answer',
		can('later', 'admin') && !can('later', 'editor') && !can('later', 'editor', true)
	);

	const row = (over: Partial<QueueFinding> = {}): QueueFinding => ({
		key: rate,
		kind: 'conflict',
		paths: [a, b],
		headline: 'The rate differs.',
		evidence: ['a: $95', 'b: $120'],
		proposal: null,
		scores: null,
		pageShas: { [a]: 'sa', [b]: 'sb' },
		runId: 'r1',
		clusterId: 'c1',
		authorUserId: null,
		...over
	});
	const shas = new Map([
		[a, 'sa'],
		[b, 'sb']
	]);
	check('queue staleness: unchanged pages are open', !isStale(row(), shas));
	check(
		'queue staleness: a changed page is stale',
		isStale(
			row(),
			new Map([
				[a, 'sa'],
				[b, 'other']
			])
		)
	);
	check('queue staleness: a deleted page is stale', isStale(row(), new Map([[a, 'sa']])));

	const editor = queueReport([row()], shas, { role: 'editor' });
	check(
		'queue report: an open finding carries its key and evidence',
		editor.open.length === 1 &&
			editor.open[0].key === rate &&
			editor.open[0].headline.includes('a: $95') &&
			editor.stale.length === 0
	);
	check(
		'queue report: a viewer gets nothing',
		queueReport([row()], shas, { role: 'viewer' }).open.length === 0
	);
	const stale = queueReport([row()], new Map(), { role: 'editor' });
	check(
		'queue report: a stale finding is not open',
		!stale.open.length && stale.stale.length === 1
	);
	check(
		'queue report: stale findings are counted, and none is no line',
		staleNote(2).includes('2 earlier finding(s) are stale') && staleNote(0) === ''
	);
	const policy = row({ key: 'policy:x', kind: 'policy', authorUserId: 'u1' });
	check(
		'queue report: the author of a policy finding sees it, another editor does not',
		queueReport([policy], shas, { role: 'editor', userId: 'u1' }).open.length === 1 &&
			queueReport([policy], shas, { role: 'editor', userId: 'u2' }).open.length === 0 &&
			queueReport([policy], shas, { role: 'editor' }).open.length === 0
	);

	const ssn = 'SSN 123-45-6789';
	check(
		'queue scrub: a flagged span goes',
		scrubSensitive(`on file: ${ssn}.`) === 'on file: SSN [redacted].'
	);
	check(
		'queue scrub: clean text is unchanged',
		scrubSensitive('the rate is $95') === 'the rate is $95'
	);

	const db = localD1(':memory:').db as unknown as D1Database;
	await upsertFindings(
		db,
		'b1',
		[
			row({
				headline: `Differs: ${ssn}`,
				evidence: [ssn],
				proposal: { edit: ssn },
				scores: { conflict: 0.8 }
			})
		],
		1000
	);
	await upsertFindings(db, 'b2', [row()], 1000);
	const [stored] = await readFindings(db, 'b1');
	check('queue store: this brain only', (await readFindings(db, 'b1')).length === 1);
	check(
		'queue store: a row round-trips',
		stored.clusterId === 'c1' && stored.scores?.conflict === 0.8 && stored.paths.length === 2,
		JSON.stringify(stored)
	);
	const raw = JSON.stringify(
		(await db.prepare("SELECT * FROM review_findings WHERE brain_id = 'b1'").all()).results
	);
	check('queue store: no flagged value reaches the table', !raw.includes('6789'), raw);

	await upsertFindings(db, 'b1', [row({ headline: 'Reworded.', runId: 'r2' })], 2000);
	const refreshed = await readFindings(db, 'b1');
	const times = await db
		.prepare("SELECT created_at, updated_at FROM review_findings WHERE brain_id = 'b1'")
		.first<{ created_at: number; updated_at: number }>();
	check(
		'queue store: the same key refreshes the row and keeps its first date',
		refreshed.length === 1 &&
			refreshed[0].headline === 'Reworded.' &&
			times?.created_at === 1000 &&
			times?.updated_at === 2000,
		JSON.stringify({ refreshed, times })
	);

	await db.prepare("UPDATE review_findings SET paths = 'not json' WHERE brain_id = 'b2'").run();
	check('queue store: an unreadable row is dropped', (await readFindings(db, 'b2')).length === 0);

	// A finding with its second page in another brain.
	const ref = await otherPageRef('brain-handbook', b);
	check(
		'other page: its reference in a key is a stable digest that names neither brain nor path',
		/^x:[0-9a-f]{16}$/.test(ref) &&
			ref === (await otherPageRef('brain-handbook', b)) &&
			ref !== (await otherPageRef('brain-legal', b)) &&
			ref !== (await otherPageRef('brain-handbook', a))
	);
	const cross = row({
		key: await conflictKey([a, ref], ['$95', '$120']),
		paths: [a],
		pageShas: { [a]: 'sa' },
		other: { brainId: 'brain-handbook', path: b, sha: 'ob' }
	});
	const handbook = (sha: string) =>
		new Map([
			[
				'brain-handbook',
				{ label: 'Handbook', handle: 'handbook-1a2b3c', shas: new Map([[b, sha]]) }
			]
		]);
	const home = new Map([[a, 'sa']]);
	const seen = queueReport([cross], home, { role: 'editor' }, handbook('ob'));
	check(
		'other page: a viewer who can open both brains gets the finding, and is told which brain',
		seen.open.length === 1 &&
			seen.open[0].headline.includes('The other brain is "Handbook" (brain: "handbook-1a2b3c").'),
		JSON.stringify(seen)
	);
	const hidden = queueReport([cross], home, { role: 'admin' });
	check(
		'other page: a viewer who cannot open the other brain gets nothing, not even a stale count',
		hidden.open.length === 0 && hidden.stale.length === 0
	);
	check(
		'other page: it does not hide findings inside the brain',
		queueReport([cross, row()], shas, { role: 'editor' }).open.length === 1
	);
	check(
		'other page: a change to the page in the other brain makes the finding stale',
		queueReport([cross], home, { role: 'editor' }, handbook('changed')).stale.length === 1 &&
			isStale(cross, home, new Map()) &&
			!isStale(cross, home, new Map([[b, 'ob']]))
	);
	check(
		'other page: so does a change to the page in this brain',
		queueReport([cross], new Map([[a, 'changed']]), { role: 'editor' }, handbook('ob')).stale
			.length === 1
	);
	check(
		'other page: the finding is never part of a cluster',
		seen.open[0].cluster === undefined &&
			(await expandClusterDecisions([{ finding: 'cluster:c1' }], async () => [cross])) ===
				'"cluster:c1" names no findings: the cluster may have been answered already.'
	);
	check(
		'other page: the brains a set of findings reaches are listed once each',
		JSON.stringify(otherBrainIds([cross, cross, row()])) === JSON.stringify(['brain-handbook'])
	);
	await upsertFindings(db, 'b3', [cross, row()], 1000);
	const kept = await readFindings(db, 'b3');
	check(
		'other page: it round-trips through the table, and a finding inside the brain has none',
		JSON.stringify(kept.find((f) => f.key === cross.key)?.other) ===
			JSON.stringify({ brainId: 'brain-handbook', path: b, sha: 'ob' }) &&
			kept.find((f) => f.key === rate)?.other === null,
		JSON.stringify(kept)
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

console.log('\nclusters: findings about one fact, shown as one item');
{
	check(
		'a fact label is lowercase words, punctuation and spacing ignored',
		normalizeFactLabel('  Engagement   Length. ') === 'engagement length' &&
			normalizeFactLabel('Advisor (hourly) rate!') === 'advisor hourly rate' &&
			normalizeFactLabel('') === ''
	);
	const f = (key: string, cluster?: string, weight = 4) => ({
		key,
		weight,
		headline: `- ${key} headline\n    evidence for ${key}`,
		...(cluster ? { cluster } : {})
	});
	const grouped = clusterFindings([
		f('conflict:a|b:1', 'engagement length'),
		f('island:x'),
		f('conflict:b|c:2', 'engagement length'),
		f('conflict:d|e:3', 'pod size')
	]);
	const item = grouped[0];
	check(
		'two findings sharing a label become one item where the first stood, others pass through in order',
		grouped.length === 3 &&
			item.key === 'cluster:engagement length' &&
			grouped[1].key === 'island:x' &&
			grouped[2].key === 'conflict:d|e:3'
	);
	check(
		'the item lists every member with its own key and evidence, and ranks above them',
		item.headline.includes('2 disagreements about "engagement length"') &&
			item.headline.includes('[conflict:a|b:1]') &&
			item.headline.includes('[conflict:b|c:2]') &&
			item.headline.includes('evidence for conflict:b|c:2') &&
			item.weight === 4.5
	);
	check('a label held by one finding is not a cluster', grouped[2].key === 'conflict:d|e:3');

	const rows = [
		{ key: 'conflict:a|b:1', kind: 'conflict', clusterId: 'engagement length' },
		{ key: 'conflict:b|c:2', kind: 'conflict', clusterId: 'engagement length' },
		{ key: 'conflict:d|e:3', kind: 'conflict', clusterId: 'pod size' },
		{ key: 'policy:x:us-ssn', kind: 'policy', clusterId: 'engagement length' }
	] as unknown as QueueFinding[];
	let reads = 0;
	const read = async () => {
		reads++;
		return rows;
	};
	const plain = [{ finding: 'island:x', action: 'dismiss', why: 'w' }];
	check(
		'decisions without a cluster key pass through without reading the queue',
		JSON.stringify(await expandClusterDecisions(plain, read)) === JSON.stringify(plain) &&
			reads === 0
	);
	const expanded = await expandClusterDecisions(
		[
			{ finding: 'cluster:engagement length', action: 'dismiss', why: 'by level' },
			{ finding: 'island:x', action: 'dismiss', why: 'w' }
		],
		read
	);
	check(
		'a cluster key becomes one decision per conflict member, keeping the action and reason',
		Array.isArray(expanded) &&
			JSON.stringify(expanded.map((d) => [d.finding, d.why])) ===
				JSON.stringify([
					['conflict:a|b:1', 'by level'],
					['conflict:b|c:2', 'by level'],
					['island:x', 'w']
				])
	);
	check(
		'a cluster key naming nothing is refused',
		typeof (await expandClusterDecisions([{ finding: 'cluster:nope', why: '' }], read)) === 'string'
	);

	const db = localD1(':memory:').db as unknown as D1Database;
	const row = (key: string, kind: 'conflict' | 'policy', clusterId: string | null) => ({
		key,
		kind,
		paths: ['a.md'],
		headline: 'h',
		evidence: [],
		proposal: null,
		scores: null,
		pageShas: { 'a.md': 's' },
		runId: 'r',
		clusterId,
		authorUserId: null
	});
	await upsertFindings(db, 'b1', [
		row('conflict:1', 'conflict', 'pod size'),
		row('conflict:2', 'conflict', 'engagement length'),
		row('conflict:3', 'conflict', 'pod size'),
		row('conflict:4', 'conflict', null),
		row('policy:a.md:us-ssn', 'policy', 'secret label')
	]);
	await upsertFindings(db, 'b2', [row('conflict:9', 'conflict', 'other brain')]);
	check(
		"the labels a brain's conflict findings use, each once, from that brain only",
		JSON.stringify(await readFactLabels(db, 'b1')) ===
			JSON.stringify(['engagement length', 'pod size'])
	);
	const conflictRow = row('conflict:5', 'conflict', 'pod size');
	const shown = queueReport(
		[conflictRow, row('policy:b.md:us-ssn', 'policy', 'pod size')],
		new Map([['a.md', 's']]),
		{ role: 'admin' }
	);
	check(
		'only conflict findings carry their label into the report',
		shown.open.find((x) => x.key === 'conflict:5')?.cluster === 'pod size' &&
			shown.open.find((x) => x.key === 'policy:b.md:us-ssn')?.cluster === undefined
	);
}

console.log('\nreview_brain: what may run, and what validate says about the contradictions pass');
{
	const legal = { brainId: 'brain-legal', orgId: 'o1' };
	const handbook = { brainId: 'brain-handbook', orgId: 'o1' };
	check(
		'against: two brains in one organization can be compared',
		againstRefusal(legal, handbook) === null
	);
	check(
		'against: a brain is not compared against itself',
		/against itself/.test(againstRefusal(legal, legal) ?? '')
	);
	check(
		'against: a brain in another organization is refused',
		/same organization/.test(againstRefusal(legal, { ...handbook, orgId: 'o2' }) ?? '')
	);
	check(
		'against: where there is no organization to compare, it is refused',
		/same organization/.test(againstRefusal({ brainId: 'a' }, { brainId: 'b' }) ?? '')
	);

	const reach = (id: string, org: string) => ({ brain_id: `brain-${id}`, org_id: org, id });
	const org = [
		reach('ops', 'o1'),
		reach('legal', 'o1'),
		reach('handbook', 'o1'),
		reach('elsewhere', 'o2')
	];
	const everyone = brainsToCompare(legal, org);
	check(
		'against all: the other brains of the same organization the caller can open, in a stable order',
		'handles' in everyone &&
			JSON.stringify(everyone.handles) === JSON.stringify(['handbook', 'ops']),
		JSON.stringify(everyone)
	);
	const alone = brainsToCompare(legal, [reach('legal', 'o1'), reach('x', 'o2')]);
	check(
		'against all: with no other brain in the organization there is nothing to run',
		'refusal' in alone && /no other brain/.test(alone.refusal)
	);
	check(
		'against all: nor without a brain list, or without an organization',
		'refusal' in brainsToCompare(legal, undefined) &&
			'refusal' in brainsToCompare({ brainId: 'a' }, [reach('b', 'o1')])
	);
	const many = brainsToCompare(
		legal,
		Array.from({ length: MAX_COMPARED_BRAINS + 1 }, (_, i) => reach(`b${i}`, 'o1'))
	);
	check(
		'against all: more brains than one pass compares is refused, naming the limit',
		'refusal' in many && many.refusal.includes(`at most ${MAX_COMPARED_BRAINS}`)
	);

	// What a call compares against, with the brains it opens faked.
	const opened: string[] = [];
	const open = (down: readonly string[] = []) => ({
		listBrains: async () => org,
		open: async (handle: string) => {
			opened.push(handle);
			if (down.includes(handle)) throw new Error(`${handle} is unreachable`);
			const row = org.find((b) => b.id === handle);
			if (!row) throw new Error(`No brain matching "${handle}".`);
			return { brainId: row.brain_id, orgId: row.org_id, handle } as ComparedBrain & {
				orgId: string;
			};
		}
	});
	const wrongCheck = await resolveComparison('sensitive-data', legal, 'handbook', open());
	check(
		'comparison: `against` applies to the contradictions check only, and opens nothing',
		'refusal' in wrongCheck && /only applies/.test(wrongCheck.refusal) && opened.length === 0
	);
	const one = await resolveComparison('contradictions', legal, 'handbook', open());
	check(
		'comparison: a named brain is the one brain compared',
		'comparison' in one &&
			!one.comparison.all &&
			one.comparison.brains.map((b) => b.handle).join() === 'handbook' &&
			one.unopened.length === 0
	);
	const self = await resolveComparison('contradictions', legal, 'legal', open());
	const foreign = await resolveComparison('contradictions', legal, 'elsewhere', open());
	check(
		'comparison: a named brain that is this one, or in another organization, is refused',
		'refusal' in self &&
			/against itself/.test(self.refusal) &&
			'refusal' in foreign &&
			/same organization/.test(foreign.refusal)
	);
	check(
		'comparison: a named brain that does not open is an error, not a silent skip',
		await resolveComparison('contradictions', legal, 'handbook', open(['handbook'])).then(
			() => false,
			(err: Error) => /unreachable/.test(err.message)
		)
	);
	opened.length = 0;
	const all = await resolveComparison('contradictions', legal, ' ALL ', open(['ops']));
	check(
		'comparison: "all" opens every other brain of the organization, and leaves out and names one that does not open',
		'comparison' in all &&
			all.comparison.all &&
			all.comparison.brains.map((b) => b.handle).join() === 'handbook' &&
			JSON.stringify(all.unopened) === JSON.stringify(['ops']) &&
			JSON.stringify(opened) === JSON.stringify(['handbook', 'ops']),
		JSON.stringify({ all, opened })
	);
	const none = await resolveComparison('contradictions', legal, 'all', open(['ops', 'handbook']));
	check(
		'comparison: "all" with no brain that opens runs nothing and says which',
		'refusal' in none && none.refusal.includes('"handbook", "ops"')
	);
	const nolist = await resolveComparison('contradictions', legal, 'all', { open: open().open });
	check(
		'comparison: "all" without a brain list has nothing to compare',
		'refusal' in nolist && /no other brain/.test(nolist.refusal)
	);
	check(
		'comparison: the reply names the brains left out, and adds nothing when there are none',
		unopenedNote(['ops']) === ' Left out, could not be opened: "ops".' && unopenedNote([]) === ''
	);

	const on = { policyMode: 'shadow' as const, contradictionsAvailable: true };
	check(
		'both checks run when the brain allows them',
		reviewCheckRefusal('sensitive-data', on) === null &&
			reviewCheckRefusal('contradictions', on) === null
	);
	check(
		'sensitive-data is refused when the brain turned the checks off',
		/turned off/.test(reviewCheckRefusal('sensitive-data', { ...on, policyMode: 'off' }) ?? '')
	);
	check(
		'contradictions is refused where the deployment has no model key, and says why',
		/enterprise feature/.test(
			reviewCheckRefusal('contradictions', { ...on, contradictionsAvailable: false }) ?? ''
		)
	);
	check(
		'turning sensitive-data checks off does not touch contradictions, and the reverse',
		reviewCheckRefusal('contradictions', { ...on, policyMode: 'off' }) === null &&
			reviewCheckRefusal('sensitive-data', { ...on, contradictionsAvailable: false }) === null
	);

	const done = {
		status: 'done' as const,
		finishedAt: Date.UTC(2026, 10, 2, 15),
		pairsChecked: 157,
		findings: 14
	};
	check('no line for an editor', contradictionCoverage('editor', true, done) === '');
	check('no line where the check cannot run', contradictionCoverage('owner', false, done) === '');
	check(
		'an admin is told it has not run, and how to run it',
		/not run on this brain yet\. review_brain with check "contradictions"/.test(
			contradictionCoverage('admin', true, null)
		)
	);
	check(
		'a pass in progress says how far it got',
		/in progress, 40 page pair\(s\) checked so far/.test(
			contradictionCoverage('admin', true, { ...done, status: 'stopped', pairsChecked: 40 })
		)
	);
	check(
		'a finished pass says when, over how much, and that running it again checks only later edits',
		contradictionCoverage('owner', true, done) ===
			'\n\nContradiction check: last finished 2026-11-02 over 157 page pair(s), 14 finding(s) raised. review_brain with check "contradictions" checks pages edited since, and only those.'
	);
}

done();
