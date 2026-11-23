// What a write SAYS about itself: the changelog bullet, the commit message, the
// pull-request text, and the two replies to the caller (one when the change landed
// on the branch, one when it became a PR). Pure, one entry per operation, pinned by
// `pnpm test:record`.
//
// Each librarian write composed these inline, eight times over, beside its own copy
// of the commit-options preamble and the changelog append. No test checked a single
// changelog line, and the three copies of the "still linked" note had drifted: one
// capped the list at 20, one did not, one added advice the others lacked. The
// changelog is a file in the brain's own repository that people read, so its
// wording is a contract, and this is where it is kept.

import type { BrainConfig } from './brain-policy.ts';
import { logPathOf } from './brain-policy.ts';
import type { CommitAuthor, CommitOrPROpts, FileWrite } from './brain-repo.ts';
import { MAX_SCAN_PAGES } from './brain-repo.ts';
import { isToolPagePath } from './custom-tools.ts';
import type { Frontmatter } from './wiki.ts';
import { insertLogEntry, listOf } from './wiki.ts';

// ---------- the commit-options preamble ----------

/** How a brain's writes land: the five fields every commitOrPR call reads off the config. */
export function commitOpts(
	config: BrainConfig,
	author: CommitAuthor | undefined
): Pick<CommitOrPROpts, 'writeMode' | 'defaultBranch' | 'author' | 'autoMerge' | 'mergeMethod'> {
	return {
		writeMode: config.writeMode,
		defaultBranch: config.defaultBranch,
		author,
		autoMerge: config.autoMerge,
		mergeMethod: config.mergeMethod
	};
}

/** The changelog write for this bullet, or null when the brain keeps no log or the log could not be read. */
export function changelogWrite(
	config: BrainConfig,
	log: { content: string } | null | undefined,
	today: string,
	bullet: string
): FileWrite | null {
	if (!log) return null;
	return { path: logPathOf(config), content: insertLogEntry(log.content, today, bullet) };
}

// ---------- the notes a reply may carry ----------

export function truncationNote(truncated: boolean): string {
	return truncated
		? `\n\nNote: this brain has more than ${MAX_SCAN_PAGES} pages; only the first ${MAX_SCAN_PAGES} were scanned.`
		: '';
}

/** Does this path touch the tools/ area? Files use the precise page rule; a folder path matches any `tools` segment. */
export function touchesToolsArea(path: string): boolean {
	return path.endsWith('.md') ? isToolPagePath(path) : path.split('/').includes('tools');
}

/**
 * A write that adds, renames or removes a tool page changes the set of registered
 * custom tools, and the stateless transport cannot push tools/list_changed, so the
 * host only sees the new roster after it re-lists. Empty unless a tool path is
 * involved. Editing an existing tool's BODY needs no reconnect.
 */
export function toolRosterNote(...paths: string[]): string {
	return paths.some(touchesToolsArea)
		? '\n\nHeads up: this changes your custom tools. Reconnect the Isomorphic connector in your AI assistant so it picks up the new tool list.'
		: '';
}

/** What `expectationNote` reads about a write. */
export interface ExpectationInput {
	kind: 'create' | 'update';
	/** The page's frontmatter after the write. */
	frontmatter: Frontmatter;
	/** The `fields` patch the call sent, if any. */
	patch?: Record<string, unknown> | null;
	/** The text this write added: the new body, the appended text, the new side of each edit. */
	added?: string[];
}

const COMMITMENT_TYPE_RE = /decision|commitment/i;
const WEEKDAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?';
const MONTH =
	'(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DEADLINE_RE = new RegExp(
	`\\b(?:by|before|until|due)\\s+(?:${WEEKDAY}|${MONTH}|\\d{4}-\\d{2}-\\d{2}|next\\s+week)\\b`,
	'i'
);

/** Does the text carry a deadline: by, before, until or due, then a weekday, month, ISO date or "next week"? */
export function hasDeadlinePhrase(text: string): boolean {
	return DEADLINE_RE.test(text);
}

const hasValue = (fm: Frontmatter, key: string) => listOf(fm[key]).some((v) => v.trim() !== '');

/**
 * The prompt to record a commitment with its check date, at most one per write. A new
 * page typed Decision or Commitment with no `check_at` and no `outcome` gets it; an
 * update gets it when the call set `expected` and the page still has no `check_at`.
 * Failing those, a page of another type gets a second, narrower note when the text this
 * write added carries a deadline phrase. Empty otherwise.
 */
export function expectationNote(input: ExpectationInput): string {
	const fm = input.frontmatter;
	if (hasValue(fm, 'check_at')) return '';
	const commitmentPage = COMMITMENT_TYPE_RE.test(listOf(fm.type)[0] ?? '');
	if (input.kind === 'create') {
		if (commitmentPage) return hasValue(fm, 'outcome') ? '' : `${EXPECTATION_TEXT} ${RECORD_TEXT}`;
	} else if (input.patch != null && input.patch.expected != null && hasValue(fm, 'expected')) {
		return EXPECTATION_TEXT;
	}
	if (commitmentPage || hasValue(fm, 'outcome')) return '';
	return (input.added ?? []).some(hasDeadlinePhrase) ? DEADLINE_TEXT : '';
}

/**
 * The view that shows a page its record: the pages linking to it that carry a check
 * date, with what was expected and what happened. It filters on `check_at`, not on
 * `type`, so a page typed Bet or ADR counts and a page that links without a date does not.
 */
export const RECORD_VIEW = [
	'```okf-view',
	'kind: backlinks',
	'filter: { check_at: ">= 2000-01-01" }',
	'as: table',
	'columns: [title, expected, check_at, outcome]',
	'sort: check_at',
	'order: desc',
	'```'
].join('\n');

const RECORD_TEXT = `If the page whose claim this tests does not already show its record (read it first), offer to append this there with write_page append:\n${RECORD_VIEW}\none yes completes it. Then tell the person that page now shows its record.`;

const EXPECTATION_TEXT =
	'If the person gave a date, use it as check_at; otherwise ask. Tell the person the check date you set. One commitment per page: a second gets its own page. write_page fields {expected, check_at: YYYY-MM-DD}.';

const DEADLINE_TEXT =
	'This reads like a commitment. Left on this page it will not appear in validate or in a what-is-due answer. Create it now as its own page (write_page, type Commitment, fields {expected, check_at: YYYY-MM-DD}), linked from here, and keep your own follow-up field too. Tell the person the check date you set. (If you already made it, ignore this.)';

export const MAX_REFS_LISTED = 20;

/**
 * The pages that still link to something just deleted. Capped, because a deleted
 * hub page can have hundreds of linkers and the reply is read inside a conversation.
 * `into` is the folder wording: linkers live outside the folder and point into it.
 */
export function refNote(
	refs: { path: string; count: number }[],
	opts: { into?: boolean } = {}
): string {
	if (refs.length === 0) return '';
	const shown = refs
		.slice(0, MAX_REFS_LISTED)
		.map((r) => `- ${r.path} (${r.count} link(s))`)
		.join('\n');
	const more = refs.length > MAX_REFS_LISTED ? `\n…and ${refs.length - MAX_REFS_LISTED} more.` : '';
	const where = opts.into ? 'elsewhere still link into it' : 'still link to it';
	return `\n\nHeads up: ${refs.length} page(s) ${where}:\n${shown}${more}\nUpdate those pages to remove or repoint the links.`;
}

// ---------- the record ----------

type Refs = { path: string; count: number }[];

export type Change =
	| {
			kind: 'create';
			path: string;
			title: string;
			status?: string;
			description?: string;
			/** Set for a write that may need the commitment prompt. */
			expectation?: Omit<ExpectationInput, 'kind'>;
	  }
	| {
			kind: 'update';
			path: string;
			/** What the page is called now: its new title, else its old one, else the path. */
			label: string;
			/** Set when this write changed the status field. */
			statusChanged?: string;
			/** Set when this write retitled the page (and repointed the wikilinks that named it). */
			retitledFrom?: string;
			/** What the write did, in the caller's reply: a patch summary, a clobber size, a field summary. */
			notes: string[];
			expectation?: Omit<ExpectationInput, 'kind'>;
	  }
	| {
			kind: 'move-page';
			path: string;
			newPath: string;
			oldTitle: string;
			newTitle: string;
			repointed: number;
			truncated: boolean;
	  }
	| {
			kind: 'move-folder';
			folder: string;
			newFolder: string;
			repointed: number;
			truncated: boolean;
			/** Markers of the destination that were kept when the move was a MERGE into an existing folder. */
			keptMarkers: string[];
	  }
	| { kind: 'move-file'; path: string; newPath: string; repointed: number; truncated: boolean }
	| { kind: 'delete-page'; path: string; title: string; refs: Refs; truncated: boolean }
	| { kind: 'delete-folder'; folder: string; pageCount: number; refs: Refs; truncated: boolean }
	| { kind: 'delete-file'; path: string; refs: Refs; truncated: boolean };

export interface ChangeRecord {
	/** The changelog line, without its leading dash. */
	bullet: string;
	/** The commit message, PR branch prefix and PR text, ready to spread into commitOrPR's options. */
	commit: Pick<CommitOrPROpts, 'message' | 'branchPrefix' | 'prTitle' | 'prBody'>;
	/** The reply when the change landed on the branch. */
	done: string;
	/** The reply when the change became a pull request. */
	proposed: string;
}

const VIA = 'Proposed via the Isomorphic brain tools.';
const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

export function describeChange(c: Change): ChangeRecord {
	switch (c.kind) {
		case 'create': {
			const statusNote = c.status ? ` with status ${c.status}` : '';
			const exp = c.expectation ? expectationNote({ kind: 'create', ...c.expectation }) : '';
			const tools = toolRosterNote(c.path) + (exp ? `\n\n${exp}` : '');
			return {
				bullet: `Created "${c.title}" (\`${c.path}\`).`,
				commit: {
					message: `Add ${c.title} (${c.path})\n\nNew page${statusNote}${c.description ? `: ${c.description}` : ''}. Logged in the same change.`,
					branchPrefix: 'isomorphic/create',
					prTitle: `Add ${c.title}`,
					prBody: `Create \`${c.path}\`${c.description ? `: ${c.description}` : ''}. ${VIA}`
				},
				done: `Created "${c.title}" at ${c.path}${statusNote}. The change was logged.${tools}`,
				proposed: `Proposed a new page "${c.title}" at ${c.path}${statusNote}.${tools}`
			};
		}
		case 'update': {
			const exp = c.expectation ? expectationNote({ kind: 'update', ...c.expectation }) : '';
			const all = exp ? [...c.notes, exp.replace(/\.$/, '')] : c.notes;
			const notes = all.length ? all.join('; ') + '. ' : '';
			return {
				bullet: c.statusChanged
					? `Updated "${c.label}" (\`${c.path}\`), status: ${c.statusChanged}.`
					: `Updated "${c.label}" (\`${c.path}\`).`,
				commit: {
					message: `Update ${c.label} (${c.path})${c.retitledFrom ? `\n\nRetitled from "${c.retitledFrom}"; inbound wikilinks repointed.` : ''}`,
					branchPrefix: 'isomorphic/update',
					prTitle: `Update ${c.label}`,
					prBody: `Update \`${c.path}\`. ${VIA}`
				},
				done: `Saved "${c.label}". ${notes}The change was logged.`,
				proposed: `Proposed an update to "${c.label}". ${notes}`
			};
		}
		case 'move-page': {
			const renamed = c.newTitle !== c.oldTitle;
			const tail = `${truncationNote(c.truncated)}${toolRosterNote(c.path, c.newPath)}`;
			return {
				bullet: renamed
					? `Moved "${c.oldTitle}" to \`${c.newPath}\` (now "${c.newTitle}").`
					: `Moved "${c.oldTitle}" to \`${c.newPath}\`.`,
				commit: {
					message: `Move ${c.path} -> ${c.newPath}\n\nInbound links repointed across ${c.repointed} page(s); logged.`,
					branchPrefix: 'isomorphic/move',
					prTitle: `Move ${c.path} → ${c.newPath}`,
					prBody: `Move \`${c.path}\` to \`${c.newPath}\`; inbound links repointed. ${VIA}`
				},
				done: `Moved "${c.oldTitle}" to ${c.newPath}${renamed ? ` and renamed it "${c.newTitle}"` : ''}. Links in ${c.repointed} page(s) were repointed; the change was logged.${tail}`,
				proposed: `Proposed moving "${c.oldTitle}" to ${c.newPath}${renamed ? ` (renamed "${c.newTitle}")` : ''}; links in ${c.repointed} page(s) repointed.${tail}`
			};
		}
		case 'move-folder': {
			// Say when this was a MERGE rather than a move into empty space: the
			// destination already existed, and its markers were kept over the source's.
			const mergeNote = c.keptMarkers.length
				? ` Merged into the existing "${c.newFolder}", which keeps its own ${c.keptMarkers.map((p) => p.split('/').pop()).join(', ')}.`
				: '';
			const tail = `${truncationNote(c.truncated)}${toolRosterNote(c.folder, c.newFolder)}`;
			return {
				bullet: `Moved folder \`${c.folder}\` to \`${c.newFolder}\`.`,
				commit: {
					message: `Move folder ${c.folder} -> ${c.newFolder}\n\nInbound links repointed across ${c.repointed} page(s).`,
					branchPrefix: 'isomorphic/folder-move',
					prTitle: `Move folder ${c.folder} → ${c.newFolder}`,
					prBody: `Move folder \`${c.folder}\` to \`${c.newFolder}\`; inbound links repointed. ${VIA}`
				},
				done: `Moved folder "${c.folder}" to ${c.newFolder}.${mergeNote} Links in ${c.repointed} page(s) were repointed; the change was logged.${tail}`,
				proposed: `Proposed moving folder "${c.folder}" to ${c.newFolder}.${mergeNote} Links in ${c.repointed} page(s) repointed.${tail}`
			};
		}
		case 'move-file': {
			const tail = truncationNote(c.truncated);
			return {
				bullet: `Moved \`${c.path}\` to \`${c.newPath}\`.`,
				commit: {
					message: `Move ${c.path} -> ${c.newPath}\n\nRepointed ${c.repointed} page(s).`,
					branchPrefix: 'isomorphic/move',
					prTitle: `Move ${c.path} → ${c.newPath}`,
					prBody: `Move \`${c.path}\` to \`${c.newPath}\`. ${VIA}`
				},
				done: `Moved "${c.path}" to ${c.newPath}. Links in ${c.repointed} page(s) were repointed; the change was logged.${tail}`,
				proposed: `Proposed moving "${c.path}" to ${c.newPath}; links in ${c.repointed} page(s) repointed.${tail}`
			};
		}
		case 'delete-page': {
			const tail = `${refNote(c.refs)}${truncationNote(c.truncated)}${toolRosterNote(c.path)}`;
			return {
				bullet: `Deleted "${c.title}" (\`${c.path}\`).`,
				commit: {
					message: `Delete ${c.title} (${c.path})\n\nDeletion logged.`,
					branchPrefix: 'isomorphic/delete',
					prTitle: `Delete ${c.title}`,
					prBody: `Delete \`${c.path}\`. ${VIA}`
				},
				done: `Deleted "${c.title}" (${c.path}). The change was logged.${tail}`,
				proposed: `Proposed deleting "${c.title}" (${c.path}).${tail}`
			};
		}
		case 'delete-folder': {
			const label = pages(c.pageCount);
			const tail = `${refNote(c.refs, { into: true })}${truncationNote(c.truncated)}${toolRosterNote(c.folder)}`;
			return {
				bullet: `Deleted folder \`${c.folder}\` (${label}).`,
				commit: {
					message: `Delete folder ${c.folder} (${label})\n\nDeletion logged.`,
					branchPrefix: 'isomorphic/folder-delete',
					prTitle: `Delete folder ${c.folder}`,
					prBody: `Delete folder \`${c.folder}\` and its ${label}. ${VIA}`
				},
				done: `Deleted folder "${c.folder}" (${label}). The change was logged.${tail}`,
				proposed: `Proposed deleting folder "${c.folder}" (${label}).${tail}`
			};
		}
		case 'delete-file': {
			const tail = `${refNote(c.refs)}${truncationNote(c.truncated)}`;
			return {
				bullet: `Deleted \`${c.path}\`.`,
				commit: {
					message: `Delete ${c.path}\n\nDeletion logged.`,
					branchPrefix: 'isomorphic/delete',
					prTitle: `Delete ${c.path}`,
					prBody: `Delete \`${c.path}\`. ${VIA}`
				},
				done: `Deleted "${c.path}". The deletion was logged.${tail}`,
				proposed: `Proposed deleting "${c.path}".${tail}`
			};
		}
	}
}

// ---------- one pull request holding several changes ----------

// Ends the change list in a joined pull request's body, so the next append finds the
// list it is extending rather than reading prose people may have edited.
const CHANGE_LIST_END = '<!-- isomorphic:changes -->';

/**
 * The title and body of the brain's open pull request once `added` (the new write's
 * own PR title) joins it. The first append turns the original single-change text into
 * a list; later appends extend that list.
 */
export function coalescedPrText(
	pr: { title: string; body: string },
	added: string
): { title: string; body: string } {
	const end = pr.body.indexOf(CHANGE_LIST_END);
	const items =
		end === -1
			? [pr.title]
			: pr.body
					.slice(0, end)
					.split('\n')
					.filter((l) => l.startsWith('- '))
					.map((l) => l.slice(2));
	items.push(added.replace(/\s+/g, ' ').trim());
	const more = items.length - 1;
	return {
		title: `${items[0]} and ${more} more ${more === 1 ? 'change' : 'changes'}`,
		body: `Changes proposed via the Isomorphic brain tools:\n\n${items.map((i) => `- ${i}`).join('\n')}\n\n${CHANGE_LIST_END}\n`
	};
}

/**
 * view_activity's text. A store without `history` keeps no record to list, which is a
 * different answer from a brain nothing has changed yet.
 */
export function activityText(opts: {
	entries: { date: string; authorName: string; message: string; shortSha: string }[];
	scope: string;
	history: boolean;
	logPath: string;
}): string {
	if (!opts.history) {
		return `This brain's storage keeps no change history, so there is nothing to list or roll back to. ${opts.logPath} records what the tools changed.`;
	}
	if (opts.entries.length === 0) return `No recorded changes for ${opts.scope} yet.`;
	return `Recent changes to ${opts.scope}:\n${opts.entries
		.map((e) => `- ${e.date.slice(0, 10)} — ${e.authorName}: ${e.message} (${e.shortSha})`)
		.join('\n')}`;
}
