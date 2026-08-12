import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  openAssignedDraft,
  reviewerUser,
  uploadFixture,
} from "./support/appliance";

test.setTimeout(150_000);

test("short coarse landscape preserves a centered transcript interval", async ({
  browser,
  page,
}) => {
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Short landscape playback record",
    durationMs: 70_000,
  });
  await createAndAssignUsers(page, recordingId);

  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
  });
  const landscape = await context.newPage();

  try {
    await openAssignedDraft(landscape, reviewerUser);
    await expect(landscape.getByTestId("wave-scrubber")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 30_000 },
    );

    const geometry = await landscape.evaluate(() => {
      const transport = document.querySelector<HTMLElement>(".media-transport")!;
      const actionBar = document.querySelector<HTMLElement>(".casefile-action-bar")!;
      const waveStage = document.querySelector<HTMLElement>(
        ".media-transport__wave-stage",
      )!;
      const transportActionCenters = Array.from(
        document.querySelector<HTMLElement>(".media-transport__actions")!.children,
      ).map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      const actionBarCenters = Array.from(actionBar.children).map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });

      return {
        actionBarHeight: actionBar.getBoundingClientRect().height,
        actionBarRowSpread:
          Math.max(...actionBarCenters) - Math.min(...actionBarCenters),
        totalChromeHeight:
          transport.getBoundingClientRect().height +
          actionBar.getBoundingClientRect().height,
        transportActionRowSpread:
          Math.max(...transportActionCenters) - Math.min(...transportActionCenters),
        waveStageHeight: waveStage.getBoundingClientRect().height,
      };
    });

    expect(geometry.waveStageHeight).toBeLessThanOrEqual(70);
    expect(geometry.transportActionRowSpread).toBeLessThanOrEqual(4);
    expect(geometry.actionBarRowSpread).toBeLessThanOrEqual(4);
    expect(geometry.actionBarHeight).toBeLessThanOrEqual(52);
    expect(geometry.totalChromeHeight).toBeLessThanOrEqual(294);
  } finally {
    await context.close();
  }
});
