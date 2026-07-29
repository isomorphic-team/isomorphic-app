// Text input and select, sharing one recipe.
//
// Both are the native elements. The select in particular stays native on purpose:
// its popup gets the platform's own keyboard handling and touch behaviour for free,
// which is worth more than being able to theme the popup. See MembersView.
import type { JSX } from 'preact';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.ts';

const control = cva(
	'rounded-md border border-border bg-transparent text-fg outline-none placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50',
	{
		variants: {
			size: {
				md: 'px-2.5 py-1.5 text-sm',
				sm: 'px-2 py-1 text-[13px]'
			}
		},
		defaultVariants: { size: 'md' }
	}
);

type ControlVariants = VariantProps<typeof control>;

export type InputProps = Omit<JSX.IntrinsicElements['input'], 'class' | 'size'> &
	ControlVariants & { class?: string };

export function Input({ size, class: cls, ...rest }: InputProps) {
	return <input {...rest} class={cn(control({ size }), cls)} />;
}

export type SelectProps = Omit<JSX.IntrinsicElements['select'], 'class' | 'size'> &
	ControlVariants & { class?: string };

export function Select({ size, class: cls, ...rest }: SelectProps) {
	return <select {...rest} class={cn(control({ size }), 'cursor-pointer', cls)} />;
}
