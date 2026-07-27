import type { VNode } from 'preact';

// Open registry of view kinds. Each routed view file augments this interface with
// `kind: propsType` via `declare module`. The `View` union is DERIVED from it, so
// adding a view kind requires no edit here.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ViewProps {}

export type View = {
	[K in keyof ViewProps]: { kind: K } & ViewProps[K];
}[keyof ViewProps];

export interface ViewDef<K extends keyof ViewProps = keyof ViewProps> {
	kind: K;
	render: (view: Extract<View, { kind: K }>) => VNode;
}

// Typed constructor: `kind` is constrained to a registered kind, and `render`
// receives the correctly-narrowed View member for that kind.
export function defineView<K extends keyof ViewProps>(
	kind: K,
	render: (view: Extract<View, { kind: K }>) => VNode
): ViewDef<K> {
	return { kind, render };
}
