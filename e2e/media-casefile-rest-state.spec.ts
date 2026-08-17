import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  firstTranscriptRow,
  openCasefile,
  uploadFixture,
} from "./support/appliance";

// Rest-state contract for the visible-context workbench: the media player
// PINS in a band above the transcript, and only the transcript owns a
// vertical scrollport. The video frame with native controls stays beside
// the chip strip and transport actions inside that band. Below
// 1100px the transport stays viewport-pinned on the single-column stack
// (responsive.css), and on phone-width viewports the review surface is
// safety-gated behind the tablet-or-desktop notice while the player stays
// available. A future layout change must update this spec deliberately
// instead of silently reverting the rest state.

async function waitForRestStateTranscript(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await firstTranscriptRow(page).isVisible().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(2_000);
    await page.reload();
  }

  await expect(firstTranscriptRow(page)).toBeVisible();
}

test("video casefile rest state: pinned media band above the transcript scrollport", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Canonical desktop window for the visible-context rest state.
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Media rest state record",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);

  // Promote the uploaded audio record to a video casefile the same way the
  // appliance labels real video uploads, and lengthen the stub transcript so
  // its own scrollport always has real scroll travel.
  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  const segments = Array.from({ length: 16 }, (_, i) => ({
    id: `${recordingId}-rest-segment-${i + 1}`,
    speakerLabel: i % 2 === 0 ? "Speaker A" : "Speaker B",
    startMs: i * 10_000,
    endMs: (i + 1) * 10_000,
    text: `Rest state segment ${i + 1}: long enough copy to give every card a natural reading height.`,
    confidence: 0.92,
  }));
  execRuntimeSql("update revisions set segments_json = ? where recording_id = ?", [
    JSON.stringify(segments),
    recordingId,
  ]);
  await openCasefile(page, recordingId);

  // Selecting the first segment for the transport's initial state must not
  // activate transcript follow. The player-led rest state stays at the top
  // until playback advances or the reviewer explicitly seeks.
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  await expect(page.locator(".case-header")).toBeInViewport();

  const video = page.locator("video[controls]");
  await expect(video).toBeVisible();

  const transport = page.locator(".media-transport");
  const rail = transport.getByRole("list", { name: "Transcript segments" });
  const transcript = page.getByTestId("transcript-start");
  const transcriptScrollport = transcript.locator(".transcript-document__segments");
  await expect(rail).toBeVisible();
  await expect(transcript).toBeVisible();

  // The compact segment chip strip carries one seek chip per transcript
  // segment, kept squeezed between the player and the review surface.
  const segmentArticles = await page
    .getByRole("article", { name: /Transcript segment \d+, / })
    .count();
  const chips = rail.getByRole("button", { name: /Seek and review\.$/ });
  await expect(chips).toHaveCount(segmentArticles);
  expect(segmentArticles).toBeGreaterThan(0);

  // Rest-state geometry: the media transport and transcript are stacked
  // workbench siblings. Video and the chip strip share the media band, and
  // the first segment card is fully visible in the first viewport.
  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".casefile-main");
    const transportEl = main?.querySelector<HTMLElement>(".media-transport");
    const videoEl = main?.querySelector("video");
    const railEl = transportEl?.querySelector<HTMLElement>(
      ".media-transport__rail",
    );
    const transcriptEl = main?.querySelector<HTMLElement>(
      '[data-testid="transcript-start"]',
    );
    const firstCard = main?.querySelector<HTMLElement>(".transcript-segment");
    const actionBar = document.querySelector<HTMLElement>(
      ".casefile-action-bar",
    );
    if (!main || !transportEl || !videoEl || !railEl || !transcriptEl || !firstCard || !actionBar) {
      return null;
    }

    const videoRect = videoEl.getBoundingClientRect();
    const railRect = railEl.getBoundingClientRect();
    const transportRect = transportEl.getBoundingClientRect();
    const transcriptRect = transcriptEl.getBoundingClientRect();
    const firstCardRect = firstCard.getBoundingClientRect();

    return {
      transportSpansVideo: transportRect.top <= videoRect.top + 1,
      videoHeight: videoRect.height,
      videoBesideRail: videoRect.right <= railRect.left + 1,
      mediaAboveTranscript: transportRect.bottom <= transcriptRect.top + 1,
      firstCardSharesFirstViewport:
        firstCardRect.top >= 0 &&
        firstCardRect.bottom <=
          Math.min(actionBar.getBoundingClientRect().top, window.innerHeight),
      videoSharesFirstViewport:
        videoRect.bottom <= actionBar.getBoundingClientRect().top,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.transportSpansVideo).toBe(true);
  expect(geometry?.videoHeight).toBeGreaterThanOrEqual(96);
  expect(geometry?.videoBesideRail).toBe(true);
  expect(geometry?.mediaAboveTranscript).toBe(true);
  expect(geometry?.firstCardSharesFirstViewport).toBe(true);
  expect(geometry?.videoSharesFirstViewport).toBe(true);

  // Transcript-only scroll state: the player and page stay put while rows
  // move inside their independent scrollport.
  const scrollState = await page.evaluate(() => {
    const transportEl = document.querySelector<HTMLElement>(".media-transport");
    const transcriptEl = document.querySelector<HTMLElement>(
      ".transcript-document__segments",
    );
    return {
      transcriptOverflowY: transcriptEl
        ? getComputedStyle(transcriptEl).overflowY
        : "missing",
      transcriptScrolls: transcriptEl
        ? transcriptEl.scrollHeight > transcriptEl.clientHeight
        : false,
      transportPosition: transportEl
        ? getComputedStyle(transportEl).position
        : "missing",
    };
  });
  expect(scrollState.transcriptOverflowY).toBe("auto");
  expect(scrollState.transcriptScrolls).toBe(true);
  expect(scrollState.transportPosition).toBe("sticky");

  const beforeScroll = await page.evaluate(() => ({
    headerTop:
      document.querySelector(".case-header")?.getBoundingClientRect().top ?? null,
    transportTop:
      document.querySelector(".media-transport")?.getBoundingClientRect().top ??
      null,
    windowScrollY: window.scrollY,
  }));
  await transcriptScrollport.evaluate((node) => node.scrollTo(0, node.scrollHeight / 2));
  const parkedChrome = await page.evaluate(() => {
    const header = document.querySelector(".case-header")?.getBoundingClientRect();
    const transportEl = document.querySelector(".media-transport")?.getBoundingClientRect();
    const rail = document.querySelector(".media-transport__rail")?.getBoundingClientRect();
    const transcriptEl = document.querySelector<HTMLElement>(
      ".transcript-document__segments",
    );
    return {
      headerTop: header?.top ?? null,
      transportTop: transportEl?.top ?? null,
      transcriptScrollTop: transcriptEl?.scrollTop ?? 0,
      windowScrollY: window.scrollY,
      railVisible: rail ? rail.bottom > 0 && rail.top < window.innerHeight : false,
    };
  });
  expect(parkedChrome.transcriptScrollTop).toBeGreaterThan(0);
  expect(parkedChrome.windowScrollY).toBe(beforeScroll.windowScrollY);
  expect(parkedChrome.headerTop).toBe(beforeScroll.headerTop);
  expect(parkedChrome.transportTop).toBe(beforeScroll.transportTop);
  expect(parkedChrome.railVisible).toBe(true);

  await expect(page.locator(".media-transport__rail")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Play (or pause segment|from) / }).first(),
  ).toBeVisible();
});

test("unavailable media leaves transcript follow dormant after a rejected timestamp seek", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Unavailable media rest state",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);

  execRuntimeSql("update recordings set media_path = null where id = ?", [recordingId]);
  await openCasefile(page, recordingId);

  await expect(
    page.getByText("No media asset is attached to this recording yet."),
  ).toBeVisible();
  const unavailableGeometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".casefile-main");
    const transcript = document.querySelector<HTMLElement>(
      ".transcript-document",
    );
    if (!main || !transcript) {
      return null;
    }
    const mainRect = main.getBoundingClientRect();
    const transcriptRect = transcript.getBoundingClientRect();
    return {
      centered:
        Math.abs(
          transcriptRect.left + transcriptRect.width / 2 -
            (mainRect.left + mainRect.width / 2),
        ) <= 1,
      spansMain: transcriptRect.width >= mainRect.width - 1,
    };
  });
  expect(unavailableGeometry).toEqual({ centered: true, spansMain: true });
  const timestamp = page.getByRole("button", {
    name: /Play or pause segment 1, /,
  });
  await expect(timestamp).toBeVisible();
  const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));

  await timestamp.click();
  await page.waitForTimeout(1_000);

  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(scrollBefore);
});

test("active timestamp play rejection leaves transcript follow dormant", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Rejected active timestamp play",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);
  await openCasefile(page, recordingId);

  const timestamp = page.getByRole("button", {
    name: /Play or pause segment 1, /,
  });
  await expect(timestamp).toBeVisible();
  await page.locator("audio, video").evaluate((media) => {
    (media as HTMLMediaElement).play = () =>
      Promise.reject(new DOMException("Playback blocked"));
  });
  const before = await page.evaluate(() => ({
    activeTop:
      document.querySelector(".transcript-segment[data-active]")?.getBoundingClientRect()
        .top ?? null,
    transcriptScrollTop:
      document.querySelector<HTMLElement>(".transcript-document__segments")
        ?.scrollTop ?? null,
    windowScrollY: window.scrollY,
  }));

  await timestamp.click();
  await page.waitForTimeout(1_000);

  expect(
    await page.evaluate(() => ({
      activeTop:
        document.querySelector(".transcript-segment[data-active]")?.getBoundingClientRect()
          .top ?? null,
      transcriptScrollTop:
        document.querySelector<HTMLElement>(".transcript-document__segments")
          ?.scrollTop ?? null,
      windowScrollY: window.scrollY,
    })),
  ).toEqual(before);
});

test("phone-width rest state: player stays available behind the review gate notice", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Media rest state phone record",
    durationMs: 10_000,
  });
  await waitForRestStateTranscript(page);

  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await openCasefile(page, recordingId);

  // Phone safety gate: review and decisions stay on tablet-or-desktop.
  await expect(
    page.getByText("Review and decisions require a tablet or desktop."),
  ).toBeVisible();

  // The media player is not hidden by the gate: the video hero still
  // renders at phone width.
  await expect(page.locator("video[controls]")).toBeVisible();
});
