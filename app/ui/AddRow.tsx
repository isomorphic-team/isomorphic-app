// The inline composer for "add a thing to this list", and the hook that publishes
// its trigger to the header.
//
// The split is the file tree's, not an invention: the TRIGGER lives in the header's
// action slot (always visible, never scrolls away, and the one place the bar's own
// rule says "what you can do here" belongs), while the COMPOSER opens INLINE. An
// earlier version put the trigger in the body too, which quietly gave the app two
// trigger patterns where the tree already had one.
//
// The composer opens at the TOP of its list, directly under the header. It was
// briefly at the bottom, on the theory that a composer should sit where the new item
// lands — but once the trigger moved to the header that put cause and effect at
// opposite ends of a scrolling list, and for Members it was not even true (an invite
// lands in "Pending invites", a different section). The tree has always inserted its
// root-level add row at the top for the same reason.
//
// NOT a modal, deliberately. `position: fixed` resolves against the IFRAME, not
// Claude's window, so in the default `inline` display mode a dialog is a box inside a
// short box: it covers the very list it is adding to and has almost no room. The app
// already learned this once — OverflowMenu has to clamp its dropdown to
// `window.innerHeight` because "a short card clips the lower menu items". Modals are
// still right for destructive confirmations (see askConfirm), where blocking IS the
// point; they are wrong for an additive one-field form.
//
// WHICH ADD GOES WHERE. The card is a bounded box in the conversation, which is
// structurally what a dialog is — so the thing that plays a dialog's role here is a
// PUSHED VIEW, not an overlay. It takes the whole card (the space a dialog wanted)
// and inherits the breadcrumb, goBack(), and the action slot, so it needs no focus
// trap, no scrim, and no height clamping. The split:
//
//   * INLINE ROW (this file) — one commit, at most a couple of known controls, and a
//     result that just lands in the list. Invite (email + role) and Connect (an
//     email) qualify, as does the file tree's create/rename row.
//   * ITS OWN VIEW — the user picks from a list whose length we don't control, or
//     there is more than one step. AddBrainView (org, then that org's repos) and
//     CreateBrainView are both this.
//
// Step two, when a composer has one, replaces step one IN PLACE rather than rendering
// elsewhere on the screen: see ConnectedAccountsSection, where the verification link
// used to appear as a banner above the list the moment the form disappeared.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { addCtl, bump } from '../core/store.ts';
import { cn } from './cn.ts';

/**
 * Publish this view's "add" action to the header for as long as the view is mounted.
 * The callback is held behind a ref so a view can pass a fresh closure on every
 * render without re-registering (and re-bumping) each time.
 */
export function useAddAction(start: () => void): void {
	const ref = useRef(start);
	ref.current = start;
	useEffect(() => {
		addCtl.bound = true;
		addCtl.start = () => ref.current();
		bump(); // the header renders its action list from this
		return () => {
			addCtl.bound = false;
			addCtl.start = () => {};
			bump();
		};
	}, []);
}

export type AddRowProps = {
	/** Whether the composer is showing. Owned by the view, opened from the header. */
	open: boolean;
	/** Dismiss. Called on Escape, and passed to the composer for its own cancel path. */
	onClose: () => void;
	children: (api: { close: () => void }) => ComponentChildren;
	class?: string;
};

export function AddRow({ open, onClose, children, class: cls }: AddRowProps) {
	if (!open) return null;
	return (
		<li
			class={cn('py-1.5', cls)}
			// Escape anywhere inside dismisses, matching the tree's inline create/rename
			// row. stopPropagation so it does not also close a surrounding menu or the
			// host's own overlay on the way out.
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			{children({ close: onClose })}
		</li>
	);
}

// No Enter-to-commit helper here on purpose: every composer that takes a text field
// wraps it in a <form>, which gives Enter-to-submit natively. The tree needs its own
// keydown handler only because its inline row is not a form.
