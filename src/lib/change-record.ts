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
import { insertLogEntry } from './wiki.ts';

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
		? '\n\nHeads up: this changes your custom tools. Reconnect the Isomorphic connector in Claude (Settings → Connectors) so the new tool list is picked up.'
		: '';
}

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
	| { kind: 'create'; path: string; title: string; status?: string; description?: string }
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
			const tools = toolRosterNote(c.path);
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
			const notes = c.notes.length ? c.notes.join('; ') + '. ' : '';
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
