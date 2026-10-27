// A tool's title and its annotations, from one call, so the two cannot drift.
//
// Anthropic's connector directory rejects a tool without `annotations.title` and
// the hint that applies to it: `readOnlyHint: true` for a read, `destructiveHint:
// true` for anything that can modify or delete data. Claude reads the hints to
// decide what runs without asking (reads) and what always prompts (destructive).
// The top-level `title` is what hosts display; the SDK carries the two apart, and
// a tool that set only one of them passed typecheck and failed review.
//
// All four hints are always a boolean. An omitted hint takes the MCP default
// (destructive, not idempotent, open world), so leaving `openWorldHint` out
// advertises a private-brain read as reaching the public internet, and ChatGPT's
// app review asks for every hint set explicitly.
//
// Every first-party registration spreads this into its config, and
// `pnpm test:annotations` fails on any registered tool that does not carry all of it.
//
//   'read'        changes nothing anywhere.
//   'additive'    creates or points at something new, and removes or overwrites
//                 nothing the caller has not just made (a new brain, an upload, an
//                 invite, which brain is active).
//   'destructive' can overwrite, move, revoke or delete what already exists.
//                 When in doubt, this one: the cost of a wrong 'additive' is a
//                 write that never asks first.
//
// `openWorld` marks a tool that reaches past the brain and the platform: it
// downloads from an arbitrary URL or publishes somewhere public. Committing to the
// brain's own repository is not open world.

export type ToolEffect = 'read' | 'additive' | 'destructive';

export interface ToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export function toolAnnotations(
	title: string,
	effect: ToolEffect,
	opts: { openWorld?: boolean } = {}
): { title: string; annotations: ToolAnnotations } {
	const read = effect === 'read';
	const annotations: ToolAnnotations = {
		title,
		readOnlyHint: read,
		destructiveHint: effect === 'destructive',
		// A repeated read changes nothing. No write is safe to repeat blindly: an
		// append duplicates, a second create is refused.
		idempotentHint: read,
		openWorldHint: opts.openWorld ?? false
	};
	return { title, annotations };
}

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** What a directory review would reject in one tool's advertised definition. */
export function annotationProblems(tool: {
	title?: unknown;
	annotations?: { title?: unknown } & { [H in (typeof HINTS)[number]]?: unknown };
}): string[] {
	const problems: string[] = [];
	const a = tool.annotations ?? {};
	if (typeof a.title !== 'string' || !a.title.trim()) problems.push('no annotations.title');
	else if (a.title !== tool.title) problems.push('annotations.title differs from title');
	for (const h of HINTS) if (typeof a[h] !== 'boolean') problems.push(`no explicit ${h}`);
	if (a.readOnlyHint === true && a.destructiveHint === true) {
		problems.push('both readOnlyHint and destructiveHint');
	}
	return problems;
}
