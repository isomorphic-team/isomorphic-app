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
// fully specified (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). It does not
// PORTAL — the panel is absolutely positioned inside the trigger's stacking context —
// which is the point at which a positioning library (floating-ui) starts paying for
// itself. It does now FLIP, because the premise that used to make that unnecessary
// ("every menu hangs off the top bar") stopped being true when the rail put one at the
// BOTTOM of its column.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from './cn.ts';
import { Button, type ButtonProps } from './Button.tsx';

/** Breathing room kept between the panel and the edge of the card. */
const GAP = 8;
/** Below this many pixels, a side counts as cramped and the panel looks for a roomier one. */
const COMFORTABLE = 160;

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
	// WHICH SIDE THE PANEL OPENS ON, and how tall it may be. The inline card IS the
	// iframe, so window.innerHeight is the card's visible height.
	//
	// A PANEL MAY NEVER EXCEED THE ROOM ON ITS SIDE. It is absolutely positioned inside
	// the card, whose own overflow-y-auto contains it, so one that overflows does not
	// simply get clipped: it makes the CARD scrollable, and opening the menu focuses its
	// first row, which scrolls the card to reach it and drags the rail up out of sight.
	// The rail then reads as clipped by a too-short window, which is not what happened.
	// That is what a `Math.max(96, …)` floor here used to guarantee on a short card: on a
	// 170px browse card the ⋯ has 32px beneath it, and the panel was told to take 96.
	const [place, setPlace] = useState<{ up: boolean; maxH: number } | null>(null);
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
			setPlace(null);
			return;
		}
		const measure = () => {
			const r = ref.current?.getBoundingClientRect();
			if (!r) return;
			const below = window.innerHeight - r.bottom - GAP;
			const above = r.top - GAP;
			// Prefer opening downward, and flip only when down is cramped AND up is
			// roomier — the same rule a positioning library applies. Menus in the top bar
			// have almost nothing above them and so never flip; the rail's ⋯ sits at the
			// bottom of its column and, on a short card, always does.
			const up = below < COMFORTABLE && above > below;
			setPlace({ up, maxH: Math.max(0, up ? above : below) });
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
					style={place ? { maxHeight: `${place.maxH}px` } : undefined}
					class={cn(
						'absolute z-20 min-w-[168px] max-w-[80vw] overflow-y-auto overscroll-contain rounded-md border border-border bg-bg py-1 shadow-lg',
						place?.up ? 'bottom-full mb-1' : 'top-full mt-1',
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
