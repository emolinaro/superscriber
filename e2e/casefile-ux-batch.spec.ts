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
 * Casefile UX batch regressions (demo bring-back, inventory #14):
 * - the sticky case action bar never widens the page horizontally
 *   (demo-actionbar-overflow);
 * - the accounts search row aligns label, growing input, hugging button
 *   (demo-accounts-search-misaligned);
 * - phone safety names the withheld review/decision affordances in both the
 *   pinned action bar and the transcript document (demo-mobile-view /
 *   demo-segment-edit).
 */

test.describe.serial("casefile ux batch", () => {
  test("the casefile never overflows horizontally at any supported width", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "UX batch geometry record" });
    await createAndAssignUsers(page, recordingId);

    for (const width of [1440, 1180, 820, 500]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      const probe = await context.newPage();
      await openAssignedDraft(probe, reviewerUser);

      const geometry = await probe.evaluate(() => {
        const bar = document.querySelector(".casefile-action-bar")?.getBoundingClientRect();
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          barRight: bar?.right ?? null,
        };
      });
      expect(
        geometry.docScrollWidth,
        `viewport ${width}px: document must not overflow horizontally`,
      ).toBeLessThanOrEqual(geometry.innerWidth);
      expect(geometry.barRight).not.toBeNull();
      expect(
        geometry.barRight!,
        `viewport ${width}px: action bar stays inside the page frame`,
      ).toBeLessThanOrEqual(geometry.innerWidth);

      await context.close();
    }
  });

  test("phone safety copy names the withheld affordances", async ({ browser, page }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "UX batch phone-safety record" });
    await createAndAssignUsers(page, recordingId);

    const phoneContext = await browser.newContext({
      viewport: { width: 500, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const phonePage = await phoneContext.newPage();
    await openAssignedDraft(phonePage, reviewerUser);

    await expect(phonePage.locator(".casefile-action-bar__phone-note")).toHaveText(
      "Review and decisions require a tablet or desktop.",
    );
    await expect(phonePage.locator(".casefile-action-bar button")).toHaveCount(0);

    // The transcript surface names its withheld editors as well.
    await expect(phonePage.locator(".transcript-document .inline-notice")).toContainText(
      "Review and decisions require a tablet or desktop.",
    );

    await phoneContext.close();
  });

  test("the accounts search row aligns the input and the button", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await page.goto("/administration?section=accounts");

    const search = page.getByRole("searchbox", { name: "Search accounts" });
    const button = page.getByRole("button", { name: "Search", exact: true });
    const inputBox = await search.boundingBox();
    const buttonBox = await button.boundingBox();

    expect(inputBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(Math.abs(inputBox!.y - buttonBox!.y)).toBeLessThanOrEqual(4);
    expect(buttonBox!.width).toBeLessThan(inputBox!.width / 2);
  });
});
