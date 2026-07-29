// The app's button recipe.
//
// Derived from what the views were already doing rather than invented: before this
// existed there were four near-identical "primary" strings that had drifted apart on
// padding (px-3 vs px-3.5), type scale (text-sm vs text-[13px]), disabled opacity
// (50 vs 60), and whether they carried a transition at all. The variants below are
// the union of those, normalized to one value each.
//
// Styling only. These are plain <button>s: no portal, no focus management, nothing
// that would need a headless library. If a real dialog/menu/tooltip ever lands, that
// is the point to reach for one, not this file.
import type { JSX } from 'preact';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.ts';

const button = cva(
	'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50',
	{
		variants: {
			variant: {
				/** Filled accent. The one affirmative action in a view (Save, Invite, Create). */
				primary: 'bg-accent text-white transition-opacity hover:opacity-90',
				/** Bordered. Secondary actions that sit next to a primary one (Cancel). */
				outline: 'border border-border bg-transparent text-fg transition-colors hover:bg-chip',
				/** Unfilled, muted until hover. Row actions and icon buttons. */
				ghost: 'font-normal text-muted transition-colors hover:bg-chip hover:text-fg',
				/** Text-weight accent. Inline actions inside prose or a list row. */
				subtle: 'text-accent transition-colors hover:bg-chip',
				/**
				 * Looks like a link, is a button. For actions that read as navigation
				 * ("Review PR ↗", a brain name). Padding is forced off below, so the
				 * `size` variant only sets the type scale here.
				 */
				link: 'border-none bg-transparent font-normal text-accent underline-offset-2 hover:underline',
				/** Full-width left-aligned row, for pick-one lists and menus. */
				row: 'w-full justify-start gap-2 rounded text-left font-normal text-fg transition-colors hover:bg-chip'
			},
			size: {
				md: 'px-3.5 py-1.5 text-sm',
				sm: 'px-2.5 py-1 text-[13px]',
				xs: 'px-1.5 py-1 text-xs',
				/** Square, for a single glyph. Needs an aria-label at the call site. */
				icon: 'rounded p-1'
			}
		},
		// cva emits compound classes last, and tailwind-merge treats `p-*` as
		// conflicting with `px-*`/`py-*`, so this reliably strips whatever padding the
		// `size` variant added rather than depending on CSS source order.
		compoundVariants: [{ variant: 'link', class: 'p-0' }],
		defaultVariants: { variant: 'primary', size: 'md' }
	}
);

export type ButtonProps = Omit<JSX.IntrinsicElements['button'], 'class' | 'size'> &
	VariantProps<typeof button> & { class?: string };

export function Button({ variant, size, class: cls, ...rest }: ButtonProps) {
	// type defaults to "button" so a button inside a <form> doesn't submit it by
	// accident; call sites that want a submit pass type="submit" and win the spread.
	return <button type="button" {...rest} class={cn(button({ variant, size }), cls)} />;
}
