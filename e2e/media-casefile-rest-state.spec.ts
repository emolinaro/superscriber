import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  firstTranscriptRow,
  openCasefile,
  uploadFixture,
} from "./support/appliance";

// Rest-state contract after the visible-context layout (which deliberately
// replaced the rollback-era bounded shell): the casefile desktop page
// window-scrolls - no bounded shell, no nested transcript scrollport, no
// pinned transport on >=1100px. The full media player leads the casefile
// main column, the segment chip strip sits between the player and the
// transcript document, and the transcript review surface flows below both,
// fully scrollable, with follow-scroll centering the active segment in the
// exact middle of the viewport (see e2e/visible-context.spec.ts for the
// centering band contract). Below 1100px the transport stays viewport-pinned
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

test("video casefile rest state: full player leads, chip strip below, transcript last, window scrolls", async ({
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
  // the page always has more content than the viewport can hold (the
  // window-scroll assertions below need real scroll travel).
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

  // Rest-state geometry: the player hero sits above the chip strip, the
  // chip strip sits above the transcript document, and the media transport
  // owns the top of the casefile main column.
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
    if (!main || !transportEl || !videoEl || !railEl || !transcriptEl) {
      return null;
    }

    const videoRect = videoEl.getBoundingClientRect();
    const railRect = railEl.getBoundingClientRect();
    const transcriptRect = transcriptEl.getBoundingClientRect();
    const transportFirst =
      (main.firstElementChild?.compareDocumentPosition(transportEl) ??
        0) === 0 ||
      Array.from(main.children).indexOf(transportEl) === 0;

    return {
      transportFirst,
      videoHeight: videoRect.height,
      videoAboveRail: videoRect.bottom <= railRect.top + 1,
      railAboveTranscript: railRect.bottom <= transcriptRect.top + 1,
      transportSpansMain: transportEl.getBoundingClientRect().top <= videoRect.top + 1,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.transportFirst).toBe(true);
  expect(geometry?.videoHeight).toBeGreaterThanOrEqual(96);
  expect(geometry?.videoAboveRail).toBe(true);
  expect(geometry?.railAboveTranscript).toBe(true);
  expect(geometry?.transportSpansMain).toBe(true);

  // Window-scroll rest state (visible-context): the desktop casefile has
  // no bounded shell or nested scrollport - the page scrolls as a document,
  // the transport flows (not pinned) at desktop width, and the header and
  // transport both leave the viewport once the transcript scrolls. The chip
  // rail stays available at every desktop height now (the pin-pressure
  // collapse below 920px was a bounded-shell rule and is gone), and every
  // segment still seeks from its transcript row timestamp.
  const scrollState = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".casefile-main");
    const transportEl = document.querySelector<HTMLElement>(".media-transport");
    return {
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
      mainOverflowY: main ? getComputedStyle(main).overflowY : "missing",
      transportPosition: transportEl
        ? getComputedStyle(transportEl).position
        : "missing",
    };
  });
  expect(scrollState.pageScrolls).toBe(true);
  expect(scrollState.mainOverflowY).toBe("visible");
  expect(scrollState.transportPosition).toBe("static");

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight / 2),
  );
  const parkedChrome = await page.evaluate(() => {
    const header = document.querySelector(".case-header")?.getBoundingClientRect();
    const transportEl = document.querySelector(".media-transport")?.getBoundingClientRect();
    return {
      headerGone: (header?.bottom ?? 1) <= 0,
      transportGone: (transportEl?.bottom ?? 1) <= 0,
    };
  });
  expect(parkedChrome.headerGone).toBe(true);
  expect(parkedChrome.transportGone).toBe(true);

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
    media.play = () => Promise.reject(new DOMException("Playback blocked"));
  });
  await timestamp.evaluate((button) => {
    const top = button.getBoundingClientRect().top + window.scrollY - 120;
    window.scrollTo(0, top);
  });
  await expect
    .poll(() => timestamp.evaluate((button) => Math.round(button.getBoundingClientRect().top)))
    .toBe(120);
  const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));

  await timestamp.click();
  await page.waitForTimeout(1_000);

  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(scrollBefore);
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
