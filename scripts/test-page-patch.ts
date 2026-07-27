// Golden test for write_page's non-destructive body edits (src/lib/page-patch.ts):
// append, ordered find/replace, the exactly-once anchor rule, and the refusal to
// anchor on generated okf-view snapshot text. Pure — no D1, no GitHub.
// Run: pnpm test:patch
import { applyPageEdits } from '../src/lib/page-patch.ts';
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

console.log(failures === 0 ? '\nAll page-patch checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
