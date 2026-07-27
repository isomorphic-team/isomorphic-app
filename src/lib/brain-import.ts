// Non-destructive bulk import (FR-3, derived-views PRD Phase 3) — the PLANNER.
//
// An external source (spreadsheet, CRM export) feeds a brain by upsert-by-key,
// never by rebuild. The invariants, in priority order:
//
//   1. HUMAN EDITS ARE SACRED. The importer only ever writes frontmatter keys the
//      call declares as source-owned; body prose is written at CREATE time only.
//      Pages, fields, and links humans added are never touched.
//   2. DELETIONS ARE PROPOSED, NEVER AUTOMATIC. A key absent from the source
//      manifest yields a proposal in the report, not a delete.
//   3. NO RESURRECTION. A key we imported before whose page is now gone was
//      removed by a human (e.g. a duplicate-org consolidation) — re-importing it
//      is a QUESTION (needsDecision), not a create. The ledger of ever-imported
//      keys is what tells "new to the brain" apart from "deliberately removed".
//   4. IDEMPOTENT. An unchanged record produces no write; an unchanged run
//      produces an empty plan (and the caller skips the commit entirely).
//
// Identity/dedup is the SOURCE's responsibility (resolved 2026-07-22): records
// arrive already keyed. A page is bound to its key via `source_key` frontmatter
// (written at create); curators can alias additional keys onto a page with a
// `source_keys` list (how a consolidation claims the duplicate's key). Both are
// ordinary frontmatter — so key→page discovery is one indexed D1 query via
// brain_page_fields — but the DIFF runs against authoritative page blobs, never
// index values (the index caps value lengths; it discovers, it doesn't decide).
//
// This module is pure (no octokit, no D1): plan(input) → ImportPlan. The tool
// (src/tools/importer.ts) gathers inputs and turns the plan into one commitOrPR
// bundle. Worker-safe (no node:*).

import {
	type Frontmatter,
	type FrontmatterValue,
	isFrontmatterBlock,
	listOf,
	parseFrontmatter,
	withFrontmatter,
	todayIso
} from './wiki.ts';

// The frontmatter keys that bind pages to import keys.
export const SOURCE_KEY_FIELD = 'source_key';
export const SOURCE_KEYS_FIELD = 'source_keys';

// Where a source's ledger lives in the repo. The ledger is importer-owned state
// that must survive across runs AND travel with the brain (repo = source of
// truth, and PR-mode brains get to review it like any other change).
export function ledgerPath(source: string): string {
	return `.isomorphic/imports/${source}.json`;
}

export interface ImportRecord {
	// Stable identity from the source (email, canonical name, row id…).
	key: string;
	// Where to create the page on first import. The SOURCE decides layout —
	// brains have arbitrary structure. Required for creates; ignored for updates
	// (the page may have been moved, and its current path wins).
	path?: string;
	// Frontmatter facts. Only keys listed in sourceOwned are ever written.
	fields: Record<string, string | string[]>;
	// Initial body markdown. Used at CREATE only — bodies belong to humans after.
	body?: string;
}

// A question the last sync left unanswered — persisted in the ledger so it
// stays visible (validate surfaces these) without a sync run in hand. State,
// not notification: syncs refresh it, resolve_import clears it.
export interface PendingQuestion {
	key: string;
	kind: 'needs-decision' | 'proposed-deletion';
	path?: string; // proposed-deletion: the page in question
	reason: string;
}

export interface ImportLedger {
	version: 1;
	// Every key this source has ever successfully imported.
	imported: string[];
	// Keys a human decided should never import again ("skip that row").
	suppressed: string[];
	// Open questions from the most recent syncs (see PendingQuestion).
	pending: PendingQuestion[];
}

export const EMPTY_LEDGER: ImportLedger = {
	version: 1,
	imported: [],
	suppressed: [],
	pending: []
};

export function parseLedger(content: string | null): ImportLedger {
	if (!content) return EMPTY_LEDGER;
	try {
		const raw = JSON.parse(content) as Partial<ImportLedger>;
		return {
			version: 1,
			imported: Array.isArray(raw.imported)
				? raw.imported.filter((k): k is string => typeof k === 'string')
				: [],
			suppressed: Array.isArray(raw.suppressed)
				? raw.suppressed.filter((k): k is string => typeof k === 'string')
				: [],
			// Absent on ledgers written before pending existed — default empty.
			pending: Array.isArray(raw.pending)
				? (raw.pending as PendingQuestion[]).filter(
						(q) =>
							q &&
							typeof q.key === 'string' &&
							(q.kind === 'needs-decision' || q.kind === 'proposed-deletion') &&
							typeof q.reason === 'string'
					)
				: []
		};
	} catch {
		// A corrupt ledger must not brick imports — but silently treating every
		// previously-imported key as new WOULD resurrect deletions, so the caller
		// is told (planner input stays honest: fail the run, don't guess).
		throw new Error('import ledger is not valid JSON');
	}
}

export function serializeLedger(l: ImportLedger): string {
	// Sorted throughout so identical STATE is identical BYTES — the tools compare
	// serializations to decide whether the ledger needs a commit at all.
	const pending = [...l.pending].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)
	);
	return `${JSON.stringify(
		{
			version: 1,
			imported: [...l.imported].sort(),
			suppressed: [...l.suppressed].sort(),
			pending
		},
		null,
		'\t'
	)}\n`;
}

// A brain page that claims one or more import keys, with its AUTHORITATIVE
// content (fetched blob, not index rows).
export interface ClaimedPage {
	path: string;
	keys: string[]; // source_key + source_keys values
	content: string;
}

export interface PlanInput {
	records: ImportRecord[];
	// The COMPLETE key set of the source, when provided. Enables deletion
	// proposals; omit on mid-chunk calls and absence detection is skipped.
	manifest?: string[];
	// Frontmatter keys the source owns (the only keys the importer may write).
	sourceOwned: string[];
	// Pages claiming any key touched by this call (records + manifest scan).
	claimed: ClaimedPage[];
	ledger: ImportLedger;
	// Every existing content path in the brain. The clobber guard: a create
	// aimed at an existing page is an ERROR, never a silent overwrite.
	existingPaths?: Set<string>;
	// Adoption (the "bind an existing brain" path, e.g. an ETL-seeded contacts brain's ~3,900
	// ETL-built pages that predate source keys): authoritative content of
	// EXISTING, UNCLAIMED pages this call may bind. Only populated when the
	// caller opted in (adopt_existing) — a record whose path matches gets its
	// source-owned fields merged and the key bound, body untouched.
	adoptable?: Map<string, string>;
	// Injected clock (Date.now is banned in some runtimes; todayIso by default).
	today?: string;
}

export interface PlannedWrite {
	key: string;
	path: string;
	content: string;
	// adopt: an existing unclaimed page gained this key's binding (+ field merge).
	kind: 'create' | 'update' | 'adopt';
	changedFields: string[]; // update/adopt: which source-owned keys moved
}

export interface ImportPlan {
	writes: PlannedWrite[];
	unchanged: string[]; // keys matched, nothing to do
	suppressed: string[]; // keys skipped by human decision
	// Previously imported, page gone, record still in source → human question.
	needsDecision: { key: string; reason: string }[];
	// Page exists, key absent from the manifest → proposed (never automatic).
	proposedDeletions: { key: string; path: string }[];
	errors: { key: string; error: string }[];
	ledgerAfter: ImportLedger;
}

const norm = (v: string | string[] | undefined): string[] =>
	v === undefined ? [] : Array.isArray(v) ? v.map((s) => s.trim()) : [v.trim()];

const sameValue = (a: FrontmatterValue | undefined, b: string | string[] | undefined): boolean => {
	// A nested block is opaque, so it can never be shown equal to a flat source
	// value. Reporting "different" makes the source-owned key get written, which is
	// the right call for a field the source owns by declaration.
	if (isFrontmatterBlock(a)) return false;
	const na = norm(a);
	const nb = norm(b);
	return na.length === nb.length && na.every((v, i) => v === nb[i]);
};

// Merge source-owned fields into existing frontmatter. Returns null when
// nothing source-owned actually changed (idempotency).
function mergeFields(
	existing: Frontmatter,
	record: ImportRecord,
	sourceOwned: string[]
): { fm: Frontmatter; changed: string[] } | null {
	const changed: string[] = [];
	const fm: Frontmatter = { ...existing };
	for (const key of sourceOwned) {
		if (!(key in record.fields)) continue; // source didn't send it — leave alone
		if (sameValue(existing[key], record.fields[key])) continue;
		fm[key] = record.fields[key];
		changed.push(key);
	}
	return changed.length ? { fm, changed } : null;
}

function createContent(record: ImportRecord, today: string): string {
	const fm: Frontmatter = {
		// Source fields first (title included when the source sends one) …
		...record.fields,
		// … then the bindings the importer owns.
		[SOURCE_KEY_FIELD]: record.key,
		updated: today
	};
	return withFrontmatter(fm, record.body ?? '');
}

export function plan(input: PlanInput): ImportPlan {
	const today = input.today ?? todayIso();
	const suppressedSet = new Set(input.ledger.suppressed);
	const importedSet = new Set(input.ledger.imported);
	const pageByKey = new Map<string, ClaimedPage>();
	const claimedPaths = new Set<string>();
	for (const p of input.claimed) {
		claimedPaths.add(p.path);
		for (const k of p.keys) pageByKey.set(k, p);
	}

	const out: ImportPlan = {
		writes: [],
		unchanged: [],
		suppressed: [],
		needsDecision: [],
		proposedDeletions: [],
		errors: [],
		ledgerAfter: {
			version: 1,
			imported: [...input.ledger.imported],
			suppressed: [...input.ledger.suppressed],
			pending: [] // rebuilt below from prior state + this run's questions
		}
	};
	const seen = new Set<string>();

	for (const record of input.records) {
		const key = record.key.trim();
		if (!key) {
			out.errors.push({ key: record.key, error: 'record has an empty key' });
			continue;
		}
		if (seen.has(key)) {
			out.errors.push({ key, error: 'duplicate key in this batch' });
			continue;
		}
		seen.add(key);
		if (suppressedSet.has(key)) {
			out.suppressed.push(key);
			continue;
		}

		const page = pageByKey.get(key);
		if (page) {
			const { frontmatter } = parseFrontmatter(page.content);
			const merged = mergeFields(frontmatter ?? {}, record, input.sourceOwned);
			if (!merged) {
				out.unchanged.push(key);
			} else {
				const { body } = parseFrontmatter(page.content);
				out.writes.push({
					key,
					path: page.path,
					kind: 'update',
					changedFields: merged.changed,
					content: withFrontmatter({ ...merged.fm, updated: today }, body)
				});
			}
			if (!importedSet.has(key)) out.ledgerAfter.imported.push(key); // adopt (e.g. alias added by hand)
			continue;
		}

		// No page claims this key.
		if (importedSet.has(key)) {
			// We imported it before and a human removed it — never resurrect.
			out.needsDecision.push({
				key,
				reason:
					'previously imported but its page was removed (e.g. a consolidation) — alias the key onto the surviving page (source_keys), suppress it, or re-create deliberately'
			});
			continue;
		}
		if (!record.path || !record.path.trim().endsWith('.md')) {
			out.errors.push({ key, error: 'new record needs a "path" ending in .md' });
			continue;
		}
		const path = record.path.trim().replace(/^\/+/, '');
		if (claimedPaths.has(path)) {
			out.errors.push({
				key,
				error: `the page at "${path}" is bound to a DIFFERENT source key — pick another path, or resolve the identity with resolve_import`
			});
			continue;
		}
		const adoptContent = input.adoptable?.get(path);
		if (adoptContent !== undefined) {
			// Bind an existing, unclaimed page: merge source-owned fields, add the
			// key binding, leave the body exactly as the humans wrote it.
			const { frontmatter, body } = parseFrontmatter(adoptContent);
			const merged = mergeFields(frontmatter ?? {}, record, input.sourceOwned);
			const fm: Frontmatter = {
				...(merged ? merged.fm : (frontmatter ?? {})),
				[SOURCE_KEY_FIELD]: key,
				updated: today
			};
			out.writes.push({
				key,
				path,
				kind: 'adopt',
				changedFields: [...(merged?.changed ?? []), SOURCE_KEY_FIELD],
				content: withFrontmatter(fm, body)
			});
			out.ledgerAfter.imported.push(key);
			continue;
		}
		if (input.existingPaths?.has(path)) {
			// The clobber guard: never silently overwrite a page the source has no
			// claim on. (such a brain's initial bind runs with adopt_existing instead.)
			out.errors.push({
				key,
				error: `a page already exists at "${path}" but doesn't claim this key — re-run with adopt_existing: true to bind it, or alias the key via resolve_import`
			});
			continue;
		}
		out.writes.push({
			key,
			path,
			kind: 'create',
			changedFields: Object.keys(record.fields),
			content: createContent(record, today)
		});
		out.ledgerAfter.imported.push(key);
	}

	// Absence detection — only when the caller sent the complete manifest.
	if (input.manifest) {
		const manifestSet = new Set(input.manifest);
		for (const p of input.claimed) {
			for (const k of p.keys) {
				// Only keys THIS source imported are its business to propose about.
				if (!importedSet.has(k)) continue;
				if (!manifestSet.has(k)) out.proposedDeletions.push({ key: k, path: p.path });
			}
		}
	}

	// Persist this run's open questions into the ledger, merged CHUNK-SAFELY:
	// a call only speaks for the record keys it saw (its needs-decision verdicts
	// replace prior ones for those keys), and only a manifest-carrying call has
	// the global knowledge to replace the absence proposals wholesale.
	const carried = input.ledger.pending.filter((q) => {
		if (q.kind === 'needs-decision') return !seen.has(q.key);
		return !input.manifest; // proposed-deletion: manifest call recomputes all
	});
	out.ledgerAfter.pending = [
		...carried,
		...out.needsDecision.map((d) => ({
			key: d.key,
			kind: 'needs-decision' as const,
			reason: d.reason
		})),
		...out.proposedDeletions.map((d) => ({
			key: d.key,
			kind: 'proposed-deletion' as const,
			path: d.path,
			reason: 'no longer in the source'
		}))
	];

	return out;
}

// ---------- decisions (resolve_import) ----------
//
// The human answers to a sync's questions (needsDecision / proposedDeletions),
// applied durably so the next import doesn't re-ask:
//   suppress — never import this key again (ledger).
//   delete   — remove the page a proposed-deletion pointed at. The key STAYS in
//              the ledger: if the source ever re-adds it, that's a needsDecision
//              (pair with suppress for "gone for good").
//   alias    — bind the key onto a surviving page's source_keys (how a
//              consolidation claims its duplicate's identity).
//   recreate — forget the key so the next sync auto-creates it (the deliberate
//              undo of a deletion).

export type ImportDecision =
	| { key: string; action: 'suppress' }
	| { key: string; action: 'delete' }
	| { key: string; action: 'alias'; alias_to: string }
	| { key: string; action: 'recreate' };

export interface DecisionsInput {
	decisions: ImportDecision[];
	// Pages relevant to the decisions: any page claiming a decided key, plus the
	// alias_to targets — with authoritative content (alias rewrites frontmatter).
	claimed: ClaimedPage[];
	ledger: ImportLedger;
	today?: string;
}

export interface DecisionsPlan {
	writes: { path: string; content: string }[]; // alias frontmatter rewrites
	deletes: string[]; // paths to remove
	applied: { key: string; action: ImportDecision['action']; detail: string }[];
	errors: { key: string; error: string }[];
	ledgerAfter: ImportLedger;
}

export function planDecisions(input: DecisionsInput): DecisionsPlan {
	const today = input.today ?? todayIso();
	const pageByKey = new Map<string, ClaimedPage>();
	const pageByPath = new Map<string, ClaimedPage>();
	for (const p of input.claimed) {
		pageByPath.set(p.path, p);
		for (const k of p.keys) pageByKey.set(k, p);
	}
	const out: DecisionsPlan = {
		writes: [],
		deletes: [],
		applied: [],
		errors: [],
		ledgerAfter: {
			version: 1,
			imported: [...input.ledger.imported],
			suppressed: [...input.ledger.suppressed],
			pending: [...input.ledger.pending]
		}
	};
	// Alias rewrites accumulate per page (several keys may land on one page).
	const aliasAdds = new Map<string, string[]>();

	for (const d of input.decisions) {
		const key = d.key.trim();
		if (!key) {
			out.errors.push({ key: d.key, error: 'empty key' });
			continue;
		}
		switch (d.action) {
			case 'suppress': {
				if (!out.ledgerAfter.suppressed.includes(key)) out.ledgerAfter.suppressed.push(key);
				out.applied.push({ key, action: 'suppress', detail: 'will never import again' });
				break;
			}
			case 'recreate': {
				out.ledgerAfter.imported = out.ledgerAfter.imported.filter((k) => k !== key);
				out.ledgerAfter.suppressed = out.ledgerAfter.suppressed.filter((k) => k !== key);
				out.applied.push({ key, action: 'recreate', detail: 'next sync will create it fresh' });
				break;
			}
			case 'delete': {
				const page = pageByKey.get(key);
				if (!page) {
					out.errors.push({ key, error: 'no page claims this key' });
					break;
				}
				if (!out.deletes.includes(page.path)) out.deletes.push(page.path);
				out.applied.push({ key, action: 'delete', detail: page.path });
				break;
			}
			case 'alias': {
				const target = pageByPath.get(d.alias_to.trim().replace(/^\/+/, ''));
				if (!target) {
					out.errors.push({ key, error: `alias target "${d.alias_to}" not found` });
					break;
				}
				const holder = pageByKey.get(key);
				if (holder && holder.path !== target.path) {
					out.errors.push({
						key,
						error: `already bound to "${holder.path}" — delete or re-key that page first`
					});
					break;
				}
				aliasAdds.set(target.path, [...(aliasAdds.get(target.path) ?? []), key]);
				if (!out.ledgerAfter.imported.includes(key)) out.ledgerAfter.imported.push(key);
				out.applied.push({ key, action: 'alias', detail: `now claimed by ${target.path}` });
				break;
			}
		}
	}

	for (const [path, keys] of aliasAdds) {
		const page = pageByPath.get(path)!;
		const { frontmatter, body } = parseFrontmatter(page.content);
		const fm: Frontmatter = { ...(frontmatter ?? {}) };
		// SOURCE_KEYS_FIELD is a binding the importer owns and always writes flat, so
		// listOf's empty result for an (impossible) nested value is the safe read.
		const list = [...listOf(fm[SOURCE_KEYS_FIELD])];
		for (const k of keys) if (!list.includes(k)) list.push(k);
		fm[SOURCE_KEYS_FIELD] = list;
		fm.updated = today;
		out.writes.push({ path, content: withFrontmatter(fm, body) });
	}

	// An answered question is no longer pending — clear entries for every key
	// whose decision APPLIED (errored decisions stay pending; the question stands).
	const appliedKeys = new Set(out.applied.map((a) => a.key));
	out.ledgerAfter.pending = out.ledgerAfter.pending.filter((q) => !appliedKeys.has(q.key));

	return out;
}
