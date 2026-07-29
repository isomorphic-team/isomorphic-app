// WAI-ARIA toolbar: one Tab stop, arrow keys to move within it.
//
// The formatting toolbar was a bare <div> of twelve <button>s, which meant Tab
// stepped through all twelve on the way to the editor, the active state of a toggle
// was carried by background colour alone (invisible to a screen reader), and there
// was no container role tying the group together. This implements the authoring
// practice for toolbars: https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
//
// Deliberately hand-rolled. The toolbar pattern is small and fully specified, so it
// does not justify a dependency. Tooltip is the one in this area that genuinely
// would (delay grouping, dismissal, touch, positioning) — the buttons here still use
// native `title`, and swapping that out is the point at which a headless library
// starts paying for itself.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.ts';

export function Toolbar({
	label,
	class: cls,
	children
}: {
	/** Names the group for assistive tech, e.g. "Formatting". */
	label: string;
	class?: string;
	children: ComponentChildren;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// Which button currently owns the tab stop. A ref, not state: moving the roving
	// index must not re-render the editor's toolbar on every arrow key.
	const activeIdx = useRef(0);

	const items = (): HTMLButtonElement[] =>
		ref.current
			? Array.from(ref.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
			: [];

	const assign = (next: number, moveFocus: boolean) => {
		const btns = items();
		if (!btns.length) return;
		const i = ((next % btns.length) + btns.length) % btns.length;
		activeIdx.current = i;
		for (let j = 0; j < btns.length; j++) btns[j].tabIndex = j === i ? 0 : -1;
		if (moveFocus) btns[i].focus();
	};

	// Re-assert the single tab stop after EVERY render, not just on mount: the editor
	// bumps the store on each transaction, so this component re-renders constantly and
	// Preact would otherwise reset the tabIndex properties we set imperatively.
	useLayoutEffect(() => {
		const btns = items();
		if (!btns.length) return;
		const i = Math.min(activeIdx.current, btns.length - 1);
		activeIdx.current = i;
		for (let j = 0; j < btns.length; j++) btns[j].tabIndex = j === i ? 0 : -1;
	});

	// Focus can land on a button without going through our key handler (a click, or
	// the browser restoring focus). Keep the roving index in step so the next arrow
	// key moves from where the user actually is. Bound imperatively because `focus`
	// does not bubble — `focusin` is the delegating form.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onFocusIn = (e: FocusEvent) => {
			const i = items().indexOf(e.target as HTMLButtonElement);
			if (i >= 0) activeIdx.current = i;
		};
		el.addEventListener('focusin', onFocusIn);
		return () => el.removeEventListener('focusin', onFocusIn);
	}, []);

	const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
		const from = items().indexOf(document.activeElement as HTMLButtonElement);
		if (from < 0) return; // focus is somewhere else in the row; leave it alone
		const move = (to: number) => {
			e.preventDefault();
			assign(to, true);
		};
		if (e.key === 'ArrowRight') move(from + 1);
		else if (e.key === 'ArrowLeft') move(from - 1);
		else if (e.key === 'Home') move(0);
		else if (e.key === 'End') move(items().length - 1);
	};

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label={label}
			aria-orientation="horizontal"
			onKeyDown={onKeyDown}
			class={cn('flex flex-wrap items-center gap-0.5', cls)}
		>
			{children}
		</div>
	);
}

const toolbarButton = cva(
	'min-w-7 rounded px-1.5 py-1 text-sm leading-none outline-none transition-colors hover:bg-chip focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
	{
		variants: { pressed: { true: 'bg-chip text-accent', false: 'text-fg' } },
		defaultVariants: { pressed: false }
	}
);

export type ToolbarButtonProps = Omit<JSX.IntrinsicElements['button'], 'class'> &
	Omit<VariantProps<typeof toolbarButton>, 'pressed'> & {
		class?: string;
		/**
		 * Toggle state. Omit entirely for buttons that are COMMANDS rather than
		 * toggles (undo, redo, "wrap in list"): `aria-pressed="false"` on a command
		 * tells a screen reader it is an un-engaged toggle, which is a lie. Undefined
		 * here means the attribute is not emitted at all.
		 */
		pressed?: boolean;
	};

export function ToolbarButton({ pressed, class: cls, ...rest }: ToolbarButtonProps) {
	return (
		<button
			type="button"
			{...rest}
			aria-pressed={pressed}
			class={cn(toolbarButton({ pressed: pressed === true }), cls)}
		/>
	);
}

export function ToolbarSeparator() {
	return <span role="separator" aria-orientation="vertical" class="mx-0.5 h-4 w-px bg-border" />;
}
