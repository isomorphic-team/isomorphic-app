// The unified findings queue: review findings that take work to produce, so they are
// stored in D1 instead of computed on each `validate`. Keys, visibility, staleness and
// scrubbing are pure; the two D1 functions at the end are the only storage.
//
// The queue is derived state. A decision about a finding is a dismissal in the brain's
// ledger (findings.ts), answered through `resolve` like any other, so nothing here
// records one.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import { findingKey, type Finding } from './findings.ts';
import { roleAtLeast, type Role } from './orgs.ts';
import { detectSensitive } from './policy-detectors.ts';

export type QueueKind = 'conflict' | 'duplicate' | 'policy';

export interface QueueFinding {
	key: string;
	kind: QueueKind;
	paths: string[];
	headline: string;
	evidence: string[];
	proposal: unknown;
	scores: Record<string, number> | null;
	// Blob sha of each page at check time.
	pageShas: Record<string, string>;
	runId: string;
	// Findings about one fact share this, for display. Never part of a key: a cluster
	// gains and loses pages as they change, and a dismissal has to outlive that.
	clusterId: string | null;
	authorUserId: string | null;
}

// Rows per D1 batch.
const WRITE_BATCH = 40;

const FINDING_WEIGHT = 4;

// ---------- keys ----------

// The disputed value as a key compares it: rewording around a value leaves the key
// alone, and changing the value makes a new disagreement.
export function normalizeDisputedValue(value: string): string {
	return value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/^[\s.,;:!?"'()]+|[\s.,;:!?"'()]+$/g, '');
}

// `conflict:<sorted paths>:<fingerprint of the disputed values>`. The pair says where,
// the fingerprint says which fact: two pages can disagree about more than one thing,
// and dismissing one must not silence the other. One path is a page against itself.
export async function conflictKey(paths: string[], values: string[]): Promise<string> {
	const normalized = [...new Set(values.map(normalizeDisputedValue))].sort();
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(normalized.join('\0'))
	);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${findingKey('conflict', [...new Set(paths)])}:${hex.slice(0, 16)}`;
}

// Whether every claimed value appears word for word on its page, so a key never rests
// on text a model produced rather than quoted.
export function valuesOnPages(
	claims: readonly { path: string; value: string }[],
	contents: ReadonlyMap<string, string>
): boolean {
	return claims.every((c) => contents.get(c.path)?.includes(c.value) ?? false);
}

// ---------- visibility ----------

// Who may see a finding, by kind. Consolidation findings go to editors. A policy finding
// says where sensitive data sits, so it goes to brain admins and its author. A kind this
// version does not know gets the narrowest answer.
export function canSeeFinding(kind: string, viewer: { role: Role; isAuthor: boolean }): boolean {
	if (kind === 'conflict' || kind === 'duplicate') return roleAtLeast(viewer.role, 'editor');
	if (kind === 'policy') return viewer.isAuthor || roleAtLeast(viewer.role, 'admin');
	return roleAtLeast(viewer.role, 'admin');
}

// ---------- staleness ----------

// A finding is stale once any page it cites has changed or gone, since what it says was
// true of those exact pages.
export function isStale(f: QueueFinding, current: ReadonlyMap<string, string>): boolean {
	return f.paths.some((p) => !f.pageShas[p] || current.get(p) !== f.pageShas[p]);
}

function toFinding(f: QueueFinding): Finding {
	return {
		key: f.key,
		weight: FINDING_WEIGHT,
		headline: [`- ${f.headline}`, ...f.evidence.map((e) => `    ${e}`)].join('\n')
	};
}

// The queue as one viewer's `validate` reports it.
export function queueReport(
	rows: readonly QueueFinding[],
	current: ReadonlyMap<string, string>,
	viewer: { role: Role; userId?: string }
): { open: Finding[]; stale: Finding[] } {
	const visible = rows.filter((f) =>
		canSeeFinding(f.kind, {
			role: viewer.role,
			isAuthor: !!viewer.userId && f.authorUserId === viewer.userId
		})
	);
	return {
		open: visible.filter((f) => !isStale(f, current)).map(toFinding),
		stale: visible.filter((f) => isStale(f, current)).map(toFinding)
	};
}

// The line for findings whose pages moved on. Stale findings are counted rather than
// listed: what they say may no longer be true.
export function staleNote(count: number): string {
	return count
		? `\n\n${count} earlier finding(s) are stale and not listed: a page they cite has changed since the check.`
		: '';
}

// ---------- scrubbing ----------

// Every span the policy detectors flag, replaced: copying a credential into D1 would
// make the leak worse.
export function scrubSensitive(text: string): string {
	const spans = detectSensitive(text);
	let out = '';
	let at = 0;
	for (const { start, end } of spans) {
		if (start < at) continue;
		out += `${text.slice(at, start)}[redacted]`;
		at = end;
	}
	return out + text.slice(at);
}

// ---------- storage ----------

// Insert or refresh rows by key. The one way into the table, so every row is scrubbed.
export async function upsertFindings(
	db: D1Database,
	brainId: string,
	findings: readonly QueueFinding[],
	now = Date.now()
): Promise<void> {
	const stmt = db.prepare(
		`INSERT INTO review_findings
		   (brain_id, key, kind, paths, headline, evidence, proposal, scores, page_shas,
		    run_id, cluster_id, author_user_id, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
		 ON CONFLICT (brain_id, key) DO UPDATE SET
		   kind = ?3, paths = ?4, headline = ?5, evidence = ?6, proposal = ?7, scores = ?8,
		   page_shas = ?9, run_id = ?10, cluster_id = ?11, author_user_id = ?12, updated_at = ?13`
	);
	for (let i = 0; i < findings.length; i += WRITE_BATCH) {
		await db.batch(
			findings
				.slice(i, i + WRITE_BATCH)
				.map((f) =>
					stmt.bind(
						brainId,
						f.key,
						f.kind,
						JSON.stringify(f.paths),
						scrubSensitive(f.headline),
						JSON.stringify(f.evidence.map(scrubSensitive)),
						f.proposal == null ? null : scrubSensitive(JSON.stringify(f.proposal)),
						f.scores ? JSON.stringify(f.scores) : null,
						JSON.stringify(f.pageShas),
						f.runId,
						f.clusterId,
						f.authorUserId,
						now
					)
				)
		);
	}
}

interface FindingRow {
	key: string;
	kind: string;
	paths: string;
	headline: string;
	evidence: string;
	proposal: string | null;
	scores: string | null;
	page_shas: string;
	run_id: string;
	cluster_id: string | null;
	author_user_id: string | null;
}

// One row that cannot be parsed is dropped, so it never costs the rest of the report.
function parseRow(r: FindingRow): QueueFinding | null {
	try {
		return {
			key: r.key,
			kind: r.kind as QueueKind,
			paths: JSON.parse(r.paths) as string[],
			headline: r.headline,
			evidence: JSON.parse(r.evidence) as string[],
			proposal: r.proposal === null ? null : (JSON.parse(r.proposal) as unknown),
			scores: r.scores === null ? null : (JSON.parse(r.scores) as Record<string, number>),
			pageShas: JSON.parse(r.page_shas) as Record<string, string>,
			runId: r.run_id,
			clusterId: r.cluster_id,
			authorUserId: r.author_user_id
		};
	} catch {
		return null;
	}
}

export async function readFindings(db: D1Database, brainId: string): Promise<QueueFinding[]> {
	const { results } = await db
		.prepare(
			`SELECT key, kind, paths, headline, evidence, proposal, scores, page_shas, run_id,
			        cluster_id, author_user_id
			 FROM review_findings WHERE brain_id = ?1`
		)
		.bind(brainId)
		.all<FindingRow>();
	return results.map(parseRow).filter((f): f is QueueFinding => f !== null);
}

// The index's blob sha per page, to compare findings against. Only called with rows in
// hand, so a brain with an empty queue pays one query.
export async function readPageShas(db: D1Database, brainId: string): Promise<Map<string, string>> {
	const { results } = await db
		.prepare('SELECT path, blob_sha FROM brain_pages WHERE brain_id = ?1')
		.bind(brainId)
		.all<{ path: string; blob_sha: string }>();
	return new Map(results.map((r) => [r.path, r.blob_sha]));
}
