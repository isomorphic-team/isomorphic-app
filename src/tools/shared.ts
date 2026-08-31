// Response shapes and argument schemas every tool suite needs.
//
// `fail` was defined identically in nine tool modules and `ok` in three. The
// copies differed only in whether they accepted structuredContent, which is the
// kind of difference that stays invisible until a caller copies the wrong one.
//
// The brain argument is deliberately NOT one shared string. Tool descriptions
// are model-facing and each suite tailors its own ("which brain's sharing to act
// on" is not "which brain to open"), so only the SHAPE is shared here.

import { z } from 'zod';

// A normal tool result. `structuredContent` rides along only when a caller passes
// one, so this stays byte-identical to the text-only form it replaces.
export function ok(text: string, structuredContent?: Record<string, unknown>) {
	return {
		content: [{ type: 'text' as const, text }],
		...(structuredContent ? { structuredContent } : {})
	};
}

// An error result. `isError` is what the host reads to render a failure, and what
// countedCall (src/lib/usage.ts) counts as an error rather than a success.
export function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

// What most suites say when the argument only routes to a brain.
export const DEFAULT_BRAIN_DESC =
	'Which brain to target (name/handle). Defaults to the active brain.';

// The default-worded routing argument.
export const brainArg = z.string().optional().describe(DEFAULT_BRAIN_DESC);

// The same shape carrying this suite's own wording. Pass the description the tool
// already used; do not consolidate the wordings.
export const brainArgFor = (description: string) => z.string().optional().describe(description);
