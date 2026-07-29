// The app's UI primitives. Styling recipes over the existing `--c-*` design tokens,
// plus the one component (Toolbar) that carries real behaviour.
//
// Scope note: this layer exists because the views had drifted into ~130 distinct
// one-off class strings for what were really four buttons and one input. It is
// deliberately NOT a component library: a thing lands here once the app has several
// of it, never before. Menu is the first component added on that rule (the chrome
// went from two hand-rolled dropdowns to one per breadcrumb segment — see Menu.tsx).
// Still no dialog, popover or tooltip, because the app has none — and it does not
// need a dialog: see Flow.tsx for why an add-shaped action is a pushed VIEW in a
// bounded card. See Toolbar.tsx for where a dependency would start paying.
export { cn } from './cn.ts';
export { Button, type ButtonProps } from './Button.tsx';
export { List, ListRow, listRowTitle, type ListRowProps } from './List.tsx';
export { Flow, FlowNote, type FlowProps } from './Flow.tsx';
export {
	eyebrow,
	viewTitle,
	crumbCurrent,
	crumbLink,
	crumbInert,
	crumbMeta
} from './typography.ts';
export { Input, Select, type InputProps, type SelectProps } from './Input.tsx';
export { Toolbar, ToolbarButton, ToolbarSeparator, type ToolbarButtonProps } from './Toolbar.tsx';
export { Menu, MenuRow, MenuSeparator, MenuNote, type MenuTriggerProps } from './Menu.tsx';
