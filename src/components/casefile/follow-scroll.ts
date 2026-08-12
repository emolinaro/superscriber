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
  const top = parent ? parent.getBoundingClientRect().top : 0;
  const bottom = parent ? parent.getBoundingClientRect().bottom : window.innerHeight;
  return rect.bottom > top && rect.top < bottom;
}
