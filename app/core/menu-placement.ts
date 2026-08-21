// WHERE A POPOVER GOES, and how tall it may be. Pure, so the rule can be pinned by a
// node test (`pnpm test:policy`) rather than inferred from a screenshot.
//
// This app renders inline as a CARD in the chat column: it sizes to its content up to a
// cap and then scrolls within itself. A panel is absolutely positioned inside that card,
// so one taller than the room on its side does not merely get clipped — it makes the
// CARD scrollable, and opening a menu focuses its first row, which scrolls the card to
// reach it and drags the chrome out of sight. It then reads as a rail clipped by a
// too-short window, which is not what happened.
//
// It lives here rather than inside ui/Menu.tsx because there are TWO popovers: the Menu
// primitive, and the file tree's per-row ⋯, which is hand-rolled so it can hang off a
// row the tree already owns the open-state of. The tree's one had no cap at all and
// overflowed a short card by ~50px. One rule, two callers, is the only arrangement this
// codebase has not eventually found drifted.

/** Breathing room kept between the panel and the edge of the card. */
export const GAP = 8;
/** Under this many pixels a side counts as cramped, and the panel looks for a roomier one. */
export const COMFORTABLE = 160;

export type Placement = {
	/** Open upward, above the trigger, rather than below it. */
	up: boolean;
	/** Hard cap. The panel scrolls internally past this rather than growing. */
	maxH: number;
};

/**
 * Place a panel against its trigger.
 *
 * Prefers opening downward and flips only when down is cramped AND up is roomier, which
 * is the rule a positioning library applies. A menu in the top bar has almost nothing
 * above it and so never flips; one at the bottom of a column in a short card always
 * does.
 *
 * @param trigger  the trigger's viewport rect (`top` and `bottom` are all that matter)
 * @param viewportH  the card's visible height — inside the iframe that IS window.innerHeight
 */
export function panelPlacement(
	trigger: { top: number; bottom: number },
	viewportH: number
): Placement {
	const below = viewportH - trigger.bottom - GAP;
	const above = trigger.top - GAP;
	const up = below < COMFORTABLE && above > below;
	return { up, maxH: Math.max(0, up ? above : below) };
}
