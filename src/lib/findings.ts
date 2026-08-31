// Findings: the things `validate` reports that a human may need to DECIDE about, and
// the ledger that remembers what they decided.
//
// The workflow has two halves and one tool each. `validate` SURFACES findings;
// `resolve` RECORDS a decision so they stop coming back. That split follows the
// gating (surfacing is viewer, deciding is editor) and it is the same shape the
// importer already had: sync_records raises questions, validate lists them, and a
// resolve verb answers them durably. This generalises that verb to every finding
// rather than only the import ones.
//
// A DEFECT IS NOT A FINDING. A broken link has one right answer and dismissing it
// would be wrong, so it is reported outside this system and carries no key. What gets
// a key is everything advisory: structure notes, consolidation tensions, and the
// import questions. That line is the reason a dismissal mechanism is safe to have at
// all — nothing provable can be silenced with it.
//
// KEYS ARE AN INTERFACE. Once someone dismisses a key it has to keep meaning the same
// thing, so a key derives from the finding's IDENTITY (kind plus the paths involved)
// and never from the wording of its headline. Rewording a message must not resurrect
// every dismissal of it, and retitling a page must not either.

export interface Finding {
	/** Namespaced and stable: `<kind>:<identity>`. Never derived from the headline. */
	key: string;
	/** The line (or lines) shown to a reader. Free to be reworded at any time. */
	headline: string;
	/** Ordering within the report; higher first. */
	weight: number;
}

export interface ReviewLedger {
	version: number;
	dismissed: { key: string; why: string; at: string }[];
}

export const REVIEW_LEDGER_PATH = '.isomorphic/review.json';
const LEDGER_VERSION = 1;

/** Import findings route to the importer's own per-source ledger, not this one. */
export const IMPORT_PREFIX = 'import:';

export const isImportKey = (key: string) => key.startsWith(IMPORT_PREFIX);

/**
 * `import:<source>:<record key>`. The source is needed to find the right ledger, and
 * a record key may itself contain `:`, so only the first two segments are structural.
 */
export function parseImportKey(key: string): { source: string; recordKey: string } | null {
	if (!isImportKey(key)) return null;
	const rest = key.slice(IMPORT_PREFIX.length);
	const cut = rest.indexOf(':');
	if (cut <= 0 || cut === rest.length - 1) return null;
	return { source: rest.slice(0, cut), recordKey: rest.slice(cut + 1) };
}

export const importKey = (source: string, recordKey: string) =>
	`${IMPORT_PREFIX}${source}:${recordKey}`;

/** `<kind>:<paths, sorted and joined>` — stable across reads and across rewording. */
export function findingKey(kind: string, identity: string | string[]): string {
	const parts = Array.isArray(identity) ? [...identity].sort() : [identity];
	return `${kind}:${parts.join('|')}`;
}

// ---------- the ledger ----------

export function parseReviewLedger(raw: string | null): ReviewLedger {
	if (!raw || !raw.trim()) return { version: LEDGER_VERSION, dismissed: [] };
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== 'object') throw new Error('review ledger is not an object');
	const obj = parsed as Partial<ReviewLedger>;
	const dismissed = Array.isArray(obj.dismissed) ? obj.dismissed : [];
	return {
		version: typeof obj.version === 'number' ? obj.version : LEDGER_VERSION,
		dismissed: dismissed
			.filter((d): d is ReviewLedger['dismissed'][number] => !!d && typeof d.key === 'string')
			.map((d) => ({ key: d.key, why: String(d.why ?? ''), at: String(d.at ?? '') }))
	};
}

export function serializeReviewLedger(ledger: ReviewLedger): string {
	return `${JSON.stringify({ version: LEDGER_VERSION, dismissed: ledger.dismissed }, null, 2)}\n`;
}

/**
 * Record a decision. Idempotent on the key: dismissing twice is not an error and does
 * not duplicate the row, because a caller re-answering a finding they already
 * answered is a normal thing to do and should not be punished.
 */
export function dismissFinding(
	ledger: ReviewLedger,
	key: string,
	why: string,
	at: string
): ReviewLedger {
	if (ledger.dismissed.some((d) => d.key === key)) return ledger;
	return { ...ledger, dismissed: [...ledger.dismissed, { key, why, at }] };
}

/** Forget a decision, so the finding is raised again if it still holds. */
export function undismissFinding(ledger: ReviewLedger, key: string): ReviewLedger {
	return { ...ledger, dismissed: ledger.dismissed.filter((d) => d.key !== key) };
}

/**
 * Drop the findings someone has already decided about. This is what keeps a report
 * worth reading: an advisory nobody can silence decays into noise, and a brain that
 * is deliberately Obsidian-first, or deliberately uses `overview.md`, currently gets
 * the same note on every run forever with no way to say "considered, deliberate".
 */
export function filterDismissed(findings: Finding[], ledger: ReviewLedger): Finding[] {
	const dropped = new Set(ledger.dismissed.map((d) => d.key));
	return findings.filter((f) => !dropped.has(f.key));
}

/**
 * Render a capped report. The cap exists because `validate` is read in a conversation
 * where every line costs context, and a hundred advisories is not more useful than
 * ten plus a count — but the count must be stated, since a silently truncated list
 * reads as "that is all of them".
 */
export function renderFindings(
	findings: Finding[],
	limit: number
): { text: string; shown: number; hidden: number } {
	const ranked = [...findings].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
	const shown = ranked.slice(0, limit);
	const hidden = ranked.length - shown.length;
	const lines = shown.map((f) => `${f.headline}\n  [${f.key}]`);
	const more = hidden > 0 ? `\n\n…and ${hidden} more. Raise the limit to see them.` : '';
	return { text: `${lines.join('\n')}${more}`, shown: shown.length, hidden };
}
