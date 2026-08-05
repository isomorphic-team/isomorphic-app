// Pure path-policy for a brain — the single source of truth for "what is this
// path?", shared by BOTH bundles: the Worker imports it via brain-config.ts, and
// the app UI imports it directly (no octokit/network dependencies, so it's safe
// to bundle into the ui:// app).
//
// The whole model is ONE map from path prefix to ROLE, where a role is a write
// discipline:
//
//   content — editable pages: people + agents, full lifecycle
//   source  — evidence (transcripts, docs): added out-of-band (e.g. via GitHub), immutable to our tools
//   log     — the tool-maintained changelog: tools append, nobody edits
//   system  — not the brain's concern: nothing reads or writes it via our tools
//
// `roleOf(path)` resolves a path against the map (longest prefix wins; unmatched
// paths are `system`), and every policy question derives from it: editable =
// content, locked = not content, hidden in the tree = not a content page.
//
// The role map replaced the original four separate mechanisms (contentRoots /
// sourceRoots / logPath / ignore) in 2026-07; the config loader still accepts
// the legacy field shape and synthesizes a map, so old .isomorphic.json files
// keep working unchanged.

import { isMediaPath } from './media.ts';

// How writes reach the repo. `direct` commits to the default branch (right for
// dedicated brains the app owns); `pull-request` opens a PR instead (right for a
// branch-protected repo, e.g. an adopted customer KB whose main requires review).
export type WriteMode = 'direct' | 'pull-request';

// Merge strategy for auto-merge (GitHub's PullRequestMergeMethod). Derived from
// the repo's allowed methods; used when a PR-mode write auto-merges on green.
export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

export type PathRole = 'content' | 'source' | 'log' | 'system';

export const PATH_ROLES: readonly PathRole[] = ['content', 'source', 'log', 'system'];

// The path-shape slice of a brain's config — everything the path predicates
// need. The app receives exactly this over the wire (editPolicy in
// src/tools/apps.ts); the Worker's full BrainConfig extends it.
export interface PathPolicy {
	// Path prefix → role. Keys are directory prefixes ("wiki/", "." = whole repo)
	// or exact file paths ("wiki/log.md"). Longest match wins; unmatched paths
	// are `system`. At most one path should carry the `log` role.
	paths: Record<string, PathRole>;
}

export interface BrainConfig extends PathPolicy {
	// How writes land. Resolved at load time: an explicit `.isomorphic.json`
	// writes.mode wins; otherwise auto-detected from default-branch protection.
	writeMode: WriteMode;
	// The repo's default branch (PR base / direct-commit target).
	defaultBranch: string;
	// In pull-request mode, enable GitHub auto-merge on the opened PR so it lands
	// automatically once the repo's required checks/approvals pass — the fix for
	// non-technical members whose edits would otherwise sit as open PRs. Defaults
	// true; set `"writes": {"autoMerge": false}` to force manual merges.
	autoMerge: boolean;
	// Merge method to auto-merge with (prefers what the repo allows: squash → merge → rebase).
	mergeMethod: MergeMethod;
	// Which frontmatter keys the content index stores per page (FR-2, derived-views
	// PRD). null (the default) = ALL scalar/list-of-scalar keys, bounded by hard
	// caps in brain-index.ts — so any brain's frontmatter is queryable with zero
	// config. Set `"index": {"fields": ["type"]}` to restrict.
	indexedFields: string[] | null;
	// Who wins when an external source and in-app curation disagree (FR-4,
	// derived-views PRD). 'app' (the default): curation is sacred — imports only
	// touch declared source-owned frontmatter, deletions are proposed. 'source':
	// the external source is authoritative — RESERVED, not implemented (the
	// importer refuses it rather than guessing at destructive semantics).
	sourceOfTruth: 'app' | 'source';
}

// The per-repo config file, read from the repo root.
export const CONFIG_PATH = '.isomorphic.json';

// Absent-file defaults == the original hardcoded behavior. Do not change these
// without a migration: existing brains rely on them implicitly.
export const DEFAULT_BRAIN_CONFIG: BrainConfig = {
	paths: { 'wiki/': 'content', 'raw/': 'source', 'wiki/log.md': 'log' },
	writeMode: 'direct',
	defaultBranch: 'main',
	autoMerge: true,
	mergeMethod: 'MERGE',
	indexedFields: null,
	sourceOfTruth: 'app'
};

// Normalize a root/prefix so prefix checks are unambiguous:
//   "", ".", "./", "/"  → ""      (whole repo)
//   "wiki", "wiki/"      → "wiki/"
export function normRoot(root: string): string {
	const t = root.trim().replace(/^\/+/, '').replace(/\/+$/, '');
	if (t === '' || t === '.') return '';
	return `${t}/`;
}

// Is `path` at or under a single root? A "" root matches everything.
function underRoot(path: string, root: string): boolean {
	const p = normRoot(root);
	if (p === '') return true;
	return path === p.slice(0, -1) || path.startsWith(p);
}

export function underAnyRoot(path: string, roots: string[]): boolean {
	return roots.some((r) => underRoot(path, r));
}

// Resolve a path's role: the longest map key that matches wins ("" / "." keys
// match everything at the lowest priority); unmatched paths are `system`. A key
// matches as an exact path or as a directory prefix, so file keys ("wiki/log.md")
// and dir keys ("wiki/") need no distinguishing syntax. The config file itself is
// always `system` — it configures the brain, it isn't in it.
export function roleOf(path: string, cfg: PathPolicy): PathRole {
	if (path === CONFIG_PATH) return 'system';
	let best: PathRole = 'system';
	let bestLen = -1;
	for (const [key, role] of Object.entries(cfg.paths)) {
		const base = key.trim().replace(/^\/+/, '').replace(/\/+$/, '');
		const norm = base === '.' ? '' : base;
		if (norm.length <= bestLen) continue;
		if (norm === '' || path === norm || path.startsWith(`${norm}/`)) {
			best = role;
			bestLen = norm.length;
		}
	}
	return best;
}

// All directory prefixes carrying `role`, normalized ("wiki/"; "" = whole repo).
// File-path entries (the log) don't produce roots.
export function rootsOf(cfg: PathPolicy, role: PathRole): string[] {
	return Object.entries(cfg.paths)
		.filter(([, r]) => r === role)
		.map(([k]) => normRoot(k))
		.filter((k) => k === '' || !/\.[a-z0-9]+\/$/i.test(k));
}

// The tool-maintained changelog path, or '' when the brain keeps none.
export function logPathOf(cfg: PathPolicy): string {
	for (const [key, role] of Object.entries(cfg.paths)) {
		if (role === 'log') return key.trim().replace(/^\/+/, '').replace(/\/+$/, '');
	}
	return '';
}

// The slice of a brain's config the in-client app needs to gate its own UI (which
// hover-affordances to show, whether the Edit button is live, which folders are
// hidden). Shipped in the structuredContent of EVERY tool the app builds a file
// tree from, so the app never has to hardcode "wiki/" — and, just as importantly,
// so a brain SWITCH re-delivers it. The app feeds this straight into the same
// roleOf/isContentPath the Worker uses.
export function pathPolicyOf(cfg: PathPolicy): PathPolicy {
	return { paths: cfg.paths };
}

// ---- role-derived predicates (kept for call-site readability) ----

export function isSourcePath(path: string, cfg: PathPolicy): boolean {
	return roleOf(path, cfg) === 'source';
}

export function isToolMaintained(path: string, cfg: PathPolicy): boolean {
	return roleOf(path, cfg) === 'log';
}

// The core predicate: may this path be an editable content page? (Callers still
// enforce the `.md` extension.)
export function isContentPath(path: string, cfg: PathPolicy): boolean {
	return roleOf(path, cfg) === 'content';
}

// The attachment predicate: is this an uploaded file living in the brain's content,
// as opposed to a page? Deliberately NOT a new PathRole. Assets sit under the same
// `content` roots as the pages that reference them and are told apart by not ending
// in `.md`, which is the distinction every page tool already enforces at its call
// site. A fifth role would have changed the path-policy wire contract the app and
// Worker share (pnpm test:policy) and forced every existing brain to add a prefix to
// its config before a single image could be uploaded.
//
// The media-type check is what keeps this from claiming arbitrary repo files: a
// stray `.yml` or `LICENSE` under wiki/ is neither a page nor an attachment.
export function isAssetPath(path: string, cfg: PathPolicy): boolean {
	if (path.endsWith('.md') || isHiddenName(path)) return false;
	return roleOf(path, cfg) === 'content' && isMediaPath(path);
}

// The display predicate: a dotfile/dot-folder name ("hidden by convention", e.g.
// the `.gitkeep` markers that persist otherwise-empty folders). Works on a full
// path or a single segment — hidden iff the last segment starts with ".".
export function isHiddenName(path: string): boolean {
	return path.split('/').pop()!.startsWith('.');
}
