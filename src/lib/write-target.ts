// Where a write lands, and whether it may: the path rules the librarian's write
// tools share. Pure, so `pnpm test:policy` can pin them.
//
// Every write tool takes a path a caller typed by hand, and each one normalized it
// and guarded it with its own copy of the same three checks. The copies drifted:
// move_page never checked that its SOURCE was editable content, its rename of a
// repo-root page computed "foo.m/slug.md", and the page branches of move and delete
// skipped the normalization every other branch did.

import { type PathPolicy, isContentPath, isSourcePath, isToolMaintained } from './brain-policy.ts';
import { slugify } from './wiki.ts';

/** A file path as the tools address it: no surrounding whitespace, no leading slash. */
export function normPagePath(p: string): string {
	return p.trim().replace(/^\/+/, '');
}

/** A folder path: no surrounding whitespace or slashes, so `${folder}/` prefix checks are unambiguous. '' means unspecified. */
export function normFolderPath(p: string): string {
	return p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

export type WriteVerb = 'written' | 'moved' | 'deleted';

/**
 * Why a path may not be written, moved or deleted, or null when it may. Three
 * checks in order: source material is immutable, tool-maintained files are the
 * tools' own, and everything else has to be inside the brain's editable content.
 * `content: false` skips the last one for a caller that decides it later (write_page
 * only asks it of a NEW page).
 */
export function writeRefusal(
	path: string,
	config: PathPolicy,
	verb: WriteVerb,
	opts: { content?: boolean } = {}
): string | null {
	if (isSourcePath(path, config)) return `"${path}" is source material, so it can't be ${verb}.`;
	if (isToolMaintained(path, config)) return `"${path}" is maintained automatically.`;
	if (opts.content !== false && !isContentPath(path, config))
		return `"${path}" is outside this brain's editable content.`;
	return null;
}

/** The same for a whole folder: the first entry that may not move or go refuses the folder. */
export function folderWriteRefusal(
	folder: string,
	entries: { path: string }[],
	config: PathPolicy,
	verb: WriteVerb
): string | null {
	for (const e of entries) {
		if (isSourcePath(e.path, config))
			return `"${folder}" contains source material, so it can't be ${verb}.`;
		if (isToolMaintained(e.path, config))
			return `"${folder}" contains a tool-maintained file, so it can't be ${verb}.`;
	}
	return null;
}

/** What a path with no `.md` extension names, by asking the tree rather than guessing. */
export function nonPageKind(cleaned: string, tree: { path: string }[]): 'file' | 'folder' | null {
	if (tree.some((e) => e.path === cleaned)) return 'file';
	if (tree.some((e) => e.path.startsWith(`${cleaned}/`))) return 'folder';
	return null;
}

export type MoveKind = 'page' | 'file' | 'folder';
export type MoveTarget = { ok: true; target: string } | { ok: false; error: string };

export const MOVE_ARGS_HINT = 'Give a new_path (move/rename) or a new_title (rename in place).';

/**
 * Where a move lands. `new_path` is taken as given; `new_name` renames in place,
 * under the same parent (a repo-root path has none). A page's new name is slugified
 * into a filename; a file's and a folder's are used as typed.
 */
export function resolveMoveTarget(
	path: string,
	args: { new_path?: string; new_name?: string },
	kind: MoveKind
): MoveTarget {
	const explicit = args.new_path?.trim();
	const name = args.new_name?.trim();
	if (!explicit && !name) return { ok: false, error: MOVE_ARGS_HINT };
	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const under = (leaf: string) => (parent ? `${parent}/${leaf}` : leaf);
	const target =
		kind === 'folder'
			? normFolderPath(explicit || under(name!))
			: kind === 'page'
				? explicit
					? normPagePath(explicit)
					: under(`${slugify(name!)}.md`)
				: normPagePath(explicit || under(name!));
	if (!target)
		return {
			ok: false,
			error: kind === 'folder' ? 'The new folder path is empty.' : 'The new path is empty.'
		};
	if (kind === 'page' && !target.endsWith('.md'))
		return { ok: false, error: 'Target must end in .md.' };
	if (kind === 'folder' && target.startsWith(`${path}/`))
		return { ok: false, error: `Can't move "${path}" into itself.` };
	return { ok: true, target };
}
