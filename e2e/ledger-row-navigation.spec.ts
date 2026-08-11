import { expect, test } from "@playwright/test";
import { adminUser, bootstrapAndLogin, uploadFixture } from "./support/appliance";

/** Regression coverage for the Work Inbox navigation contract in DESIGN.md. */

test.describe.serial("ledger row navigation", () => {
  test("admin opens a case by clicking anywhere on a desktop ledger row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await bootstrapAndLogin(page, adminUser);
    const title = "Ledger row navigation record";
    const recordingId = await uploadFixture(page, { title });

    await page.goto("/workspace");
    // Scope by the unique recording id (titles repeat across host-lane reruns).
    const row = page
      .getByRole("table", { name: "Work recordings" })
      .getByRole("row")
      .filter({ hasText: recordingId });

    const link = row.getByRole("link", { name: title });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText("Open record");

    // Clicking the row body (top-left padding, away from the action button)
    // navigates to the casefile.
    await row.click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(new RegExp(`/recordings/${recordingId}$`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });
  });

  test("admin opens a case by tapping anywhere on a 390px ledger card", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrapAndLogin(page, adminUser);
    const title = "Ledger card navigation record";
    const recordingId = await uploadFixture(page, { title });

    await page.goto("/workspace");
    const card = page
      .getByRole("list", { name: "Work recordings" })
      .locator(".recording-card")
      .filter({ hasText: recordingId });

    const link = card.getByRole("link", { name: title });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText("Open record");

    // Tap the card facts area (below the header and its action button).
    await card.click({ position: { x: 40, y: 190 } });
    await expect(page).toHaveURL(new RegExp(`/recordings/${recordingId}$`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });
  });
});
