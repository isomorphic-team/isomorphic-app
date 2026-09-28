// The app's UI primitives. Styling recipes over the existing `--c-*` design tokens,
// plus the few components that carry real behaviour (Toolbar, Menu, Flow).
//
// Scope note: this layer exists because the views had drifted into ~130 distinct
// one-off class strings for what were really four buttons and one input. It is
// deliberately NOT a component library: a thing lands here once the app has several
// of it, never before. Menu is the one popover, with one caller left (see Menu.tsx).
// No dialog or tooltip, because the app has none, and it does not need a dialog: see
// Flow.tsx for why an add-shaped action is a pushed VIEW in a bounded card. See
// Toolbar.tsx for where a dependency would start paying.
export { cn } from './cn.ts';
export { Button, type ButtonProps } from './Button.tsx';
export { List, ListRow, listRowTitle, type ListRowProps } from './List.tsx';
export { Flow, FlowNote, submitOnEnter, type FlowProps } from './Flow.tsx';
export { eyebrow, viewTitle, crumbCurrent, crumbLink, crumbMeta } from './typography.ts';
export { Input, Select, type InputProps, type SelectProps } from './Input.tsx';
export { Toolbar, ToolbarButton, ToolbarSeparator, type ToolbarButtonProps } from './Toolbar.tsx';
export { Menu, MenuRow, MenuSeparator, MenuNote, type MenuTriggerProps } from './Menu.tsx';
