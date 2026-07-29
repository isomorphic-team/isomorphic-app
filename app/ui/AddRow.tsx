// The inline composer for "add a thing to this list", and the hook that publishes
// its trigger to the header.
//
// The split matters, and it is the file tree's, not an invention: the TRIGGER lives
// in the header's action slot (always visible, never scrolls away, and the one place
// the bar's own rule says "what you can do here" belongs), while the COMPOSER opens
// INLINE, at the end of the list, where the new item will actually land. An earlier
// version of this file put the trigger in the body too, which quietly gave the app
// two trigger patterns where the tree already had one.
//
// Complexity scales inside the composer, never in the trigger: Connect is one field,
// Invite is a field plus a role, Add-a-brain is a two-step org then repo picker. All
// three are opened the same way and dismissed the same way.
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
