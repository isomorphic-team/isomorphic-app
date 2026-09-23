// Golden test for write_page's partial page updates (src/lib/page-patch.ts).
// Body half: append, ordered find/replace, the exactly-once anchor rule, and the
// refusal to anchor on generated okf-view snapshot text. Frontmatter half:
// merge-patch semantics for `fields`, the key names that survive a read back, the
// managed keys that route to their own arguments, and the nested-YAML refusal.
// Pure: no D1, no GitHub.
// Run: pnpm test:patch
import {
	applyPageEdits,
	applyFieldPatch,
	validateFieldPatch,
	MANAGED_FIELD_KEYS,
	OKF_PAGE_STATUSES
} from '../src/lib/page-patch.ts';
import { parseFrontmatter, withFrontmatter, type Frontmatter } from '../src/lib/wiki.ts';
import { SNAPSHOT_BEGIN, SNAPSHOT_END } from '../src/lib/view-directives.ts';
import {
	checkPageWrite,
	planPageWrite,
	composeCreate,
	composeUpdate,
	isPatching,
	type PageWriteArgs
} from '../src/lib/page-write.ts';
import { parsePaths } from '../src/lib/brain-config.ts';

import { checker } from './check.ts';

const { check, done } = checker('page-patch checks');

const BODY = `# Key documents

Our four systems:

- Ingest, which pulls records in.
- Index, which makes them searchable.
- Views, which renders them.
- Sync, which pushes them back.

Ask the platform team for access.`;

// ---------- append ----------
{
	const r = applyPageEdits(BODY, { append: '## See also\n\n- [Systems](../systems/index.md)' });
	check('append: ok', r.ok);
	if (r.ok) {
		check('append: original body intact', r.body.startsWith(BODY));
		check(
			'append: addition lands at the end',
			r.body.trimEnd().endsWith('[Systems](../systems/index.md)')
		);
		check('append: one blank line between', r.body.includes('access.\n\n## See also'));
		check('append: single trailing newline', r.body.endsWith('\n') && !r.body.endsWith('\n\n'));
		check('append: summary counts lines', r.summary === '3 lines appended', r.summary);
	}
}
{
	// Appending twice must not stack blank lines (the write path is idempotent-ish).
	const once = applyPageEdits(BODY, { append: 'One.' });
	const twice = once.ok ? applyPageEdits(once.body, { append: 'Two.' }) : once;
	check(
		'append: repeatable without blank-line drift',
		twice.ok && twice.body.includes('One.\n\nTwo.\n')
	);
}
check('append: empty is refused', !applyPageEdits(BODY, { append: '   ' }).ok);

// ---------- edits ----------
{
	const r = applyPageEdits(BODY, {
		edits: [
			{
				find: '- Ingest, which pulls records in.',
				replace: '- [Ingest](ingest.md), which pulls records in.'
			}
		]
	});
	check('edit: ok', r.ok);
	if (r.ok) {
		check(
			'edit: replacement applied',
			r.body.includes('- [Ingest](ingest.md), which pulls records in.')
		);
		check('edit: rest of the page untouched', r.body.includes('Ask the platform team for access.'));
		check('edit: nothing else rewritten', r.body.split('\n').length === BODY.split('\n').length);
		check('edit: summary', r.summary === '1 replacement made', r.summary);
	}
}
{
	// Several edits in one save, applied in order, each seeing the previous result.
	const r = applyPageEdits(BODY, {
		edits: [
			{ find: 'Index, which', replace: '[Index](index.md), which' },
			{
				find: '[Index](index.md), which makes them searchable.',
				replace: '[Index](index.md) makes them searchable.'
			}
		]
	});
	check(
		'edits: applied in order, compounding',
		r.ok && r.body.includes('[Index](index.md) makes them searchable.')
	);
	check(
		'edits: summary pluralizes',
		r.ok && r.summary === '2 replacements made',
		r.ok ? r.summary : ''
	);
}
{
	const r = applyPageEdits(BODY, { edits: [{ find: 'which', replace: 'that' }] });
	check('edit: ambiguous anchor refused', !r.ok);
	check(
		'edit: ambiguity error counts matches',
		!r.ok && r.error.includes('4 times'),
		!r.ok ? r.error : ''
	);
}
{
	const r = applyPageEdits(BODY, { edits: [{ find: 'nonexistent text', replace: 'x' }] });
	check('edit: missing anchor refused', !r.ok);
	check(
		'edit: not-found error quotes the anchor',
		!r.ok && r.error.includes('nonexistent text'),
		!r.ok ? r.error : ''
	);
}
check(
	'edit: empty find refused',
	!applyPageEdits(BODY, { edits: [{ find: '', replace: 'x' }] }).ok
);
{
	// An edit that fails leaves NOTHING applied, including earlier edits in the batch.
	const r = applyPageEdits(BODY, {
		edits: [
			{ find: 'Ingest, which', replace: 'Ingest, that' },
			{ find: 'no such line', replace: 'x' }
		]
	});
	check('edits: a failing edit aborts the whole batch', !r.ok);
}
{
	const r = applyPageEdits(BODY, {
		edits: [{ find: '\nAsk the platform team for access.', replace: '' }]
	});
	check('edit: empty replace deletes', r.ok && !r.body.includes('Ask the platform'));
}

// ---------- generated okf-view snapshots are not editable anchors ----------
const WITH_SNAPSHOT = `# Systems

\`\`\`okf-view
kind: folders
under: wiki/systems
\`\`\`

${SNAPSHOT_BEGIN}
| Folder | Description |
| --- | --- |
| [Ingest](ingest/index.md) | Pulls records in. |
${SNAPSHOT_END}

Maintained by the platform team.`;
{
	const r = applyPageEdits(WITH_SNAPSHOT, {
		edits: [
			{ find: '| [Ingest](ingest/index.md) | Pulls records in. |', replace: '| Ingest | gone |' }
		]
	});
	check('snapshot: anchor inside a snapshot is refused', !r.ok);
	check(
		'snapshot: error explains it is regenerated',
		!r.ok && r.error.includes('okf-view snapshot'),
		!r.ok ? r.error : ''
	);
}
{
	// The same text outside the snapshot is a perfectly good anchor.
	const r = applyPageEdits(WITH_SNAPSHOT, {
		edits: [{ find: 'Maintained by the platform team.', replace: 'Maintained by platform.' }]
	});
	check(
		'snapshot: text outside the region still edits',
		r.ok && r.body.includes('Maintained by platform.')
	);
	check(
		'snapshot: region left byte-identical',
		r.ok && r.body.includes(`${SNAPSHOT_BEGIN}\n| Folder | Description |`)
	);
}
{
	// A directive edit (what an agent SHOULD do to change a view) is untouched by the guard.
	const r = applyPageEdits(WITH_SNAPSHOT, {
		edits: [{ find: 'under: wiki/systems', replace: 'under: wiki/platform' }]
	});
	check(
		'snapshot: the okf-view directive itself is editable',
		r.ok && r.body.includes('under: wiki/platform')
	);
}
{
	// Appending to a page whose body ENDS in a snapshot must not land inside it.
	const endsWithSnapshot = `# S\n\n${SNAPSHOT_BEGIN}\ngenerated\n${SNAPSHOT_END}`;
	const r = applyPageEdits(endsWithSnapshot, { append: 'Footnote.' });
	check(
		'snapshot: append lands after the region',
		r.ok && r.body.trimEnd().endsWith(`${SNAPSHOT_END}\n\nFootnote.`)
	);
}

// ---------- neither argument ----------
check('nothing to do is an error', !applyPageEdits(BODY, {}).ok);
check('empty edits array is an error', !applyPageEdits(BODY, { edits: [] }).ok);

// =====================================================================
// fields: frontmatter merge-patch
// =====================================================================

check(
	'OKF lifecycle vocabulary is shared by the tool and app',
	OKF_PAGE_STATUSES.join('|') === 'draft|stable|deprecated'
);

const PAGE = `---
title: Ship the importer
type: Todo
status: published
owner: ana
tags:
  - backlog
  - q3
updated: 2026-08-01
---

Body text that must never move.`;

// A page carrying OKF provenance the flat parser deliberately does not model.
const NESTED = `---
title: Quarterly numbers
sources:
  - resource: crm/export.csv
    title: CRM export
generated: |
  by: etl
  at: 2026-08-01
---

Body.`;

function fmOf(md: string): Frontmatter {
	const { frontmatter } = parseFrontmatter(md);
	if (!frontmatter) throw new Error('fixture has no frontmatter');
	return frontmatter;
}

// ---------- setting and removing ----------
{
	const r = applyFieldPatch(fmOf(PAGE), { done: '2026-08-10', owner: null });
	check('fields: ok', r.ok);
	if (r.ok) {
		check('fields: new key set', r.frontmatter.done === '2026-08-10');
		check('fields: null removes', !('owner' in r.frontmatter));
		check('fields: untouched keys survive', r.frontmatter.type === 'Todo');
		check(
			'fields: lists survive untouched',
			JSON.stringify(r.frontmatter.tags) === JSON.stringify(['backlog', 'q3'])
		);
		check('fields: summary names both halves', r.summary === 'set done; removed owner', r.summary);
		check('fields: changed counts both', r.changed === 2, String(r.changed));
	}
}

// ---------- value shapes ----------
{
	const r = applyFieldPatch(fmOf(PAGE), { priority: 2, blocked: false, tags: ['done', 'q3'] });
	check('fields: numbers become text', r.ok && r.frontmatter.priority === '2');
	check('fields: booleans become text', r.ok && r.frontmatter.blocked === 'false');
	check(
		'fields: a list replaces a list',
		r.ok && JSON.stringify(r.frontmatter.tags) === JSON.stringify(['done', 'q3'])
	);
}
{
	// The whole point of the write path: the body is never an input here.
	const r = applyFieldPatch(fmOf(PAGE), { done: 'yes' });
	check(
		'fields: empty string is a value, not a removal',
		applyFieldPatch(fmOf(PAGE), { note: '' }).ok
	);
	if (r.ok)
		check(
			'fields: serializes back to a readable page',
			!!parseFrontmatter(withFrontmatter(r.frontmatter, 'Body.')).frontmatter?.done
		);
}

// ---------- idempotence ----------
{
	const r = applyFieldPatch(fmOf(PAGE), { owner: 'ana' });
	check('fields: an unchanged value counts as no change', r.ok && r.changed === 0);
	const n = applyFieldPatch(fmOf(PAGE), { priority: 2 });
	const again = n.ok ? applyFieldPatch(n.frontmatter, { priority: '2' }) : null;
	check('fields: 2 and "2" are the same value', !!again && again.ok && again.changed === 0);
	const gone = applyFieldPatch(fmOf(PAGE), { nope: null });
	check('fields: removing an absent key changes nothing', gone.ok && gone.changed === 0);
}

// ---------- key names must survive a read ----------
for (const bad of ['due date', 'due.date', 'due:date', '', 'dûe']) {
	const r = applyFieldPatch(fmOf(PAGE), { [bad]: 'x' });
	check(`fields: rejects the unreadable key ${JSON.stringify(bad)}`, !r.ok);
}
check(
	'fields: accepts letters, digits, dash, underscore',
	applyFieldPatch(fmOf(PAGE), {
		'due_date-2': 'x'
	}).ok
);

// ---------- managed keys route to their own arguments ----------
for (const key of MANAGED_FIELD_KEYS) {
	const r = applyFieldPatch(fmOf(PAGE), { [key]: 'x' });
	check(`fields: refuses the managed key "${key}"`, !r.ok);
	if (!r.ok)
		check(
			`fields: ...and names the argument to use instead`,
			/argument|automatically/.test(r.error),
			r.error
		);
}

// ---------- nested YAML is never flattened ----------
{
	const set = applyFieldPatch(fmOf(NESTED), { sources: 'crm/export.csv' });
	check('fields: refuses to overwrite a nested block', !set.ok);
	const drop = applyFieldPatch(fmOf(NESTED), { generated: null });
	check('fields: refuses to remove a nested block', !drop.ok);
	const beside = applyFieldPatch(fmOf(NESTED), { done: 'yes' });
	check('fields: writes alongside a nested block happily', beside.ok);
	if (beside.ok) {
		// The bug this guards: any writer that flattens these loses provenance on save.
		check(
			'fields: ...and the block round-trips byte for byte',
			withFrontmatter(beside.frontmatter, 'Body.').includes(
				'sources:\n  - resource: crm/export.csv\n    title: CRM export'
			),
			withFrontmatter(beside.frontmatter, 'Body.')
		);
	}
}

// ---------- an empty patch says nothing ----------
check('fields: an empty patch is an error', !applyFieldPatch(fmOf(PAGE), {}).ok);
check('fields: validate agrees before any page is fetched', validateFieldPatch({}) !== null);
check('fields: validate passes a good patch', validateFieldPatch({ done: 'yes' }) === null);

// ---------------------------------------------------------------------------
console.log('\nwrite_page: what it decides before the repository is read (checkPageWrite)');
// ---------------------------------------------------------------------------
// wiki/ is content, raw/ is source, wiki/log.md is the changelog.
const POLICY = { paths: parsePaths({}) };
const refuses = (r: { ok: boolean; error?: string }, text: string) =>
	!r.ok && (r as { error: string }).error.includes(text);
{
	const ok = checkPageWrite({ path: ' /wiki/a.md', content: 'x' }, POLICY);
	check('check: the target is normalized', ok.ok && ok.target === 'wiki/a.md');
	check(
		'check: a non-.md path',
		refuses(checkPageWrite({ path: 'wiki/a' }, POLICY), 'must end in .md')
	);
	check(
		'check: content AND a patch is refused, not one silently dropped',
		refuses(checkPageWrite({ path: 'wiki/a.md', content: 'x', append: 'y' }, POLICY), 'not both')
	);
	check(
		'check: an EMPTY edits list is not a patch, so content alone passes',
		checkPageWrite({ path: 'wiki/a.md', content: 'x', edits: [] }, POLICY).ok
	);
	check(
		'check: source material',
		refuses(checkPageWrite({ path: 'raw/a.md' }, POLICY), 'source material')
	);
	check(
		'check: the changelog',
		refuses(checkPageWrite({ path: 'wiki/log.md' }, POLICY), 'maintained automatically')
	);
	check(
		'check: outside content is NOT refused yet (an existing page there stays updatable)',
		checkPageWrite({ path: 'README.md', content: 'x' }, POLICY).ok
	);
	check(
		'check: a bad field patch is refused before any read',
		refuses(checkPageWrite({ path: 'wiki/a.md', fields: { title: 'x' } }, POLICY), 'title')
	);
	check('isPatching: append', isPatching({ append: '' }));
	check('isPatching: edits', isPatching({ edits: [{ find: 'a', replace: 'b' }] }));
	check('isPatching: neither', !isPatching({}));
}

// ---------------------------------------------------------------------------
console.log('\nwrite_page: create, update, or refuse (planPageWrite)');
// ---------------------------------------------------------------------------
{
	const PAGE_NOW = { content: `---\ntitle: A\n---\n\n${BODY}`, sha: 'sha-now' };
	const plan = (
		args: Omit<PageWriteArgs, 'path'>,
		existing: typeof PAGE_NOW | null,
		target = 'wiki/a.md'
	) => planPageWrite({ path: target, ...args }, target, existing, POLICY);

	check(
		'plan: a new path with content is a create',
		(() => {
			const p = plan({ content: 'x' }, null);
			return p.ok && p.kind === 'create';
		})()
	);
	check(
		'plan: mode create on a new path',
		(() => {
			const p = plan({ content: 'x', mode: 'create' }, null);
			return p.ok && p.kind === 'create';
		})()
	);
	check(
		'plan: mode update on a MISSING page is refused',
		refuses(plan({ content: 'x', mode: 'update' }, null), 'does not exist')
	);
	check(
		'plan: append to a missing page is refused, naming the verb',
		refuses(plan({ append: 'x' }, null), 'nothing to append to')
	);
	check(
		'plan: edits to a missing page is refused, naming the verb',
		refuses(plan({ edits: [{ find: 'a', replace: 'b' }] }, null), 'nothing to edit')
	);
	check(
		'plan: a new page OUTSIDE content is refused here',
		refuses(plan({ content: 'x' }, null, 'README.md'), 'outside')
	);
	check(
		'plan: an existing page outside content is still updatable',
		(() => {
			const p = plan({ content: 'x' }, PAGE_NOW, 'README.md');
			return p.ok && p.kind === 'update';
		})()
	);

	check(
		'plan: mode create on an existing page is the clobber guard',
		refuses(plan({ content: 'x', mode: 'create' }, PAGE_NOW), 'already exists')
	);
	check(
		'plan: a STALE sha is refused (the editor must not save over a newer version)',
		refuses(plan({ content: 'x', sha: 'sha-old' }, PAGE_NOW), 'changed since you opened it')
	);
	check(
		'plan: the current sha passes',
		(() => {
			const p = plan({ content: 'x', sha: 'sha-now' }, PAGE_NOW);
			return p.ok && p.kind === 'update';
		})()
	);
	check('plan: no sha is a conversational caller and passes', plan({ content: 'x' }, PAGE_NOW).ok);
	check(
		'plan: the clobber guard outranks the sha guard',
		refuses(plan({ content: 'x', mode: 'create', sha: 'sha-old' }, PAGE_NOW), 'already exists')
	);
	check('plan: nothing to update is refused', refuses(plan({}, PAGE_NOW), 'Nothing to update'));
	check(
		'plan: an empty edits list is still nothing',
		refuses(plan({ edits: [] }, PAGE_NOW), 'Nothing to update')
	);
	for (const [label, args] of [
		['title', { title: 'B' }],
		['type', { type: 'Note' }],
		['description', { description: 'd' }],
		['status', { status: 'draft' as const }],
		['fields', { fields: { done: 'yes' } }]
	] as const)
		check(
			`plan: a ${label}-only write is an update`,
			(() => {
				const p = plan(args, PAGE_NOW);
				return p.ok && p.kind === 'update' && p.rawBody === undefined;
			})()
		);

	const appended = plan({ append: 'Added.' }, PAGE_NOW);
	check(
		'plan: append is applied to the BODY of the page as it stands',
		appended.ok &&
			appended.kind === 'update' &&
			appended.rawBody?.includes(BODY) === true &&
			appended.rawBody.trimEnd().endsWith('Added.') &&
			!appended.rawBody.includes('title: A')
	);
	check(
		'plan: the patch summary rides along',
		appended.ok && appended.kind === 'update' && !!appended.changeSummary
	);
	check(
		'plan: an edit anchored in FRONTMATTER finds nothing, because only the body is searched',
		!plan({ edits: [{ find: 'title: A', replace: 'title: B' }] }, PAGE_NOW).ok
	);
	check(
		'plan: a patch refusal comes back as the refusal',
		!plan({ edits: [{ find: 'not on the page', replace: 'x' }] }, PAGE_NOW).ok
	);
}

// ---------------------------------------------------------------------------
console.log('\nwrite_page: the new file (composeCreate / composeUpdate)');
// ---------------------------------------------------------------------------
const TODAY = '2026-09-23';
{
	const c = composeCreate('wiki/notes/weekly.md', { content: '# Weekly Sync\n\nBody.' }, TODAY);
	check('create: title falls back to the H1, not the filename', c.ok && c.title === 'Weekly Sync');
	const note = composeCreate('wiki/vendors/index.md', { content: 'Body.' }, TODAY);
	check(
		'create: a folder note is titled by its folder, never "index"',
		note.ok && note.title === 'vendors'
	);
	const typed = composeCreate(
		'wiki/a.md',
		{ content: '---\ntype: Vendor\n---\nBody.', title: 'A' },
		TODAY
	);
	check(
		'create: a type the content declared is kept',
		typed.ok && fmOf(typed.content).type === 'Vendor'
	);
	check(
		'create: type leads the frontmatter',
		typed.ok && typed.content.startsWith('---\ntype: Vendor\ntitle: A')
	);
	const untyped = composeCreate('wiki/a.md', { content: 'Body.', title: 'A' }, TODAY);
	check('create: no type is invented', untyped.ok && !('type' in fmOf(untyped.content)));
	check('create: updated is stamped', untyped.ok && fmOf(untyped.content).updated === TODAY);
	const kept = composeCreate(
		'wiki/a.md',
		{ content: '---\nsources: [x]\nowner: ops\n---\nBody.', title: 'A' },
		TODAY
	);
	check(
		"create: the caller's own keys survive, including a managed NAME this call does not set",
		kept.ok && fmOf(kept.content).owner === 'ops' && 'sources' in fmOf(kept.content)
	);
	const explicit = composeCreate(
		'wiki/a.md',
		{ content: '---\ntitle: Old\n---\nBody.', title: 'New' },
		TODAY
	);
	check(
		'create: the title argument outranks the content',
		explicit.ok && fmOf(explicit.content).title === 'New'
	);
	const withFields = composeCreate(
		'wiki/a.md',
		{ content: 'Body.', title: 'A', fields: { owner: 'ops' }, status: 'draft' },
		TODAY
	);
	check('create: fields land at birth', withFields.ok && fmOf(withFields.content).owner === 'ops');
	check('create: the status is reported', withFields.ok && withFields.status === 'draft');
	check(
		'create: a bad field is refused',
		!composeCreate('wiki/a.md', { title: 'A', fields: { 'a b': 'x' } }, TODAY).ok
	);
}
{
	const PAGE_FM = `---\ntitle: A\nstatus: draft\nowner: ops\n---\n\nOne\nTwo\nThree`;
	const up = (args: Parameters<typeof composeUpdate>[2], existing = PAGE_FM, cap = 24) =>
		composeUpdate('wiki/a.md', existing, args, TODAY, cap);

	const meta = up({ status: 'stable' });
	check(
		'update: metadata-only keeps the body verbatim',
		meta.ok && meta.content.endsWith('One\nTwo\nThree')
	);
	check('update: other keys are preserved', meta.ok && fmOf(meta.content).owner === 'ops');
	check('update: a status change is reported', meta.ok && meta.statusChanged === 'stable');
	check(
		'update: the same status is not a change',
		(() => {
			const r = up({ status: 'draft' });
			return r.ok && r.statusChanged === undefined;
		})()
	);
	check('update: updated is stamped', meta.ok && fmOf(meta.content).updated === TODAY);

	const retitle = up({ title: 'B' });
	check(
		'update: a retitle names the old title, so its wikilinks get repointed',
		retitle.ok && retitle.retitledFrom === 'A' && retitle.label === 'B'
	);
	check(
		'update: the same title is not a retitle',
		(() => {
			const r = up({ title: 'A' });
			return r.ok && r.retitledFrom === undefined;
		})()
	);
	check(
		'update: a page with no title has no links to repoint',
		(() => {
			const r = up({ title: 'B' }, 'Plain body.');
			return r.ok && r.retitledFrom === undefined;
		})()
	);

	const clobber = up({ content: 'Just one line.' });
	check(
		'update: a whole-body replace SAYS what it replaced',
		clobber.ok && clobber.notes[0] === 'replaced the whole body (was 3 lines, now 1)'
	);
	check(
		'update: an identical replace says nothing',
		(() => {
			const r = up({ content: 'One\nTwo\nThree' });
			return r.ok && r.notes.length === 0;
		})()
	);
	check(
		'update: a patch reports its own summary instead',
		(() => {
			const r = up({ rawBody: 'x', changeSummary: 'appended 1 line', content: 'ignored' });
			return r.ok && r.notes[0] === 'appended 1 line';
		})()
	);
	check(
		'update: rawBody is never re-parsed for frontmatter',
		(() => {
			const r = up({ rawBody: '---\nnot: frontmatter\n---\nbody' });
			return r.ok && fmOf(r.content).not === undefined && r.content.includes('not: frontmatter');
		})()
	);
	check(
		'update: replacement content carrying frontmatter merges it',
		(() => {
			const r = up({ content: '---\nowner: eng\n---\nNew body.' });
			return r.ok && fmOf(r.content).owner === 'eng' && fmOf(r.content).title === 'A';
		})()
	);
	check(
		'update: a page without frontmatter stays without it',
		(() => {
			const r = up({ content: 'New body.' }, 'Old body.');
			return r.ok && r.content === 'New body.';
		})()
	);
	check(
		'update: ...unless the call sets a managed field',
		(() => {
			const r = up({ type: 'Note' }, 'Old body.');
			return r.ok && fmOf(r.content).type === 'Note';
		})()
	);
	check(
		'update: the label falls back to the path',
		(() => {
			const r = up({ content: 'x' }, 'Old body.');
			return r.ok && r.label === 'wiki/a.md';
		})()
	);

	const f = up({ fields: { team: 'core' } });
	check(
		'update: a field patch reports its summary',
		f.ok && f.notes.some((n) => n.includes('team'))
	);
	const capped = up({ fields: { team: 'core' } }, PAGE_FM, 3);
	check(
		'update: past the indexed-key cap, the reply says the field cannot be filtered on',
		capped.ok &&
			capped.notes.some((n) => n.startsWith('heads up:') && n.includes('only the first 3'))
	);
	check(
		'update: under the cap, no warning',
		f.ok && !f.notes.some((n) => n.startsWith('heads up:'))
	);
	check('update: a bad field is refused', !up({ fields: { title: 'x' } }).ok);
}

done();
