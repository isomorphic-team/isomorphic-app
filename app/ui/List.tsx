// The list-screen row: Recent changes, Members, Manage brains, Connected accounts.
//
// These four screens each carried their own copy of
//   flex items-center gap-3 border-b border-border py-2.5 last:border-b-0
// which is how they drifted away from the rest of the app. One definition now.
//
// The rhythm is deliberately the FILE TREE's, not a table's:
//
//   * py-1.5 and gap-2, a half-step looser than the tree's py-1/gap-1.5 because
//     these rows carry two lines of text where a tree row carries one.
//   * No per-row rule. A hairline under every row is a table device, and it was
//     the thing making these screens read as a different component family. The
//     tree conveys structure through indentation and spacing alone; so do these.
//   * Row titles inherit the chrome's 13.5px base (see styles.css) rather than
//     falling through to the user agent's 16px, which is what made list screens
//     render ~19% larger than everything around them.
//
// `divided` is an escape hatch for a list that genuinely IS tabular. Nothing uses
// it today; it exists so the next such screen reaches for a named option instead
// of hand-rolling a fifth row class.
import type { ComponentChildren, JSX } from 'preact';
import { cn } from './cn.ts';

export function List({ class: cls, children }: { class?: string; children: ComponentChildren }) {
	return <ul class={cn('flex flex-col', cls)}>{children}</ul>;
}

export type ListRowProps = Omit<JSX.IntrinsicElements['li'], 'class'> & {
	class?: string;
	divided?: boolean;
	children: ComponentChildren;
};

export function ListRow({ class: cls, divided, children, ...rest }: ListRowProps) {
	return (
		<li
			{...rest}
			class={cn(
				'flex items-center gap-2 py-1.5',
				divided && 'border-b border-border last:border-b-0',
				cls
			)}
		>
			{children}
		</li>
	);
}

/**
 * The clickable title inside a ListRow. Matches the file tree's row-title
 * behaviour: colour-shift on hover, no background fill, no underline until focus.
 */
export const listRowTitle =
	'min-w-0 flex-1 truncate text-left font-medium text-fg transition-colors hover:text-accent focus-visible:underline';
