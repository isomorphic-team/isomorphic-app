// Class-name merge for the app's UI primitives.
//
// clsx composes; tailwind-merge resolves *conflicts*, which is the part that makes
// these primitives overridable. Without it, a call site passing `px-2` to a recipe
// whose default is `px-3.5` emits both classes and lets CSS source order decide,
// which is not something the call site can reason about. With it, the later class
// wins deterministically.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
