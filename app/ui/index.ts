// The app's UI primitives. Styling recipes over the existing `--c-*` design tokens,
// plus the one component (Toolbar) that carries real behaviour.
//
// Scope note: this layer exists because the views had drifted into ~130 distinct
// one-off class strings for what were really four buttons and one input. It is
// deliberately NOT a component library — there is no dialog, menu, popover or
// tooltip here, because the app does not have any yet. (Nor does it need a dialog:
// see Flow.tsx for why an add-shaped action is a pushed VIEW in a bounded card.)
// See Toolbar.tsx for where that line would get redrawn.
export { cn } from './cn.ts';
export { Button, type ButtonProps } from './Button.tsx';
export { List, ListRow, listRowTitle, type ListRowProps } from './List.tsx';
export { Flow, FlowNote, type FlowProps } from './Flow.tsx';
export { eyebrow, viewTitle } from './typography.ts';
export { Input, Select, type InputProps, type SelectProps } from './Input.tsx';
export { Toolbar, ToolbarButton, ToolbarSeparator, type ToolbarButtonProps } from './Toolbar.tsx';
