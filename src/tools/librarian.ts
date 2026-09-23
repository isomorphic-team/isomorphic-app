// Librarian tool suite — the write/maintenance surface of the brain MCP server.
//
// Two rules govern everything here:
//
// 1. THE UNIT OF WORK IS A BUNDLE. A page write is the page + a changelog entry,
//    landed as ONE atomic commit via commitOrPR(). The log can never drift from
//    content because no tool can forget it. (Link repointing on move/rename adds
//    the affected pages to the same bundle.)
//
// 2. THE USER NEVER SEES GIT. Tool responses speak in saves, pages, and links —
//    never SHAs, branches, or commits. Commit messages are auto-generated and
//    intent-rich, but they're backend bookkeeping.
//
// Write policy comes entirely from the brain's role map (.isomorphic.json, via
// brain-config.ts): folders are arbitrary and free-form, "source" paths are
// immutable, the "log" path is tool-maintained. There are NO fixed entity types
// and NO auto-generated index — those were removed 2026-07. Frontmatter is
// optional; when present it's preserved and merged.

import type { McpServer } from '@modelcontextprotocol/server';
import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import type { Octokit } from 'octokit';
import {
	type Frontmatter,
	todayIso,
	parseFrontmatter,
	pageTitle,
	withFrontmatter,
	rewriteMdLinks,
	rewriteWikiLinks,
	rebaseMdLinks,
	wikilinkKey,
	slugOf
} from '../lib/wiki.ts';
import {
	type RepoRef,
	type Head,
	type TreeEntry,
	type PageContent,
	type WriteOutcome,
	type CommitOrPROpts,
	type CommitAuthor,
	type BrainStore,
	type FileWrite,
	MAX_SCAN_PAGES
} from '../lib/brain-repo.ts';
import {
	type BrainConfig,
	isAssetPath,
	isContentPath,
	isHiddenName,
	isToolMaintained,
	logPathOf
} from '../lib/brain-config.ts';
import {
	ensureFresh,
	loadResolvedGraph,
	backlinksTo,
	searchBrains,
	loadAllFields,
	loadPageContents,
	writeThroughIndex,
	MAX_FIELD_KEYS_PER_PAGE
} from '../lib/brain-index.ts';
import { isMediaPath, mediaTypeOf } from '../lib/media.ts';
import { tryRenderViews, type ViewDeps } from '../lib/views.ts';
import { isToolPagePath, planCustomTools } from '../lib/custom-tools.ts';
import { isFolderNoteName } from '../lib/view-directives.ts';
import {
	filterDismissed,
	parseReviewLedger,
	renderFindings,
	REVIEW_LEDGER_PATH,
	importFindings,
	type Finding
} from '../lib/findings.ts';
import {
	folderNoteSuggestions,
	inlinedConceptSuggestions,
	typeFieldSuggestions,
	ambiguousTitleSuggestions,
	brokenLinkReport,
	wikilinkPortabilityNote,
	describeProbe,
	MAX_FINDINGS_SHOWN
} from '../lib/advisories.ts';
import { computeTensions, tensionFindings, MAX_DUP_PAGES } from '../lib/consolidate.ts';
import { scoreProbe } from '../lib/probe.ts';
import { OKF_PAGE_STATUSES } from '../lib/page-patch.ts';
import { elisionNote } from '../lib/search.ts';
import { parseLedger } from '../lib/brain-import.ts';
import { dedupeWrite, writeFingerprint, secondsSince } from '../lib/write-dedupe.ts';
import { d1WriteLedger } from '../lib/write-dedupe-store.ts';
import { brainLabel, type TenantOpts, type Role, type AccessibleBrain } from '../lib/orgs.ts';
import { brainArg, fail, ok } from './shared.ts';
import { checkPageWrite, planPageWrite, composeCreate, composeUpdate } from '../lib/page-write.ts';
import {
	commitOpts,
	changelogWrite,
	describeChange,
	truncationNote
} from '../lib/change-record.ts';
import {
	normPagePath,
	normFolderPath,
	writeRefusal,
	folderWriteRefusal,
	nonPageKind,
	resolveMoveTarget
} from '../lib/write-target.ts';
import type { SearchWire } from '../lib/tool-payloads.ts';

// Shared optional `brain` arg — every tool takes it so the model can one-shot a
// different brain than the connection's active one (see tenantContext in worker.ts).

// Frontmatter keys are free-form and brain-owned, exactly like folders and
// `type:` values, so this takes whatever the brain calls things rather than a
// fixed list.
const fieldsArg = z
	// zod 4 wants the KEY schema passed explicitly. The one-argument form still parses
	// at runtime, but its inferred type widens to Record<string | number | symbol,
	// unknown>, which no longer matches FieldPatch. Naming z.string() keeps the record
	// typed as Record<string, ...>.
	.record(
		z.string(),
		z.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.array(z.union([z.string(), z.number()])),
			z.null()
		])
	)
	.optional()
	.describe(
		'Frontmatter fields to set on the page, as {key: value}. The BODY IS LEFT ALONE, so you do not need to read the page first: use this for any metadata the brain tracks its own way ("done", "owner", "due", "priority", "client"). A value may be text, a number, true/false, or a list. Pass null to REMOVE a key. Keys use letters, digits, dashes and underscores only. Every key set here becomes filterable by okf-view. Not for title / type / description / status: those have their own arguments, because setting them does more than write a value.'
	);

export interface BrainContext {
	// Where this brain's content lives, and the only way the content tools reach it.
	// See src/lib/brain-repo.ts.
	store: BrainStore;
	// The raw GitHub client, for operations that are GitHub as a platform rather than
	// a brain as storage: creating a repository, listing an installation's
	// repositories, checking a repo exists before connecting it. Optional because a
	// non-GitHub backend has no such client; all of those operations belong to the org
	// model, which such a deployment does not register (`hasOrgModel` in worker.ts).
	// Anything a brain's content needs goes on `store`.
	octokit?: Octokit;
	repoArgs: RepoRef;
	// The caller's role ON THIS BRAIN (viewer < editor < admin), resolved by
	// effectiveBrainRole from an explicit share, the brain's org visibility, or the
	// org-admin floor. Read tools ignore it; write/configure/share tools gate on it.
	// The legacy github/static single-tenant paths report 'owner'.
	role: Role;
	// The caller's role in this brain's ORG (viewer < editor < admin < owner).
	// Separate from `role` on purpose: org membership governs managing people and
	// adding/removing brains, brain access governs the content. The
	// member-management tools authorize roster changes on THIS one: gating them on
	// `role` would let someone who was merely shared a brain as admin edit the org
	// roster. Legacy single-tenant paths report 'owner'.
	orgRole: Role | null;
	// The resolved org's id + the acting user's id, present only on the product-native
	// (authjs) path. The member-management tools need these to scope roster queries and
	// enforce self-guards; they're undefined on the legacy single-tenant paths, which
	// have no org table row (those tools error with a clear "org accounts only" message).
	orgId?: string;
	actorUserId?: string;
	// The brain's content-shape config — which paths are editable content,
	// immutable source, or the tool-maintained changelog. Read from .isomorphic.json
	// (or defaults). Every write-policy decision below reads from it.
	config: BrainConfig;
	// The acting human, for commit attribution. Undefined on the static legacy
	// path (no signed-in user) — writes stay App-authored there.
	author?: CommitAuthor;
	// Platform D1 + this brain's index key ("owner/repo"), for the content index
	// that backs the read tools (src/lib/brain-index.ts).
	db: D1Database;
	brainId: string;
	// Which brain this call resolved to (id + display label), so app tools can echo the
	// active brain to the nav switcher.
	activeBrain: { id: string; label: string };
}

// Shape a write response to match how the change actually landed:
//   - direct commit               → the normal "done" message
//   - PR, auto-merged immediately → "done" (it's already live on the branch)
//   - PR, auto-merge armed        → "proposed", will merge itself once checks pass
//   - PR, no auto-merge           → "proposed", needs a human to merge
// The single composer for every write's user-facing message, which is why the brain is
// named here rather than in eight call sites.
//
// WHY NAME IT AT ALL: a write takes an optional `brain` handle resolved by fuzzy match.
// Ambiguity is refused outright, so the dangerous case is not ambiguity but
// confident-and-wrong: a unique substring match on the wrong brain puts a real page in
// a real client's repository, and nothing in the response would have said so. Naming
// the brain the write LANDED in makes that mistake visible in the same turn instead of
// a week later. It is one short line on an operation that is both rare and hard to
// undo.
export function landed(ctx: BrainContext, outcome: WriteOutcome, done: string, proposed: string) {
	const where = `\n\nBrain: ${ctx.activeBrain?.label || ctx.brainId}.`;
	if (!outcome.prUrl) return ok(`${done}${where}`);
	if (outcome.merged) return ok(`${done} (via PR ${outcome.prUrl})${where}`);
	const tail = outcome.autoMergeEnabled
		? `It will merge automatically once checks pass: ${outcome.prUrl}`
		: `Review and merge it here: ${outcome.prUrl}`;
	return ok(`${proposed} ${tail}${where}`);
}

// The one write chokepoint for the librarian tools: commitOrPR plus a write-through
// index update. A direct commit reports the revision that landed, and the bundle
// already holds the exact content of every page it touched, so the index advances in
// place — the read an agent makes to verify the write costs one getRef instead of an
// incremental reindex (which is what used to make the first read after a write the
// slow call in the session — issue #31). PR mode leaves the index alone (the branch
// has not moved), and a write-through failure is swallowed: the commit landed
// regardless, and the next read reconciles, as it always did.
async function commitBundle(ctx: BrainContext, opts: CommitOrPROpts): Promise<WriteOutcome> {
	const outcome = await ctx.store.commitOrPR(ctx.repoArgs, opts);
	if (outcome.commitSha && opts.head) {
		await writeThroughIndex(
			ctx.db,
			ctx.brainId,
			ctx.config,
			opts.head.commitSha,
			outcome.commitSha,
			opts.writes ?? [],
			opts.deletes ?? []
		).catch(() => {});
	}
	return outcome;
}

// The dedupe wrapper the three content writes run inside.
//
// Issue #50: a write whose ANSWER was lost — a 502, a timeout, a dropped
// connection — leaves the caller unable to tell whether it landed, and both ways
// of guessing wrong are silent. A retried `append` duplicates the text; a
// retried `mode: "create"` fails claiming the page exists, on a page the caller
// believes it never created. Reading the page before every retry was the only
// recourse, which is guidance rather than a mechanism. The ledger recognises the
// retry and replays the original answer instead of applying the write twice.
// Engine, windows, and the deliberate-repeat trade-off: src/lib/write-dedupe.ts.
//
// IT WRAPS THE WHOLE HANDLER, NOT THE COMMIT. The create case never reaches a
// commit: write_page's own "that path already exists" check fires first, and
// what that check tells a retry is the confusing half of the bug. Wrapping the
// handler is also what makes the claim cover every exit path, so a refusal
// cannot leave a fingerprint reserved behind it.
//
// FAIL-OPEN. The brain is the source of truth and this table is only a cache of
// "did this just happen", so a ledger that cannot be reached must never stop a
// write: any failure before the handler runs falls through to running it exactly
// as it ran before this existed.
async function guardedWrite<R>(
	ctx: BrainContext,
	tool: string,
	args: Record<string, unknown>,
	perform: () => Promise<R>
): Promise<R> {
	const now = Date.now();
	// Whether the handler itself has been entered. It separates a ledger failure
	// (fall through and write) from the handler's own failure (propagate), and
	// guarantees the handler is never run twice by the fallback.
	let entered = false;
	const enter = async () => {
		entered = true;
		return perform();
	};
	try {
		const fingerprint = await writeFingerprint(ctx.actorUserId ?? 'anon', tool, args);
		return await dedupeWrite<R>(
			d1WriteLedger(ctx.db),
			{ brainId: ctx.brainId, fingerprint, now },
			{
				perform: enter,
				record: (result) => {
					const r = result as { isError?: boolean; content?: { text?: string }[] };
					// A refusal is deterministic: re-running it produces the same answer, so
					// it is released rather than remembered and stays retryable at once.
					if (r.isError) return null;
					const text = (r.content ?? [])
						.map((c) => c.text ?? '')
						.filter(Boolean)
						.join('\n');
					return text || null;
				},
				// ok() and fail() build valid tool results, but nothing proves to the
				// compiler that they are the same result type this handler returns, so
				// the two caller-facing branches are cast at the boundary.
				onReplay: (attempt) =>
					ok(
						`${attempt.summary ?? 'That write already landed.'}\n\n(Already applied. This repeats the answer to an identical ${tool} call from you that finished ${secondsSince(
							attempt.completedAt ?? attempt.startedAt,
							now
						)}s ago — nothing was written a second time, so nothing is duplicated. To make the same change twice over, vary it or wait a few minutes.)`
					) as R,
				onInFlight: (attempt) =>
					fail(
						`An identical ${tool} call from you started ${secondsSince(
							attempt.startedAt,
							now
						)}s ago and has not finished. THIS call wrote nothing. Do not retry blindly: wait a few seconds, then read the page to see whether the first one landed.`
					) as R
			}
		);
	} catch (err) {
		if (entered) throw err;
		return perform();
	}
}

// Fetch only the pages that link to any of `targetPaths`, for repointing links when
// those pages move or are renamed. Discovers the linkers via the content index
// (backlinksTo), then reads just those pages' content at `head` (consistent with the
// commit base). Bounded by inbound-link count rather than brain size, and uncapped:
// the index sees every page, so a linker beyond the old MAX_SCAN_PAGES ceiling no longer
// gets silently missed (which a whole-brain scan capped at MAX_SCAN_PAGES would).
// `exclude` drops linkers that are themselves in the moved set (they're handled as
// moved pages, not outside linkers).
async function fetchInboundLinkersForPaths(
	ctx: BrainContext,
	head: Head,
	targetPaths: string[],
	exclude: Set<string>,
	// The caller often already fetched the tree (a collision check); reusing it
	// saves a second listTree round trip for the same answer.
	tree?: TreeEntry[]
): Promise<{ pages: PageContent[]; truncated: boolean }> {
	const { store, repoArgs, config, db, brainId } = ctx;
	const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
	const resolved = await loadResolvedGraph(db, brainId, config);
	const linkerPaths = new Set<string>();
	for (const t of targetPaths) {
		for (const r of backlinksTo(resolved, t)) {
			if (!exclude.has(r.path)) linkerPaths.add(r.path);
		}
	}
	if (linkerPaths.size === 0) return { pages: [], truncated };
	const entries = (tree ?? (await store.listTree(repoArgs, head))).filter((e) =>
		linkerPaths.has(e.path)
	);
	const { pages } = await store.fetchPages(repoArgs, entries);
	return { pages, truncated };
}

// Single-target convenience wrapper (move_page / edit_page retitle).
async function fetchInboundLinkers(
	ctx: BrainContext,
	head: Head,
	targetPath: string,
	tree?: TreeEntry[]
): Promise<{ pages: PageContent[]; truncated: boolean }> {
	return fetchInboundLinkersForPaths(ctx, head, [targetPath], new Set([targetPath]), tree);
}

// Count inbound references to a set of target pages, from the content index (no blob
// fetch, just the per-linker md+wiki tallies backlinksTo already resolves). Used for the
// "still referenced" heads-up on delete_page (page or folder path). Excludes tool-maintained
// pages (e.g. the changelog) and any linker that is itself one of the targets.
// `truncated` reflects an index build that hit MAX_SCAN_PAGES.
async function inboundRefs(
	ctx: BrainContext,
	targets: string[]
): Promise<{ refs: { path: string; count: number }[]; truncated: boolean }> {
	const { store, repoArgs, config, db, brainId } = ctx;
	const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
	const resolved = await loadResolvedGraph(db, brainId, config);
	const targetSet = new Set(targets);
	const counts = new Map<string, number>();
	for (const t of targets) {
		for (const r of backlinksTo(resolved, t)) {
			if (targetSet.has(r.path) || isToolMaintained(r.path, config)) continue;
			counts.set(r.path, (counts.get(r.path) ?? 0) + r.count);
		}
	}
	const refs = [...counts.entries()].map(([path, count]) => ({ path, count }));
	return { refs, truncated };
}

// Derived views: regenerate the cached snapshot rendering beneath each okf-view
// fence before the content lands in the file (see src/lib/views.ts). No-op for
// pages without views; falls back to the unrefreshed content on any failure.
async function withFreshSnapshots(ctx: BrainContext, path: string, content: string) {
	const deps: ViewDeps = {
		db: ctx.db,
		store: ctx.store,
		repoArgs: ctx.repoArgs,
		brainId: ctx.brainId,
		config: ctx.config
	};
	const views = await tryRenderViews(content, path, deps);
	return views?.snapshotted ?? content;
}

// write_page's two internal paths. write_page validates the path and decides which to
// run from whether the page already exists; each path builds one atomic commit bundle.

// Create a brand-new page. The caller guarantees `target` is free, ends in .md, and
// is inside the editable area (planPageWrite).
async function createPageWrite(
	ctx: BrainContext,
	head: Head,
	target: string,
	args: Parameters<typeof composeCreate>[1]
) {
	const { store, repoArgs, config, author } = ctx;
	const today = todayIso();
	const composed = composeCreate(target, args, today);
	if (!composed.ok) return fail(composed.error);
	// The snapshot refresh (which may touch the index) and the changelog read are
	// independent, so they run together rather than back to back.
	const [newContent, log] = await Promise.all([
		withFreshSnapshots(ctx, target, composed.content),
		store.readFile(repoArgs, logPathOf(config))
	]);
	const rec = describeChange({
		kind: 'create',
		path: target,
		title: composed.title,
		status: composed.status,
		description: args.description
	});
	const writes = [{ path: target, content: newContent }];
	const entry = changelogWrite(config, log, today, rec.bullet);
	if (entry) writes.push(entry);
	const outcome = await commitBundle(ctx, {
		...commitOpts(config, author),
		...rec.commit,
		writes,
		head
	});
	return landed(ctx, outcome, rec.done, rec.proposed);
}

// Update an existing page: compose the new file (composeUpdate), repoint inbound
// wikilinks on a retitle, and (for the in-client editor) return a fresh sha.
// `existing` is the current blob; planPageWrite has already checked the sha.
async function updatePageWrite(
	ctx: BrainContext,
	head: Head,
	existing: { content: string; sha: string },
	args: Parameters<typeof composeUpdate>[2] & { path: string; sha?: string }
) {
	const { store, repoArgs, config, author } = ctx;
	const { path, sha } = args;
	// The changelog read is independent of everything below (snapshot refresh, link
	// repointing), so it starts first and overlaps them. The detached catch keeps an
	// early return below from leaving an unhandled rejection; the await still rethrows.
	const logPromise = store.readFile(repoArgs, logPathOf(config));
	logPromise.catch(() => {});
	const today = todayIso();
	const composed = composeUpdate(path, existing.content, args, today, MAX_FIELD_KEYS_PER_PAGE);
	if (!composed.ok) return fail(composed.error);
	const newContent = await withFreshSnapshots(ctx, path, composed.content);

	const writes = [{ path, content: newContent }];
	const notes = [...composed.notes];

	// Retitling breaks [[Old Title]] wikilinks — repoint them in the same save. Only the
	// pages that actually link to this one are fetched (via the index), so this is bounded
	// by inbound-link count, not brain size.
	if (composed.retitledFrom) {
		const { pages, truncated } = await fetchInboundLinkers(ctx, head, path);
		let repointed = 0;
		for (const page of pages) {
			if (page.path === path || isToolMaintained(page.path, config)) continue;
			const rewritten = rewriteWikiLinks(page.content, composed.retitledFrom, composed.label);
			if (rewritten.changed > 0) {
				writes.push({ path: page.path, content: rewritten.body });
				repointed += rewritten.changed;
			}
		}
		if (repointed > 0) notes.push(`${repointed} link(s) to the old title repointed`);
		if (truncated) notes.push(`only the first ${MAX_SCAN_PAGES} pages were indexed for links`);
	}

	const log = await logPromise;
	const rec = describeChange({
		kind: 'update',
		path,
		label: composed.label,
		statusChanged: composed.statusChanged,
		retitledFrom: composed.retitledFrom,
		notes
	});
	const entry = changelogWrite(config, log, today, rec.bullet);
	if (entry) writes.push(entry);

	const outcome = await commitBundle(ctx, {
		...commitOpts(config, author),
		...rec.commit,
		writes,
		head
	});
	const res = landed(ctx, outcome, rec.done, rec.proposed);
	// The in-client editor (which passes a sha) wants a fresh sha back so it can keep
	// saving without reopening. Re-read only when the change actually landed on the
	// branch; an unmerged PR leaves the editor's current sha valid.
	if (sha !== undefined) {
		let freshSha = sha;
		if (!(outcome.prUrl && !outcome.merged)) {
			const saved = await store.readFile(repoArgs, path);
			freshSha = saved?.sha ?? '';
		}
		return { ...res, structuredContent: { path, sha: freshSha } };
	}
	return res;
}

// What a folder move would land on top of, split by whether it actually matters.
//
// A folder marker (`.gitkeep`, and any other dot-prefixed scaffolding) exists to
// persist an otherwise-empty directory in git, so the destination's own copy already
// does that job and the source's is redundant. Treating those as collisions made
// MERGING a folder into an existing one impossible in the case where it is most
// wanted: every scaffolded folder has a `.gitkeep`, so the destination always
// already had one, and archiving into an existing archive folder was refused with a
// message naming a file the caller never wrote.
//
// Real content is a different answer: overwriting a page is not this tool's call to
// make. Those are collected in full rather than reported one at a time, so the
// caller learns the shape of the problem in one call instead of clearing it file by
// file.
export function folderMoveCollisions(
	moved: string[],
	existing: Set<string>,
	rename: (path: string) => string
): { blocking: string[]; scaffolding: string[] } {
	const blocking: string[] = [];
	const scaffolding: string[] = [];
	for (const path of moved) {
		if (!existing.has(rename(path))) continue;
		if (isHiddenName(path)) scaffolding.push(path);
		else blocking.push(path);
	}
	return { blocking, scaffolding };
}

// The folder-path form of move_page: move/rename a whole subtree in one atomic commit.
// Two link classes are handled:
//   - Moved pages' OWN outbound links: intra-subtree links are invariant (source and
//     target shift by the same prefix), so only links pointing OUTSIDE the subtree are
//     repointed to a moved sibling first, then the body is rebased for the new location.
//     Titles never change on a move, so [[wikilinks]] still resolve.
//   - OUTSIDE pages linking INTO a moved page: their relative md links are repointed.
async function moveFolderWrite(
	ctx: BrainContext,
	args: { path: string; new_path?: string; new_name?: string },
	// The caller may already have paid for these while deciding this was a folder
	// at all; re-fetching would cost a second round trip for the same answer.
	pre?: { head: Head; tree: TreeEntry[] }
) {
	const { store, repoArgs, config, author } = ctx;
	const folder = normFolderPath(args.path);
	if (!folder) return fail('Give a folder path, e.g. "wiki/Projects".');
	const resolved = resolveMoveTarget(folder, args, 'folder');
	if (!resolved.ok) return fail(resolved.error);
	const newFolder = resolved.target;
	if (newFolder === folder) return ok(`"${folder}" is already there — nothing to move.`);
	if (!isContentPath(`${newFolder}/.gitkeep`, config))
		return fail(`Can't move to "${newFolder}" — it's outside this brain's editable content.`);

	const head = pre?.head ?? (await store.getHead(repoArgs, config.defaultBranch));
	const tree = pre?.tree ?? (await store.listTree(repoArgs, head, { extension: '*' }));
	const moved = tree.filter((e) => e.path.startsWith(`${folder}/`));
	if (moved.length === 0) return fail(`No folder "${folder}" found (it has no files).`);
	const refusal = folderWriteRefusal(folder, moved, config, 'moved');
	if (refusal) return fail(refusal);
	const rename = (p: string) => `${newFolder}${p.slice(folder.length)}`;
	const existing = new Set(tree.map((e) => e.path));
	const { blocking, scaffolding } = folderMoveCollisions(
		moved.map((e) => e.path),
		existing,
		rename
	);
	if (blocking.length) {
		const shown = blocking
			.slice(0, 10)
			.map((p) => `"${rename(p)}"`)
			.join(', ');
		const more = blocking.length > 10 ? `, and ${blocking.length - 10} more` : '';
		return fail(
			`Can't move "${folder}" into "${newFolder}": ${blocking.length} file(s) already exist there (${shown}${more}). Move or rename those first, or pick a destination that doesn't hold them.`
		);
	}
	// The destination keeps its own folder markers; the source's are dropped with the
	// folder rather than written over the top of them.
	const supersededScaffolding = new Set(scaffolding);

	const movedMdEntries = moved.filter((e) => e.path.endsWith('.md'));
	const movedMd = new Set(movedMdEntries.map((e) => e.path));
	// Non-markdown blobs to copy across, minus the scaffolding the destination already
	// carries: writing over that would replace a file the caller never asked to touch,
	// so those are dropped with the folder instead (delete-only).
	const copiedNonMd = moved.filter(
		(e) => !movedMd.has(e.path) && !supersededScaffolding.has(e.path)
	);
	// Four independent reads at the same head, run together: the moved pages' content
	// (by known path, bounded by folder size, needed to rebase their outbound links),
	// the non-markdown blobs, the outside linkers (discovered via the content index,
	// bounded by inbound-link count and uncapped, reusing the tree above), and the
	// changelog.
	const [movedRes, nonMdFiles, linkersRes, log] = await Promise.all([
		store.fetchPages(repoArgs, movedMdEntries),
		Promise.all(copiedNonMd.map((e) => store.readFile(repoArgs, e.path))),
		fetchInboundLinkersForPaths(ctx, head, [...movedMd], movedMd, tree),
		store.readFile(repoArgs, logPathOf(config))
	]);
	const movedContent = new Map(movedRes.pages.map((p) => [p.path, p.content]));
	const today = todayIso();
	const writes: { path: string; content: string }[] = [];
	const deletes: string[] = [];
	let repointedPages = 0;

	// 1. Moved markdown pages — repoint outbound links to moved siblings, then rebase
	//    for the new location, and reattach frontmatter unchanged.
	for (const oldPath of movedMd) {
		const content = movedContent.get(oldPath);
		if (content == null) continue; // unreadable blob, leave it (rare)
		const newPath = rename(oldPath);
		const { frontmatter, body } = parseFrontmatter(content);
		let rebased = body;
		for (const sibling of movedMd) {
			rebased = rewriteMdLinks(rebased, oldPath, sibling, rename(sibling)).body;
		}
		rebased = rebaseMdLinks(rebased, oldPath, newPath);
		writes.push({
			path: newPath,
			content: frontmatter ? withFrontmatter(frontmatter, rebased) : rebased
		});
		deletes.push(oldPath);
	}

	// 2. Non-markdown blobs under the folder (.gitkeep, etc.) — copied across verbatim
	//    (contents fetched above); the superseded scaffolding is delete-only.
	copiedNonMd.forEach((e, i) => {
		writes.push({ path: rename(e.path), content: nonMdFiles[i]?.content ?? '' });
		deletes.push(e.path);
	});
	for (const e of supersededScaffolding) deletes.push(e);

	// 3. Outside pages linking INTO a moved page — repoint their md links.
	const { pages: linkers, truncated } = linkersRes;
	for (const page of linkers) {
		if (isToolMaintained(page.path, config)) continue;
		let content = page.content;
		let changed = 0;
		for (const oldPath of movedMd) {
			const r = rewriteMdLinks(content, page.path, oldPath, rename(oldPath));
			content = r.body;
			changed += r.changed;
		}
		if (changed > 0) {
			writes.push({ path: page.path, content });
			repointedPages++;
		}
	}

	const rec = describeChange({
		kind: 'move-folder',
		folder,
		newFolder,
		repointed: repointedPages,
		truncated,
		keptMarkers: [...supersededScaffolding]
	});
	const entry = changelogWrite(config, log, today, rec.bullet);
	if (entry) writes.push(entry);

	const outcome = await commitBundle(ctx, {
		...commitOpts(config, author),
		...rec.commit,
		writes,
		deletes,
		head
	});
	return landed(ctx, outcome, rec.done, rec.proposed);
}

// The non-markdown file form of move_page: move or rename one blob that isn't a page.
//
// This exists because a path like "wiki/Todos/.gitkeep" used to route to the FOLDER
// mover (anything without a .md extension did), which found no files under it and
// answered "no folder found (it has no files)" about a file that plainly existed. So
// a non-page file could block a folder move and could not be addressed to clear it.
//
// No link repointing: markdown links whose target isn't .md are deliberately outside
// the resolved graph (loadResolvedGraph skips them), so there is nothing pointing at
// this file for the index to know about.
async function moveFileWrite(
	ctx: BrainContext,
	head: Head,
	tree: TreeEntry[],
	args: { path: string; new_path?: string; new_name?: string }
) {
	const { store, repoArgs, config, author } = ctx;
	const path = normPagePath(args.path);
	const refusal = writeRefusal(path, config, 'moved');
	if (refusal) return fail(refusal);
	const resolved = resolveMoveTarget(path, args, 'file');
	if (!resolved.ok) return fail(resolved.error);
	const newPath = resolved.target;
	if (newPath === path) return ok(`"${path}" is already there — nothing to move.`);
	if (!isContentPath(newPath, config))
		return fail(`Can't move to "${newPath}" — it's outside this brain's editable content.`);
	if (tree.some((e) => e.path === newPath))
		return fail(`Can't move to "${newPath}" — a file already exists there.`);
	// Renaming a `.png` to `.jpg` converts nothing; it leaves a file whose extension
	// lies about its bytes, and the extension is what every later reader goes on.
	if (isMediaPath(path) && mediaTypeOf(path) !== mediaTypeOf(newPath))
		return fail(
			`Can't move ${path} to ${newPath} — that changes the file type, which would break how it is read.`
		);

	// Read as BYTES, not as text. Blobs reach readFile base64-decoded as UTF-8, so a
	// PNG arrives already mangled and writing it back would commit a corrupted copy
	// over the original — which is why this used to refuse a non-text file outright.
	// readBinary plus a base64 FileWrite carries the bytes through untouched, so an
	// attachment now moves like anything else.
	//
	// The blob, the pages linking it, and the changelog are independent reads at the
	// same head — run them together (the linker fetch reuses the router's tree).
	const [file, linkersRes, log] = await Promise.all([
		store.readBinary(repoArgs, path),
		fetchInboundLinkers(ctx, head, path, tree),
		store.readFile(repoArgs, logPathOf(config))
	]);
	if (!file) return fail(`"${path}" does not exist.`);

	// Repoint what points AT it. This was skipped on the grounds that non-`.md`
	// targets sit outside the resolved graph. They no longer do — assetEdges records
	// them — so a moved attachment no longer rots every page displaying it.
	const { pages, truncated } = linkersRes;
	let repointedPages = 0;

	const today = todayIso();
	const writes: FileWrite[] = [{ path: newPath, content: file.contentBase64, encoding: 'base64' }];
	for (const page of pages) {
		if (isToolMaintained(page.path, config)) continue;
		const md = rewriteMdLinks(page.content, page.path, path, newPath);
		if (md.changed > 0) {
			writes.push({ path: page.path, content: md.body });
			repointedPages++;
		}
	}
	const rec = describeChange({
		kind: 'move-file',
		path,
		newPath,
		repointed: repointedPages,
		truncated
	});
	const entry = changelogWrite(config, log, today, rec.bullet);
	if (entry) writes.push(entry);

	const outcome = await commitBundle(ctx, {
		...commitOpts(config, author),
		...rec.commit,
		writes,
		deletes: [path],
		head
	});
	return landed(ctx, outcome, rec.done, rec.proposed);
}

// The folder-path form of delete_page: delete a whole subtree and everything under it.
// The non-markdown file form of delete_page, and the twin of moveFileWrite: before
// this, a path like "wiki/assets/logo.png" routed to the FOLDER deleter and came
// back as "No folder found" about a file that existed.
//
// Inbound references come from the SAME inboundRefs the page deleter uses. They used
// to need a separate query, because a link to a non-page file was not an edge in the
// resolved graph — now it is one (fileEdges), so the parallel implementation is gone.
// That matters beyond tidiness: the two disagreed. inboundRefs also drops references
// from tool-maintained files, so the changelog's own mention of a path no longer
// counts as a page that would lose something.
async function deleteFileWrite(ctx: BrainContext, head: Head, args: { path: string }) {
	const { store, repoArgs, config, author } = ctx;
	const path = normPagePath(args.path);
	const refusal = writeRefusal(path, config, 'deleted');
	if (refusal) return fail(refusal);

	// The reference count and the changelog are independent reads — run them together.
	const [refsRes, log] = await Promise.all([
		inboundRefs(ctx, [path]),
		store.readFile(repoArgs, logPathOf(config))
	]);
	const { refs, truncated } = refsRes;

	const today = todayIso();
	const rec = describeChange({ kind: 'delete-file', path, refs, truncated });
	const writes: { path: string; content: string }[] = [];
	const entry = changelogWrite(config, log, today, rec.bullet);
	if (entry) writes.push(entry);

	const outcome = await commitBundle(ctx, {
		...commitOpts(config, author),
		...rec.commit,
		writes,
		deletes: [path],
		head
	});
	return landed(ctx, outcome, rec.done, rec.proposed);
}

async function deleteFolderWrite(
	ctx: BrainContext,
	args: { path: string },
	// Already fetched by the router that decided this was a folder (see move's twin).
	pre?: { head: Head; tree: TreeEntry[] }
) {
	const { store, repoArgs, config, author } = ctx;
	const folder = normFolderPath(args.path);
	if (!folder) return fail('Give a folder path, e.g. "wiki/Projects".');

	const head = pre?.head ?? (await store.getHead(repoArgs, config.defaultBranch));
	const tree = pre?.tree ?? (await store.listTree(repoArgs, head, { extension: '*' }));
	const doomed = tree.filter((e) => e.path.startsWith(`${folder}/`));
	if (doomed.length === 0) return fail(`No folder "${folder}" found.`);
	const refusal = folderWriteRefusal(folder, doomed, config, 'deleted');
	if (refusal) return fail(refusal);
	const doomedMd = new Set(doomed.filter((e) => e.path.endsWith('.md')).map((e) => e.path));

	// References from OUTSIDE the folder into any deleted page, from the content index
	// (md + wikilinks, bounded by inbound-link count rather than brain size). The
	// changelog read is independent — run them together.
	const [refsRes, log] = await Promise.all([
		inboundRefs(ctx, [...doomedMd]),
		store.readFile(repoArgs, logPathOf(config))
	]);
	const { refs, truncated } = refsRes;

	const today = todayIso();
	const rec = describeChange({
		kind: 'delete-folder',
		folder,
		pageCount: doomedMd.size,
		refs,
		truncated
	});
	const writes: { path: string; content: string }[] = [];
	const entry = changelogWrite(config, log, today, rec.bullet);
	if (entry) writes.push(entry);

	const outcome = await commitBundle(ctx, {
		...commitOpts(config, author),
		...rec.commit,
		writes,
		deletes: doomed.map((e) => e.path),
		head
	});
	return landed(ctx, outcome, rec.done, rec.proposed);
}

// Optional wiring, supplied only where there is more than one brain to search.
// `listBrains` is the caller's whole accessible set, which is the one thing a fan-out
// needs and a single BrainContext cannot express: a context resolves exactly one brain.
// It is the same dep the brain tools already take (worker.ts), and it is absent in the
// local runtime and in single-tenant mode, where one brain means `scope: "all"` is the
// same search as the default.
export interface LibrarianDeps {
	listBrains?: () => Promise<AccessibleBrain[]>;
}

// Which brains a search runs over. The active brain always leads, so it wins the
// round-robin under the global cap and reads first in the output.
//
// Exported only so `pnpm test:search` can call it. This is the function that DECIDES
// which brains a fan-out reaches, and therefore whose content can appear in one answer;
// leaving it private would have put that decision somewhere no test could reach.
export async function searchTargets(
	ctx: BrainContext,
	deps: LibrarianDeps | undefined
): Promise<{ id: string; label: string }[]> {
	const here = { id: ctx.brainId, label: ctx.activeBrain?.label || ctx.brainId };
	if (!deps?.listBrains) return [here];
	try {
		const rest = (await deps.listBrains())
			.filter((b) => b.id !== here.id)
			.map((b) => ({ id: b.id, label: brainLabel(b) }));
		return [here, ...rest];
	} catch {
		// A search that can still answer for the brain you are IN must not fail because
		// the wider set could not be resolved.
		return [here];
	}
}

export function registerLibrarianTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>,
	deps?: LibrarianDeps
) {
	// ---------- write_page (create or update) ----------
	server.registerTool(
		'write_page',
		{
			title: 'Write a brain page',
			description:
				'Create a new page, or change an existing one, at a content path you choose (folders are free-form). ONE PAGE = ONE CONCEPT: anything another page should be able to link to — a person, vendor, system, event series, project — gets its own file, never a section inside a bigger page. If you are about to write a heading per item, write a page per item instead. To change PART of a page use `edits` (exact find/replace; each anchor must match exactly once) or `append` (add to the end): both leave the rest of the page untouched, so you do not have to read it first and cannot destroy text you have not seen. To change METADATA rather than page text, use `fields` (set or remove any frontmatter key the brain tracks, e.g. done/owner/due) or the title/type/description/status arguments: those leave the body untouched. `content` REPLACES the entire body, so pass it only for a new page or a deliberate full rewrite, and read the page first (read_page) if you did not just write it. OKF lifecycle status is optional: absent means stable; set draft, stable, or deprecated only when the distinction should be explicit. On an existing page frontmatter is preserved and merged, the "updated" date is bumped, a retitle repoints inbound links, and passing none of content/edits/append changes only metadata. Every change is logged. Pass mode: "create" to require a new path (fails if it exists) or "update" to require an existing one. If this call FAILS WITHOUT A RESULT — a timeout, a 502 or any other gateway error, a dropped connection — its outcome is ambiguous and the write may still have landed. Retrying the IDENTICAL call is the safe move: a repeat with the same arguments within a few minutes is recognised as a retry and answered from the first attempt rather than applied twice. Change anything about the call and that no longer holds, so read the page before retrying a changed one: a repeated create fails if the first attempt landed, and a repeated append would duplicate the text.',
			inputSchema: z.object({
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Content path, e.g. "wiki/research/model-eval.md". Must end in .md. A folder\'s overview/index page MUST be named "index.md" (e.g. "wiki/vendors/index.md"): that makes it the folder note, which the app opens when the folder is clicked. Naming it anything else ("overview.md", "vendors.md") leaves the folder note-less and the page a loose sibling. An index.md is a LISTING of the folder\'s pages (write it as an okf-view, or as links), never a container holding the folder\'s content inline.'
					),
				content: z
					.string()
					.optional()
					.describe(
						'Markdown body, REPLACING the whole body on an existing page (use edits/append to change only part of it). Frontmatter is generated on create and preserved/merged on update (any you include is merged). Omit on an existing page to change only metadata.'
					),
				append: z
					.string()
					.optional()
					.describe(
						'Markdown to add to the END of an existing page, leaving everything above it untouched. Non-destructive: no need to read the page first. Not combinable with content.'
					),
				edits: z
					.array(
						z.object({
							find: z
								.string()
								.describe(
									'Exact text to replace, copied verbatim from the page (whitespace included). Must occur exactly once, or the call fails and nothing is written; include surrounding lines to disambiguate.'
								),
							replace: z.string().describe('Text to put in its place (empty string deletes it).')
						})
					)
					.optional()
					.describe(
						'Find/replace edits applied in order to an existing page, leaving the rest untouched. Non-destructive: no need to read the whole page first. Not combinable with content.'
					),
				title: z
					.string()
					.optional()
					.describe(
						'Human title. Defaults to the filename on create; retitles on update (inbound links repointed).'
					),
				type: z
					.string()
					.optional()
					.describe(
						'What KIND of thing this page is — a short free-form noun phrase ("Vendor", "Event Series", "Person", "Meeting Note"). This is the one field the Open Knowledge Format requires, and it is not a fixed taxonomy: reuse whatever types the brain already uses (check a sibling page), and coin a new one when nothing fits. Set it on every concept page. If you cannot name a type for something, that is usually a sign it belongs inside another page rather than in its own.'
					),
				description: z.string().optional().describe('One-line summary for the index.'),
				status: z
					.enum(OKF_PAGE_STATUSES)
					.optional()
					.describe(
						'Optional OKF lifecycle status: draft (not yet reviewed), stable (ready for consumption), or deprecated (kept for links/history but no longer current). Absence means stable.'
					),
				fields: fieldsArg,
				sources: z
					.array(z.string())
					.optional()
					.describe(
						'What this page was derived from, recorded on create: source/ paths, or URLs. Record them whenever the page restates material from somewhere else — provenance is what lets a reader check a claim later.'
					),
				mode: z
					.enum(['create', 'update', 'upsert'])
					.optional()
					.describe(
						'create = fail if the path exists; update = fail if it does not; upsert (default) = either.'
					),
				sha: z
					.string()
					.optional()
					.describe(
						'Blob sha from edit_page, passed by the in-client editor as a concurrency guard. Omit for conversational edits.'
					)
			})
		},
		async (args) => {
			const { content, title, type, description, status, fields, sources, sha, brain } = args;
			const ctx = await getContext({ requires: 'editor', brain });
			return guardedWrite(ctx, 'write_page', args, async () => {
				const { store, repoArgs, config } = ctx;
				// Refusals that need no page are answered before a round trip is spent.
				const checked = checkPageWrite(args, config);
				if (!checked.ok) return fail(checked.error);
				const { target } = checked;

				// Capture the commit base before reading authoritative content. If the
				// branch moves afterwards, updateRef rejects this write instead of letting
				// content read from an older revision overwrite the newer commit.
				const head = await store.getHead(repoArgs, config.defaultBranch);
				const existing = await store.readFile(repoArgs, target, head.commitSha);
				const plan = planPageWrite(args, target, existing, config);
				if (!plan.ok) return fail(plan.error);
				if (plan.kind === 'create')
					return createPageWrite(ctx, head, target, {
						content,
						title,
						type,
						description,
						status,
						fields,
						sources
					});
				return updatePageWrite(ctx, head, existing!, {
					path: target,
					content,
					rawBody: plan.rawBody,
					changeSummary: plan.changeSummary,
					title,
					type,
					description,
					status,
					fields,
					sha
				});
			});
		}
	);

	// ---------- move_page ----------
	server.registerTool(
		'move_page',
		{
			title: 'Move or rename a page or folder',
			description:
				"Move a page (or a whole folder and everything under it) to a different location and/or rename it. Every link pointing at the moved page(s) — from other pages and the index — is repointed in the same save, and the moved content's own links keep working. Nothing dangles. Pass a folder path (no .md extension) to move or rename an entire subtree; moving a folder ONTO an existing one merges them, and is refused only if a page would be overwritten. If this call FAILS WITHOUT A RESULT (a timeout, a 502 or any other gateway error, a dropped connection), retrying the identical call is safe: a repeat with the same arguments within a few minutes is recognised as a retry rather than applied twice. A move lands whole or not at all, so if you change the call, check whether the page is already at the destination before retrying.",
			inputSchema: z.object({
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Current page, folder, or file path, e.g. "wiki/customers/acme.md", "wiki/Projects", or "wiki/Projects/.gitkeep".'
					),
				new_path: z
					.string()
					.optional()
					.describe(
						'Full target path, e.g. "wiki/research/acme.md" (page) or "wiki/Work" (folder). Move to any location and/or rename.'
					),
				new_title: z
					.string()
					.optional()
					.describe(
						'Rename in place (keeps the parent folder). For a page it becomes the new title; for a folder, the new folder name (kept as typed). Ignored if new_path is given.'
					)
			})
		},
		async (args) => {
			const { new_path, new_title, brain } = args;
			const path = normPagePath(args.path);
			const ctx = await getContext({ requires: 'editor', brain });
			return guardedWrite(ctx, 'move_page', args, async () => {
				// A path without a .md extension is a folder OR a non-page file, and the
				// name cannot tell them apart (".gitkeep" is a file, ".obsidian" a folder).
				// Ask the tree instead of guessing, then hand the answer to the mover that
				// fits. Guessing "folder" is what made a dotfile unaddressable: it reported
				// "no folder found (it has no files)" about a file that was right there.
				//
				// This supersedes an attachment-specific branch that routed on isAssetPath:
				// the tree answers the same question for EVERY non-page file, so an
				// attachment needs no case of its own.
				if (!path.endsWith('.md')) {
					const cleaned = normFolderPath(path);
					const head = await ctx.store.getHead(ctx.repoArgs, ctx.config.defaultBranch);
					const tree = await ctx.store.listTree(ctx.repoArgs, head, { extension: '*' });
					const kind = nonPageKind(cleaned, tree);
					if (kind === 'file')
						return moveFileWrite(ctx, head, tree, { path: cleaned, new_path, new_name: new_title });
					if (kind === 'folder')
						return moveFolderWrite(
							ctx,
							{ path: cleaned, new_path, new_name: new_title },
							{ head, tree }
						);
					return fail(`No file or folder "${cleaned}" found.`);
				}
				const { store, repoArgs, config, author } = ctx;
				const refusal = writeRefusal(path, config, 'moved');
				if (refusal) return fail(refusal);
				const resolved = resolveMoveTarget(path, { new_path, new_name: new_title }, 'page');
				if (!resolved.ok) return fail(resolved.error);
				const newPath = resolved.target;

				const head = await store.getHead(repoArgs, config.defaultBranch);
				const existing = await store.readFile(repoArgs, path, head.commitSha);
				if (!existing) return fail(`"${path}" does not exist.`);

				const { frontmatter, body } = parseFrontmatter(existing.content);
				// pageTitle is the single title resolver (frontmatter > H1 > filename); a
				// second copy here would repoint links to a name the rest of the system
				// doesn't call this page.
				const oldTitle = pageTitle(path, existing.content);
				if (!isContentPath(newPath, config))
					return fail(`Can't move to ${newPath} — it's outside this brain's editable content.`);
				const newTitle = new_title ?? oldTitle;
				if (newPath === path) return ok(`"${oldTitle}" is already at ${path} — nothing to move.`);

				const tree = await store.listTree(repoArgs, head);
				if (tree.some((e) => e.path === newPath)) {
					return fail(`Can't move to ${newPath} — a page already exists there.`);
				}

				// Only the pages that link to the moving page are fetched (discovered via the
				// content index), not the whole brain — bounded by inbound-link count. The
				// linker fetch reuses the tree above, and runs alongside the changelog read.
				const [linkersRes, log] = await Promise.all([
					fetchInboundLinkers(ctx, head, path, tree),
					store.readFile(repoArgs, logPathOf(config))
				]);
				const { pages, truncated } = linkersRes;
				const today = todayIso();
				const writes: { path: string; content: string }[] = [];
				let repointedPages = 0;

				// Repoint inbound links across the wiki.
				for (const page of pages) {
					if (page.path === path || isToolMaintained(page.path, config)) continue;
					let content = page.content;
					let changed = 0;
					const md = rewriteMdLinks(content, page.path, path, newPath);
					content = md.body;
					changed += md.changed;
					if (newTitle !== oldTitle) {
						const wl = rewriteWikiLinks(content, oldTitle, newTitle);
						content = wl.body;
						changed += wl.changed;
					}
					// A wikilink can also name a page by its FILENAME, so a rename orphans
					// those unless they move with it (the title lane above only catches the
					// ones written as the title).
					if (wikilinkKey(slugOf(newPath)) !== wikilinkKey(slugOf(path))) {
						const wl = rewriteWikiLinks(content, slugOf(path), slugOf(newPath));
						content = wl.body;
						changed += wl.changed;
					}
					if (changed > 0) {
						writes.push({ path: page.path, content });
						repointedPages++;
					}
				}

				// The moved page itself: rebase outbound links, refresh frontmatter.
				const fm: Frontmatter = { ...(frontmatter ?? {}), title: newTitle, updated: today };
				writes.push({
					path: newPath,
					content: withFrontmatter(fm, rebaseMdLinks(body, path, newPath))
				});

				const rec = describeChange({
					kind: 'move-page',
					path,
					newPath,
					oldTitle,
					newTitle,
					repointed: repointedPages,
					truncated
				});
				const entry = changelogWrite(config, log, today, rec.bullet);
				if (entry) writes.push(entry);

				const outcome = await commitBundle(ctx, {
					...commitOpts(config, author),
					...rec.commit,
					writes,
					deletes: [path],
					head
				});
				return landed(ctx, outcome, rec.done, rec.proposed);
			});
		}
	);

	// ---------- delete_page ----------
	server.registerTool(
		'delete_page',
		{
			title: 'Delete a page or folder',
			description:
				'Remove a page (or a whole folder and everything under it) from the wiki. The deletion is logged. If other pages still link into what you deleted, they are listed so the references can be cleaned up. Pass a folder path (no .md extension) to delete an entire subtree, or the path of a non-page file (an image, a folder marker) to delete just that file. If this call FAILS WITHOUT A RESULT (a timeout, a 502 or any other gateway error, a dropped connection), retrying the identical call is safe: a repeat with the same arguments within a few minutes is recognised as a retry rather than applied twice. A delete lands whole or not at all, so if you change the call, check whether the path still exists before retrying.',
			inputSchema: z.object({
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Page, folder, or file path, e.g. "wiki/projects/old.md", "wiki/Projects", or "wiki/assets/logo.png".'
					)
			})
		},
		async (args) => {
			const { brain } = args;
			const path = normPagePath(args.path);
			const ctx = await getContext({ requires: 'editor', brain });
			return guardedWrite(ctx, 'delete_page', args, async () => {
				// A path without a .md extension is a folder OR a non-page file; the tree
				// says which, for the same reason it does in move_page. Guessing "folder"
				// answered "No folder found" about files that were plainly there. This
				// supersedes an attachment-specific branch, exactly as in move_page.
				if (!path.endsWith('.md')) {
					const cleaned = normFolderPath(path);
					const head = await ctx.store.getHead(ctx.repoArgs, ctx.config.defaultBranch);
					const tree = await ctx.store.listTree(ctx.repoArgs, head, { extension: '*' });
					const kind = nonPageKind(cleaned, tree);
					if (kind === 'file') return deleteFileWrite(ctx, head, { path: cleaned });
					if (kind === 'folder') return deleteFolderWrite(ctx, { path: cleaned }, { head, tree });
					return fail(`No file or folder "${cleaned}" found.`);
				}
				const { store, repoArgs, config, author } = ctx;
				const refusal = writeRefusal(path, config, 'deleted');
				if (refusal) return fail(refusal);

				const head = await store.getHead(repoArgs, config.defaultBranch);
				const existing = await store.readFile(repoArgs, path, head.commitSha);
				if (!existing) return fail(`"${path}" does not exist.`);

				const title = pageTitle(path, existing.content);
				// The reference count and the changelog are independent — run them together.
				const [refsRes, log] = await Promise.all([
					inboundRefs(ctx, [path]),
					store.readFile(repoArgs, logPathOf(config))
				]);
				const { refs, truncated } = refsRes;

				const today = todayIso();
				const rec = describeChange({ kind: 'delete-page', path, title, refs, truncated });
				const writes: { path: string; content: string }[] = [];
				const entry = changelogWrite(config, log, today, rec.bullet);
				if (entry) writes.push(entry);

				const outcome = await commitBundle(ctx, {
					...commitOpts(config, author),
					...rec.commit,
					writes,
					deletes: [path],
					head
				});
				return landed(ctx, outcome, rec.done, rec.proposed);
			});
		}
	);

	// ---------- find_inbound_links ----------
	server.registerTool(
		'find_inbound_links',
		{
			title: 'Find pages linking to a page',
			annotations: { readOnlyHint: true },
			description:
				'List everything that links to the given page or attachment — via markdown links, image embeds, or [[wikilinks]]. Useful before restructuring, before deleting an image (to see which pages would lose it), or to gauge how connected a page is.',
			inputSchema: z.object({
				brain: brainArg,
				path: z
					.string()
					.describe(
						'Target page or attachment path, e.g. "wiki/customers/acme.md" or "wiki/customers/assets/logo.png".'
					)
			})
		},
		async ({ path, brain }) => {
			const { store, repoArgs, config, db, brainId } = await getContext({ brain });
			// An attachment has to take a different existence check. readFile decodes the
			// blob as UTF-8, and on a PNG that does not fail — it returns mojibake — so
			// the old path would sail past the `!existing` guard and then run pageTitle()
			// over binary garbage, labelling the image with whatever fell out of it.
			// An attachment's title is its filename; there is nothing inside to read.
			let title: string;
			if (isAssetPath(path, config)) {
				const file = await store.readBinary(repoArgs, path);
				if (!file) return fail(`"${path}" does not exist.`);
				title = path.split('/').pop() ?? path;
			} else {
				// readFile confirms the target exists and gives its authoritative current
				// title; the backlinks themselves come from the content index.
				const existing = await store.readFile(repoArgs, path);
				if (!existing) return fail(`"${path}" does not exist.`);
				title = pageTitle(path, existing.content);
			}

			const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
			const resolved = await loadResolvedGraph(db, brainId, config);
			const refs = backlinksTo(resolved, path);

			// Structured payload for the in-client app's "Linked references" panel.
			// backlinksTo already carries each backlink's display title + md/wiki counts.
			const structuredContent = {
				target: { path, title },
				refs,
				truncated
			};

			if (refs.length === 0) {
				return {
					...ok(`No pages link to "${title}" (${path}).${truncationNote(truncated)}`),
					structuredContent
				};
			}
			return {
				...ok(
					`${refs.length} page(s) link to "${title}" (${path}):\n${refs
						.map((r) => {
							const parts = [];
							if (r.mdCount) parts.push(`${r.mdCount} link(s)`);
							if (r.wikiCount) parts.push(`${r.wikiCount} wikilink(s)`);
							return `- ${r.path} — ${parts.join(', ')}`;
						})
						.join('\n')}${truncationNote(truncated)}`
				),
				structuredContent
			};
		}
	);

	// ---------- validate ----------
	server.registerTool(
		'validate',
		{
			title: 'Check the brain for problems',
			annotations: { readOnlyHint: true },
			description:
				'`validate` checks a brain and reports what needs attention. Two kinds of result, deliberately separate. DEFECTS: broken links — markdown links to missing pages and [[wikilinks]] that match no page. Those have one right answer and cannot be silenced. FINDINGS: everything advisory, each carrying a `[key]` — pending import decisions, Open Knowledge Format structure notes (concepts written as sections inside a folder note instead of getting their own page, pages missing a `type:`, names two pages both answer to), and consolidation tensions (a page nothing links to, a folder note that lists none of its pages, two pages telling the same story). Nothing advisory blocks a save, and any finding can be answered or permanently silenced with `resolve` using its key, so a deliberate choice stops being re-reported. Run after big changes or restructures, or when asked to tidy a brain up.',
			inputSchema: z.object({ brain: brainArg })
		},
		async ({ brain }) => {
			const { store, repoArgs, config, db, brainId } = await getContext({ brain });
			const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);
			const resolved = await loadResolvedGraph(db, brainId, config);

			// Every link that resolved to no page (see loadResolvedGraph), reported in
			// two sections: files that aren't there, and names that match no page.
			const problemSections = brokenLinkReport(resolved.broken, resolved.pages);
			const problemCount = resolved.broken.length;
			const pageCount = resolved.pages.length;

			// Pending import decisions: the last sync's unanswered questions, persisted
			// per source in its ledger (.isomorphic/imports/<source>.json). Validate is
			// the "anything need attention?" surface — deciding happens via
			// resolve_import; a decision stays listed here until someone answers it.
			const pendingSections: string[] = [];
			const importFindingsList: Finding[] = [];
			try {
				const head = await store.getHead(repoArgs, config.defaultBranch);
				// listTree defaults to .md — ledgers are .json.
				const tree = await store.listTree(repoArgs, head, { extension: '.json' });
				const ledgers = tree.filter((e) => /^\.isomorphic\/imports\/[^/]+\.json$/.test(e.path));
				for (const entry of ledgers) {
					const source = entry.path
						.split('/')
						.pop()!
						.replace(/\.json$/, '');
					const file = await store.readFile(repoArgs, entry.path);
					let ledger;
					try {
						ledger = parseLedger(file?.content ?? null);
					} catch {
						pendingSections.push(
							`Import ledger for "${source}" is corrupt (${entry.path}) — fix it before the next sync.`
						);
						continue;
					}
					if (!ledger.pending.length) continue;
					importFindingsList.push(...importFindings(source, ledger.pending));
					pendingSections.push(
						`${ledger.pending.length} import decision(s) pending for "${source}".`
					);
				}
			} catch {
				// Surfacing pending questions is best-effort; link validation stands alone.
			}
			const pendingText = pendingSections.length ? `\n\n${pendingSections.join('\n\n')}` : '';

			// Custom tools: report tool pages (under tools/) that can't register — a
			// malformed ```tool block, an unknown op, a duplicate name — so an author
			// sees why a tool didn't show up in the list. Best-effort; the tool blobs are
			// few (bounded by tools/ page count) and this never blocks link validation.
			let toolNotes: string[] = [];
			try {
				const toolPaths = resolved.pages.filter((p) => isToolPagePath(p.path)).map((p) => p.path);
				const pages = await Promise.all(
					toolPaths.map(async (path) => ({
						path,
						content: (await store.readFile(repoArgs, path))?.content ?? null
					}))
				);
				// The same rule the loader registers by (planCustomTools), so every page
				// reported here is exactly one that did not register, including those past
				// the per-brain cap.
				toolNotes = planCustomTools(pages).errors.map((e) => `- ${e.sourcePath}: ${e.error}`);
			} catch {
				// Best-effort: malformed-tool reporting never blocks link validation.
			}
			const toolText = toolNotes.length
				? `\n\n${toolNotes.length} custom tool page(s) won't register — fix them, then reconnect:\n${toolNotes.join('\n')}`
				: '';

			// Folders whose overview page isn't named index.md, so the app can't open
			// them from the folder. Advisory, not a problem, and pure over the index's
			// page list (no extra fetch).
			const folderNotes = folderNoteSuggestions(resolved.pages);

			// OKF structure advisories: concepts inlined into a folder note instead of
			// getting their own file, and pages missing the `type:` the format requires.
			// Soft and best-effort — a failure here must never take link validation with it.
			let findingsText = '';
			try {
				const notePaths = resolved.pages
					.filter((p) => isFolderNoteName(p.path.slice(p.path.lastIndexOf('/') + 1)))
					.map((p) => p.path);
				const noteContents = await loadPageContents(db, brainId, notePaths);
				const fieldsByPath = await loadAllFields(db, brainId);
				const conceptPages = resolved.pages.filter(
					(p) =>
						!isFolderNoteName(p.path.slice(p.path.lastIndexOf('/') + 1)) &&
						!isToolMaintained(p.path, config)
				);

				// Consolidation tensions need page BODIES only for near-duplicate
				// detection, and loading a whole brain's content is the one expensive
				// thing here — so above the cap that check is skipped rather than run.
				const contents =
					resolved.pages.length <= MAX_DUP_PAGES
						? await loadPageContents(
								db,
								brainId,
								resolved.pages.map((p) => p.path)
							)
						: undefined;

				const all: Finding[] = [
					...importFindingsList,
					...inlinedConceptSuggestions(
						[...noteContents].map(([path, content]) => ({ path, content })),
						resolved.pages
					),
					...typeFieldSuggestions(conceptPages, fieldsByPath),
					...ambiguousTitleSuggestions(resolved.pages),
					...wikilinkPortabilityNote(resolved.edges),
					...folderNotes,
					...tensionFindings(
						computeTensions({
							pages: resolved.pages,
							edges: resolved.edges,
							contents,
							toolMaintained: (p) => isToolMaintained(p, config)
						})
					)
				];

				// Everything already decided about is dropped here. A best-effort read:
				// a corrupt or unreadable ledger must not cost the caller their report,
				// it just means nothing is filtered this run.
				let kept = all;
				try {
					const raw = await store.readFile(repoArgs, REVIEW_LEDGER_PATH);
					kept = filterDismissed(all, parseReviewLedger(raw?.content ?? null));
				} catch {
					// An unparseable ledger filters nothing rather than failing the read.
				}

				if (kept.length) {
					const { text } = renderFindings(kept, MAX_FINDINGS_SHOWN);
					const silenced = all.length - kept.length;
					const note = silenced ? ` ${silenced} previously dismissed and not shown.` : '';
					findingsText =
						`\n\n${kept.length} finding(s) need a decision — advisory, nothing here is broken,` +
						` and each can be answered or silenced with resolve.${note}\n${text}`;
				}
			} catch {
				// Advisory only; link validation stands alone.
			}

			const extras = `${truncationNote(truncated)}${pendingText}${toolText}${findingsText}`;
			if (problemCount === 0) {
				return ok(`Checked ${pageCount} page(s) — no broken links.${extras}`);
			}
			return ok(
				`Checked ${pageCount} page(s) — ${problemCount} broken link(s):\n\n${problemSections.join('\n\n')}${extras}`
			);
		}
	);

	// ---------- search_pages ----------
	// Names ITSELF in its own description, and says when to reach for it. A tool an
	// agent hunts for by name mid-task must be findable by that name: `view_page` once
	// outranked `read_page` in a host tool-search because read_page's own one-liner
	// never said "read_page", and the agent concluded it could not read pages at all.
	server.registerTool(
		'search_pages',
		{
			title: 'Search brain pages',
			annotations: { readOnlyHint: true },
			// search_pages names itself, and says enough that an agent hunting for it
			// mid-task finds it — see the read_page/view_page note in CLAUDE.md. It also
			// states that a question works, because the previous engine's inability to
			// answer one is the habit a model arrives with.
			description:
				'search_pages: full-text search across a brain\'s wiki pages, case-insensitive. Takes a phrase, a question, or a single term — the query is split into words and pages are ranked by how many of them they carry, so "who owns the referral program" works as well as "referral". Returns the best matching lines, best page first, each with its page path and line number. By default it searches the brain you are in. Pass scope: "all" to search every brain you can reach in one call, which is how to find something when you are not sure which brain holds it; every result then names the brain it came from. Results from other brains are served from the search index and can lag a very recent edit there; read_page on any hit always returns the authoritative page. Use read_page or view_page to open a page it names.',
			inputSchema: z.object({
				brain: brainArg,
				query: z.string().min(2).describe('Text to search for.'),
				prefix: z
					.string()
					.optional()
					.describe(
						'Restrict to a path prefix, e.g. "internal/frameworks/". Defaults to all content.'
					),
				scope: z
					.enum(['brain', 'all'])
					.optional()
					.describe(
						'"brain" (default) searches one brain: the one named by `brain`, else the active one. "all" searches every brain you can reach, and each result names its brain. Use "all" when you do not know which brain holds what you are after.'
					),
				expect: z
					.string()
					.optional()
					.describe(
						'Path of the page that SHOULD answer this query. Adds a line saying where it ranked and what beat it, without changing the results. Use it to check that a page is findable by the questions it owns, and to see whether a retitle helped. Measured against the brain you are in.'
					)
			})
		},
		async ({ query, prefix, brain, scope, expect }) => {
			const ctx = await getContext({ brain });
			const { store, repoArgs, config, db, brainId } = ctx;
			// FRESHNESS IS PER BRAIN, and only the brain you are in keeps it. ensureFresh
			// costs one branchCommitSha per brain, plus a full reindex for any whose HEAD
			// moved since it was last touched, which for a rarely-opened brain is the
			// common case rather than the rare one. Fanning that out would spend N
			// subrequests and an unbounded reindex before answering. So the other brains
			// are served from whatever is indexed, and the result says so. A read_page on
			// any hit resolves the authoritative blob anyway, and slightly stale discovery
			// followed by a fresh read is correct behaviour for a search.
			const { truncated } = await ensureFresh(db, store, repoArgs, brainId, config);

			const targets = await searchTargets(ctx, scope === 'all' ? deps : undefined);
			const wide = targets.length > 1;
			const labelOf = new Map(targets.map((t) => [t.id, t.label]));

			// The per-page cap is what keeps breadth: without it one page with a common
			// term takes the whole budget and every other page is invisible, which on a
			// large brain is the difference between a search and a lucky sort order.
			const opts = { max: 50, perPage: 3 };
			// A per-brain budget only when there is more than one brain; with one, the two
			// limits collapse and the result is identical to the single-brain search.
			const perBrain = wide ? 15 : opts.max;
			const found = await searchBrains(
				db,
				targets.map((t) => t.id),
				query,
				prefix,
				{ perBrain, total: opts.max, perPage: opts.perPage }
			);
			const { terms } = found;
			// Structured hits ride along for UI consumers (the brain MCP App); the text
			// block stays the source of truth for chat/agent consumers. Both carry the
			// brain, because a result set that does not say where each line came from is
			// how one client's material gets quoted into another client's conversation.
			const hits = found.hits.map((h) => ({
				path: h.path,
				line: h.line,
				text: h.text,
				brain: h.brainId,
				brainLabel: labelOf.get(h.brainId) ?? h.brainId
			}));

			// Naming the terms is the difference between "the brain does not say" and
			// "I asked the wrong question". A model that gets a bare no-match rephrases
			// blindly; one that can see the query was reduced to two words can tell
			// which two missed.
			const searched = terms.join(', ');
			const note =
				searched && searched !== query.trim().toLowerCase() ? ` Searched: ${searched}.` : '';

			// `expect` measures the retrieval path rather than changing it: the results
			// are identical with and without it. It answers the one question a rewrite
			// otherwise cannot check — did the page that owns this question come back,
			// and did it come back first. A path names a page in ONE brain, so under
			// fan-out the probe reads the active brain's own ranking rather than the
			// merged list, where another brain's hits would count as things that beat it.
			const here = found.perBrain.get(brainId);
			const probe = expect && here ? scoreProbe(query, expect, here.hits, perBrain) : null;
			const probeNote = probe ? `\n\n${describeProbe(probe)}` : '';

			const where = wide ? ` across ${targets.length} brains` : '';
			if (hits.length === 0) {
				return {
					...ok(
						`No matches for "${query}"${where}.${note}${probeNote}${truncationNote(truncated)}`
					),
					structuredContent: {
						hits: [],
						terms,
						pagesMatched: 0,
						probe,
						scope: wide ? 'all' : 'brain'
					} satisfies SearchWire
				};
			}
			const capped = found.budgetHit ? ` (the top ${opts.max})` : '';
			// The brain is named on every line for a fan-out and never for a single-brain
			// search: the confusion this guards against is crossing brains, and repeating
			// the brain you are already in on all fifty lines is noise.
			const lines = hits
				.map((h) => (wide ? `${h.brainLabel} · ` : '') + `${h.path}:${h.line}: ${h.text}`)
				.join('\n');
			const pagesShown = wide
				? new Set(hits.map((h) => `${h.brain}\0${h.path}`)).size
				: (here?.pagesShown ?? 0);
			const elision = wide
				? `\nOther brains are searched from the index; read_page returns the live page.`
				: here
					? elisionNote(here, opts)
					: '';
			return {
				...ok(
					`${hits.length} match(es)${capped} for "${query}"${where} across ${pagesShown} page(s), best first${wide ? ', grouped by brain' : ''}.${note}\n${lines}` +
						`${elision}${probeNote}${truncationNote(truncated)}`
				),
				structuredContent: {
					hits,
					terms,
					pagesMatched: found.pagesMatched,
					probe,
					scope: wide ? 'all' : 'brain'
				} satisfies SearchWire
			};
		}
	);
}
