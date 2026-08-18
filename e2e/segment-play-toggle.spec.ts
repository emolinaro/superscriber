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
      return rect.bottom > 0 && rect.top < window.innerHeight;
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
  // casefile-pin-transcript-zone: the transport is pinned inside the bounded
  // desktop page, so it stays on the window viewport even for a deep active
  // row (previously the window scrolled it off-screen).
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

  await testInfo.attach("active-segment-paused-with-pinned-transport", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  const evidenceDir = process.env.SUPERSCRIBER_E2E_EVIDENCE_DIR?.trim();
  if (evidenceDir) {
    await page.screenshot({
      path: `${evidenceDir}/active-segment-paused-pinned-transport.png`,
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
