// Why a tool call failed, as a category for the usage counters (`usage_failures`,
// migration 0031). Never the message: a refusal can quote page text, and the
// counters hold nothing a brain holds.
//
// No imports, so the error classes in orgs.ts and brain-repo.ts can tag themselves
// without pulling in the analytics layer.
//
// Worker-safe: no node:* imports.

/**
 *   anchor      an `edits` find text matched zero times, or more than once
 *   not_found   the page, file or folder the call named does not exist
 *   conflict    the target already exists, or changed since it was read
 *   invalid     the arguments or the path were refused before any work
 *   permission  the caller's role is below what the tool requires
 *   thrown      the handler threw an error nothing tagged
 *   other       an error result nothing tagged
 */
export const FAILURE_REASONS = [
	'anchor',
	'not_found',
	'conflict',
	'invalid',
	'permission',
	'thrown',
	'other'
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

// A symbol key, non-enumerable: JSON never sees it, so a tagged result goes over
// the wire exactly as an untagged one.
const REASON_KEY = Symbol.for('isomorphic.failureReason');

/** Attach a reason to an error result or an Error. Returns the same object. */
export function tagFailure<T extends object>(target: T, reason: FailureReason): T {
	Object.defineProperty(target, REASON_KEY, {
		value: reason,
		enumerable: false,
		configurable: true
	});
	return target;
}

/** The reason a failed call records: its tag, else `thrown` or `other` by how it failed. */
export function failureReason(outcome: unknown, threw: boolean): FailureReason {
	const tag =
		outcome && typeof outcome === 'object'
			? (outcome as Record<symbol, unknown>)[REASON_KEY]
			: undefined;
	if ((FAILURE_REASONS as readonly unknown[]).includes(tag)) return tag as FailureReason;
	return threw ? 'thrown' : 'other';
}
