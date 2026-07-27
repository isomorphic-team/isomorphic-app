// Per-brain content-shape config — what makes an arbitrary GitHub repo a "brain".
//
// A brain is any repo owned by any org. This module LOADS, per brain, which
// paths are EDITABLE CONTENT, which are IMMUTABLE SOURCE, and where the
// tool-maintained changelog lives — so the write tools stop hardcoding the
// string "wiki/". The declaration is a `.isomorphic.json` file committed at the
// repo root; when it's ABSENT the defaults reproduce the original wiki/ + raw/
// behavior exactly, so pre-existing brains (isomorphic-mind) need no migration.
//
// Example for a whole-repo brain (e.g. an adopted external knowledge base with
// its own top-level layout):
//   { "paths": { ".": "content", ".github/": "system", "scripts/": "system",
//                ".isomorphic/log.md": "log" } }
// (The legacy contentRoots/sourceRoots/logPath/ignore shape is still accepted;
// see parsePaths.)
//
// The pure path predicates (isContentPath, isHiddenName, …) live in
// brain-policy.ts — a no-dependency module the app UI bundles too, so the tree's
// notion of editable/hidden can never drift from the Worker's. This module adds
// the repo-touching half (octokit loads) and re-exports the policy for existing
// importers. Worker-safe (no node:*): loaded from the repo via octokit at
// request time.

import type { Octokit } from 'octokit';
import { type RepoRef, getHead, listTree, readFile } from './brain-repo.ts';
import {
	type BrainConfig,
	type MergeMethod,
	type PathRole,
	type WriteMode,
	CONFIG_PATH,
	DEFAULT_BRAIN_CONFIG,
	PATH_ROLES,
	isContentPath,
	normRoot
} from './brain-policy.ts';

export * from './brain-policy.ts';

// Everything in the repo that is NOT a visible content page: system files
// (.isomorphic.json), folder markers (.gitkeep), immutable source, the
// changelog, ignored paths, non-md assets. The app's file tree shows content
// pages by default and reveals the rest behind "show hidden" (locked where the
// policy makes them read-only). One recursive tree read.
export async function listHiddenPaths(
	octokit: Octokit,
	repo: RepoRef,
	config: BrainConfig
): Promise<string[]> {
	const head = await getHead(octokit, repo);
	const tree = await listTree(octokit, repo, head, { extension: '*' });
	return tree
		.map((e) => e.path)
		.filter((p) => !(p.endsWith('.md') && isContentPath(p, config)))
		.sort();
}

function stringList(v: unknown, fallback: string[]): string[] {
	if (!Array.isArray(v)) return fallback;
	return v.filter((s): s is string => typeof s === 'string');
}

// The legacy file shape (pre role-map, 2026-07): four separate mechanisms that
// the role map replaced. Still accepted indefinitely — live brains carry it.
interface LegacyConfigFile {
	contentRoots?: unknown;
	sourceRoots?: unknown;
	logPath?: unknown;
	ignore?: unknown;
	writeMode?: unknown;
	autoMerge?: unknown;
	indexedFields?: unknown;
}

interface ConfigFile extends LegacyConfigFile {
	paths?: unknown;
	sourceOfTruth?: unknown;
	writes?: { mode?: unknown; autoMerge?: unknown };
	index?: { fields?: unknown };
}

// Parse the path→role map from either file shape. New shape: a `paths` record
// (unknown roles dropped). Legacy shape: contentRoots/sourceRoots/logPath/ignore
// synthesized into the equivalent map (ignore → system; longest-prefix already
// reproduces the old precedence order).
export function parsePaths(raw: ConfigFile): Record<string, PathRole> {
	if (raw.paths && typeof raw.paths === 'object' && !Array.isArray(raw.paths)) {
		const out: Record<string, PathRole> = {};
		for (const [k, v] of Object.entries(raw.paths as Record<string, unknown>)) {
			if (typeof v === 'string' && (PATH_ROLES as readonly string[]).includes(v))
				out[k] = v as PathRole;
		}
		return out;
	}
	// Legacy shape, with the old per-field fallbacks (a field the file omits gets
	// its default; a field it sets — even to empty — is honored).
	const out: Record<string, PathRole> = {};
	for (const r of stringList(raw.contentRoots, ['wiki/'])) out[normRoot(r) || '.'] = 'content';
	for (const r of stringList(raw.sourceRoots, ['raw/'])) out[normRoot(r) || '.'] = 'source';
	for (const r of stringList(raw.ignore, [])) out[normRoot(r) || '.'] = 'system';
	const log = typeof raw.logPath === 'string' ? raw.logPath.trim() : 'wiki/log.md';
	if (log) out[log] = 'log';
	return out;
}

// Resolve how writes should land. An explicit writeMode in .isomorphic.json wins;
// otherwise auto-detect from the default branch's protection (protected → PR).
// Any failure (permissions, network) falls back to direct — the pre-config
// behavior — so detection can never make a brain worse than it was.
async function resolveWritePolicy(
	octokit: Octokit,
	repo: RepoRef,
	rawMode: unknown
): Promise<{ writeMode: WriteMode; defaultBranch: string; mergeMethod: MergeMethod }> {
	const explicit: WriteMode | null =
		rawMode === 'direct' || rawMode === 'pull-request' ? rawMode : null;
	let defaultBranch = DEFAULT_BRAIN_CONFIG.defaultBranch;
	let mergeMethod: MergeMethod = DEFAULT_BRAIN_CONFIG.mergeMethod;
	try {
		const { data: r } = await octokit.rest.repos.get(repo);
		defaultBranch = r.default_branch;
		// Prefer squash (one clean commit per edit bundle), then merge, then rebase.
		mergeMethod = r.allow_squash_merge
			? 'SQUASH'
			: r.allow_merge_commit
				? 'MERGE'
				: r.allow_rebase_merge
					? 'REBASE'
					: 'MERGE';
		if (explicit) return { writeMode: explicit, defaultBranch, mergeMethod };
		// `.protected` on the branch object needs no admin permission (unlike the
		// /protection endpoint), so this works with plain contents access.
		const { data: br } = await octokit.rest.repos.getBranch({ ...repo, branch: defaultBranch });
		return { writeMode: br.protected ? 'pull-request' : 'direct', defaultBranch, mergeMethod };
	} catch {
		return { writeMode: explicit ?? 'direct', defaultBranch, mergeMethod };
	}
}

// Load a brain's config from its repo. Absent/malformed .isomorphic.json → the
// wiki/+raw/ defaults (never break a brain over a bad config commit). The write
// policy is always resolved from the live repo (protection detection), regardless
// of whether a config file exists.
export async function loadBrainConfig(octokit: Octokit, repo: RepoRef): Promise<BrainConfig> {
	const file = await readFile(octokit, repo, CONFIG_PATH);
	let raw: ConfigFile = {};
	if (file) {
		try {
			raw = JSON.parse(file.content) as ConfigFile;
		} catch {
			raw = {};
		}
	}
	// New shape nests the write overrides under `writes`; legacy kept them top-level.
	const rawMode = raw.writes?.mode ?? raw.writeMode;
	const rawAutoMerge = raw.writes?.autoMerge ?? raw.autoMerge;
	const rawFields = raw.index?.fields ?? raw.indexedFields;
	const { writeMode, defaultBranch, mergeMethod } = await resolveWritePolicy(
		octokit,
		repo,
		rawMode
	);
	return {
		paths: parsePaths(raw),
		writeMode,
		defaultBranch,
		autoMerge: typeof rawAutoMerge === 'boolean' ? rawAutoMerge : DEFAULT_BRAIN_CONFIG.autoMerge,
		mergeMethod,
		// Distinguish "absent" (null → index all keys) from an explicit list.
		indexedFields: Array.isArray(rawFields) ? stringList(rawFields, []) : null,
		sourceOfTruth: raw.sourceOfTruth === 'source' ? 'source' : 'app'
	};
}
