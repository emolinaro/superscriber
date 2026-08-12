// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOLLOW_SCROLL_PAUSE_KEYS,
  decideFollowScroll,
  findScrollParent,
  isRowInScrollView,
} from "./follow-scroll";

describe("decideFollowScroll", () => {
  it("centers the active segment while follow is engaged", () => {
    expect(decideFollowScroll(false, true)).toBe("center");
    // Engaged follow centers regardless of visibility - the whole point is
    // to bring the active line to mid-window.
    expect(decideFollowScroll(false, false)).toBe("center");
  });

  it("skips the scroll while paused and the active line is out of view", () => {
    expect(decideFollowScroll(true, false)).toBe("skip");
  });

  it("resumes follow when the active line is back in view", () => {
    expect(decideFollowScroll(true, true)).toBe("resume");
  });
});

describe("FOLLOW_SCROLL_PAUSE_KEYS", () => {
  it("covers the page-scroll keys only", () => {
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("PageDown")).toBe(true);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("PageUp")).toBe(true);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("Home")).toBe(true);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("End")).toBe(true);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("ArrowDown")).toBe(true);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("ArrowUp")).toBe(true);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has(" ")).toBe(true);
    // ArrowLeft/ArrowRight seek on the wave slider; they never scroll the
    // transcript scrollport, so they must not pause follow.
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("ArrowLeft")).toBe(false);
    expect(FOLLOW_SCROLL_PAUSE_KEYS.has("ArrowRight")).toBe(false);
  });
});

function fakeRect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("isRowInScrollView", () => {
  it("uses the window viewport when no ancestor scrolls", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);

    row.getBoundingClientRect = () => fakeRect(100, 180);
    expect(isRowInScrollView(row)).toBe(true);

    // jsdom's window.innerHeight is 768: a row fully below it is out of view.
    row.getBoundingClientRect = () => fakeRect(900, 980);
    expect(isRowInScrollView(row)).toBe(false);

    // A row fully above the viewport is out of view too.
    row.getBoundingClientRect = () => fakeRect(-200, -120);
    expect(isRowInScrollView(row)).toBe(false);

    row.remove();
  });

  it("uses the nearest overflowing ancestor scrollport bounds", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { value: 300 });
    Object.defineProperty(scroller, "scrollHeight", { value: 900 });
    scroller.getBoundingClientRect = () => fakeRect(200, 500);

    const row = document.createElement("div");
    scroller.appendChild(row);
    document.body.appendChild(scroller);

    // Inside the scrollport (200-500).
    row.getBoundingClientRect = () => fakeRect(250, 300);
    expect(isRowInScrollView(row)).toBe(true);

    // Beyond the scrollport bottom but still inside the window viewport:
    // must count as out of view (window matches would false-positive here).
    row.getBoundingClientRect = () => fakeRect(540, 600);
    expect(isRowInScrollView(row)).toBe(false);

    // Above the scrollport top.
    row.getBoundingClientRect = () => fakeRect(100, 160);
    expect(isRowInScrollView(row)).toBe(false);

    scroller.remove();
  });
});

describe("findScrollParent", () => {
  it("walks past non-scrolling ancestors to the overflowing scrollport", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    Object.defineProperty(outer, "clientHeight", { value: 200 });
    Object.defineProperty(outer, "scrollHeight", { value: 800 });

    const inner = document.createElement("div");
    const row = document.createElement("div");
    inner.appendChild(row);
    outer.appendChild(inner);
    document.body.appendChild(outer);

    expect(findScrollParent(row)).toBe(outer);
    expect(findScrollParent(outer)).toBeNull();

    outer.remove();
  });

  it("ignores auto-overflow ancestors that do not actually overflow", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    Object.defineProperty(outer, "clientHeight", { value: 200 });
    Object.defineProperty(outer, "scrollHeight", { value: 200 });

    const row = document.createElement("div");
    outer.appendChild(row);
    document.body.appendChild(outer);

    expect(findScrollParent(row)).toBeNull();

    outer.remove();
  });
});
