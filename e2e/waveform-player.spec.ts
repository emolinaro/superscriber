import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  openAssignedDraft,
  reviewerUser,
  uploadFixture,
} from "./support/appliance";

/**
 * Waveform player bring-back (inventory #4): the decoded-wave progress bar
 * replaces the stock audio controls, stays synced to playback, seeks by
 * click and by segment marker, and rides both appearance modes on desktop
 * and phone widths.
 *
 * The upload is a 70s silent fixture so the media outlasts the degraded
 * fallback transcript (two segments: 0-8s and 8-16s); only then do the
 * markers sit mid-wave rather than pinned past the end of the audio.
 */
test.describe.serial("waveform player", () => {
  test("desktop light: renders the wave, tracks playback, and seeks by click and marker", async ({
    page,
  }, testInfo) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, {
      title: "Wave player record",
      durationMs: 70_000,
    });
    await createAndAssignUsers(page, recordingId);
    await openAssignedDraft(page, reviewerUser);

    // The wave renders ready and the native controls are dropped.
    const scrubber = page.getByTestId("wave-scrubber");
    await expect(scrubber).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.locator("audio[controls]")).toHaveCount(0);

    const stage = scrubber.locator(".media-transport__wave-stage");
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();

    const media = page.locator("audio");
    const duration = await media.evaluate((node: HTMLAudioElement) => node.duration);
    expect(duration).toBeGreaterThan(30);

    // The seek slider exposes an accessible value.
    await expect(stage).toHaveAttribute("role", "slider");
    await expect(stage).toHaveAttribute("aria-valuemax", String(Math.round(duration)));

    // Click-to-seek: tapping 3/4 across the wave lands at ~3/4 of the
    // duration. Position-relative locator clicks re-measure the box at click
    // time, so they survive layout shifts that stale absolute coordinates do
    // not.
    await stage.click({ position: { x: box!.width * 0.75, y: box!.height / 2 } });
    const clickedAt = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
    expect(Math.abs(clickedAt - duration * 0.75)).toBeLessThan(1.5);

    // Playback moves the playhead: mute avoids the headless autoplay gesture.
    await media.evaluate((node: HTMLAudioElement) => {
      node.muted = true;
      void node.play();
    });
    await expect
      .poll(() => media.evaluate((node: HTMLAudioElement) => node.currentTime), {
        timeout: 10_000,
      })
      .toBeGreaterThan(clickedAt + 0.4);

    // The transport Play/Pause toggle halts playback and follows the media
    // element's own state.
    const toggle = page.getByTestId("transport-play-toggle");
    await expect(toggle).toHaveText("Pause");
    await toggle.click();
    await expect(toggle).toHaveText("Play");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const pausedAt = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
    await page.waitForTimeout(600);
    const stillPausedAt = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
    expect(stillPausedAt - pausedAt).toBeLessThan(0.06);
    await toggle.click();
    await expect(toggle).toHaveText("Pause");

    // Segment markers sit on the wave (fallback transcript: two segments,
    // the second starting at 8s) and actuating one seeks to its start and
    // lights the active-segment band.
    const markers = page.locator(".media-transport__wave-marker");
    await expect(markers).toHaveCount(2);
    await markers.nth(1).click();
    const afterMarker = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
    expect(Math.abs(afterMarker - 8)).toBeLessThan(1.5);
    await expect(scrubber.getByTestId("wave-active-band")).toBeVisible();

    const screenshot = await scrubber.screenshot();
    await testInfo.attach("wave-scrubber-desktop-light", {
      body: screenshot,
      contentType: "image/png",
    });
  });

  test("phone 390px dark: wave renders, seeks, and keeps markers actuatable", async ({
    browser,
    page,
  }, testInfo) => {
    // Admin setup stays on the desktop surface (the shared helpers walk the
    // administration pages, which are not the phone surface under test).
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, {
      title: "Wave player phone record",
      durationMs: 70_000,
    });
    await createAndAssignUsers(page, recordingId);

    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: "light",
    });
    // Explicit dark beats the light OS setting; the layout boot script reads
    // this copy pre-paint.
    await phoneContext.addInitScript(() => {
      window.localStorage.setItem("superscriber.theme", "dark");
    });
    const phone = await phoneContext.newPage();
    try {
      await openAssignedDraft(phone, reviewerUser);

      // Dark rendering is actually in force on the casefile surface.
      await expect
        .poll(async () =>
          phone.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--color-bone")
              .trim(),
          ),
        )
        .toBe("#131918");

      const scrubber = phone.getByTestId("wave-scrubber");
      await expect(scrubber).toHaveAttribute("data-ready", "true", { timeout: 30_000 });

      const stage = scrubber.locator(".media-transport__wave-stage");
      const box = await stage.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(390);

      const media = phone.locator("audio");
      const duration = await media.evaluate((node: HTMLAudioElement) => node.duration);
      expect(duration).toBeGreaterThan(30);

      // Tap-to-seek at the midpoint lands within tolerance.
      await stage.click({ position: { x: box!.width * 0.5, y: box!.height / 2 } });
      const tappedAt = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
      expect(Math.abs(tappedAt - duration * 0.5)).toBeLessThan(1.5);

      // Marker actuation still seeks on the narrow surface.
      const markers = phone.locator(".media-transport__wave-marker");
      await expect(markers).toHaveCount(2);
      await markers.nth(0).click();
      const afterMarker = await media.evaluate((node: HTMLAudioElement) => node.currentTime);
      expect(afterMarker).toBeLessThan(1.5);
      await expect(scrubber.getByTestId("wave-active-band")).toBeVisible();

      const screenshot = await scrubber.screenshot();
      await testInfo.attach("wave-scrubber-390-dark", {
        body: screenshot,
        contentType: "image/png",
      });
    } finally {
      await phoneContext.close();
    }
  });
});
