import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  firstTranscriptRow,
  openCasefile,
  uploadFixture,
} from "./support/appliance";

// Rest-state contract: after the rollback of the media-casefile layout work
// (#53/#54), the casefile media surface returns to its earlier presentation:
// the full media player leads the casefile main column, a compact segment
// chip strip sits between the player and the transcript document whenever the
// window can afford it, and the transcript review surface stays below both.
// The vertical-budget rule is part of the rest state too: on short
// laptop-height windows (>=1100px wide, <=920px tall) the pinned transport
// collapses the chip rail so the review surface keeps room - every segment
// still seeks from its transcript row timestamp. On phone-width viewports
// the review surface is safety-gated behind the tablet-or-desktop notice
// while the player stays available. A future layout change must update this
// spec deliberately instead of silently reverting the rest state.

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

test("video casefile rest state: full player leads, compact chip strip below, transcript last", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Tall reference window: the vertical-budget rule below is exercised
  // separately; here the full rest state (rail included) is on display.
  await page.setViewportSize({ width: 1280, height: 960 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Media rest state record",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);

  // Promote the uploaded audio record to a video casefile the same way the
  // appliance labels real video uploads.
  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await openCasefile(page, recordingId);

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

  // Vertical-budget rest state: shrink to a laptop-height window and the
  // pinned transport collapses the chip rail; the transcript rows keep the
  // per-segment seek affordance.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".media-transport__rail")).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Play (or pause segment|from) / }).first(),
  ).toBeVisible();
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
