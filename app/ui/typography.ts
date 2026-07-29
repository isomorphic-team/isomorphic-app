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
