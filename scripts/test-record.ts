// Golden test for the change record (src/lib/change-record.ts): what a write says
// about itself. The changelog bullet lands in `wiki/log.md` inside the brain's own
// repository, the commit message and PR text land in its history, and the two
// replies are what the caller reads. Pure, no store.
//
// No test checked a single changelog line before this: e2e-librarian counts
// commits. Two rules here are the ones worth the file:
//
//   - A PROPOSED change never claims to be logged. A pull request is not on the
//     branch yet, so "the change was logged" in that reply would be false, and it is
//     the reply a caller acts on.
//   - The "still linked" note is CAPPED. A deleted hub page can have hundreds of
//     linkers, and the reply is read inside a conversation.
//
//   pnpm test:record

import {
	commitOpts,
	changelogWrite,
	truncationNote,
	touchesToolsArea,
	toolRosterNote,
	refNote,
	MAX_REFS_LISTED,
	describeChange,
	type Change
} from '../src/lib/change-record.ts';
import { parsePaths } from '../src/lib/brain-config.ts';
import type { BrainConfig } from '../src/lib/brain-policy.ts';
import { MAX_SCAN_PAGES } from '../src/lib/brain-repo.ts';

import { checker } from './check.ts';

const { check, done } = checker('change-record checks');

const config = {
	paths: parsePaths({}),
	writeMode: 'pull-request',
	defaultBranch: 'trunk',
	autoMerge: false,
	mergeMethod: 'SQUASH',
	indexedFields: null,
	sourceOfTruth: 'app'
} as unknown as BrainConfig;
const author = { name: 'Ada', email: 'ada@example.com' };

// ---------------------------------------------------------------------------
console.log('\nThe commit-options preamble and the changelog write');
// ---------------------------------------------------------------------------
check(
	'commitOpts: the five fields, from the config and the author',
	JSON.stringify(commitOpts(config, author)) ===
		'{"writeMode":"pull-request","defaultBranch":"trunk","author":{"name":"Ada","email":"ada@example.com"},"autoMerge":false,"mergeMethod":"SQUASH"}'
);
check(
	'commitOpts: no author stays absent (App-authored)',
	commitOpts(config, undefined).author === undefined
);
check('changelogWrite: no log, no write', changelogWrite(config, null, '2026-09-22', 'x') === null);
const entry = changelogWrite(
	config,
	{ content: '# Log\n\n<!-- newest first -->\n' },
	'2026-09-22',
	'Created "A" (`wiki/a.md`).'
);
check('changelogWrite: lands at the configured log path', entry?.path === 'wiki/log.md');
check(
	'changelogWrite: the bullet under a dated heading',
	entry?.content.includes('## 2026-09-22\n\n- Created "A" (`wiki/a.md`).') === true,
	entry?.content
);

// ---------------------------------------------------------------------------
console.log('\nThe notes');
// ---------------------------------------------------------------------------
check('truncationNote: nothing when nothing was cut', truncationNote(false) === '');
check('truncationNote: names the cap', truncationNote(true).includes(`first ${MAX_SCAN_PAGES}`));
check('touchesToolsArea: a tool page', touchesToolsArea('wiki/tools/digest.md'));
check(
	'touchesToolsArea: a folder note under tools/ is not a tool',
	!touchesToolsArea('wiki/tools/index.md')
);
check('touchesToolsArea: an ordinary page', !touchesToolsArea('wiki/notes/tools.md'));
check('touchesToolsArea: the tools folder itself', touchesToolsArea('wiki/tools'));
check('touchesToolsArea: a folder with tools in the middle', touchesToolsArea('wiki/tools/legacy'));
check('touchesToolsArea: a folder merely named like it', !touchesToolsArea('wiki/toolshed'));
check('toolRosterNote: empty for ordinary paths', toolRosterNote('wiki/a.md', 'wiki/b.md') === '');
check(
	'toolRosterNote: fires if ANY path touches tools/',
	toolRosterNote('wiki/a.md', 'wiki/tools/x.md').includes('Reconnect')
);

const refs = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ path: `wiki/p${i}.md`, count: i + 1 }));
check('refNote: nothing when nothing links', refNote([]) === '');
check(
	'refNote: lists each linker with its count and says what to do',
	refNote(refs(2)) ===
		'\n\nHeads up: 2 page(s) still link to it:\n- wiki/p0.md (1 link(s))\n- wiki/p1.md (2 link(s))\nUpdate those pages to remove or repoint the links.'
);
check(
	'refNote: the folder wording',
	refNote(refs(1), { into: true }).includes('elsewhere still link into it')
);
{
	const note = refNote(refs(MAX_REFS_LISTED + 5));
	check(
		'refNote: CAPPED, with the remainder counted',
		note.includes(`…and 5 more.`) && !note.includes(`wiki/p${MAX_REFS_LISTED}.md`)
	);
	check('refNote: the headline counts them all', note.includes(`${MAX_REFS_LISTED + 5} page(s)`));
}

// ---------------------------------------------------------------------------
console.log('\nThe record, one entry per operation');
// ---------------------------------------------------------------------------
const create = describeChange({
	kind: 'create',
	path: 'wiki/a.md',
	title: 'A',
	status: 'draft',
	description: 'About A'
});
check('create: bullet', create.bullet === 'Created "A" (`wiki/a.md`).');
check(
	'create: commit message names the status and description',
	create.commit.message ===
		'Add A (wiki/a.md)\n\nNew page with status draft: About A. Logged in the same change.'
);
check(
	'create: PR',
	create.commit.prTitle === 'Add A' &&
		create.commit.prBody ===
			'Create `wiki/a.md`: About A. Proposed via the Isomorphic brain tools.' &&
		create.commit.branchPrefix === 'isomorphic/create'
);
check(
	'create: done',
	create.done === 'Created "A" at wiki/a.md with status draft. The change was logged.'
);
check(
	'create: proposed',
	create.proposed === 'Proposed a new page "A" at wiki/a.md with status draft.'
);
check(
	'create: a tool page carries the reconnect nudge in both replies',
	(() => {
		const r = describeChange({ kind: 'create', path: 'wiki/tools/t.md', title: 'T' });
		return r.done.includes('Reconnect') && r.proposed.includes('Reconnect');
	})()
);

const update = describeChange({
	kind: 'update',
	path: 'wiki/a.md',
	label: 'A2',
	statusChanged: 'stable',
	retitledFrom: 'A',
	notes: ['replaced the whole body (was 3 lines, now 5)']
});
check(
	'update: bullet names the status change',
	update.bullet === 'Updated "A2" (`wiki/a.md`), status: stable.'
);
check(
	'update: commit message records the retitle',
	update.commit.message ===
		'Update A2 (wiki/a.md)\n\nRetitled from "A"; inbound wikilinks repointed.'
);
check(
	'update: done carries the notes',
	update.done === 'Saved "A2". replaced the whole body (was 3 lines, now 5). The change was logged.'
);
check(
	'update: proposed carries the notes',
	update.proposed === 'Proposed an update to "A2". replaced the whole body (was 3 lines, now 5). '
);
{
	const plain = describeChange({ kind: 'update', path: 'wiki/a.md', label: 'A', notes: [] });
	check('update: plain bullet', plain.bullet === 'Updated "A" (`wiki/a.md`).');
	check('update: plain commit message', plain.commit.message === 'Update A (wiki/a.md)');
	check('update: no notes, no gap', plain.done === 'Saved "A". The change was logged.');
}

const movePage = describeChange({
	kind: 'move-page',
	path: 'wiki/a.md',
	newPath: 'wiki/b.md',
	oldTitle: 'A',
	newTitle: 'B',
	repointed: 3,
	truncated: false
});
check(
	'move-page: bullet names the new title',
	movePage.bullet === 'Moved "A" to `wiki/b.md` (now "B").'
);
check(
	'move-page: done',
	movePage.done ===
		'Moved "A" to wiki/b.md and renamed it "B". Links in 3 page(s) were repointed; the change was logged.'
);
check(
	'move-page: proposed',
	movePage.proposed ===
		'Proposed moving "A" to wiki/b.md (renamed "B"); links in 3 page(s) repointed.'
);
check(
	'move-page: PR title uses the arrow',
	movePage.commit.prTitle === 'Move wiki/a.md → wiki/b.md'
);
{
	const same = describeChange({
		kind: 'move-page',
		path: 'wiki/a.md',
		newPath: 'wiki/x/a.md',
		oldTitle: 'A',
		newTitle: 'A',
		repointed: 0,
		truncated: true
	});
	check(
		'move-page: same title, no rename clause',
		same.bullet === 'Moved "A" to `wiki/x/a.md`.' && !same.done.includes('renamed')
	);
	check(
		'move-page: truncation rides both replies',
		same.done.includes('only the first') && same.proposed.includes('only the first')
	);
}

const moveFolder = describeChange({
	kind: 'move-folder',
	folder: 'wiki/P',
	newFolder: 'wiki/Q',
	repointed: 2,
	truncated: false,
	keptMarkers: ['wiki/Q/.gitkeep', 'wiki/Q/index.md']
});
check('move-folder: bullet', moveFolder.bullet === 'Moved folder `wiki/P` to `wiki/Q`.');
check(
	'move-folder: a merge names what the destination kept',
	moveFolder.done ===
		'Moved folder "wiki/P" to wiki/Q. Merged into the existing "wiki/Q", which keeps its own .gitkeep, index.md. Links in 2 page(s) were repointed; the change was logged.'
);
check(
	'move-folder: no merge, no merge note',
	!describeChange({
		kind: 'move-folder',
		folder: 'a',
		newFolder: 'b',
		repointed: 0,
		truncated: false,
		keptMarkers: []
	}).done.includes('Merged')
);

const moveFile = describeChange({
	kind: 'move-file',
	path: 'wiki/img/a.png',
	newPath: 'wiki/img/b.png',
	repointed: 1,
	truncated: false
});
check('move-file: bullet', moveFile.bullet === 'Moved `wiki/img/a.png` to `wiki/img/b.png`.');
check(
	'move-file: done',
	moveFile.done ===
		'Moved "wiki/img/a.png" to wiki/img/b.png. Links in 1 page(s) were repointed; the change was logged.'
);

const delPage = describeChange({
	kind: 'delete-page',
	path: 'wiki/a.md',
	title: 'A',
	refs: refs(1),
	truncated: false
});
check('delete-page: bullet', delPage.bullet === 'Deleted "A" (`wiki/a.md`).');
check(
	'delete-page: done carries the still-linked note',
	delPage.done.startsWith(
		'Deleted "A" (wiki/a.md). The change was logged.\n\nHeads up: 1 page(s) still link to it:'
	)
);
check(
	'delete-page: PR',
	delPage.commit.prTitle === 'Delete A' && delPage.commit.branchPrefix === 'isomorphic/delete'
);

const delFolder = describeChange({
	kind: 'delete-folder',
	folder: 'wiki/P',
	pageCount: 1,
	refs: [],
	truncated: false
});
check(
	'delete-folder: singular page count',
	delFolder.bullet === 'Deleted folder `wiki/P` (1 page).'
);
check(
	'delete-folder: plural page count',
	describeChange({
		kind: 'delete-folder',
		folder: 'wiki/P',
		pageCount: 3,
		refs: [],
		truncated: false
	}).commit.message === 'Delete folder wiki/P (3 pages)\n\nDeletion logged.'
);
check(
	'delete-folder: the folder wording for linkers',
	describeChange({
		kind: 'delete-folder',
		folder: 'wiki/P',
		pageCount: 3,
		refs: refs(1),
		truncated: false
	}).done.includes('elsewhere still link into it')
);

const delFile = describeChange({
	kind: 'delete-file',
	path: 'wiki/img/a.png',
	refs: [],
	truncated: false
});
check('delete-file: bullet', delFile.bullet === 'Deleted `wiki/img/a.png`.');
check('delete-file: done', delFile.done === 'Deleted "wiki/img/a.png". The deletion was logged.');

// ---------------------------------------------------------------------------
console.log('\nInvariants across every operation');
// ---------------------------------------------------------------------------
const EVERY: Change[] = [
	{ kind: 'create', path: 'wiki/tools/a.md', title: 'A' },
	{ kind: 'update', path: 'wiki/a.md', label: 'A', notes: ['n'] },
	{
		kind: 'move-page',
		path: 'wiki/a.md',
		newPath: 'wiki/b.md',
		oldTitle: 'A',
		newTitle: 'A',
		repointed: 1,
		truncated: true
	},
	{
		kind: 'move-folder',
		folder: 'wiki/P',
		newFolder: 'wiki/Q',
		repointed: 1,
		truncated: true,
		keptMarkers: []
	},
	{ kind: 'move-file', path: 'a.png', newPath: 'b.png', repointed: 0, truncated: false },
	{ kind: 'delete-page', path: 'wiki/a.md', title: 'A', refs: refs(2), truncated: true },
	{ kind: 'delete-folder', folder: 'wiki/tools', pageCount: 2, refs: refs(2), truncated: false },
	{ kind: 'delete-file', path: 'a.png', refs: refs(1), truncated: false }
];
for (const c of EVERY) {
	const r = describeChange(c);
	check(
		`${c.kind}: a PROPOSED change never claims to be logged`,
		!/logged/i.test(r.proposed),
		r.proposed
	);
	check(`${c.kind}: a landed change says it was logged`, /logged/i.test(r.done), r.done);
	check(
		`${c.kind}: the bullet is one sentence ending in a period`,
		r.bullet.endsWith('.') && !r.bullet.includes('\n'),
		r.bullet
	);
	check(
		`${c.kind}: the PR body says who proposed it`,
		r.commit.prBody?.endsWith('Proposed via the Isomorphic brain tools.') === true
	);
	check(
		`${c.kind}: the branch prefix is namespaced`,
		r.commit.branchPrefix?.startsWith('isomorphic/') === true
	);
	check(
		`${c.kind}: no em-dash in what a person reads`,
		![r.bullet, r.done, r.proposed, r.commit.message].some((s) => s.includes('—'))
	);
}

done();
