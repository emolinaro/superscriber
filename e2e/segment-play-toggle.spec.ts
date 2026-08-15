import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  execRuntimeSql,
  openAssignedDraft,
  reviewerUser,
  uploadFixture,
} from "./support/appliance";

type PlaybackState = {
  currentTime: number;
  mediaPaused: boolean;
  segmentLabel: string | null;
  segmentPressed: string | null;
  transportLabel: string | null;
  transportPressed: string | null;
  transcriptButtonInViewport: boolean;
  transportButtonInViewport: boolean;
};

function longTranscriptSegments() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `long-seg-${index + 1}`,
    speakerLabel: index % 2 === 0 ? "Speaker 1" : "Speaker 2",
    startMs: index * 5_000,
    endMs: (index + 1) * 5_000,
    text: `Transcript segment ${index + 1} keeps the review context available beside its playback control.`,
    confidence: 0.9,
  }));
}

async function playbackState(page: import("@playwright/test").Page): Promise<PlaybackState> {
  return page.evaluate(() => {
    const media = document.querySelector("audio");
    const segmentButton = document.querySelector<HTMLButtonElement>(
      '.transcript-segment[aria-current="true"] .transcript-segment__timestamp',
    );
    const transportButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="transport-play-toggle"]',
    );
    const inViewport = (element: Element | null) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      let left = Math.max(rect.left, 0);
      let right = Math.min(rect.right, window.innerWidth);
      let top = Math.max(rect.top, 0);
      let bottom = Math.min(rect.bottom, window.innerHeight);
      const clippingOverflow = new Set(["auto", "clip", "hidden", "overlay", "scroll"]);

      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (clippingOverflow.has(style.overflowX)) {
          const clipLeft = ancestorRect.left + ancestor.clientLeft;
          left = Math.max(left, clipLeft);
          right = Math.min(right, clipLeft + ancestor.clientWidth);
        }
        if (clippingOverflow.has(style.overflowY)) {
          const clipTop = ancestorRect.top + ancestor.clientTop;
          top = Math.max(top, clipTop);
          bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
        }
      }

      return right > left && bottom > top;
    };

    if (!media) throw new Error("Expected the casefile audio element.");

    return {
      currentTime: media.currentTime,
      mediaPaused: media.paused,
      segmentLabel: segmentButton?.getAttribute("aria-label") ?? null,
      segmentPressed: segmentButton?.getAttribute("aria-pressed") ?? null,
      transportLabel: transportButton?.textContent?.trim() ?? null,
      transportPressed: transportButton?.getAttribute("aria-pressed") ?? null,
      transcriptButtonInViewport: inViewport(segmentButton),
      transportButtonInViewport: inViewport(transportButton),
    };
  });
}

test("a deep active transcript segment pauses and resumes in place with transport parity", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Long transcript segment toggle record",
    durationMs: 70_000,
  });
  await createAndAssignUsers(page, recordingId);
  await openAssignedDraft(page, reviewerUser);

  await expect(page.getByTestId("wave-scrubber")).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });

  execRuntimeSql(
    "update revisions set segments_json = ? where recording_id = ? and state = 'draft'",
    [JSON.stringify(longTranscriptSegments()), recordingId],
  );
  await page.reload();

  await expect(page.getByRole("article", { name: /Transcript segment/ })).toHaveCount(12);
  const media = page.locator("audio");
  await media.evaluate((node: HTMLAudioElement) => {
    node.muted = true;
  });

  const deepSegment = page.getByRole("button", { name: "Play from 00:40-00:45" });
  await deepSegment.click();

  const activeSegment = page.getByRole("button", {
    name: "Play or pause segment 9, 00:40-00:45",
  });
  const transport = page.getByTestId("transport-play-toggle");
  await expect(activeSegment).toHaveAttribute("aria-pressed", "true");
  await expect(transport).toHaveAttribute("aria-pressed", "true");
  await expect(transport).toHaveText("Pause");
  await expect
    .poll(() => media.evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBeGreaterThan(40.25);

  const afterNonActiveClick = await playbackState(page);
  expect(afterNonActiveClick.currentTime).toBeLessThan(42);
  expect(afterNonActiveClick.mediaPaused).toBe(false);
  expect(afterNonActiveClick.transcriptButtonInViewport).toBe(true);
  // Pinned/docked transport (player-pinned-center, media-casefile dock):
  // the transport keeps its slot at the top of the reviewing surface while
  // the deep segment centers below it - centering must yank neither the
  // transport nor the deep row out of the viewport.
  expect(afterNonActiveClick.transportButtonInViewport).toBe(true);

  await activeSegment.click();
  await expect(activeSegment).toHaveAttribute("aria-pressed", "false");
  await expect(transport).toHaveAttribute("aria-pressed", "false");
  await expect(transport).toHaveText("Play");
  await expect.poll(() => media.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);

  const paused = await playbackState(page);
  await page.waitForTimeout(600);
  const pausedAfterWait = await playbackState(page);
  expect(pausedAfterWait.currentTime - paused.currentTime).toBeLessThan(0.06);
  expect(paused.segmentLabel).toBe("Play or pause segment 9, 00:40-00:45");
  expect(paused.segmentPressed).toBe("false");
  expect(paused.transportLabel).toBe("Play");
  expect(paused.transportPressed).toBe("false");
  expect(paused.transcriptButtonInViewport).toBe(true);
  expect(paused.transportButtonInViewport).toBe(true);

  await testInfo.attach("active-segment-paused-with-transport-pinned", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  const evidenceDir = process.env.SUPERSCRIBER_E2E_EVIDENCE_DIR?.trim();
  if (evidenceDir) {
    await page.screenshot({
      path: `${evidenceDir}/active-segment-paused-transport-pinned.png`,
    });
  }

  await activeSegment.click();
  await expect(activeSegment).toHaveAttribute("aria-pressed", "true");
  await expect(transport).toHaveAttribute("aria-pressed", "true");
  const immediatelyResumedAt = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
  expect(Math.abs(immediatelyResumedAt - paused.currentTime)).toBeLessThan(0.3);
  await expect
    .poll(() => media.evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBeGreaterThan(paused.currentTime + 0.3);
  const resumed = await playbackState(page);

  await transport.evaluate((node: HTMLButtonElement) => node.focus({ preventScroll: true }));
  await expect(transport).toBeFocused();
  await page.keyboard.press("Space");
  await expect(transport).toHaveAttribute("aria-pressed", "false");
  await expect(activeSegment).toHaveAttribute("aria-pressed", "false");
  const spacePaused = await playbackState(page);
  await page.keyboard.press("Space");
  await expect(transport).toHaveAttribute("aria-pressed", "true");
  await expect(activeSegment).toHaveAttribute("aria-pressed", "true");
  const spaceResumed = await playbackState(page);

  await page.keyboard.press("Space");
  await expect(transport).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 1280, height: 640 });

  const transcript = page.getByTestId("transcript-start");
  const transcriptMain = page.locator("#transcript-main");
  await expect
    .poll(() =>
      transcriptMain.evaluate((node: HTMLElement) => node.scrollHeight > node.clientHeight),
    )
    .toBe(true);
  await transcriptMain.evaluate((node: HTMLElement) => {
    node.scrollTop = 0;
  });
  await transcript.evaluate((node: HTMLElement) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() =>
      transcript.evaluate(
        (node: HTMLElement) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
      ),
    )
    .toBe(true);

  const wheelPoint = await transcript.evaluate((node: HTMLElement) => {
    const main = node.closest<HTMLElement>("#transcript-main");
    if (!main) throw new Error("Expected the transcript main scrollport.");
    const transcriptRect = node.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const top = Math.max(transcriptRect.top, mainRect.top, 0);
    const bottom = Math.min(transcriptRect.bottom, mainRect.bottom, window.innerHeight);
    if (bottom <= top) throw new Error("Expected the transcript scrollport to be visible.");
    return {
      x: transcriptRect.left + transcriptRect.width / 2,
      y: top + (bottom - top) / 2,
    };
  });
  const transportTopBeforeWheel = await page
    .locator(".media-transport")
    .evaluate((node: HTMLElement) => node.getBoundingClientRect().top);
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  expect(await transcriptMain.evaluate((node: HTMLElement) => node.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() => transcriptMain.evaluate((node: HTMLElement) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .locator(".media-transport")
        .evaluate((node: HTMLElement) => node.getBoundingClientRect().top),
    )
    .toBeLessThan(transportTopBeforeWheel - 1);

  await testInfo.attach("segment-play-toggle-browser-state", {
    body: Buffer.from(
      JSON.stringify(
        {
          afterNonActiveClick,
          paused,
          pausedAfterWait,
          resumed,
          spacePaused,
          spaceResumed,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
});
