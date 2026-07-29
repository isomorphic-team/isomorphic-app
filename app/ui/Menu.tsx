// The menu-button popover: a trigger plus a dismissible list of choices.
//
// This is the "not a component library" note in index.ts being redrawn, on the
// criterion that file states — the app now HAS menus. There were two hand-rolled
// ones (the ⋯ overflow, the brain switcher) carrying identical dismiss effects, and
// the breadcrumb adds one PER SEGMENT, so the count went from two to unbounded. Three
// copies of a `document.mousedown` listener is where a primitive stops being
// speculative.
//
// Still hand-rolled, for Toolbar.tsx's reason: the menu-button pattern is small and
// fully specified (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). What it
// does NOT do is portal or flip — the panel is absolutely positioned inside the
// trigger's stacking context. That is fine here because every menu hangs off the top
// bar of a card that scrolls internally, and it is the point at which a positioning
// library (floating-ui) starts paying for itself.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from './cn.ts';
import { Button, type ButtonProps } from './Button.tsx';

/** Spread onto whatever element opens the menu. */
export type MenuTriggerProps = {
	onClick: () => void;
	'aria-haspopup': 'menu';
	'aria-expanded': boolean;
};

export function Menu({
	label,
	align = 'start',
	class: cls,
	panelClass,
	trigger,
	children
}: {
	/** Names the popup for assistive tech, e.g. "Brains" or "Pages in wiki". */
	label: string;
	/** Which edge the panel aligns to. `end` for a menu on the right of the bar. */
	align?: 'start' | 'end';
	class?: string;
	panelClass?: string;
	trigger: (t: {
		props: MenuTriggerProps;
		open: boolean;
		/** For a trigger with a second, non-opening action (a crumb label that navigates). */
		close: () => void;
	}) => ComponentChildren;
	children: (close: () => void) => ComponentChildren;
}) {
	const [open, setOpen] = useState(false);
	// Cap the panel to the space between the trigger and the bottom of the visible
	// viewport (the inline card IS the iframe, so window.innerHeight is the card's
	// visible height). Without this a short card clips the lower rows, since the card's
	// own overflow-y-auto contains the absolutely-positioned panel.
	const [maxH, setMaxH] = useState<number | null>(null);
	// Wraps the trigger. The panel is absolute, so it does not affect this rect — one
	// ref serves both the outside-click test and the measurement.
	const ref = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	const close = () => setOpen(false);

	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			setOpen(false);
			// Escape must land focus back on the trigger, or a keyboard user is dropped at
			// the top of the document.
			ref.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
		};
		document.addEventListener('mousedown', onDoc);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);

	useLayoutEffect(() => {
		if (!open) {
			setMaxH(null);
			return;
		}
		const measure = () => {
			const b = ref.current?.getBoundingClientRect().bottom ?? 0;
			setMaxH(Math.max(96, window.innerHeight - b - 8));
		};
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	}, [open]);

	const items = (): HTMLElement[] =>
		panelRef.current
			? Array.from(
					panelRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
				)
			: [];

	// Open with the first item focused: arrow keys then work immediately, and a mouse
	// user sees nothing (Button rings on focus-VISIBLE only).
	useEffect(() => {
		if (open) items()[0]?.focus();
	}, [open]);

	const onPanelKeyDown = (e: KeyboardEvent) => {
		const btns = items();
		if (!btns.length) return;
		const from = btns.indexOf(document.activeElement as HTMLElement);
		const move = (to: number) => {
			e.preventDefault();
			btns[((to % btns.length) + btns.length) % btns.length].focus();
		};
		if (e.key === 'ArrowDown') move(from + 1);
		else if (e.key === 'ArrowUp') move(from - 1);
		else if (e.key === 'Home') move(0);
		else if (e.key === 'End') move(btns.length - 1);
	};

	return (
		<div ref={ref} class={cn('relative shrink-0', cls)}>
			{trigger({
				props: {
					onClick: () => setOpen((o) => !o),
					'aria-haspopup': 'menu',
					'aria-expanded': open
				},
				open,
				close
			})}
			{open && (
				<div
					ref={panelRef}
					role="menu"
					aria-label={label}
					onKeyDown={onPanelKeyDown}
					style={maxH ? { maxHeight: `${maxH}px` } : undefined}
					class={cn(
						'absolute top-full z-20 mt-1 min-w-[168px] max-w-[80vw] overflow-y-auto overscroll-contain rounded-md border border-border bg-bg py-1 shadow-lg',
						align === 'end' ? 'right-0' : 'left-0',
						panelClass
					)}
				>
					{children(close)}
				</div>
			)}
		</div>
	);
}

/**
 * One choice in a Menu. The `row` button recipe with the menu's own metrics applied
 * once here, so the three menus in the chrome can't drift apart on padding again.
 */
export function MenuRow({ class: cls, ...rest }: ButtonProps) {
	return (
		<Button
			variant="row"
			role="menuitem"
			{...rest}
			class={cn('gap-2.5 rounded-none px-3 py-1.5 text-sm', cls)}
		/>
	);
}

export function MenuSeparator() {
	return <div role="separator" class="my-1 border-t border-border" />;
}

/** A non-interactive line inside a menu: a group label, "Loading…", "nothing here". */
export function MenuNote({
	class: cls,
	children
}: {
	class?: string;
	children: ComponentChildren;
}) {
	return <div class={cn('px-3 py-1.5 text-sm text-muted', cls)}>{children}</div>;
}
