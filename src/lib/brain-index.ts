// Brain content index — the read-path backend for search / graph / backlinks /
// validate. Worker-safe (no node:*): reachable from worker.ts and the tools.
//
// THE INDEX IS A DERIVED CACHE, NOT THE SOURCE OF TRUTH — the GitHub repo is.
// Every read calls ensureFresh() first, which compares the repo's branch HEAD to
// the commit the index reflects (brain_index_meta.indexed_commit_sha):
//   - HEAD unchanged  → serve from the index (one cheap getRef, then D1 queries).
//   - HEAD moved      → reindex the changed pages (diff blob shas), then serve.
// So a query can never return content stale relative to the branch, even when the
// repo was edited outside our tools (github.com, another agent, a merged PR). The
// index just makes reads fast and unbounded; correctness rides on the HEAD guard.
//
// Design notes:
//   - Links are stored RAW and resolved to targets at QUERY time (loadResolvedGraph)
//     against the current page set, so adding/removing a page fixes/breaks inbound
//     links with no whole-brain re-resolve. See src/db/index-schema.sql.
//   - The blob fetch reuses fetchPages (batched GraphQL), so a (re)build costs
//     ceil(changedPages / 100) subrequests, not one per page.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { type RepoRef, type TreeEntry, type BrainStore, MAX_SCAN_PAGES } from './brain-repo.ts';
import { classifyMdLink } from './links.ts';
import { type BrainConfig, CONFIG_PATH, isContentPath, loadIndexConfig } from './brain-config.ts';
import {
	parseFrontmatter,
	extractLinks,
	isFrontmatterBlock,
	pageTitle,
	buildWikilinkIndex,
	resolveWikilink,
	wikilinkKey,
	wikilinkTargetName
} from './wiki.ts';
import {
	DEFAULT_SEARCH_OPTIONS,
	rankPages,
	searchCorpus,
	tokenizeQuery,
	type PageSignal,
	type SearchResult
} from './search.ts';

// Version of the index's ROW SHAPE (not the D1 schema — migrations handle that).
// Bumped when (re)indexing starts producing rows older builds lack, so brains
// indexed before the bump lazily rebuild the missing rows from the page content
// already stored in brain_pages — no GitHub refetch. v1: brain_page_fields.
// v2: nested frontmatter is preserved verbatim rather than flattened (see wiki.ts),
// so it no longer produces field rows — brains indexed at v1 hold mangled rows for
// those keys ("resource: /source/x.md" as a value) which a filter could still match.
// v3: titles resolve via pageTitle (frontmatter title > body H1 > folder/filename),
// so stored titles from v1/v2 can disagree with what the page calls itself.
// v4: link extraction skips code spans and fenced blocks, so v1–v3 link rows hold
// "links" that were only ever syntax examples.
export const INDEX_SCHEMA_VERSION = 4;

// ---------- shared helpers ----------

const slugOf = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');
const deslug = (path: string) => slugOf(path).replace(/-/g, ' ');

// Title resolution lives in wiki.ts (pageTitle) as the single source of truth —
// this file and librarian.ts each used to carry their own copy of the fallback.

// A page's distinct links with occurrence counts (so backlink counts survive a
// page that links the same target twice). Extracted from the WHOLE content — this
// matches find_inbound_links (which scans full content); validate historically
// scanned the body only, so it now also sees the rare link written in frontmatter,
// which is strictly more correct.
interface ParsedLink {
	rawTarget: string;
	kind: 'md' | 'wiki';
	cnt: number;
}
function parseLinks(content: string): ParsedLink[] {
	const byKey = new Map<string, ParsedLink>();
	for (const l of extractLinks(content)) {
		const key = `${l.kind}\0${l.target}`;
		const existing = byKey.get(key);
		if (existing) existing.cnt++;
		else byKey.set(key, { rawTarget: l.target, kind: l.kind, cnt: 1 });
	}
	return [...byKey.values()];
}

// ---------- frontmatter fields (FR-2, derived-views PRD) ----------
//
// Every scalar / list-of-scalar frontmatter key is indexed by default (decided
// 2026-07-22: zero-config beats an allowlist; `indexedFields` in .isomorphic.json
// optionally restricts). Hard caps bound the rows any single page can produce, so
// "index everything" stays cheap even on a hostile page.

export const MAX_FIELD_KEYS_PER_PAGE = 24;
const MAX_FIELD_VALUE_CHARS = 256;
const MAX_FIELD_LIST_ELEMENTS = 20;

interface FieldRow {
	key: string;
	value: string;
	num: number | null;
}

// A value's numeric interpretation, when it cleanly is one ("3", "-2.5"), so
// numeric fields (rank) can sort/compare numerically. Strict: `Number('')` and
// `Number('  ')` are 0, so require a digit.
function numOf(value: string): number | null {
	if (!/^-?\d/.test(value.trim())) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function fieldRowsOf(content: string, config: BrainConfig): FieldRow[] {
	const { frontmatter } = parseFrontmatter(content);
	if (!frontmatter) return [];
	const rows: FieldRow[] = [];
	const seen = new Set<string>(); // dedupe (key, value) — the table's PK
	let keys = 0;
	for (const [key, raw] of Object.entries(frontmatter)) {
		if (config.indexedFields && !config.indexedFields.includes(key)) continue;
		if (++keys > MAX_FIELD_KEYS_PER_PAGE) break;
		// Nested values are held verbatim and never interpreted, so there is nothing
		// meaningful to index or filter on — skip them rather than store a mangling.
		if (isFrontmatterBlock(raw)) continue;
		const values = Array.isArray(raw) ? raw.slice(0, MAX_FIELD_LIST_ELEMENTS) : [raw];
		for (const v of values) {
			const value = v.trim().slice(0, MAX_FIELD_VALUE_CHARS);
			if (value === '') continue;
			const dedupe = `${key}\0${value}`;
			if (seen.has(dedupe)) continue;
			seen.add(dedupe);
			rows.push({ key, value, num: numOf(value) });
		}
	}
	return rows;
}

// D1 caps statements per batch; keep chunks modest so a large full build stays
// well within limits and each batch is a single transaction.
const BATCH_CHUNK = 40;
async function runBatched(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
	for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
		await db.batch(stmts.slice(i, i + BATCH_CHUNK));
	}
}

function pageUpsert(
	db: D1Database,
	brainId: string,
	path: string,
	content: string,
	blobSha: string,
	config: BrainConfig
): D1PreparedStatement[] {
	const stmts: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT OR REPLACE INTO brain_pages (brain_id, path, title, blob_sha, content)
				 VALUES (?1, ?2, ?3, ?4, ?5)`
			)
			.bind(brainId, path, pageTitle(path, content), blobSha, content),
		// This page's links + fields are fully replaced (the old ones are gone).
		db.prepare(`DELETE FROM brain_links WHERE brain_id = ?1 AND source = ?2`).bind(brainId, path),
		db
			.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?1 AND path = ?2`)
			.bind(brainId, path)
	];
	for (const l of parseLinks(content)) {
		stmts.push(
			db
				.prepare(
					`INSERT OR REPLACE INTO brain_links (brain_id, source, raw_target, kind, cnt)
					 VALUES (?1, ?2, ?3, ?4, ?5)`
				)
				.bind(brainId, path, l.rawTarget, l.kind, l.cnt)
		);
	}
	for (const f of fieldRowsOf(content, config)) {
		stmts.push(
			db
				.prepare(
					`INSERT OR REPLACE INTO brain_page_fields (brain_id, path, key, value, value_num)
					 VALUES (?1, ?2, ?3, ?4, ?5)`
				)
				.bind(brainId, path, f.key, f.value, f.num)
		);
	}
	return stmts;
}

// ---------- freshness guard (the read entrypoint) ----------

export interface IndexState {
	truncated: boolean; // the brain exceeded MAX_SCAN_PAGES, so the index is partial
}

// The commit sha of a branch's tip — one subrequest, the cheap steady-state check.
// Reconcile the index with the repo HEAD, then return its state. Cheap when the
// index is already current (one getRef); does an incremental — or first-time full —
// reindex only when HEAD has moved. MUST be awaited before any index query.
export async function ensureFresh(
	db: D1Database,
	store: BrainStore,
	repo: RepoRef,
	brainId: string,
	config: BrainConfig
): Promise<IndexState> {
	const liveSha = await store.branchCommitSha(repo, config.defaultBranch);
	const meta = await db
		.prepare(
			`SELECT indexed_commit_sha, truncated, schema_version, rebuild_cursor
			 FROM brain_index_meta WHERE brain_id = ?1`
		)
		.bind(brainId)
		.first<{
			indexed_commit_sha: string | null;
			truncated: number;
			schema_version: number;
			rebuild_cursor: string | null;
		}>();

	if (meta && meta.indexed_commit_sha === liveSha) {
		// Content is current, but the rows may predate a row-shape bump (e.g. the
		// brain was indexed before brain_page_fields existed). Rebuild the missing
		// rows from the content already in brain_pages — no GitHub fetch. Bounded per
		// request: schema_version only advances once the walk reaches the end, so a
		// brain too big to rebuild in one request converges over successive reads
		// instead of timing out on every one of them.
		if ((meta.schema_version ?? 0) < INDEX_SCHEMA_VERSION) {
			const next = await rebuildDerivedFromStore(db, brainId, config, meta.rebuild_cursor ?? '');
			await db
				.prepare(
					`UPDATE brain_index_meta SET schema_version = ?2, rebuild_cursor = ?3 WHERE brain_id = ?1`
				)
				.bind(brainId, next === null ? INDEX_SCHEMA_VERSION : (meta.schema_version ?? 0), next)
				.run();
		}
		return { truncated: !!meta.truncated };
	}

	// Stale (or never built) → (re)index. Read the content-shape config from this
	// exact revision: a config commit can land after the request context was built,
	// and recording that commit with rows derived under the prior config would make
	// the mismatch look permanently fresh. This is one pinned blob read, not the old
	// three-call config + write-policy reload.
	const head = await store.getHead(repo, config.defaultBranch);
	const freshConfig = await loadIndexConfig(store, repo, head.commitSha, config);
	const entries = (await store.listTree(repo, head)).filter(
		(e) => e.path.endsWith('.md') && isContentPath(e.path, freshConfig)
	);
	const truncated = entries.length > MAX_SCAN_PAGES;

	// How the meta row should read afterwards. Both build paths are budgeted, so
	// either may finish only part of the work; the meta row has to say so honestly
	// or the next read will believe a partial index is current.
	let schemaVersion = INDEX_SCHEMA_VERSION;
	let rebuildCursor: string | null = null;
	// The sha to record. Only advance to HEAD once the index actually reflects it.
	// NULL is meaningful here (the schema's "never built"), and is what an
	// over-budget FIRST build leaves behind: rows exist, but they don't yet
	// correspond to any commit, so the next read keeps reconciling.
	let indexedSha: string | null = head.commitSha;

	if (!meta) {
		// First build. Bounded for the same reason the others are: a brain big enough
		// that its initial index can't be built in one request would otherwise fail,
		// write no meta row, and take the !meta path again on the next read — wedged
		// before it ever had an index, with nothing recorded to resume from.
		const built = await fullBuild(db, store, repo, brainId, entries, freshConfig);
		if (!built) indexedSha = null;
	} else {
		const reconciled = await incrementalReindex(db, store, repo, brainId, entries, freshConfig);
		if (!reconciled) indexedSha = meta.indexed_commit_sha;
		// The incremental pass only rewrote CHANGED pages' rows; on a row-shape bump
		// the unchanged pages still need their new rows built from stored content.
		if ((meta.schema_version ?? 0) < INDEX_SCHEMA_VERSION) {
			rebuildCursor = await rebuildDerivedFromStore(
				db,
				brainId,
				freshConfig,
				meta.rebuild_cursor ?? ''
			);
			if (rebuildCursor !== null) schemaVersion = meta.schema_version ?? 0;
		}
	}

	await db
		.prepare(
			`INSERT OR REPLACE INTO brain_index_meta (brain_id, indexed_commit_sha, truncated, updated_at, schema_version, rebuild_cursor)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
		)
		.bind(brainId, indexedSha, truncated ? 1 : 0, Date.now(), schemaVersion, rebuildCursor)
		.run();

	return { truncated };
}

// How many pages one request will rebuild derived rows for. The rebuild used to
// run whole-brain and inline, which made a large brain UNREADABLE rather than
// slow: ~3,000 pages is ~13,000 statements, past the host's 60s tool timeout, and
// because schema_version was only written at the end, the next read started over.
// Bounding it converges instead — each read advances the cursor by a slice.
const REBUILD_PAGE_BUDGET = 300;

// Rebuild the DERIVED rows — the page title, its links, and the queryable
// frontmatter fields — for at most REBUILD_PAGE_BUDGET pages, from the content
// already stored in brain_pages. Used on a schema_version bump, where page content
// is current but what we compute FROM it has changed (v1: fields table added;
// v2: nested frontmatter no longer flattened into fields; v3: titles now resolve
// through pageTitle; v4: link extraction skips code). No GitHub refetch: content
// is local.
//
// Walks pages in path order starting AFTER `cursor`. Returns the cursor to resume
// from, or null when the brain is fully rebuilt. Each page's rows are cleared
// per-path rather than by one brain-wide DELETE, so a partial pass leaves the
// pages it already did intact and re-running a slice is idempotent.
async function rebuildDerivedFromStore(
	db: D1Database,
	brainId: string,
	config: BrainConfig,
	cursor: string
): Promise<string | null> {
	const rows = await db
		.prepare(
			`SELECT path, content FROM brain_pages
			 WHERE brain_id = ?1 AND path > ?2 ORDER BY path LIMIT ?3`
		)
		.bind(brainId, cursor, REBUILD_PAGE_BUDGET)
		.all<{ path: string; content: string }>();
	if (rows.results.length === 0) return null;

	const stmts: D1PreparedStatement[] = [];
	for (const r of rows.results) {
		stmts.push(
			db
				.prepare(`UPDATE brain_pages SET title = ?3 WHERE brain_id = ?1 AND path = ?2`)
				.bind(brainId, r.path, pageTitle(r.path, r.content)),
			db
				.prepare(`DELETE FROM brain_links WHERE brain_id = ?1 AND source = ?2`)
				.bind(brainId, r.path),
			db
				.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?1 AND path = ?2`)
				.bind(brainId, r.path)
		);
		for (const l of parseLinks(r.content)) {
			stmts.push(
				db
					.prepare(
						`INSERT OR REPLACE INTO brain_links (brain_id, source, raw_target, kind, cnt)
						 VALUES (?1, ?2, ?3, ?4, ?5)`
					)
					.bind(brainId, r.path, l.rawTarget, l.kind, l.cnt)
			);
		}
		for (const f of fieldRowsOf(r.content, config)) {
			stmts.push(
				db
					.prepare(
						`INSERT OR REPLACE INTO brain_page_fields (brain_id, path, key, value, value_num)
						 VALUES (?1, ?2, ?3, ?4, ?5)`
					)
					.bind(brainId, r.path, f.key, f.value, f.num)
			);
		}
	}
	await runBatched(db, stmts);

	// A short page short-circuits the walk: fewer rows than asked for means this was
	// the last slice.
	if (rows.results.length < REBUILD_PAGE_BUDGET) return null;
	return rows.results[rows.results.length - 1].path;
}

// First-time build: wipe any stragglers for this brain and insert its pages, up to
// REINDEX_PAGE_BUDGET of them. Returns false when the brain has more pages than
// that, i.e. rows landed but the index does not yet cover HEAD — the caller records
// a NULL indexed_commit_sha and the next read continues through incrementalReindex,
// which sees the already-stored pages and only fetches the rest.
async function fullBuild(
	db: D1Database,
	store: BrainStore,
	repo: RepoRef,
	brainId: string,
	entries: TreeEntry[],
	config: BrainConfig
): Promise<boolean> {
	const complete = entries.length <= REINDEX_PAGE_BUDGET;
	const take = complete ? entries : entries.slice(0, REINDEX_PAGE_BUDGET);
	const { pages } = await store.fetchPages(repo, take);
	const shaByPath = new Map(take.map((e) => [e.path, e.sha]));
	const stmts: D1PreparedStatement[] = [
		db.prepare(`DELETE FROM brain_pages WHERE brain_id = ?1`).bind(brainId),
		db.prepare(`DELETE FROM brain_links WHERE brain_id = ?1`).bind(brainId),
		db.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?1`).bind(brainId)
	];
	for (const p of pages) {
		stmts.push(...pageUpsert(db, brainId, p.path, p.content, shaByPath.get(p.path) ?? '', config));
	}
	await runBatched(db, stmts);
	return complete;
}

// How many changed pages one request will re-fetch and re-upsert. Same reasoning
// as REBUILD_PAGE_BUDGET: a brain that has drifted by thousands of pages (a long
// gap since the last successful read, or a bulk import) must not need a single
// request big enough to reconcile all of it, because that request just times out
// and the index never advances. Over budget, the pass reports incomplete, the
// indexed commit sha is left alone, and the next read picks up the remainder.
const REINDEX_PAGE_BUDGET = 600;

// Incremental: re-fetch only pages whose blob sha changed (added or modified) and
// drop pages that disappeared. Inbound links to a dropped page are left in place —
// they simply stop resolving at query time and correctly surface as broken.
//
// Returns false when the changed set exceeded REINDEX_PAGE_BUDGET, i.e. the index
// is closer to HEAD but not yet at it.
async function incrementalReindex(
	db: D1Database,
	store: BrainStore,
	repo: RepoRef,
	brainId: string,
	entries: TreeEntry[],
	config: BrainConfig
): Promise<boolean> {
	const stored = await db
		.prepare(`SELECT path, blob_sha FROM brain_pages WHERE brain_id = ?1`)
		.bind(brainId)
		.all<{ path: string; blob_sha: string }>();
	const storedSha = new Map(stored.results.map((r) => [r.path, r.blob_sha]));
	const livePaths = new Set(entries.map((e) => e.path));

	const allChanged = entries.filter((e) => storedSha.get(e.path) !== e.sha);
	const complete = allChanged.length <= REINDEX_PAGE_BUDGET;
	// Deletions are cheap (no fetch), so they always land in full on the first pass.
	const changed = complete ? allChanged : allChanged.slice(0, REINDEX_PAGE_BUDGET);
	const removed = [...storedSha.keys()].filter((p) => !livePaths.has(p));

	const stmts: D1PreparedStatement[] = [];
	for (const path of removed) {
		stmts.push(
			db.prepare(`DELETE FROM brain_pages WHERE brain_id = ?1 AND path = ?2`).bind(brainId, path),
			db.prepare(`DELETE FROM brain_links WHERE brain_id = ?1 AND source = ?2`).bind(brainId, path),
			db
				.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?1 AND path = ?2`)
				.bind(brainId, path)
		);
	}
	if (changed.length) {
		const { pages } = await store.fetchPages(repo, changed);
		const shaByPath = new Map(changed.map((e) => [e.path, e.sha]));
		for (const p of pages) {
			stmts.push(
				...pageUpsert(db, brainId, p.path, p.content, shaByPath.get(p.path) ?? '', config)
			);
		}
	}
	await runBatched(db, stmts);
	return complete;
}

// A git blob's object id for content we already hold, so write-through can store
// the SAME sha a tree walk reports — blob shas are what incrementalReindex diffs
// against, and a wrong one would merely cost a harmless refetch later. Worker-safe:
// Web Crypto SHA-1, no node:crypto.
async function gitBlobSha(content: string): Promise<string> {
	const body = new TextEncoder().encode(content);
	const header = new TextEncoder().encode(`blob ${body.byteLength}\0`);
	const buf = new Uint8Array(header.byteLength + body.byteLength);
	buf.set(header, 0);
	buf.set(body, header.byteLength);
	const digest = await crypto.subtle.digest('SHA-1', buf);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// Write-through: fold one of our own commits into the index instead of leaving the
// next read to reconcile it. The caller holds the revision the write was based on,
// the one it landed, and the exact content of every page the bundle touched, so this
// upserts those rows and advances indexed_commit_sha. The read an agent makes to
// verify a write then costs one getRef instead of an incremental reindex — which is
// also what used to make the FIRST read after a write the slow one (issue #31).
//
// Only when provably safe: the index must already be CURRENT at the write's base
// revision (otherwise other pages changed under us and the next read reconciles as
// usual) and not mid schema-rebuild. Never applies on the PR path — the caller only
// receives a commitSha for a direct commit. Returns whether the index advanced.
// Fail-open by contract: the commit has landed regardless, and callers swallow
// errors; a missed write-through only costs one reconcile.
export async function writeThroughIndex(
	db: D1Database,
	brainId: string,
	config: BrainConfig,
	baseSha: string,
	landedSha: string,
	writes: { path: string; content: string; encoding?: string }[],
	deletes: string[]
): Promise<boolean> {
	const meta = await db
		.prepare(
			`SELECT indexed_commit_sha, schema_version, rebuild_cursor
			 FROM brain_index_meta WHERE brain_id = ?1`
		)
		.bind(brainId)
		.first<{
			indexed_commit_sha: string | null;
			schema_version: number;
			rebuild_cursor: string | null;
		}>();
	if (!meta || meta.indexed_commit_sha !== baseSha) return false;
	if (meta.schema_version !== INDEX_SCHEMA_VERSION || meta.rebuild_cursor) return false;

	// Only content pages are indexed rows; the log, config, ledgers and attachments
	// in the same bundle are invisible to the index, so they need no rows — the sha
	// still advances past them.
	const isPage = (p: string) => p.endsWith('.md') && isContentPath(p, config);
	const stmts: D1PreparedStatement[] = [];
	for (const w of writes) {
		if (!isPage(w.path) || w.encoding === 'base64') continue;
		const blobSha = await gitBlobSha(w.content);
		// Every mutation carries the same generation guard. D1 executes one batch as
		// one transaction, so a concurrent reconcile/write either leaves this base
		// current and the whole replacement lands, or makes every statement a no-op.
		stmts.push(
			db
				.prepare(
					`INSERT OR REPLACE INTO brain_pages (brain_id, path, title, blob_sha, content)
					 SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
					   SELECT 1 FROM brain_index_meta
					   WHERE brain_id = ?1 AND indexed_commit_sha = ?6
					     AND schema_version = ?7 AND rebuild_cursor IS NULL
					 )`
				)
				.bind(
					brainId,
					w.path,
					pageTitle(w.path, w.content),
					blobSha,
					w.content,
					baseSha,
					INDEX_SCHEMA_VERSION
				),
			db
				.prepare(
					`DELETE FROM brain_links WHERE brain_id = ?1 AND source = ?2 AND EXISTS (
					   SELECT 1 FROM brain_index_meta
					   WHERE brain_id = ?1 AND indexed_commit_sha = ?3
					     AND schema_version = ?4 AND rebuild_cursor IS NULL
					 )`
				)
				.bind(brainId, w.path, baseSha, INDEX_SCHEMA_VERSION),
			db
				.prepare(
					`DELETE FROM brain_page_fields WHERE brain_id = ?1 AND path = ?2 AND EXISTS (
					   SELECT 1 FROM brain_index_meta
					   WHERE brain_id = ?1 AND indexed_commit_sha = ?3
					     AND schema_version = ?4 AND rebuild_cursor IS NULL
					 )`
				)
				.bind(brainId, w.path, baseSha, INDEX_SCHEMA_VERSION)
		);
		for (const l of parseLinks(w.content)) {
			stmts.push(
				db
					.prepare(
						`INSERT OR REPLACE INTO brain_links (brain_id, source, raw_target, kind, cnt)
						 SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
						   SELECT 1 FROM brain_index_meta
						   WHERE brain_id = ?1 AND indexed_commit_sha = ?6
						     AND schema_version = ?7 AND rebuild_cursor IS NULL
						 )`
					)
					.bind(brainId, w.path, l.rawTarget, l.kind, l.cnt, baseSha, INDEX_SCHEMA_VERSION)
			);
		}
		for (const f of fieldRowsOf(w.content, config)) {
			stmts.push(
				db
					.prepare(
						`INSERT OR REPLACE INTO brain_page_fields (brain_id, path, key, value, value_num)
						 SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
						   SELECT 1 FROM brain_index_meta
						   WHERE brain_id = ?1 AND indexed_commit_sha = ?6
						     AND schema_version = ?7 AND rebuild_cursor IS NULL
						 )`
					)
					.bind(brainId, w.path, f.key, f.value, f.num, baseSha, INDEX_SCHEMA_VERSION)
			);
		}
	}
	for (const p of deletes) {
		if (!isPage(p)) continue;
		stmts.push(
			db
				.prepare(
					`DELETE FROM brain_pages WHERE brain_id = ?1 AND path = ?2 AND EXISTS (
					   SELECT 1 FROM brain_index_meta
					   WHERE brain_id = ?1 AND indexed_commit_sha = ?3
					     AND schema_version = ?4 AND rebuild_cursor IS NULL
					 )`
				)
				.bind(brainId, p, baseSha, INDEX_SCHEMA_VERSION),
			db
				.prepare(
					`DELETE FROM brain_links WHERE brain_id = ?1 AND source = ?2 AND EXISTS (
					   SELECT 1 FROM brain_index_meta
					   WHERE brain_id = ?1 AND indexed_commit_sha = ?3
					     AND schema_version = ?4 AND rebuild_cursor IS NULL
					 )`
				)
				.bind(brainId, p, baseSha, INDEX_SCHEMA_VERSION),
			db
				.prepare(
					`DELETE FROM brain_page_fields WHERE brain_id = ?1 AND path = ?2 AND EXISTS (
					   SELECT 1 FROM brain_index_meta
					   WHERE brain_id = ?1 AND indexed_commit_sha = ?3
					     AND schema_version = ?4 AND rebuild_cursor IS NULL
					 )`
				)
				.bind(brainId, p, baseSha, INDEX_SCHEMA_VERSION)
		);
	}
	stmts.push(
		db
			.prepare(
				`UPDATE brain_index_meta
				 SET indexed_commit_sha = ?2,
				     truncated = CASE WHEN (
				       SELECT COUNT(*) FROM brain_pages WHERE brain_id = ?1
				     ) > ?3 THEN 1 ELSE 0 END,
				     updated_at = ?4
				 WHERE brain_id = ?1 AND indexed_commit_sha = ?5
				   AND schema_version = ?6 AND rebuild_cursor IS NULL`
			)
			.bind(brainId, landedSha, MAX_SCAN_PAGES, Date.now(), baseSha, INDEX_SCHEMA_VERSION)
	);

	// A single D1 batch is one transaction. Never split write-through across
	// transactions: a partial page replacement whose blob sha already advanced can
	// look unchanged to incremental reconciliation. Oversized bundles simply retain
	// the old behavior and reconcile on the next read.
	if (stmts.length > BATCH_CHUNK) return false;
	const results = await db.batch(stmts);
	const final = results[results.length - 1] as { meta?: { changes?: number } } | undefined;
	return (final?.meta?.changes ?? 0) > 0;
}

// Mark a brain's index stale so the next read forces a reconcile against HEAD.
// (No-op in the always-check design — HEAD is compared every read — but exposed so
// a future sha-check TTL cache / write-through path can invalidate explicitly.)
export async function invalidateIndex(db: D1Database, brainId: string): Promise<void> {
	await db
		.prepare(`UPDATE brain_index_meta SET indexed_commit_sha = NULL WHERE brain_id = ?1`)
		.bind(brainId)
		.run();
}

// Drop a brain's index entirely so the next ensureFresh does a FULL rebuild. Needed
// when the CONTENT SHAPE changes (e.g. .isomorphic.json contentRoots edited): the
// content blobs are unchanged, so an incremental (sha-diff) reindex wouldn't pick up
// pages that just became in-scope. Deleting the meta row makes ensureFresh take the
// !meta → fullBuild path, which re-walks the tree against the new config.
export async function resetIndex(db: D1Database, brainId: string): Promise<void> {
	await db.batch([
		db.prepare(`DELETE FROM brain_index_meta WHERE brain_id = ?1`).bind(brainId),
		db.prepare(`DELETE FROM brain_pages WHERE brain_id = ?1`).bind(brainId),
		db.prepare(`DELETE FROM brain_links WHERE brain_id = ?1`).bind(brainId),
		db.prepare(`DELETE FROM brain_page_fields WHERE brain_id = ?1`).bind(brainId)
	]);
}

// Does this repo look like it was adopted but never told where its content lives?
// True when there's NO .isomorphic.json and markdown exists but none of it falls under
// the (default) content roots — the "connected but shows no pages" trap. Fetches the
// tree, so callers gate it on "the page list came back empty" to avoid the cost.
export async function detectNeedsConfig(
	store: BrainStore,
	repo: RepoRef,
	config: BrainConfig
): Promise<boolean> {
	const head = await store.getHead(repo, config.defaultBranch);
	const tree = await store.listTree(repo, head);
	if (tree.some((e) => e.path === CONFIG_PATH)) return false; // author configured it explicitly
	const md = tree.filter((e) => e.path.endsWith('.md'));
	if (md.length === 0) return false; // genuinely empty repo, not a misconfig
	return !md.some((e) => isContentPath(e.path, config)); // md exists, but none is in-scope
}

// ---------- queries (call ensureFresh first) ----------

export interface ResolvedEdge {
	source: string;
	target: string;
	kind: 'md' | 'wiki';
	cnt: number;
}
export interface BrokenLink {
	source: string;
	rawTarget: string;
	kind: 'md' | 'wiki';
	target?: string; // md only: where the (missing) link resolved to
}
export interface ResolvedGraph {
	pages: { path: string; title: string }[];
	edges: ResolvedEdge[]; // links between two known pages (directed, with counts)
	// Links from a page to a non-page FILE under content (an image, a PDF, a CSV).
	// Kept apart from `edges` rather than merged into them, because the graph view
	// builds its nodes from `pages` alone and computes degree from `edges`: one of
	// these in that list would reference a node the renderer has no data for.
	// Backlink queries read both.
	fileEdges: ResolvedEdge[];
	broken: BrokenLink[]; // links that resolve to no page (powers validate)
}

// Pull the brain's pages + raw links and resolve every link against the current
// page set — markdown links via resolveRelative, [[wikilinks]] by path/filename/title,
// exactly as the live scan did. Two D1 queries, then in-memory resolution; no
// GitHub content fetch. This is the shared primitive behind graph / backlinks /
// validate.
export async function loadResolvedGraph(
	db: D1Database,
	brainId: string,
	config: BrainConfig
): Promise<ResolvedGraph> {
	const pagesRes = await db
		.prepare(`SELECT path, title FROM brain_pages WHERE brain_id = ?1`)
		.bind(brainId)
		.all<{ path: string; title: string | null }>();
	const linksRes = await db
		.prepare(`SELECT source, raw_target, kind, cnt FROM brain_links WHERE brain_id = ?1`)
		.bind(brainId)
		.all<{ source: string; raw_target: string; kind: string; cnt: number }>();

	const pages = pagesRes.results.map((r) => ({ path: r.path, title: r.title ?? deslug(r.path) }));
	const pathSet = new Set(pages.map((p) => p.path));
	const wikiIndex = buildWikilinkIndex(pages);

	const edges: ResolvedEdge[] = [];
	const fileEdges: ResolvedEdge[] = [];
	const broken: BrokenLink[] = [];
	for (const l of linksRes.results) {
		const kind = l.kind === 'wiki' ? 'wiki' : 'md';
		if (kind === 'md') {
			// The rule itself lives in links.ts, pure, so the dev harness resolves links
			// exactly the way this does. It used to be inlined here, which meant nothing
			// outside D1 could reuse it and the harness carried a divergent copy.
			const c = classifyMdLink(l.source, l.raw_target, config, (p) => pathSet.has(p));
			const target = c.target!;
			if (c.kind === 'page') edges.push({ source: l.source, target, kind, cnt: l.cnt });
			// Non-page files are recorded but kept out of `edges`: MD_LINK_RE always
			// captured `![](…)`, so these were in brain_links all along and were simply
			// dropped, which is why backlinksTo used to report an image as referenced by
			// nobody. move_page repoints them and delete_page warns about them.
			else if (c.kind === 'file') fileEdges.push({ source: l.source, target, kind, cnt: l.cnt });
			else if (c.kind === 'broken')
				broken.push({ source: l.source, rawTarget: l.raw_target, kind, target });
		} else {
			// [[#Section]] is an anchor within the linking page — nothing to resolve,
			// and not a broken link either.
			if (!wikilinkKey(wikilinkTargetName(l.raw_target))) continue;
			const target = resolveWikilink(wikiIndex, l.raw_target);
			if (target) edges.push({ source: l.source, target, kind, cnt: l.cnt });
			else broken.push({ source: l.source, rawTarget: l.raw_target, kind });
		}
	}
	return { pages, edges, fileEdges, broken };
}

// The brain's content pages with display titles, straight from the index (no link
// resolution). Backs list_pages / browse_brain so the file tree can show titles.
// Call ensureFresh first so the list reflects the current repo.
export async function listIndexedPages(
	db: D1Database,
	brainId: string
): Promise<{ path: string; title: string }[]> {
	const res = await db
		.prepare(`SELECT path, title FROM brain_pages WHERE brain_id = ?1 ORDER BY path`)
		.bind(brainId)
		.all<{ path: string; title: string | null }>();
	return res.results.map((r) => ({ path: r.path, title: r.title ?? deslug(r.path) }));
}

// Backlinks to one page: which pages link in, and how (md vs wiki counts). Mirrors
// findReferences() in the old live path.
// `count` is the total, and is what callers should use — the md/wiki split is kept
// only for surfaces that report the two syntaxes separately to a human. Two link
// syntaxes are an authoring convenience; downstream, a link is a link, and making
// every consumer remember to add both is how one of them ends up under-counting.
export function backlinksTo(
	resolved: ResolvedGraph,
	targetPath: string
): { path: string; title: string; count: number; mdCount: number; wikiCount: number }[] {
	const titleByPath = new Map(resolved.pages.map((p) => [p.path, p.title]));
	const agg = new Map<string, { mdCount: number; wikiCount: number }>();
	// Both lists: an asset path can never collide with a page path (one ends in .md,
	// the other cannot), so scanning both is unambiguous and spares every caller from
	// having to know whether it is asking about a page or a picture.
	for (const e of [...resolved.edges, ...resolved.fileEdges]) {
		if (e.target !== targetPath || e.source === targetPath) continue;
		const a = agg.get(e.source) ?? { mdCount: 0, wikiCount: 0 };
		if (e.kind === 'md') a.mdCount += e.cnt;
		else a.wikiCount += e.cnt;
		agg.set(e.source, a);
	}
	return [...agg.entries()].map(([path, c]) => ({
		path,
		title: titleByPath.get(path) ?? path,
		count: c.mdCount + c.wikiCount,
		mdCount: c.mdCount,
		wikiCount: c.wikiCount
	}));
}

// A page's indexed frontmatter: key → values (list fields have several). Loaded
// for a bounded set of candidate paths (e.g. the backlinks of one page) with
// chunked IN queries, so cost tracks the candidate count, not brain size.
export type PageFields = Map<string, string[]>;

// Every page's fields for a brain in ONE statement — for views whose candidate
// set is the whole brain (kind: pages / directory indexes), where per-path IN
// chunks would degenerate into dozens of queries. Row count is bounded by the
// per-page caps (≤ pages × 24 keys), fine to hold in memory.
export async function loadAllFields(
	db: D1Database,
	brainId: string
): Promise<Map<string, PageFields>> {
	const rows = await db
		.prepare(`SELECT path, key, value FROM brain_page_fields WHERE brain_id = ?1`)
		.bind(brainId)
		.all<{ path: string; key: string; value: string }>();
	const byPath = new Map<string, PageFields>();
	for (const r of rows.results) {
		const fields = byPath.get(r.path) ?? new Map<string, string[]>();
		fields.set(r.key, [...(fields.get(r.key) ?? []), r.value]);
		byPath.set(r.path, fields);
	}
	return byPath;
}

export async function loadFieldsFor(
	db: D1Database,
	brainId: string,
	paths: string[]
): Promise<Map<string, PageFields>> {
	const byPath = new Map<string, PageFields>();
	const CHUNK = 50; // bound per-statement bind params (D1 caps ~100)
	for (let i = 0; i < paths.length; i += CHUNK) {
		const chunk = paths.slice(i, i + CHUNK);
		const placeholders = chunk.map((_, j) => `?${j + 2}`).join(', ');
		const rows = await db
			.prepare(
				`SELECT path, key, value FROM brain_page_fields
				 WHERE brain_id = ?1 AND path IN (${placeholders})`
			)
			.bind(brainId, ...chunk)
			.all<{ path: string; key: string; value: string }>();
		for (const r of rows.results) {
			const fields = byPath.get(r.path) ?? new Map<string, string[]>();
			fields.set(r.key, [...(fields.get(r.key) ?? []), r.value]);
			byPath.set(r.path, fields);
		}
	}
	return byPath;
}

// Indexed content for a BOUNDED set of paths, straight from the index (no GitHub
// fetch). Chunked like loadFieldsFor so cost tracks the candidate count. Callers
// must keep that set small — validate passes only the brain's folder notes (one
// per folder), never the whole page list, since `content` is the full file text.
export async function loadPageContents(
	db: D1Database,
	brainId: string,
	paths: string[]
): Promise<Map<string, string>> {
	const byPath = new Map<string, string>();
	const CHUNK = 50; // bound per-statement bind params (D1 caps ~100)
	for (let i = 0; i < paths.length; i += CHUNK) {
		const chunk = paths.slice(i, i + CHUNK);
		const placeholders = chunk.map((_, j) => `?${j + 2}`).join(', ');
		const rows = await db
			.prepare(
				`SELECT path, content FROM brain_pages
				 WHERE brain_id = ?1 AND path IN (${placeholders})`
			)
			.bind(brainId, ...chunk)
			.all<{ path: string; content: string }>();
		for (const r of rows.results) byPath.set(r.path, r.content);
	}
	return byPath;
}

// Pages whose content is fetched so their matching lines can be extracted. This is a
// memory bound, not a relevance one: the previous engine selected `content` for every
// matching row, so a common term on a large brain pulled the whole brain into the
// isolate and then discarded all but the first 50 lines of it. Ranking happens on the
// cheap signal rows first, so what survives this cut is the best of the brain rather
// than the alphabetically earliest of it.
const MAX_SEARCH_CANDIDATES = 25;

// Full-text search over indexed page content, in two phases.
//
// Phase 1 asks SQL only what is cheap to ask: for each page, does it contain each
// query term, and does it contain the whole query verbatim. Those rows are path,
// title and a handful of booleans, so the answer stays small however large the brain.
// Phase 2 fetches content for the top-ranked candidates and extracts their lines.
//
// SQL narrows; it never orders. Every decision about what ranks above what, and what
// gets dropped, lives in the pure src/lib/search.ts so it can be tested without a
// database — see docs/design/search-relevance.md.
export async function searchIndex(
	db: D1Database,
	brainId: string,
	query: string,
	prefix: string | undefined,
	max: number,
	perPage: number = DEFAULT_SEARCH_OPTIONS.perPage
): Promise<SearchResult> {
	const q = tokenizeQuery(query);
	const empty: SearchResult = {
		hits: [],
		terms: q.terms,
		pagesMatched: 0,
		pagesShown: 0,
		linesElided: 0,
		budgetHit: false
	};
	if (q.terms.length === 0) return empty;

	// One bound parameter per term, reused between the SELECT list and the WHERE, so a
	// term is escaped exactly once. escapeLike keeps a query's own % or _ literal.
	const binds: unknown[] = [brainId];
	const selects: string[] = [];
	const conds: string[] = [];
	for (const term of q.terms) {
		binds.push(`%${escapeLike(term)}%`);
		const p = `?${binds.length}`;
		selects.push(`(content LIKE ${p} ESCAPE '\\') AS t${selects.length}`);
		conds.push(`content LIKE ${p} ESCAPE '\\'`);
	}
	binds.push(`%${escapeLike(q.phrase)}%`);
	selects.push(`(content LIKE ?${binds.length} ESCAPE '\\') AS ph`);

	// OR, not AND: a page holding some of the terms is a worse match, not a non-match,
	// and the scorer is what decides how much worse. ANDing here would reintroduce the
	// defect this replaces — an empty result for a query the brain can nearly answer.
	let where = `brain_id = ?1 AND (${conds.join(' OR ')})`;
	if (prefix) {
		binds.push(`${escapeLike(prefix)}%`);
		where += ` AND path LIKE ?${binds.length} ESCAPE '\\'`;
	}

	const rows = await db
		.prepare(`SELECT path, title, ${selects.join(', ')} FROM brain_pages WHERE ${where}`)
		.bind(...binds)
		.all<Record<string, string | number | null>>();

	const signals: PageSignal[] = rows.results.map((r) => ({
		path: String(r.path),
		title: r.title == null ? null : String(r.title),
		has: q.terms.map((_, i) => Number(r[`t${i}`]) === 1),
		phrase: Number(r.ph) === 1
	}));
	if (signals.length === 0) return empty;

	const chosen = rankPages(signals, q.terms).slice(0, MAX_SEARCH_CANDIDATES);
	const contents = await loadPageContents(
		db,
		brainId,
		chosen.map((s) => s.path)
	);
	const pages = chosen.map((s) => ({
		path: s.path,
		title: s.title,
		content: contents.get(s.path) ?? ''
	}));
	// Ranking runs again over the fetched pages, where term FREQUENCY is finally
	// known. It only refines the phase-1 order (frequency is one saturating term of a
	// score coverage dominates), so a page cannot leapfrog a strictly better match.
	return searchCorpus(pages, query, { max, perPage }, signals.length - chosen.length);
}

// Escape LIKE wildcards so a query containing % or _ is matched literally.
// Exported so pnpm test:search can pin it. It has to be tested directly, because it is
// invisible from the outside: searchCorpus re-verifies every candidate against the page
// content it fetched, so an unescaped `%` that made phase 1 match the whole brain would
// still produce the right hits — just after scanning and fetching far more than it had
// any reason to. The escaping bounds the WORK; the re-verification is what guarantees
// the answer.
export function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
