// What write_page does with its arguments, decided without touching a repository.
// Pure, pinned by `pnpm test:patch` beside the body and field patchers it calls.
//
// Two halves, split where the tool has to read the repository:
//
//   checkPageWrite  refusals that need no page: the path, the argument mix, a bad
//                   field patch. Answered before a round trip is spent.
//   planPageWrite   given the page as it stands (or its absence), whether this is a
//                   create, an update, or a refusal, and for an update the patched body.
//
// Then composeCreate / composeUpdate build the new file: frontmatter merged in the
// documented precedence, and the notes the reply carries about what the write did.
// The tool keeps only what needs IO: reading the head and the blob, refreshing view
// snapshots, repointing wikilinks on a retitle, and the commit.
//
// This was ~200 lines inside the write_page handler and two private functions, and
// the branches most likely to lose someone's work had no test: the sha guard that
// stops the editor saving over a newer version, "nothing to update", and a patch
// aimed at a page that does not exist.

import type { PathPolicy } from './brain-policy.ts';
import {
	applyFieldPatch,
	applyPageEdits,
	validateFieldPatch,
	type FieldPatch,
	type OkfPageStatus,
	type PageEdit
} from './page-patch.ts';
import { pageTitle, parseFrontmatter, withFrontmatter, type Frontmatter } from './wiki.ts';
import { normPagePath, writeRefusal } from './write-target.ts';

export interface PageWriteArgs {
	path: string;
	content?: string;
	append?: string;
	edits?: PageEdit[];
	title?: string;
	type?: string;
	description?: string;
	status?: OkfPageStatus;
	fields?: FieldPatch;
	sources?: string[];
	mode?: 'create' | 'update' | 'upsert';
	sha?: string;
}

export type Refusal = { ok: false; error: string };

/** A partial edit (append / edits) rather than a whole-body replacement. An empty edits list is not one. */
export function isPatching(args: Pick<PageWriteArgs, 'append' | 'edits'>): boolean {
	return args.append !== undefined || (args.edits !== undefined && args.edits.length > 0);
}

/** Refusals that need no page. On success, the normalized target path. */
export function checkPageWrite(
	args: PageWriteArgs,
	config: PathPolicy
): Refusal | { ok: true; target: string } {
	const target = normPagePath(args.path);
	if (!target.endsWith('.md'))
		return { ok: false, error: 'Pages must end in .md, e.g. "wiki/research/notes.md".' };
	// Partial edit and whole-body replace are different intents; taking both would
	// mean silently dropping one of them.
	if (isPatching(args) && args.content !== undefined)
		return {
			ok: false,
			error:
				'Pass either content (which replaces the whole body) or append/edits (which change part of it), not both.'
		};
	// Whether the path is inside editable content is asked only of a NEW page, in
	// planPageWrite: an existing page outside it is still updatable.
	const refusal = writeRefusal(target, config, 'written', { content: false });
	if (refusal) return { ok: false, error: refusal };
	if (args.fields) {
		const invalid = validateFieldPatch(args.fields);
		if (invalid) return { ok: false, error: invalid };
	}
	return { ok: true, target };
}

export type PageWritePlan =
	| Refusal
	| { ok: true; kind: 'create' }
	| { ok: true; kind: 'update'; rawBody?: string; changeSummary?: string };

/**
 * Create, update, or refuse, given the page as the branch holds it now (null when
 * there is none). For an update carrying append / edits, the patch is applied here
 * against the AUTHORITATIVE body, so an anchor can never match frontmatter.
 */
export function planPageWrite(
	args: PageWriteArgs,
	target: string,
	existing: { content: string; sha: string } | null,
	config: PathPolicy
): PageWritePlan {
	const patching = isPatching(args);
	const mode = args.mode ?? 'upsert';

	if (!existing) {
		if (patching)
			return {
				ok: false,
				error: `"${target}" does not exist yet, so there is nothing to ${args.append !== undefined ? 'append to' : 'edit'}. Create it first by passing content.`
			};
		if (mode === 'update')
			return {
				ok: false,
				error: `"${target}" does not exist. Use mode "create" or "upsert" (the default) to create it.`
			};
		const outside = writeRefusal(target, config, 'written');
		if (outside) return { ok: false, error: outside };
		return { ok: true, kind: 'create' };
	}

	// The clobber guard.
	if (mode === 'create')
		return {
			ok: false,
			error: `A page already exists at ${target}. Use mode "update" or "upsert" to change it, or pick a different path.`
		};
	// The in-client editor passes the sha it opened; conversational callers pass none.
	if (args.sha !== undefined && existing.sha !== args.sha)
		return {
			ok: false,
			error:
				'This page changed since you opened it (someone else saved first). Reopen the editor to get the latest version (your unsaved text stays in the editor until you leave).'
		};
	if (
		args.content === undefined &&
		!patching &&
		args.title === undefined &&
		args.type === undefined &&
		args.description === undefined &&
		args.status === undefined &&
		args.fields === undefined
	)
		return {
			ok: false,
			error:
				'Nothing to update: pass append / edits (to change part of the page) or content (to replace the body), or a fields / title / type / description / status change.'
		};

	if (!patching) return { ok: true, kind: 'update' };
	const patched = applyPageEdits(parseFrontmatter(existing.content).body, {
		append: args.append,
		edits: args.edits
	});
	if (!patched.ok) return patched;
	return { ok: true, kind: 'update', rawBody: patched.body, changeSummary: patched.summary };
}

// Merge caller-supplied frontmatter (when the content begins with a `---` block)
// under the managed keys, returning the body without it.
export function splitProvidedContent(content: string): { fm: Frontmatter; body: string } {
	const { frontmatter, body } = parseFrontmatter(content);
	return { fm: frontmatter ?? {}, body: frontmatter ? body : content };
}

export interface ComposedCreate {
	/** The new file, before view snapshots are refreshed. */
	content: string;
	title: string;
	status?: string;
}

/** A brand-new page: fresh frontmatter, managed keys first. */
export function composeCreate(
	target: string,
	args: Pick<
		PageWriteArgs,
		'content' | 'title' | 'type' | 'description' | 'status' | 'fields' | 'sources'
	>,
	today: string
): Refusal | ({ ok: true } & ComposedCreate) {
	// Falls back through the SAME chain the rest of the system resolves titles by
	// (pageTitle): a `title:` in the caller's own content, then the body's `# H1`,
	// then the filename, or the folder's name for a folder note. Deriving straight
	// from the filename would write a title that outranks the heading the author just
	// wrote, and would name every folder note "index".
	const title = args.title?.trim() || pageTitle(target, args.content ?? '');
	const provided = splitProvidedContent(args.content ?? '');
	// `type` is OKF's one required field: the explicit argument, else a type the
	// caller wrote into the content's own frontmatter, else nothing. Never invented.
	const type =
		args.type?.trim() || (typeof provided.fm.type === 'string' ? provided.fm.type.trim() : '');
	// Keys this call actually sets. `type` leads, as in the OKF spec's own examples.
	const managed: Frontmatter = {
		...(type ? { type } : {}),
		title,
		...(args.description ? { description: args.description } : {}),
		...(args.status ? { status: args.status } : {}),
		updated: today,
		...(args.sources?.length ? { sources: args.sources } : {})
	};
	let fm: Frontmatter = {
		...managed,
		// Everything else the caller supplied is kept, including keys that merely SHARE
		// a managed name while this call sets no value for them. Filtering on the
		// managed NAME list dropped a caller's OKF `sources:` block whenever the
		// `sources` argument was absent, which is how provenance went missing.
		...Object.fromEntries(Object.entries(provided.fm).filter(([k]) => !(k in managed)))
	};
	// A page can be born with the brain's own metadata, not only after a second call.
	if (args.fields) {
		const patched = applyFieldPatch(fm, args.fields);
		if (!patched.ok) return patched;
		fm = patched.frontmatter;
	}
	return {
		ok: true,
		content: withFrontmatter(fm, provided.body),
		title,
		status: typeof fm.status === 'string' ? fm.status : undefined
	};
}

export interface ComposedUpdate {
	/** The new file, before view snapshots are refreshed. */
	content: string;
	/** What the page is called after this write. */
	label: string;
	/** The title before this write, when this write changes it: the wikilinks naming it need repointing. */
	retitledFrom?: string;
	/** The status this write set, when it differs from the page's current one. */
	statusChanged?: string;
	/** What the write did, in the order the reply lists it. */
	notes: string[];
}

/**
 * An existing page. Frontmatter is preserved and merged when the page has it or the
 * call sets a managed field; otherwise the body is saved as-is, with no structure
 * assumed. The body comes from, in precedence order: `rawBody` (an already-patched
 * body, never re-parsed for frontmatter), `content` (a replacement that may carry its
 * own frontmatter), else the existing body verbatim (a metadata-only write).
 */
export function composeUpdate(
	path: string,
	existingContent: string,
	args: Pick<PageWriteArgs, 'content' | 'title' | 'type' | 'description' | 'status' | 'fields'> & {
		rawBody?: string;
		changeSummary?: string;
	},
	today: string,
	maxIndexedKeys: number
): Refusal | ({ ok: true } & ComposedUpdate) {
	const old = parseFrontmatter(existingContent);
	const provided =
		args.rawBody !== undefined
			? { fm: {} as Frontmatter, body: args.rawBody }
			: args.content !== undefined
				? splitProvidedContent(args.content)
				: { fm: {} as Frontmatter, body: old.body };

	const oldTitle = typeof old.frontmatter?.title === 'string' ? old.frontmatter.title : null;
	const newTitle = args.title ?? oldTitle ?? undefined;
	const manageFm =
		old.frontmatter !== null ||
		args.title !== undefined ||
		args.type !== undefined ||
		args.description !== undefined ||
		args.status !== undefined ||
		args.fields !== undefined;

	const notes: string[] = [];
	// Say what the write did to the body. A patch reports its own summary; a
	// whole-content write reports the SIZE of what it replaced, so a clobber of text
	// the caller never read is visible in the transcript instead of silent.
	if (args.changeSummary) {
		notes.push(args.changeSummary);
	} else if (args.content !== undefined && provided.body.trim() !== old.body.trim()) {
		const count = (s: string) => (s.trim() ? s.trim().split('\n').length : 0);
		notes.push(
			`replaced the whole body (was ${count(old.body)} lines, now ${count(provided.body)})`
		);
	}

	let content = provided.body;
	if (manageFm) {
		let fm: Frontmatter = {
			...(old.frontmatter ?? {}),
			...provided.fm,
			...(newTitle ? { title: newTitle } : {}),
			...(args.type?.trim() ? { type: args.type.trim() } : {}),
			...(args.description ? { description: args.description } : {}),
			...(args.status ? { status: args.status } : {}),
			updated: today
		};
		if (args.fields) {
			const patched = applyFieldPatch(fm, args.fields);
			if (!patched.ok) return patched;
			fm = patched.frontmatter;
			notes.push(patched.summary);
			// Past the cap the indexer stops reading keys, so the field would be set in
			// the file and invisible to okf-view filter: / group-by:.
			const keys = Object.keys(fm).length;
			if (keys > maxIndexedKeys)
				notes.push(
					`heads up: this page now has ${keys} frontmatter keys and only the first ${maxIndexedKeys} are indexed, so the last ones cannot be filtered on`
				);
		}
		content = withFrontmatter(fm, provided.body);
	}

	return {
		ok: true,
		content,
		label: newTitle ?? path,
		retitledFrom: args.title && oldTitle && args.title !== oldTitle ? oldTitle : undefined,
		statusChanged: args.status && args.status !== old.frontmatter?.status ? args.status : undefined,
		notes
	};
}
