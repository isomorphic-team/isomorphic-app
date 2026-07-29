// The shell every multi-step / add-shaped flow renders into.
//
// WHY A FLOW IS A VIEW. In the default `inline` display mode the card IS a bounded
// box in the conversation, which is structurally what a dialog is. `position: fixed`
// resolves against the IFRAME, so an overlay would be a box inside a short box,
// covering the very list it is adding to (OverflowMenu already has to clamp its
// dropdown to `window.innerHeight` or "a short card clips the lower menu items").
// A pushed view instead takes the whole card — the space a dialog wanted — and
// inherits the breadcrumb, goBack() and the header's action slot, so it needs no
// focus trap, no scrim, no z-index and no height clamping. Overlays stay right for
// destructive confirmation (askConfirm), where blocking IS the point.
//
// WHY A SHARED SHELL. Four flows now render this way (create brain, add brain,
// invite member, connect account). They previously carried four copies of the same
// centred column, and this whole branch has been unwinding exactly that kind of
// copy. One definition means the title size, the column width, the gap above the
// footer and the Cancel treatment cannot drift apart between them.
//
// The inline composer this replaced is gone. The one place a form still opens INSIDE
// a list is the file tree's create/rename row, and that is a different thing: the
// row's POSITION in the tree is part of the input (it is where the page will live),
// which is not true of any of these.
import type { ComponentChildren, VNode } from 'preact';
import { cn } from './cn.ts';
import { viewTitle } from './typography.ts';

export type FlowProps = {
	/** Optional glyph above the title. Decorative; the title carries the meaning. */
	icon?: VNode;
	title: string;
	/** One line saying what happens next. Skip it when the title is self-evident. */
	subtitle?: string;
	children: ComponentChildren;
	/** Buttons. Always includes the way out — a flow with no exit is a trap. */
	footer?: ComponentChildren;
	class?: string;
};

export function Flow({ icon, title, subtitle, children, footer, class: cls }: FlowProps) {
	return (
		<div class={cn('mx-auto mt-10 max-w-md px-4', cls)}>
			<div class="text-center">
				{icon && (
					<div class="mb-3 flex justify-center text-muted" aria-hidden="true">
						{icon}
					</div>
				)}
				<h2 class={viewTitle}>{title}</h2>
				{subtitle && <p class="mx-auto mt-1 max-w-xs text-sm text-muted">{subtitle}</p>}
			</div>
			<div class="mt-5">{children}</div>
			{footer && <div class="mt-4 flex justify-center gap-2">{footer}</div>}
		</div>
	);
}

/** A bordered aside inside a flow: loading, empty, an error, or a result to act on. */
export function FlowNote({
	children,
	class: cls
}: {
	children: ComponentChildren;
	class?: string;
}) {
	return (
		<div class={cn('rounded-md border border-border px-3 py-2.5 text-sm text-muted', cls)}>
			{children}
		</div>
	);
}
