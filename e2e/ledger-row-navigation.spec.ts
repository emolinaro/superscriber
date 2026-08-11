import { expect, test } from "@playwright/test";
import { adminUser, bootstrapAndLogin, uploadFixture } from "./support/appliance";

/**
 * Ledger row navigation regression (demo bring-back).
 *
 * The governed-redesign squash (pr2-head b421809 "honor server action labels",
 * landed as 2ef883b in v0.4.0) made the per-row case link conditional on a
 * role action label. Admin and uploader rows, and reviewer/approver rows in
 * waiting stages, get `actionLabel: null` from the server, so they rendered
 * no affordance at all and pointer users could not open a case from the
 * ledger - even though admin oversight covers "every inbox row, every current
 * casefile" (DESIGN.md). The demo line had the "Open record" fallback per row.
 *
 * Contract: every ledger row exposes exactly one case link named by the
 * recording title (the role action label, or the "Open record" fallback), and
 * clicking anywhere on the row/card opens the casefile.
 */

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

    // Exactly one case link per row, named by the recording title, carrying
    // the oversight fallback label when no role action applies.
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
