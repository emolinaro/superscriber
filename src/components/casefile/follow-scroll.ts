/**
 * Playback follow-scroll decision logic (player-pinned-center).
 *
 * The transcript follow centers the active segment in the scrollport
 * (scrollIntoView block: "center") so context stays visible on both sides
 * of the playing line. Follow is non-fighting: any user scroll gesture
 * pauses it, and it re-engages the moment the active line is visible in
 * the scrollport again - the same "only while you can see it" boundary the
 * previous nearest-edge alignment held - or immediately on an explicit
 * seek (segment timestamp click, rail chip, wave marker).
 *
 * The segment rail inside the pinned transport mirrors this contract on the
 * horizontal axis (wave-track scroll sync): the same decision matrix, the
 * same pause-on-user-gesture boundary, applied to the rail's scrollLeft so
 * the active segment's chip stays centered-ish while the transcript centers
 * the same segment vertically.
 *
 * These helpers are pure so the decision logic stays unit-testable without
 * relying on jsdom layout (jsdom reports zero geometry for everything).
 */

export type FollowDecision =
  /** Not paused: center the active segment. */
  | "center"
  /** Paused and the active segment left the scrollport: leave the user's reading position alone. */
  | "skip"
  /** Paused but the active segment is in view: re-engage and center. */
  | "resume";

export function decideFollowScroll(
  paused: boolean,
  activeRowVisible: boolean,
): FollowDecision {
  if (!paused) {
    return "center";
  }
  return activeRowVisible ? "resume" : "skip";
}

/**
 * Horizontal follow (wave-track scroll sync): the segment rail inside the
 * pinned transport is an independent horizontal scrollport that must keep
 * the active segment's chip visible - the same active segment the
 * transcript's vertical follow is centering. The non-fighting contract is
 * axis-agnostic, so the rail runs the exact same decision matrix through
 * decideFollowScroll; only the geometry changes axis. These helpers take
 * plain numbers so the sync math stays unit-testable without jsdom layout
 * (which reports zero geometry for everything).
 */

/** Geometry of the horizontally scrolling strip scrollport. */
export type HorizontalScrollport = {
  clientWidth: number;
  scrollLeft: number;
};

/**
 * Geometry of one target inside the strip's scrollable content, measured
 * from the content's leading edge (scrollLeft === 0 origin), not from the
 * scrollport's current left edge.
 */
export type HorizontalTarget = {
  offsetLeft: number;
  width: number;
};

/**
 * True when the target intersects the scrollport's horizontal bounds.
 * Partial intersection counts - the same visibility boundary the vertical
 * follow's nearest-edge heritage holds (a paused follow only re-engages
 * once the user can see any of the active chunk again).
 */
export function isTargetInHorizontalView(
  scrollport: HorizontalScrollport,
  target: HorizontalTarget,
): boolean {
  const viewStart = scrollport.scrollLeft;
  const viewEnd = scrollport.scrollLeft + scrollport.clientWidth;
  return target.offsetLeft + target.width > viewStart && target.offsetLeft < viewEnd;
}

/**
 * The scrollLeft that centers the target inside the scrollport
 * ("centered-ish" horizontal tracking, mirroring block: "center" on the
 * vertical axis). Clamped at zero; Element.scrollTo clamps the overshoot
 * at the far end itself, so only the leading clamp lives here.
 */
export function centeredHorizontalScrollLeft(
  scrollport: HorizontalScrollport,
  target: HorizontalTarget,
): number {
  return Math.max(0, target.offsetLeft + target.width / 2 - scrollport.clientWidth / 2);
}

/**
 * Keys that scroll the scrollport (and so count as a manual scroll gesture)
 * when pressed with focus outside an editor or slider.
 */
export const FOLLOW_SCROLL_PAUSE_KEYS = new Set([
  " ",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
]);

/** The nearest overflowing ancestor scrollport, or null for window scroll. */
export function findScrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * True when the row intersects its scrollport's vertical bounds (the window
 * viewport when no ancestor scrolls). Partial intersection counts - the
 * boundary mirrors the old nearest-edge alignment, which also fired only
 * once the active line had fully left the view.
 */
export function isRowInScrollView(row: HTMLElement): boolean {
  const rect = row.getBoundingClientRect();
  const parent = findScrollParent(row);
  const scrollTarget = parent ?? document.documentElement;
  const computedStyle = window.getComputedStyle(scrollTarget);
  const computedPaddingTop = Number.parseFloat(computedStyle.scrollPaddingTop);
  const computedPaddingBottom = Number.parseFloat(computedStyle.scrollPaddingBottom);
  const scrollPaddingTop = Number.isFinite(computedPaddingTop) ? computedPaddingTop : 0;
  const scrollPaddingBottom = Number.isFinite(computedPaddingBottom)
    ? computedPaddingBottom
    : 0;
  const top = (parent ? parent.getBoundingClientRect().top : 0) + scrollPaddingTop;
  const bottom =
    (parent ? parent.getBoundingClientRect().bottom : window.innerHeight) -
    scrollPaddingBottom;
  return rect.bottom > top && rect.top < bottom;
}
