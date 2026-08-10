import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createSilentWavFixture,
} from "./support/appliance";

test.describe.serial("batch ingest", () => {
  test("uploads a two-file batch with persistent per-file results", async ({ page }) => {
    const alpha = createSilentWavFixture("batch-alpha.wav", 500);
    const beta = createSilentWavFixture("batch-beta.wav", 500);

    try {
      await bootstrapAndLogin(page, adminUser);
      await page.goto("/ingest");
      await page.waitForLoadState("networkidle");

      // Persistent transfer surface: visible before any transfer starts.
      await expect(page.getByTestId("transfer-progress")).toContainText("Idle");
      await expect(page.getByTestId("transfer-progress")).toContainText(
        "No transfer in progress.",
      );
      await expect(
        page.getByRole("button", { name: "Upload file" }),
      ).toBeEnabled();

      await page.locator("#recording-title").fill("Batch harness");
      await page.locator("#recording-language").selectOption("english");
      await page.locator("#upload-file").setInputFiles([alpha.path, beta.path]);
      await expect(page.getByTestId("batch-count")).toHaveText("2 files selected.");

      await page.getByRole("button", { name: "Upload file" }).click();

      const results = page.getByTestId("batch-results");
      await expect(results).toBeVisible();
      await expect(results.getByText("batch-alpha.wav").locator("..")).toHaveAttribute(
        "data-state",
        "queued",
      );
      await expect(results.getByText("batch-beta.wav").locator("..")).toHaveAttribute(
        "data-state",
        "queued",
      );
      await expect(results).toContainText("Queued for transcription");
      await expect(
        page.locator(".ingest-status-card"),
      ).toContainText("Batch complete: 2 recordings queued for transcription.");

      // No redirect in batch mode, and the submit control returns to idle.
      await expect(page).toHaveURL(/\/ingest$/);
      await expect(
        page.getByRole("button", { name: "Upload file" }),
      ).toBeEnabled();

      // Both files produced real recordings under their own file-stem titles.
      await page.goto("/workspace");
      await expect(page.getByText("batch-alpha").first()).toBeVisible();
      await expect(page.getByText("batch-beta").first()).toBeVisible();
    } finally {
      alpha.cleanup();
      beta.cleanup();
    }
  });

  test("single-file upload keeps the original redirect behavior", async ({ page }) => {
    const solo = createSilentWavFixture("batch-control.wav", 500);

    try {
      await bootstrapAndLogin(page, adminUser);
      await page.goto("/ingest");
      await page.waitForLoadState("networkidle");
      await page.locator("#recording-title").fill("Single-file regression control");
      await page.locator("#recording-language").selectOption("english");
      await page.locator("#upload-file").setInputFiles(solo.path);
      await expect(page.getByTestId("batch-count")).toHaveCount(0);

      await page.getByRole("button", { name: "Upload file" }).click();
      await expect(page).toHaveURL(/\/recordings\/[^/?]+/, { timeout: 30_000 });
      await expect(
        page.getByRole("heading", { name: "Single-file regression control" }),
      ).toBeVisible();
    } finally {
      solo.cleanup();
    }
  });
});
