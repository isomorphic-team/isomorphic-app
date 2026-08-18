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

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

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

console.log(failures === 0 ? '\nAll page-patch checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
