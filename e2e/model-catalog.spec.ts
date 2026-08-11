import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  buildSilentWavBuffer,
  provisionRuntimeModelTier,
  queryRuntimeRows,
  setUploadFile,
} from "./support/appliance";

// demo-model-tier-picker: end-to-end contract of the Advanced settings tier
// picker - availability is host-checked, the choice persists on the
// recording, and the worker visibly receives it.

const CATALOG_TIERS = [
  "large-v3",
  "large-v3-turbo",
  "distil-large-v3",
  "large-v2",
  "large-v1",
  "medium",
  "small",
  "base",
  "tiny",
];

test.describe.serial("model catalog tier picker (demo-model-tier-picker)", () => {
  test("shows all nine faster-whisper tiers with unprovisioned ones disabled, and none preselected", async ({
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);

    await page.goto("/ingest");
    await expect(
      page.getByRole("heading", {
        name: "Bring audio into the governed queue without losing your place.",
      }),
    ).toBeVisible();

    // The catalog is loaded lazily: expanding Advanced settings must enable
    // the picker once the server answer is in.
    const advanced = page.getByTestId("advanced-settings");
    await advanced.getByText("Advanced settings").click();
    const modelSelect = advanced.locator("#recording-model");
    await expect(modelSelect).toBeEnabled();

    for (const tierId of CATALOG_TIERS) {
      const option = modelSelect.locator(`option[value="${tierId}"]`);
      await expect(option).toHaveCount(1);
      // Nothing was provisioned for this lane yet: every tier is honest
      // about not being runnable here.
      await expect(option).toBeDisabled();
      expect(await option.textContent()).toContain("not available on this host");
    }

    // Host truth changes pick up on the next visit (no app restart): once a
    // tier's artifacts exist it becomes selectable and marked the default.
    provisionRuntimeModelTier("tiny");
    await page.reload();
    await page.getByTestId("advanced-settings").getByText("Advanced settings").click();
    const refreshedSelect = page.locator("#recording-model");
    await expect(refreshedSelect).toBeEnabled();

    const tinyOption = refreshedSelect.locator(`option[value="tiny"]`);
    await expect(tinyOption).toBeEnabled();
    expect(await tinyOption.textContent()).toContain("default (best quality on this host)");
    // Best-quality provisioned tier is preselected by the server answer.
    await expect(refreshedSelect).toHaveValue("tiny");

    // Everything else stays honestly disabled.
    for (const tierId of CATALOG_TIERS.filter((id) => id !== "tiny")) {
      await expect(refreshedSelect.locator(`option[value="${tierId}"]`)).toBeDisabled();
    }
  });

  test("persists the chosen tier on the recording and the worker visibly receives it", async ({
    page,
  }) => {
    provisionRuntimeModelTier("tiny");
    await bootstrapAndLogin(page, adminUser);

    const title = "Tier-picked recording";
    await page.goto("/ingest");
    await page.locator("#recording-title").fill(title);
    await page.locator("#recording-language").selectOption("english");
    await page.getByTestId("advanced-settings").getByText("Advanced settings").click();
    const modelSelect = page.locator("#recording-model");
    await expect(modelSelect).toBeEnabled();
    await modelSelect.selectOption("tiny");

    await setUploadFile(page, {
      name: "tier-picked.wav",
      mimeType: "audio/wav",
      buffer: buildSilentWavBuffer({ durationMs: 1_500 }),
    });
    await page.getByRole("button", { name: "Upload file" }).click();
    await expect(page).toHaveURL(/\/recordings\/[^/?]+/, { timeout: 30_000 });
    const recordingId = page.url().match(/\/recordings\/([^/?]+)/)?.[1] ?? "";
    expect(recordingId).not.toBe("");

    // The persisted pick survives on the recording row.
    const rows = queryRuntimeRows<{ transcriptModel: string | null }>(
      `select transcript_model as transcriptModel from recordings where id = ?`,
      [recordingId],
    );
    expect(rows[0]?.transcriptModel).toBe("tiny");

    // The worker consumed it: this lane's tier artifacts are fabricated, so
    // the run degrades honestly and the revision summary says the requested
    // tier could not run instead of hiding the pick.
    await expect
      .poll(
        () => {
          const revisions = queryRuntimeRows<{ summary: string | null }>(
            `select r.summary as summary
               from revisions r
               join recordings rec on rec.current_revision_id = r.id
              where rec.id = ?`,
            [recordingId],
          );
          return revisions[0]?.summary ?? "";
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toContain("Requested model 'tiny' could not run on this host");
  });
});
