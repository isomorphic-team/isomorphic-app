// Named type roles, so a role is defined once instead of being retyped per view.
//
// Both of these existed as repeated class strings that had quietly diverged: the
// eyebrow appeared seven times, five of them identical, one at text-xs instead
// of text-xs and one at font-semibold instead of font-medium. The view headline
// appeared twice, once as `text-base font-semibold` and once as a bare `font-bold`
// with no size at all (so it inherited body size and was a "headline" no larger
// than the paragraph under it).
//
// These are class strings rather than components on purpose: they land on <h2>,
// <dt>, <div> and <p> depending on what the surrounding markup calls for, and
// wrapping that in a component would fight the semantics rather than help them.

/**
 * Small uppercase section label ("Display", "Pending invites", "Add to which
 * organization?"). Sits above a group and names it.
 */
export const eyebrow = 'text-xs font-medium uppercase tracking-wide text-muted';

/**
 * A view's headline, for the empty/error states that need one. Page content sets
 * its own headings through `.prose`, so this is chrome only.
 */
export const viewTitle = 'text-base font-semibold text-fg';

// ---------- the trail ----------
//
// The breadcrumb has FOUR type roles and no others. They were ad-hoc strings, and had
// drifted exactly the way the eyebrow above did: the brain crumb was font-medium while
// every other crumb was normal weight, the Search crumb rendered its own name muted
// while Members rendered it in fg (so one read as active and the other as disabled),
// and the ancestor-link recipe existed three times — twice identical, once without the
// hover underline.
//
// The rule these encode: a crumb's WEIGHT never varies, and its COLOUR says one thing
// only — fg is where you are, muted is everything else. The root is distinguished by
// its glyph, not by being heavier. A new nav state picks one of these four; if none
// fits, the role is missing and belongs here rather than inline.

/**
 * Where you are. The end of the trail, and never a link — the last path segment, a
 * destination's own name, or the brain crumb on the file tree, whose place IS the root
 * the tree is showing.
 *
 * CURRENT AND INERT ARE THE SAME ROLE, not two. There was a second `crumbInert` at
 * `text-muted` for "names a place but must not link", and the brain crumb on the file
 * tree used it — so that one trail ended in a muted segment and, by the rule above,
 * said you were nowhere. Meanwhile the identical case one level down (the last folder
 * crumb, equally unclickable) was already `text-fg`. Colour answers where you are;
 * whether a segment is a <button> answers whether you can leave. Do not re-split them.
 */
export const crumbCurrent = 'text-fg';

/** A crumb above you, clickable. */
export const crumbLink =
	'rounded text-muted outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-accent';

/**
 * The identity suffix after a destination's name: which search, which page's history.
 * Never a count — see NO TALLIES in components/Breadcrumb.
 */
export const crumbMeta = 'text-muted';
