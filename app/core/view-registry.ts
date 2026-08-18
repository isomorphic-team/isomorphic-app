import type { VNode } from 'preact';

// Open registry of view kinds. Each routed view file augments this interface with
// `kind: propsType` via `declare module`. The `View` union is DERIVED from it, so
// adding a view kind requires no edit here.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ViewProps {}

export type View = {
	[K in keyof ViewProps]: { kind: K } & ViewProps[K];
}[keyof ViewProps];

/**
 * One entry in the header's right-hand action slot.
 *
 * The bar's rule (stated in main.tsx) is LEFT = where you are and where you can go,
 * RIGHT = what you can do HERE. "Here" is per-view, so views declare their own
 * actions rather than the header hardcoding a `view.kind === …` switch. Five views
 * had an empty slot and had to put their primary action in the body instead; this
 * is what closes that.
 */
export interface ViewAction {
	/** Stable identity for the render list. */
	key: string;
	/**
	 * Text label. PREFERRED for infrequent or non-obvious actions: a bare "＋" is
	 * self-evident on a file tree and not at all self-evident for "invite a person
	 * to your organization".
	 *
	 * Set alongside `icon` to give a glyph a value that belongs to it (the page's
	 * refresh control and the render's age). Reserve that pairing for a value the
	 * action REPORTS; a label that merely names the action duplicates `title`.
	 */
	label?: string;
	/** Icon, for frequent actions with a conventional glyph. Requires `title`. */
	icon?: VNode;
	/** Tooltip and accessible name. REQUIRED when the action is icon-only. */
	title?: string;
	onClick: () => void;
	/** Lit, for actions that reflect a toggle (the tree's "show hidden files"). */
	active?: boolean;
	disabled?: boolean;
	/** Accent emphasis. At most one per view: the affirmative action (Save). */
	primary?: boolean;
}

export interface ViewDef<K extends keyof ViewProps = keyof ViewProps> {
	kind: K;
	render: (view: Extract<View, { kind: K }>) => VNode;
	actions?: (view: Extract<View, { kind: K }>) => ViewAction[];
}

// Typed constructor: `kind` is constrained to a registered kind, and `render` and
// `actions` both receive the correctly-narrowed View member for that kind.
//
// `actions` is called on every header render, so it may read live state off the
// module-level control handles (treeCtl, editCtl) — those already bump()
// the store when they change, which is what re-renders the header.
export function defineView<K extends keyof ViewProps>(
	kind: K,
	render: (view: Extract<View, { kind: K }>) => VNode,
	opts?: { actions?: (view: Extract<View, { kind: K }>) => ViewAction[] }
): ViewDef<K> {
	return { kind, render, actions: opts?.actions };
}
