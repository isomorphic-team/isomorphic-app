// A tool's title and its annotations, from one call, so the two cannot drift.
//
// Anthropic's connector directory rejects a tool without `annotations.title` and
// the hint that applies to it: `readOnlyHint: true` for a read, `destructiveHint:
// true` for anything that can modify or delete data. Claude reads the hints to
// decide what runs without asking (reads) and what always prompts (destructive).
// The top-level `title` is what hosts display; the SDK carries the two apart, and
// a tool that set only one of them passed typecheck and failed review.
//
// Every first-party registration spreads this into its config, and
// `pnpm test:annotations` fails on any registered tool that does not carry both.
//
//   'read'        changes nothing anywhere.
//   'additive'    creates or points at something new, and removes or overwrites
//                 nothing the caller has not just made (a new brain, an upload, an
//                 invite, which brain is active).
//   'destructive' can overwrite, move, revoke or delete what already exists.
//                 When in doubt, this one: the cost of a wrong 'additive' is a
//                 write that never asks first.

export type ToolEffect = 'read' | 'additive' | 'destructive';

export interface ToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint?: boolean;
}

export function toolAnnotations(
	title: string,
	effect: ToolEffect
): { title: string; annotations: ToolAnnotations } {
	const annotations: ToolAnnotations =
		effect === 'read'
			? { title, readOnlyHint: true }
			: { title, readOnlyHint: false, destructiveHint: effect === 'destructive' };
	return { title, annotations };
}

/** What the directory review would reject in one tool's advertised definition. */
export function annotationProblems(tool: {
	title?: unknown;
	annotations?: { title?: unknown; readOnlyHint?: unknown; destructiveHint?: unknown };
}): string[] {
	const problems: string[] = [];
	const a = tool.annotations ?? {};
	if (typeof a.title !== 'string' || !a.title.trim()) problems.push('no annotations.title');
	else if (a.title !== tool.title) problems.push('annotations.title differs from title');
	if (a.readOnlyHint === true) {
		if (a.destructiveHint === true) problems.push('both readOnlyHint and destructiveHint');
	} else if (typeof a.destructiveHint !== 'boolean') {
		problems.push('not readOnly, and no explicit destructiveHint');
	}
	return problems;
}
