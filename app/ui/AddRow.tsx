// "Add a thing to this list", as one flow.
//
// Three screens each invented their own: Members and Connected accounts pinned an
// always-visible form ABOVE the list, Manage brains put a boxed button BELOW it that
// toggled a panel. The file tree already had the good version (Browse.tsx), and this
// generalises it:
//
//   * The composer opens WHERE THE RESULT WILL LAND — the trigger row is replaced in
//     place — so there is no "where did it go" moment after committing.
//   * Nothing permanent on screen while reading, which is the common case. You open
//     Members to see who is there far more often than to invite someone.
//   * Escape cancels, from anywhere inside the composer.
//
// The trigger and its position are identical across all three screens; only what
// unfolds differs (one field / field + role / a two-step picker). Complexity belongs
// inside the reveal, never in the trigger.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from './Button.tsx';
import { cn } from './cn.ts';

export type AddRowProps = {
	/** The action, as a verb phrase: "Invite member". Reused verbatim on the trigger. */
	label: string;
	/** The composer. Gets `close` so its cancel/commit paths can dismiss the row. */
	children: (api: { close: () => void }) => ComponentChildren;
	/**
	 * Controlled open state. Omit for the common case (AddRow owns it); pass it when
	 * the composer has state of its own to reset on close, as Manage brains does.
	 */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/**
	 * Render the trigger as a filled primary button rather than a quiet list row.
	 * For empty states: a muted row at the bottom of nothing is the wrong emphasis
	 * when adding is the only thing left to do.
	 */
	promoted?: boolean;
	class?: string;
};

export function AddRow({
	label,
	children,
	open: openProp,
	onOpenChange,
	promoted,
	class: cls
}: AddRowProps) {
	const [selfOpen, setSelfOpen] = useState(false);
	const open = openProp ?? selfOpen;
	const set = (v: boolean) => {
		if (openProp === undefined) setSelfOpen(v);
		onOpenChange?.(v);
	};
	const close = () => set(false);

	if (!open) {
		return (
			<li class={cls}>
				<Button
					variant={promoted ? 'primary' : 'row'}
					onClick={() => set(true)}
					class={promoted ? 'mt-3' : 'gap-1.5 py-1.5 text-muted hover:text-fg'}
				>
					<span aria-hidden="true">＋</span>
					{label}
				</Button>
			</li>
		);
	}

	return (
		<li
			class={cn('py-1.5', cls)}
			// Escape anywhere in the composer dismisses it, matching the tree's inline
			// rename/create row. stopPropagation so it does not also close a surrounding
			// menu or the host's own overlay.
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					close();
				}
			}}
		>
			{children({ close })}
		</li>
	);
}

// No Enter-to-commit helper here on purpose: every composer that takes a text field
// wraps it in a <form>, which gives Enter-to-submit natively. The tree needs its own
// keydown handler only because its inline row is not a form.
