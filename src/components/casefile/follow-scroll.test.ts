// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOLLOW_SCROLL_PAUSE_KEYS,
  centeredHorizontalScrollLeft,
  decideFollowScroll,
  findScrollParent,
  isRowInScrollView,
  isTargetInHorizontalView,
} from "./follow-scroll";

describe("decideFollowScroll", () => {
  it("keeps follow dormant before playback or an accepted explicit seek moves the track", () => {
    expect(decideFollowScroll(false, false, true)).toBe("dormant");
    expect(decideFollowScroll(false, true, false)).toBe("dormant");
    expect(decideFollowScroll(false, false, false)).toBe("dormant");
  });

  it("centers the active segment while follow is engaged", () => {
    expect(decideFollowScroll(true, false, true)).toBe("center");
    // Engaged follow centers regardless of visibility - the whole point is
    // to bring the active line to the viewport middle.
    expect(decideFollowScroll(true, false, false)).toBe("center");
  });

  it("skips the scroll while paused and the active line is out of view", () => {
    expect(decideFollowScroll(true, true, false)).toBe("skip");
  });

  it("resumes follow when the active line is back in view", () => {
    expect(decideFollowScroll(true, true, true)).toBe("resume");
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

  it("excludes window content hidden by scroll padding", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    document.documentElement.style.scrollPaddingTop = "120px";

    row.getBoundingClientRect = () => fakeRect(80, 110);
    expect(isRowInScrollView(row)).toBe(false);

    row.getBoundingClientRect = () => fakeRect(130, 180);
    expect(isRowInScrollView(row)).toBe(true);

    document.documentElement.style.removeProperty("scroll-padding-top");
    row.remove();
  });

  it("excludes window content hidden by bottom scroll padding", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    document.documentElement.style.scrollPaddingBottom = "100px";

    row.getBoundingClientRect = () => fakeRect(700, 750);
    expect(isRowInScrollView(row)).toBe(false);

    row.getBoundingClientRect = () => fakeRect(620, 680);
    expect(isRowInScrollView(row)).toBe(true);

    document.documentElement.style.removeProperty("scroll-padding-bottom");
    row.remove();
  });

  it("excludes scrollport content hidden by scroll padding", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.style.scrollPaddingTop = "100px";
    Object.defineProperty(scroller, "clientHeight", { value: 300 });
    Object.defineProperty(scroller, "scrollHeight", { value: 900 });
    scroller.getBoundingClientRect = () => fakeRect(200, 500);

    const row = document.createElement("div");
    scroller.appendChild(row);
    document.body.appendChild(scroller);

    row.getBoundingClientRect = () => fakeRect(250, 280);
    expect(isRowInScrollView(row)).toBe(false);

    row.getBoundingClientRect = () => fakeRect(310, 360);
    expect(isRowInScrollView(row)).toBe(true);

    scroller.remove();
  });

  it("excludes scrollport content hidden by bottom scroll padding", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.style.scrollPaddingBottom = "80px";
    Object.defineProperty(scroller, "clientHeight", { value: 300 });
    Object.defineProperty(scroller, "scrollHeight", { value: 900 });
    scroller.getBoundingClientRect = () => fakeRect(200, 500);

    const row = document.createElement("div");
    scroller.appendChild(row);
    document.body.appendChild(scroller);

    row.getBoundingClientRect = () => fakeRect(430, 470);
    expect(isRowInScrollView(row)).toBe(false);

    row.getBoundingClientRect = () => fakeRect(370, 410);
    expect(isRowInScrollView(row)).toBe(true);

    scroller.remove();
  });
});

describe("findScrollParent", () => {
  it("walks past non-scrolling ancestors to the declared scrollport", () => {
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

  it("keeps an auto-overflow ancestor as the scroll owner before it overflows", () => {
    // casefile-pin-transcript-zone: the transcript viewport is a declared
    // scroller even on short transcripts that fit without overflow, so
    // centering and visibility checks must target it from the start.
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    Object.defineProperty(outer, "clientHeight", { value: 200 });
    Object.defineProperty(outer, "scrollHeight", { value: 200 });

    const row = document.createElement("div");
    outer.appendChild(row);
    document.body.appendChild(outer);

    expect(findScrollParent(row)).toBe(outer);

    outer.remove();
  });
});

describe("isTargetInHorizontalView (wave-track scroll sync)", () => {
  const scrollport = { clientWidth: 400, scrollLeft: 100 };

  it("counts any partial intersection as visible, mirroring the vertical boundary", () => {
    // Fully inside the view window (100-500).
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: 200, width: 120 })).toBe(true);
    // Trailing edge pokes in from the right.
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: 480, width: 120 })).toBe(true);
    // Leading edge pokes in from the left.
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: 20, width: 120 })).toBe(true);
  });

  it("treats fully out-of-window targets as not visible, edges exclusive", () => {
    // Entirely to the right.
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: 520, width: 120 })).toBe(false);
    // Entirely to the left.
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: 0, width: 80 })).toBe(false);
    // Exactly touching the trailing edge does not intersect.
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: 500, width: 120 })).toBe(false);
    // Exactly touching the leading edge does not intersect either.
    expect(isTargetInHorizontalView(scrollport, { offsetLeft: -20, width: 120 })).toBe(false);
  });

  it("tracks the scrolled position, not the content origin", () => {
    const target = { offsetLeft: 520, width: 120 };
    expect(isTargetInHorizontalView({ clientWidth: 400, scrollLeft: 100 }, target)).toBe(false);
    expect(isTargetInHorizontalView({ clientWidth: 400, scrollLeft: 300 }, target)).toBe(true);
  });
});

describe("centeredHorizontalScrollLeft (wave-track scroll sync)", () => {
  it("centers the target chunk in the scrollport", () => {
    // Content offset 600, width 100 -> center 650; scrollport 400 wide -> 450.
    expect(
      centeredHorizontalScrollLeft(
        { clientWidth: 400, scrollLeft: 0 },
        { offsetLeft: 600, width: 100 },
      ),
    ).toBe(450);
  });

  it("clamps at the leading edge (already-near-start chunks center at zero)", () => {
    expect(
      centeredHorizontalScrollLeft(
        { clientWidth: 400, scrollLeft: 300 },
        { offsetLeft: 100, width: 100 },
      ),
    ).toBe(0);
  });

  it("does not clamp the far end (scrollTo owns the content-length clamp)", () => {
    expect(
      centeredHorizontalScrollLeft(
        { clientWidth: 400, scrollLeft: 0 },
        { offsetLeft: 5000, width: 100 },
      ),
    ).toBe(4850);
  });
});
