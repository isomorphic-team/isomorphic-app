// Making a retried write safe when the FIRST attempt's answer never arrived.
//
// Issue #50: a `write_page` that fails with a 502 (or a timeout, or a dropped
// connection) tells the caller nothing about whether the commit landed. The
// caller's only recourse is to read the page before every retry, and the two
// ways of getting it wrong are both silent — a retried `append` duplicates the
// text, and a retried `mode: "create"` fails claiming the page exists, on a page
// the caller believes it never created.
//
// The fix is a short-lived ledger of write attempts, keyed by what the CALL
// asked for rather than by what the commit would contain. That distinction is
// the whole design:
//
//   An append's BUNDLE is not stable across a retry. Attempt 1 reads body B and
//   commits B+T. If it lands, attempt 2 reads B+T and commits B+T+T — a
//   different bundle, so anything fingerprinting the commit would miss exactly
//   the case this exists for. The ARGUMENTS are identical across both attempts,
//   so that is what is hashed.
//
// Two windows, because they answer different questions:
//
//   IN_FLIGHT_GRACE_MS — how long an unfinished attempt speaks for itself. The
//   client gives up well before the Worker does, so a retry can arrive while the
//   original is still committing; without a row reserved BEFORE the commit, that
//   retry would commit a second time. But a Worker killed mid-request leaves a
//   row nobody will ever finish, and a fingerprint blocked forever is worse than
//   the duplicate it prevents, so a stale claim is taken over rather than obeyed.
//
//   DONE_TTL_MS — how long a completed attempt is remembered, and therefore how
//   long an identical repeat is answered from the ledger instead of applied.
//
// The trade-off worth stating plainly: a DELIBERATE identical write inside the
// done window (the same text appended twice on purpose, with no edit between)
// is reported as already applied rather than applied again. It is not silent —
// the caller is told the write it is repeating already landed, and when — and
// the alternative is being unable to distinguish it from the retry, which is
// the bug. Changing the text, or any other argument, makes it a different write.
//
// Pure and Worker-safe: Web Crypto only, no `node:*`, no bindings, no I/O. The
// D1 implementation of `WriteLedger` lives in write-dedupe-store.ts.

/** How long an unfinished attempt blocks an identical one. */
export const IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;

/** How long a completed attempt is replayed instead of re-applied. */
export const DONE_TTL_MS = 10 * 60 * 1000;

export interface WriteAttempt {
	brainId: string;
	fingerprint: string;
	state: 'in_flight' | 'done';
	startedAt: number;
	completedAt: number | null;
	/** What the original attempt reported, replayed verbatim to the retry. */
	summary: string | null;
}

/**
 * The durable half. Implemented over D1 in write-dedupe-store.ts and over a Map
 * in the golden test, which is the point of the seam.
 */
export interface WriteLedger {
	/** Drop rows too old to speak for anything. Called before every claim. */
	prune(cutoffs: { inFlightBefore: number; doneBefore: number }): Promise<void>;
	/**
	 * Reserve this fingerprint. True when the caller now owns the attempt —
	 * either because no row existed, or because a stale in-flight row was taken
	 * over. Must be atomic: two concurrent claims cannot both win.
	 */
	claim(brainId: string, fingerprint: string, now: number): Promise<boolean>;
	read(brainId: string, fingerprint: string): Promise<WriteAttempt | null>;
	complete(brainId: string, fingerprint: string, at: number, summary: string): Promise<void>;
	/** Give the fingerprint back, so a deterministic refusal can be retried at once. */
	release(brainId: string, fingerprint: string): Promise<void>;
}

/**
 * JSON with keys in a stable order, so two spellings of the same arguments hash
 * the same. `undefined` members are dropped rather than rendered, because an
 * absent argument and one explicitly passed as undefined are the same call.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * The identity of a write, as the CALLER expressed it.
 *
 * `brain` is excluded deliberately: it is a routing argument, and the resolved
 * `brainId` already pins which brain this is. A retry that spells the same brain
 * a different way ("Acme" vs "acme/brain") is still the same write.
 */
export async function writeFingerprint(
	actor: string,
	tool: string,
	args: Record<string, unknown>
): Promise<string> {
	const { brain: _brain, ...rest } = args;
	const canonical = `${actor} ${tool} ${stableStringify(rest)}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type WriteVerdict =
	| { kind: 'claimed' }
	| { kind: 'replay'; attempt: WriteAttempt }
	| { kind: 'in-flight'; attempt: WriteAttempt };

/**
 * What to do about a fingerprint that was already in the ledger. Pure, so the
 * whole table is walkable: `claim` having failed means a row exists, and only
 * its state and age decide.
 *
 * A row that has vanished between the failed claim and the read (pruned by a
 * concurrent request) reads as `claimed`: proceeding is what the caller wanted,
 * and the worst case is the duplicate we were already living with.
 */
export function decideWrite(attempt: WriteAttempt | null, now: number): WriteVerdict {
	if (!attempt) return { kind: 'claimed' };
	if (attempt.state === 'done') {
		if (now - (attempt.completedAt ?? attempt.startedAt) >= DONE_TTL_MS) return { kind: 'claimed' };
		return { kind: 'replay', attempt };
	}
	if (now - attempt.startedAt >= IN_FLIGHT_GRACE_MS) return { kind: 'claimed' };
	return { kind: 'in-flight', attempt };
}

/** Whole seconds since a moment, for wording a replay without a clock in the message. */
export function secondsSince(then: number, now: number): number {
	return Math.max(0, Math.round((now - then) / 1000));
}

/**
 * Run `perform` at most once per fingerprint.
 *
 * The claim is taken BEFORE `perform` and given back if it throws or refuses, so
 * a deterministic refusal ("that path already exists", "no such page") stays
 * immediately retryable and only a write that actually landed is remembered.
 *
 * Bookkeeping AFTER `perform` never changes the answer. Once the write has
 * landed, the commit is the fact and this table is a cache of it: failing to
 * record the attempt must not turn a successful write into a failed one, the
 * same rule the write-through index follows. Failing to record only costs the
 * NEXT retry its replay.
 *
 * `onReplay` and `onInFlight` build the caller-facing result; this module has no
 * opinion about tool result shapes, which is what keeps it pure and testable.
 */
export async function dedupeWrite<R>(
	ledger: WriteLedger,
	key: { brainId: string; fingerprint: string; now: number },
	handlers: {
		perform: () => Promise<R>;
		/** The text to remember, or null to remember nothing (a refusal). */
		record: (result: R) => string | null;
		onReplay: (attempt: WriteAttempt) => R;
		onInFlight: (attempt: WriteAttempt) => R;
	}
): Promise<R> {
	const { brainId, fingerprint, now } = key;
	await ledger.prune({
		inFlightBefore: now - IN_FLIGHT_GRACE_MS,
		doneBefore: now - DONE_TTL_MS
	});
	const mine = await ledger.claim(brainId, fingerprint, now);
	if (!mine) {
		const verdict = decideWrite(await ledger.read(brainId, fingerprint), now);
		if (verdict.kind === 'replay') return handlers.onReplay(verdict.attempt);
		if (verdict.kind === 'in-flight') return handlers.onInFlight(verdict.attempt);
		// The row aged out between the claim and the read — take it and proceed.
		await ledger.claim(brainId, fingerprint, now);
	}
	let result: R;
	try {
		result = await handlers.perform();
	} catch (err) {
		await ledger.release(brainId, fingerprint).catch(() => {});
		throw err;
	}
	const summary = handlers.record(result);
	if (summary === null) await ledger.release(brainId, fingerprint).catch(() => {});
	else await ledger.complete(brainId, fingerprint, now, summary).catch(() => {});
	return result;
}
