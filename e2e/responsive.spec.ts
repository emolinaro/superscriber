import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  openAssignedDraft,
  uploadFixture,
  reviewerUser,
} from "./support/appliance";

const VIEWPORTS = [
  { width: 320, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
  { width: 1024, height: 768 },
  { width: 1440, height: 1000 },
] as const;

test.describe.serial("responsive governed casefile layout", () => {
  test("keeps transcript geometry, gutters, sticky actions, and targets within bounds", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Responsive governed record" });
    await createAndAssignUsers(page, recordingId);

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        hasTouch: viewport.width < 768,
        isMobile: viewport.width < 768,
        viewport,
      });
      const responsivePage = await context.newPage();
      await openAssignedDraft(responsivePage, reviewerUser);

      const transcriptStart = responsivePage.getByTestId("transcript-start");
      await transcriptStart.scrollIntoViewIfNeeded();
      const transcriptBox = await transcriptStart.boundingBox();
      expect(transcriptBox).not.toBeNull();
      expect(transcriptBox?.y ?? 0).toBeLessThanOrEqual(viewport.height - 16);
      expect(transcriptBox?.x ?? 0).toBeGreaterThanOrEqual(16);
      expect(viewport.width - ((transcriptBox?.x ?? 0) + (transcriptBox?.width ?? 0))).toBeGreaterThanOrEqual(16);

      const overflow = await responsivePage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);

      const buttons = responsivePage.getByRole("button");
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        const box = await buttons.nth(index).boundingBox();
        if (box) {
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
        }
      }

      const titleBox = await responsivePage.getByRole("heading", { name: "Responsive governed record" }).boundingBox();
      expect(titleBox).not.toBeNull();
      const actionBarBox = await responsivePage.getByRole("region", { name: "Case actions" }).boundingBox();
      expect(actionBarBox).not.toBeNull();
      expect((actionBarBox?.y ?? 0) + (actionBarBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);

      await context.close();
    }
  });
});
