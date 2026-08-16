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
// affordances), the transcript window-scrolls end to end, the ACTIVE segment
// sits in the exact middle of the viewport on both axes while the track
// plays (including across short -> long segment transitions), and 5-10
// context segments stay visible around it. Media keeps its restored form:
// video keeps its frame with the previous controls, audio keeps the full
// transport. All geometry is asserted viewport-relative
// (getBoundingClientRect vs window.innerWidth/innerHeight), never from
// internal scrollport heights.

const CANONICAL_VIEWPORT = { width: 1280, height: 800 };
// Centering tolerance: the scroll-padding boxes are symmetric so the exact
// landing point is the viewport middle; a few px of slack covers sub-pixel
// rounding and cross-lane font metric drift.
const CENTER_TOLERANCE_PX = 24;
const MIN_CONTEXT = 5;
const MAX_CONTEXT = 10;

type SegmentSeed = {
  id: string;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
};

// 24 segments over 240s: a short/medium/long mix with a genuinely long card
// every fifth segment so the band holds across short -> long transitions.
function buildSegmentSeeds(recordingId: string, label: string): SegmentSeed[] {
  const short = (n: number) => `${label} segment ${n}: a brief note.`;
  const mid = (n: number) =>
    `${label} segment ${n}: the speaker walks through the timeline of the interview and confirms the sequence of events for the record.`;
  const long = (n: number) =>
    `${label} segment ${n}: a deliberately long segment proving the layout never clamps or truncates card content. The speaker gives full background on the case, covering the initial outreach, the on-site visit, the follow-up calls with the coordination team, and the written summary that was circulated afterwards. Every sentence stays visible in the transcript at all times, because reviewers must be able to read the complete record while playback follows the active segment. No expand control, no ellipsis, no hidden copy - the full text stands on the card and the card grows to fit it.`;
  const seeds: SegmentSeed[] = [];
  for (let i = 0; i < 24; i += 1) {
    const n = i + 1;
    const kind = i % 5;
    seeds.push({
      id: `${recordingId}-vc-segment-${n}`,
      speakerLabel: i % 2 === 0 ? "Speaker A" : "Speaker B",
      startMs: i * 10_000,
      endMs: (i + 1) * 10_000,
      text: kind === 2 ? long(n) : kind % 2 === 0 ? mid(n) : short(n),
      confidence: kind === 2 ? 0.81 : 0.93,
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
  await segmentRow(page, oneBasedIndex)
    .getByRole("button", { name: /^Play from / })
    .click();
}

type ActiveGeometry = {
  centerX: number;
  centerY: number;
  context: number;
  index: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
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
    const rect = active.getBoundingClientRect();
    const context = rows
      .filter((row) => row !== active)
      .map((row) => row.getBoundingClientRect())
      .filter((rowRect) => rowRect.bottom > 0 && rowRect.top < window.innerHeight)
      .length;
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      context,
      height: rect.height,
      index: rows.indexOf(active),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

// The active segment sits in the MIDDLE of the viewport on BOTH axes, with
// the 5-10 segment context band visible around it. Polls so smooth-scroll
// settle and one-frame re-centers never flake the assertion.
async function expectActiveMidViewport(page: Page) {
  let last: ActiveGeometry | null = null;
  await expect(async () => {
    last = await measureActive(page);
    expect(last).not.toBeNull();
    expect(Math.abs(last!.centerX - last!.viewportWidth / 2)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
    expect(Math.abs(last!.centerY - last!.viewportHeight / 2)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
    expect(last!.context).toBeGreaterThanOrEqual(MIN_CONTEXT);
    expect(last!.context).toBeLessThanOrEqual(MAX_CONTEXT);
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1_000] });
  return last!;
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
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics!.textLength).toBe(expectedText.length);
  expect(metrics!.clipped).toBe(false);
  expect(metrics!.cardClipped).toBe(false);
}

async function expectFullyScrollable(page: Page, segmentCount: number) {
  const scrollInfo = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }));
  expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.viewport);

  // Bottom end: the last card is reachable and lands fully in view.
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(segmentRow(page, segmentCount)).toBeInViewport();

  // Top end: the window returns to the document start, and the first card
  // is directly scrollable into view (at the document start the case header
  // and transport legitimately occupy the first screen).
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 5_000 })
    .toBe(0);
  await segmentRow(page, 1).scrollIntoViewIfNeeded();
  await expect(segmentRow(page, 1)).toBeInViewport();
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

test.describe.serial("visible-context casefile transcript surface", () => {
  test("audio casefile: review and approver modes keep the active segment mid-viewport inside a 5-10 segment band", async ({
    page,
  }) => {
    test.setTimeout(300_000);
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

    // Explicit seek recenters the target mid-viewport (both axes) with the
    // context band around it - a short row first...
    await seekSegment(page, 7);
    await expectActiveIndex(page, 6);
    const shortGeometry = await expectActiveMidViewport(page);

    // ...then a long row: the card grows, centering and band hold.
    await seekSegment(page, 13);
    await expectActiveIndex(page, 12);
    const longGeometry = await expectActiveMidViewport(page);
    expect(longGeometry.height).toBeGreaterThan(shortGeometry.height);

    // Playback crossing a short -> long boundary keeps the active row
    // mid-viewport while the track moves on its own.
    await playAcrossBoundary(page, 70_000);
    await expectActiveIndex(page, 7);
    await expectActiveMidViewport(page);
    await page.waitForTimeout(1_500);
    await expectActiveMidViewport(page);
    await stopPlayback(page);

    // No clamping: segment 8's long text stands complete on the card.
    await expectNoClamp(page, 8, seeds[7].text);

    // The transcript is fully scrollable end to end.
    await expectFullyScrollable(page, 24);

    // Approver mode (read-only pending revision, same surface contract).
    await segmentRow(page, 1).scrollIntoViewIfNeeded();
    await submitForApproval(page);
    await login(page, approverUser);
    await openCasefile(page, sharedCasefile().recordingId);
    await expect(page.getByRole("article", { name: /Transcript segment \d+, / })).toHaveCount(24);
    await expect(
      segmentRow(page, 1).getByRole("textbox"),
    ).toHaveCount(0);

    await seekSegment(page, 10);
    await expectActiveIndex(page, 9);
    await expectActiveMidViewport(page);

    await playAcrossBoundary(page, 130_000);
    await expectActiveIndex(page, 13);
    await expectActiveMidViewport(page);
    await stopPlayback(page);

    await expectNoClamp(page, 13, seeds[12].text);
    await expectFullyScrollable(page, 24);
  });

  test("video casefile: video frame with previous controls plus the same centered context contract in review and approver modes", async ({
    page,
  }) => {
    test.setTimeout(300_000);
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
    const videoBox = await video.boundingBox();
    expect(videoBox?.height ?? 0).toBeGreaterThanOrEqual(96);
    expect(await video.evaluate((node) => (node as HTMLVideoElement).controls)).toBe(true);

    await seekSegment(page, 8);
    await expectActiveIndex(page, 7);
    await expectActiveMidViewport(page);

    await playAcrossBoundary(page, 70_000);
    await expectActiveIndex(page, 7);
    await expectActiveMidViewport(page);
    await stopPlayback(page);

    await expectNoClamp(page, 8, seeds[7].text);
    await expectFullyScrollable(page, 24);

    // Approver mode on the video casefile.
    await segmentRow(page, 1).scrollIntoViewIfNeeded();
    await submitForApproval(page);
    await login(page, approverUser);
    await openCasefile(page, sharedCasefile().recordingId);
    await expect(page.getByRole("article", { name: /Transcript segment \d+, / })).toHaveCount(24);
    await expect(segmentRow(page, 1).getByRole("textbox")).toHaveCount(0);
    await expect(video).toBeVisible();

    await seekSegment(page, 12);
    await expectActiveIndex(page, 11);
    await expectActiveMidViewport(page);

    await playAcrossBoundary(page, 130_000);
    await expectActiveIndex(page, 13);
    await expectActiveMidViewport(page);
    await stopPlayback(page);

    // The full segment list renders: count sanity against the DB seed.
    const rows = await queryRuntimeRows<{ n: number }>(
      "select json_array_length(segments_json) as n from revisions where recording_id = ?",
      [sharedCasefile().recordingId],
    );
    expect(rows[0]?.n).toBe(24);
  });
});
