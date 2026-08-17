import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  approverUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  execRuntimeSql,
  login,
  openAssignedDraft,
  openCasefile,
  queryRuntimeRows,
  reviewerUser,
  sharedCasefile,
  uploadFixture,
} from "./support/appliance";

// Visible-context casefile spec (fm/superscriber-visible-context-spec): on the
// canonical desktop viewport (1280x800) the casefile transcript editing
// surface - review mode AND approver mode, audio AND video - keeps every
// segment at its natural height (no line clamps, no truncation, no expand
// affordances), the transcript scrollport scrolls end to end, interior ACTIVE
// segments sit in its exact middle while the track plays, and its first and
// final segments anchor to the corresponding edge. At least five context
// segments stay visible around a centered row. Video holds the 5-10 acceptance
// band; audio shows more whenever room allows.
//
// Media workbench (captain's standing laws, round 1 live-pilot receipts):
// the player PINS and never scrolls away in a band above the horizontally
// centered transcript column. The transcript zone always shares the first
// viewport, so the first segment card is reachable without any scroll. The
// video's rendered height is bounded (max 32.5vh); video keeps its frame and
// native controls, and audio keeps the full transport.
//
// Horizontal centering stays viewport-relative. Vertical alignment and context
// visibility use the transcript scrollport's actual unobscured bounds.

const CANONICAL_VIEWPORT = { width: 1280, height: 800 };
// Centering tolerance covers sub-pixel rounding and cross-lane font metric
// drift around the exact viewport middle.
const CENTER_TOLERANCE_PX = 24;
const MIN_CONTEXT = 5;
const MIN_CONTEXT_EACH_SIDE = 2;
const MAX_VIDEO_CONTEXT = 10;
// Audio deliberately uses the taller available transcript viewport. This
// loose guard catches runaway density regressions without imposing video's
// acceptance ceiling.
const MAX_AUDIO_CONTEXT_GUARD = 16;
// Video frame bound (matches casefile.css max-height: 32.5vh).
const VIDEO_MAX_VH = 0.325;

type SegmentSeed = {
  id: string;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
};

// 24 segments over 240s: a short/medium/long rhythm ([short, mid, long,
// short, short]) with a genuinely long utterance every fifth segment so
// the band holds across short -> long transitions - longs sit between
// short neighbors, which is what makes the 5-segment combined floor
// physically reachable inside a 723px working band. One card is an
// extreme monster (~630 characters) that only serves the no-clamp proof;
// no band assertion runs with the monster as the active row's neighbor
// because a card that tall cannot physically share the band with four
// whole neighbors (accepted outlier of "never clamp", same idea as the
// single >800px-segment outlier from the review gates).
const MONSTER_INDEX = 22;

function buildSegmentSeeds(recordingId: string, label: string): SegmentSeed[] {
  const short = (n: number) => `${label} segment ${n}: a brief note.`;
  const mid = (n: number) =>
    `${label} segment ${n}: the speaker walks through the timeline of the interview and confirms the sequence of events for the record.`;
  const long = (n: number) =>
    `${label} segment ${n}: a genuinely long utterance keeping every sentence on the card. The speaker covers the initial outreach, the on-site visit, and the follow-up calls with the coordination team, all standing on the card at once with no expand control and no ellipsis.`;
  const monster = (n: number) =>
    `${label} segment ${n}: a deliberately extreme segment proving the layout never clamps or truncates card content. The speaker gives full background on the case, covering the initial outreach, the on-site visit, the follow-up calls with the coordination team, and the written summary that was circulated afterwards. Every sentence stays visible in the transcript at all times, because reviewers must be able to read the complete record while playback follows the active segment. No expand control, no ellipsis, no hidden copy - the full text stands on the card and the card grows to fit it.`;
  const seeds: SegmentSeed[] = [];
  for (let i = 0; i < 24; i += 1) {
    const n = i + 1;
    const kind = i % 5;
    const monsterHere = i === MONSTER_INDEX;
    seeds.push({
      id: `${recordingId}-vc-segment-${n}`,
      speakerLabel: i % 2 === 0 ? "Speaker A" : "Speaker B",
      startMs: i * 10_000,
      endMs: (i + 1) * 10_000,
      text: monsterHere ? monster(n) : kind === 2 ? long(n) : kind === 1 ? mid(n) : short(n),
      confidence: monsterHere || kind === 2 ? 0.81 : 0.93,
    });
  }
  return seeds;
}

function segmentRow(page: Page, oneBasedIndex: number) {
  return page.getByRole("article", {
    name: new RegExp(`Transcript segment ${oneBasedIndex}, `),
  });
}

async function seekSegment(page: Page, oneBasedIndex: number) {
  const windowScrollY = await page.evaluate(() => window.scrollY);
  await page.getByRole("button", {
    name: new RegExp(`^Segment ${oneBasedIndex}, .*Seek and review\\.$`),
  }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(windowScrollY);
}

type ActiveGeometry = {
  centerX: number;
  bottom: number;
  left: number;
  right: number;
  centerY: number;
  contextAfter: number;
  contextBefore: number;
  index: number;
  height: number;
  scrollportBottom: number;
  scrollportMaxScrollTop: number;
  scrollportScrollTop: number;
  scrollportTop: number;
  top: number;
  transportBottom: number;
  viewportWidth: number;
  windowScrollY: number;
};

async function measureActive(page: Page): Promise<ActiveGeometry | null> {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".transcript-segment"),
    );
    const active = document.querySelector<HTMLElement>(
      ".transcript-segment[data-active]",
    );
    if (!active) {
      return null;
    }
    const scrollport = active.closest<HTMLElement>(
      ".transcript-document__segments",
    );
    if (!scrollport) {
      return null;
    }
    const rect = active.getBoundingClientRect();
    const scrollportRect = scrollport.getBoundingClientRect();
    const transportBottom =
      document.querySelector<HTMLElement>(".media-transport")?.getBoundingClientRect()
        .bottom ?? 0;
    const activeIndex = rows.indexOf(active);
    const actionBarTop =
      document.querySelector<HTMLElement>(".casefile-action-bar")?.getBoundingClientRect()
        .top ?? window.innerHeight;
    const unobscuredBottom = Math.min(actionBarTop, window.innerHeight);
    const unobscuredTop = Math.max(scrollportRect.top, 0);
    const scrollportBottom = Math.min(scrollportRect.bottom, unobscuredBottom);
    const visibleIndices = rows.flatMap((row, index) => {
      if (row === active) {
        return [];
      }
      const rowRect = row.getBoundingClientRect();
      const visibleHeight = Math.max(
        0,
        Math.min(rowRect.bottom, scrollportBottom) -
          Math.max(rowRect.top, unobscuredTop),
      );
      return visibleHeight >= rowRect.height / 2 ? [index] : [];
    });
    return {
      centerX: rect.left + rect.width / 2,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      centerY: rect.top + rect.height / 2,
      contextAfter: visibleIndices.filter((index) => index > activeIndex).length,
      contextBefore: visibleIndices.filter((index) => index < activeIndex).length,
      height: rect.height,
      index: activeIndex,
      scrollportBottom,
      scrollportMaxScrollTop: Math.max(
        0,
        scrollport.scrollHeight - scrollport.clientHeight,
      ),
      scrollportScrollTop: scrollport.scrollTop,
      scrollportTop: unobscuredTop,
      top: rect.top,
      transportBottom,
      viewportWidth: window.innerWidth,
      windowScrollY: window.scrollY,
    };
  });
}

// An interior active segment sits in the MIDDLE of the transcript scrollport
// and the viewport-centered transcript column. The context band around it is
// split before/after with the 5-segment combined floor.
// Polls so smooth-scroll settle and one-frame re-centers never flake the
// assertion.
async function expectActiveMidScrollport(
  page: Page,
  options: { contextBand?: boolean; mediaKind: "audio" | "video" },
) {
  let last: ActiveGeometry | null = null;
  await expect(async () => {
    last = await measureActive(page);
    expect(last).not.toBeNull();
    expect(last!.left).toBeGreaterThanOrEqual(-1);
    expect(last!.right).toBeLessThanOrEqual(last!.viewportWidth + 1);
    expect(last!.centerY).toBeGreaterThanOrEqual(last!.scrollportTop);
    expect(last!.centerY).toBeLessThanOrEqual(last!.scrollportBottom);
    expect(last!.scrollportTop).toBeGreaterThanOrEqual(last!.transportBottom - 1);
    expect(last!.windowScrollY).toBe(0);
    expect(Math.abs(last!.centerX - last!.viewportWidth / 2)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
    expect(
      Math.abs(
        last!.centerY - (last!.scrollportTop + last!.scrollportBottom) / 2,
      ),
    ).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
    if (options.contextBand !== false) {
      expect(last!.contextBefore).toBeGreaterThanOrEqual(MIN_CONTEXT_EACH_SIDE);
      expect(last!.contextAfter).toBeGreaterThanOrEqual(MIN_CONTEXT_EACH_SIDE);
      expect(last!.contextBefore + last!.contextAfter).toBeGreaterThanOrEqual(
        MIN_CONTEXT,
      );
      expect(last!.contextBefore + last!.contextAfter).toBeLessThanOrEqual(
        options.mediaKind === "video"
          ? MAX_VIDEO_CONTEXT
          : MAX_AUDIO_CONTEXT_GUARD,
      );
    }
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1_000] });
  return last!;
}

async function expectActiveAtEdge(
  page: Page,
  input: { edge: "bottom" | "top"; zeroBasedIndex: number },
) {
  await expect(async () => {
    const geometry = await measureActive(page);
    expect(geometry).not.toBeNull();
    expect(geometry!.index).toBe(input.zeroBasedIndex);
    expect(geometry!.windowScrollY).toBe(0);
    expect(Math.abs(geometry!.centerX - geometry!.viewportWidth / 2)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
    if (input.edge === "top") {
      expect(geometry!.scrollportScrollTop).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.top - geometry!.scrollportTop)).toBeLessThanOrEqual(2);
    } else {
      expect(
        Math.abs(
          geometry!.scrollportScrollTop - geometry!.scrollportMaxScrollTop,
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry!.bottom - geometry!.scrollportBottom),
      ).toBeLessThanOrEqual(2);
    }
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1_000] });
}

// The two standing laws at rest (no seek, no playback, scrollY === 0):
// the transcript zone shares the FIRST viewport with the media (the first
// segment card is fully visible without scrolling), and the player pins in a
// band above the centered transcript. The transcript then scrolls without
// moving the player or page chrome.
async function expectRestStateWorkbench(page: Page, input: { video: boolean }) {
  const geometry = await page.evaluate(() => {
    const q = (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const transport = q(".media-transport");
    const video = q(".media-transport video");
    const firstCard = q(".transcript-segment");
    const transcript = q(".transcript-document");
    const scrollport = q(".transcript-document__segments");
    const actionBar = q(".casefile-action-bar");
    const transportEl = document.querySelector<HTMLElement>(".media-transport");
    const transcriptEl = document.querySelector<HTMLElement>(
      ".transcript-document",
    );
    const scrollportEl = document.querySelector<HTMLElement>(
      ".transcript-document__segments",
    );
    if (
      !transport ||
      !firstCard ||
      !transcript ||
      !scrollport ||
      !actionBar ||
      !transportEl ||
      !transcriptEl ||
      !scrollportEl
    ) {
      return null;
    }
    return {
      transportBottom: transport.bottom,
      transportTop: transport.top,
      transportPosition: getComputedStyle(transportEl).position,
      transcriptOverflowY: getComputedStyle(scrollportEl).overflowY,
      transcriptScrollTop: scrollportEl.scrollTop,
      transcriptScrolls: scrollportEl.scrollHeight > scrollportEl.clientHeight,
      transcriptTop: transcript.top,
      scrollportTop: scrollport.top,
      videoBottom: video?.bottom ?? null,
      videoHeight: video?.height ?? null,
      firstCardTop: firstCard.top,
      firstCardBottom: firstCard.bottom,
      firstCardLeft: firstCard.left,
      firstCardRight: firstCard.right,
      actionBarTop: actionBar.top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry).not.toBeNull();
  // Pinned band: the player sticks above the transcript.
  expect(geometry!.transportPosition).toBe("sticky");
  expect(geometry!.transportBottom).toBeLessThanOrEqual(geometry!.transcriptTop + 1);
  expect(geometry!.transcriptOverflowY).toBe("auto");
  expect(geometry!.transcriptScrollTop).toBe(0);
  expect(geometry!.transcriptScrolls).toBe(true);
  expect(Math.abs(geometry!.firstCardTop - geometry!.scrollportTop)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      (geometry!.firstCardLeft + geometry!.firstCardRight) / 2 -
        geometry!.viewportWidth / 2,
    ),
  ).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
  // The first card is fully visible without scrolling.
  expect(geometry!.firstCardTop).toBeGreaterThanOrEqual(0);
  expect(geometry!.firstCardBottom).toBeLessThanOrEqual(
    Math.min(geometry!.actionBarTop, geometry!.viewportHeight),
  );
  if (input.video) {
    expect(geometry!.videoHeight).not.toBeNull();
    expect(geometry!.videoHeight!).toBeGreaterThanOrEqual(96);
    // The rendered frame is bounded so the media column stays compact.
    expect(geometry!.videoHeight!).toBeLessThanOrEqual(
      Math.round(geometry!.viewportHeight * VIDEO_MAX_VH) + 1,
    );
    // The video frame itself shares the first viewport.
    expect(geometry!.videoBottom!).toBeLessThanOrEqual(geometry!.actionBarTop);
  }

  const beforeScroll = await page.evaluate(() => {
    const transport = document
      .querySelector(".media-transport")
      ?.getBoundingClientRect();
    return {
      transportTop: transport?.top ?? null,
      windowScrollY: window.scrollY,
    };
  });
  await page.locator(".transcript-document__segments").evaluate((node) => {
    node.scrollTo(0, node.scrollHeight / 2);
  });
  const scrolled = await page.evaluate(() => {
    const q = (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const transport = q(".media-transport");
    const rail = q(".media-transport__rail");
    const actions = q(".media-transport__actions");
    const transcript = document.querySelector<HTMLElement>(
      ".transcript-document__segments",
    );
    return {
      transportTop: transport?.top ?? null,
      transcriptScrollTop: transcript?.scrollTop ?? 0,
      windowScrollY: window.scrollY,
      railVisible: rail ? rail.bottom > 0 && rail.top < window.innerHeight : false,
      actionsVisible: actions
        ? actions.bottom > 0 && actions.top < window.innerHeight
        : false,
    };
  });
  expect(scrolled.transcriptScrollTop).toBeGreaterThan(0);
  expect(scrolled.windowScrollY).toBe(beforeScroll.windowScrollY);
  expect(scrolled.transportTop).toBe(beforeScroll.transportTop);
  expect(scrolled.railVisible).toBe(true);
  expect(scrolled.actionsVisible).toBe(true);
  // Back to rest for the remainder of the flow.
  await page.locator(".transcript-document__segments").evaluate((node) => node.scrollTo(0, 0));
}

async function expectActiveIndex(page: Page, zeroBasedIndex: number) {
  await expect
    .poll(async () => (await measureActive(page))?.index, { timeout: 10_000 })
    .toBe(zeroBasedIndex);
}

// Real playback across the segment boundary (seek close to the boundary,
// then let the track advance on its own) - the centering must hold when the
// active row changes mid-playback, including short -> long transitions.
async function playAcrossBoundary(page: Page, boundaryMs: number) {
  await page.evaluate(async (ms) => {
    const media = document.querySelector<HTMLMediaElement>("audio, video");
    if (!media) {
      throw new Error("no media element");
    }
    media.currentTime = ms / 1000;
    await media.play();
  }, boundaryMs - 1_200);
}

async function stopPlayback(page: Page) {
  await page.evaluate(() => {
    document.querySelector<HTMLMediaElement>("audio, video")?.pause();
  });
}

// Every segment keeps its original content: the longest card must carry the
// full text with nothing clipped (cards grow; they never clamp).
async function expectNoClamp(page: Page, oneBasedIndex: number, expectedText: string) {
  const row = segmentRow(page, oneBasedIndex);
  const metrics = await row.evaluate((node) => {
    const editor = node.querySelector("textarea");
    const paragraph = node.querySelector(".transcript-segment__text p");
    const carrier = editor ?? paragraph;
    if (!carrier) {
      return null;
    }
    const text =
      carrier instanceof HTMLTextAreaElement ? carrier.value : (carrier.textContent ?? "");
    return {
      textLength: text.length,
      clipped: carrier.scrollHeight > carrier.clientHeight + 1,
      cardClipped: node.scrollHeight > node.clientHeight + 1,
      resize: editor ? getComputedStyle(editor).resize : null,
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics!.textLength).toBe(expectedText.length);
  expect(metrics!.clipped).toBe(false);
  expect(metrics!.cardClipped).toBe(false);
  if (metrics!.resize !== null) {
    expect(metrics!.resize).toBe("none");
  }
}

async function expectFullyScrollable(page: Page, segmentCount: number) {
  const scrollInfo = await page.locator(".transcript-document__segments").evaluate((node) => ({
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
  }));
  expect(scrollInfo.overflowY).toBe("auto");
  expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight);

  // Bottom end: the last card is reachable and lands fully in view.
  await page.locator(".transcript-document__segments").evaluate((node) =>
    node.scrollTo(0, node.scrollHeight),
  );
  await expect
    .poll(() =>
      segmentRow(page, segmentCount).evaluate((row) => {
        const scrollport = row.closest(".transcript-document__segments");
        if (!scrollport) {
          return false;
        }
        const rowRect = row.getBoundingClientRect();
        const scrollportRect = scrollport.getBoundingClientRect();
        return (
          rowRect.top >= scrollportRect.top - 1 &&
          rowRect.bottom <= scrollportRect.bottom + 1
        );
      }),
    )
    .toBe(true);

  // Top end: the transcript returns to its own start and the first card is
  // directly readable below its summary and speaker tools.
  await page.locator(".transcript-document__segments").evaluate((node) => node.scrollTo(0, 0));
  await expect
    .poll(
      () =>
        page
          .locator(".transcript-document__segments")
          .evaluate((node) => Math.round(node.scrollTop)),
      { timeout: 5_000 },
    )
    .toBe(0);
  await expect
    .poll(() =>
      segmentRow(page, 1).evaluate((row) => {
        const scrollport = row.closest(".transcript-document__segments");
        if (!scrollport) {
          return false;
        }
        const rowRect = row.getBoundingClientRect();
        const scrollportRect = scrollport.getBoundingClientRect();
        return (
          rowRect.top >= scrollportRect.top - 1 &&
          rowRect.bottom <= scrollportRect.bottom + 1
        );
      }),
    )
    .toBe(true);
}

async function submitForApproval(page: Page) {
  await page.getByRole("button", { name: "Submit for approval" }).click();
  const dialog = page.getByRole("dialog", { name: "Submit for approval" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Submit for approval" }).last().click();
  await expect(dialog).toBeHidden();
}

async function seedVisibleContextCasefile(
  page: Page,
  input: { title: string; label: string; video: boolean },
) {
  await page.setViewportSize(CANONICAL_VIEWPORT);
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: input.title,
    durationMs: 240_000,
  });
  // Wait for the stub transcript to land (DB-level poll works in both the
  // host and container lanes), then lengthen it: the visible-context
  // contract needs a long, varied segment list (schema accepts any segment
  // list - same sanctioned seam the casefile QA flows use).
  await expect
    .poll(
      () =>
        queryRuntimeRows<{ n: number }>(
          "select count(*) as n from revisions where recording_id = ?",
          [recordingId],
        )[0]?.n,
      { timeout: 120_000, intervals: [1_000, 2_000, 4_000] },
    )
    .toBe(1);

  const seeds = buildSegmentSeeds(recordingId, input.label);
  execRuntimeSql("update revisions set segments_json = ? where recording_id = ?", [
    JSON.stringify(seeds),
    recordingId,
  ]);
  if (input.video) {
    // Same relabel the appliance applies to real video uploads.
    execRuntimeSql(
      "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
      [recordingId],
    );
  }
  await createAndAssignUsers(page, recordingId);
  return { recordingId, seeds };
}

test.describe("visible-context casefile transcript surface", () => {
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  test("audio casefile: review and approver modes keep expanded context around the centered active segment", async ({
    page,
  }) => {
    const { seeds } = await seedVisibleContextCasefile(page, {
      title: "Visible context audio",
      label: "Audio",
      video: false,
    });

    // Review mode (assigned reviewer, editable draft).
    await openAssignedDraft(page, reviewerUser);
    await expect(page.getByRole("article", { name: /Transcript segment \d+, / })).toHaveCount(24);
    // Audio keeps the transport: the wave scrubber or the native-audio
    // fallback is present and usable.
    await expect(page.locator(".media-transport")).toBeVisible();
    await expect(
      page.locator(".media-transport__wave-stage, .media-transport audio[controls]").first(),
    ).toBeVisible();

    // Standing laws at rest: transcript zone shares the first viewport and
    // the player pins above it (never scrolls away).
    await expectRestStateWorkbench(page, { video: false });

    await seekSegment(page, 1);
    await expectActiveAtEdge(page, { edge: "top", zeroBasedIndex: 0 });

    // Explicit seek recenters the target in the scrollport with the
    // context band around it - a mid-size row first...
    await seekSegment(page, 7);
    await expectActiveIndex(page, 6);
    const midGeometry = await expectActiveMidScrollport(page, { mediaKind: "audio" });

    // ...then a long row: the card grows, centering and band hold.
    await seekSegment(page, 13);
    await expectActiveIndex(page, 12);
    const longGeometry = await expectActiveMidScrollport(page, { mediaKind: "audio" });
    expect(longGeometry.height).toBeGreaterThan(midGeometry.height);

    // Playback crossing a short -> long boundary keeps the active row
    // centered in the scrollport while the track moves on its own.
    await playAcrossBoundary(page, 70_000);
    await expectActiveIndex(page, 7);
    await expectActiveMidScrollport(page, { mediaKind: "audio" });
    await page.waitForTimeout(1_500);
    await expectActiveMidScrollport(page, { mediaKind: "audio" });
    await stopPlayback(page);

    // No clamping: segment 8's long text stands complete on the card.
    await expectNoClamp(page, 8, seeds[7].text);

    await seekSegment(page, 24);
    await expectActiveAtEdge(page, { edge: "bottom", zeroBasedIndex: 23 });

    // The extreme monster stands complete too - cards grow, never clamp.
    await expectNoClamp(page, MONSTER_INDEX + 1, seeds[MONSTER_INDEX].text);

    // The transcript is fully scrollable end to end.
    await expectFullyScrollable(page, 24);

    // Approver mode (read-only pending revision, same surface contract).
    await submitForApproval(page);
    await login(page, approverUser);
    await openCasefile(page, sharedCasefile().recordingId);
    await expect(page.getByRole("article", { name: /Transcript segment \d+, / })).toHaveCount(24);
    await expect(
      segmentRow(page, 1).getByRole("textbox"),
    ).toHaveCount(0);

    await seekSegment(page, 1);
    await expectActiveAtEdge(page, { edge: "top", zeroBasedIndex: 0 });

    await seekSegment(page, 9);
    await expectActiveIndex(page, 8);
    await expectActiveMidScrollport(page, { mediaKind: "audio" });

    await playAcrossBoundary(page, 130_000);
    await expectActiveIndex(page, 13);
    await expectActiveMidScrollport(page, { mediaKind: "audio" });
    await stopPlayback(page);

    await expectNoClamp(page, 13, seeds[12].text);
    await seekSegment(page, 24);
    await expectActiveAtEdge(page, { edge: "bottom", zeroBasedIndex: 23 });
    await expectFullyScrollable(page, 24);
  });

  test("video casefile: video frame with previous controls plus the same centered context contract in review and approver modes", async ({
    page,
  }) => {
    const { seeds } = await seedVisibleContextCasefile(page, {
      title: "Visible context video",
      label: "Video",
      video: true,
    });

    await openAssignedDraft(page, reviewerUser);
    await expect(page.getByRole("article", { name: /Transcript segment \d+, / })).toHaveCount(24);

    // Video keeps its frame and the previous (native) controls.
    const video = page.locator(".media-transport video[controls]");
    await expect(video).toBeVisible();
    expect(await video.evaluate((node) => (node as HTMLVideoElement).controls)).toBe(true);

    // Standing laws at rest: bounded frame, transcript zone shares the
    // first viewport, player pinned above the transcript.
    await expectRestStateWorkbench(page, { video: true });

    await seekSegment(page, 1);
    await expectActiveAtEdge(page, { edge: "top", zeroBasedIndex: 0 });

    await seekSegment(page, 8);
    await expectActiveIndex(page, 7);
    await expectActiveMidScrollport(page, { mediaKind: "video" });

    await playAcrossBoundary(page, 70_000);
    await expectActiveIndex(page, 7);
    await expectActiveMidScrollport(page, { mediaKind: "video" });
    await stopPlayback(page);

    await expectNoClamp(page, 8, seeds[7].text);
    await seekSegment(page, 24);
    await expectActiveAtEdge(page, { edge: "bottom", zeroBasedIndex: 23 });
    await expectFullyScrollable(page, 24);

    // Approver mode on the video casefile.
    await submitForApproval(page);
    await login(page, approverUser);
    await openCasefile(page, sharedCasefile().recordingId);
    await expect(page.getByRole("article", { name: /Transcript segment \d+, / })).toHaveCount(24);
    await expect(segmentRow(page, 1).getByRole("textbox")).toHaveCount(0);
    await expect(video).toBeVisible();

    await seekSegment(page, 1);
    await expectActiveAtEdge(page, { edge: "top", zeroBasedIndex: 0 });

    await seekSegment(page, 12);
    await expectActiveIndex(page, 11);
    await expectActiveMidScrollport(page, { mediaKind: "video" });

    await playAcrossBoundary(page, 130_000);
    await expectActiveIndex(page, 13);
    await expectActiveMidScrollport(page, { mediaKind: "video" });
    await stopPlayback(page);

    await seekSegment(page, 24);
    await expectActiveAtEdge(page, { edge: "bottom", zeroBasedIndex: 23 });

    // The full segment list renders: count sanity against the DB seed.
    const rows = await queryRuntimeRows<{ n: number }>(
      "select json_array_length(segments_json) as n from revisions where recording_id = ?",
      [sharedCasefile().recordingId],
    );
    expect(rows[0]?.n).toBe(24);
  });
});
