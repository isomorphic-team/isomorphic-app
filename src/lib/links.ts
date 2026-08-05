// What a markdown link MEANS, as one pure rule.
//
// This existed twice, and the two copies disagreed in exactly the way that hides a
// bug: the real one lived inside loadResolvedGraph (coupled to D1, so nothing else
// could call it) and the dev harness carried a hand-written approximation. When
// attachments were added, the server copy was taught that an image link is a real
// reference and the harness copy was not — so the preview reported "no page shows
// this file" for an image that was plainly on a page, while production would have
// answered correctly. A preview that is wrong in a different direction than prod is
// worse than no preview, because it manufactures bugs that do not exist and hides
// ones that do.
//
// Pure: no D1, no octokit, no `node:*`. The index calls it per stored link; the
// harness calls it while scanning fixtures; anything else that needs to ask "what is
// this link pointing at?" calls it too, and they cannot drift.

import { resolveRelative } from './wiki.ts';
import { isAssetPath, isContentPath, isSourcePath, type PathPolicy } from './brain-policy.ts';

export type MdLinkKind =
	// Points at a known content page: a real edge in the graph.
	| 'page'
	// Points at an attachment (image, PDF) under content. A real reference too, but
	// kept apart: the graph view draws nodes from pages, so an asset in that list
	// would be an edge to a node the renderer has no data for.
	| 'asset'
	// Points at a content page that does not exist. This is what `validate` reports.
	| 'broken'
	// Everything we deliberately say nothing about: external URLs, anchors, source
	// material (not indexed), and non-page targets we have no inventory of. Never
	// reported as broken, because "I have not indexed it" is not the same as "it is
	// missing", and guessing makes validate cry wolf on every brain.
	| 'ignore';

export interface MdLinkClassification {
	kind: MdLinkKind;
	// The resolved repo-relative path, absent for links we never resolve (external).
	target?: string;
}

// Is this href something we resolve inside the repo at all?
export function isExternalHref(href: string): boolean {
	return /^(https?:|mailto:|tel:|data:|#)/i.test(href.trim());
}

// Classify one markdown link found in `sourcePath`.
//
// `isKnownPage` answers "is there a content page at this path?" — supplied by the
// caller because only they know the page set (the index queries D1 for it; the
// harness has a fixture map in hand).
export function classifyMdLink(
	sourcePath: string,
	rawTarget: string,
	cfg: PathPolicy,
	isKnownPage: (path: string) => boolean
): MdLinkClassification {
	if (isExternalHref(rawTarget)) return { kind: 'ignore' };
	const target = resolveRelative(sourcePath, rawTarget);
	if (!target) return { kind: 'ignore' };

	if (!target.endsWith('.md')) {
		return { kind: isAssetPath(target, cfg) ? 'asset' : 'ignore', target };
	}
	// Source material is not indexed, so a link into it is not broken.
	if (isSourcePath(target, cfg)) return { kind: 'ignore', target };
	if (isKnownPage(target)) return { kind: 'page', target };
	// Only a MISSING CONTENT page counts as broken; a link outside the content roots
	// is somebody else's business.
	return { kind: isContentPath(target, cfg) ? 'broken' : 'ignore', target };
}
