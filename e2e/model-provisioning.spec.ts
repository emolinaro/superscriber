import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  clearModelDownloadFixture,
  provisionRuntimeModelTier,
  removeRuntimeModelTier,
  runtimeModelTierFileSize,
  seedModelDownloadFixture,
} from "./support/appliance";

// model-tier-provisioning: the picker's in-app install path end to end -
// admins get a sized one-click Download per unprovisioned tier, live progress
// while it lands, honest state when it is done, and the catalog's
// best-available default is recomputed the moment host truth changes. The
// download transport runs against the fixture seam (fast local bytes standing
// in for the pinned huggingface.co URLs, same disk path and reveal logic), and
// one network-gated test proves the REAL pinned download of the tiny tier.
//
// Tiers used: "base" for the fixture installs; "tiny" for the real download.
// Both are removed again so sibling specs see the host they expect.

const BASE_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"];
// Big enough that the throttled fixture transport keeps the progress surface
// observable for several poll ticks (8 chunks at 250 ms each).
const FIXTURE_MODEL_BIN_BYTES = 8 * 1024 * 1024;

test.describe.serial("model tier provisioning (model-tier-provisioning)", () => {
  test.beforeAll(() => {
    for (const tierId of ["base", "tiny", "large-v3-turbo"]) {
      removeRuntimeModelTier(tierId);
    }
    clearModelDownloadFixture();
  });

  test.afterAll(() => {
    for (const tierId of ["base", "tiny", "large-v3-turbo"]) {
      removeRuntimeModelTier(tierId);
    }
    clearModelDownloadFixture();
  });

  async function openAdvancedSettings(page: import("@playwright/test").Page) {
    await page.goto("/ingest");
    await page.waitForLoadState("networkidle");
    const advanced = page.getByTestId("advanced-settings");
    await advanced.getByText("Advanced settings").click();
    const modelSelect = advanced.locator("#recording-model");
    await expect(modelSelect).toBeEnabled();
    return modelSelect;
  }

  test("admin installs a tier from the picker: size on the button, live progress, then selectable and default", async ({
    page,
  }) => {
    seedModelDownloadFixture("base", BASE_FILES, { modelBinBytes: FIXTURE_MODEL_BIN_BYTES });
    await bootstrapAndLogin(page, adminUser);

    const modelSelect = await openAdvancedSettings(page);

    // Nothing provisioned on this lane: both tiers are honest about it, and
    // every unprovisioned tier carries a sized one-click install action.
    const baseButton = page.getByRole("button", { name: "Download base (141.0 MB)" });
    await expect(baseButton).toBeVisible();
    await expect(page.getByRole("button", { name: "Download tiny (74.6 MB)" })).toBeVisible();
    await expect(modelSelect.locator('option[value="base"]')).toBeDisabled();

    await baseButton.click();

    // Live progress while the install runs: a real progressbar plus a byte
    // readout against the pinned size.
    const progress = page.getByRole("progressbar", { name: "Downloading base model" });
    await expect(progress).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Downloading base: .+ of 141\.0 MB/)).toBeVisible();

    // While one tier installs the others cannot start (the server serializes).
    await expect(page.getByRole("button", { name: "Download tiny (74.6 MB)" })).toBeDisabled();

    // Completion: the tier turns selectable (no reload), the action dissolves,
    // and the best-available default moves to the newly provisioned tier.
    await expect(modelSelect.locator('option[value="base"]')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Download base (141.0 MB)" })).toHaveCount(0);
    await expect(modelSelect).toHaveValue("base", { timeout: 15_000 });

    // Hand-provisioning a STRONGER tier on the host flips the best-available
    // default on the next visit - the picker default never sticks to weaker
    // tiers when better ones are provisioned.
    provisionRuntimeModelTier("large-v3-turbo");
    const refreshedSelect = await openAdvancedSettings(page);
    await expect(refreshedSelect.locator('option[value="large-v3-turbo"]')).toBeEnabled();
    await expect(refreshedSelect).toHaveValue("large-v3-turbo");
    // A completed, now-available tier offers no install control.
    await expect(page.getByRole("button", { name: /Download base/ })).toHaveCount(0);
  });

  test("phone-safety sessions never see the install controls", async ({ page }) => {
    seedModelDownloadFixture("base", BASE_FILES, { modelBinBytes: FIXTURE_MODEL_BIN_BYTES });
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrapAndLogin(page, adminUser);

    await openAdvancedSettings(page);
    await expect(page.getByRole("button", { name: /Download / })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test("really downloads the tiny tier from the pinned huggingface.co source when the network allows", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    // No fixture for tiny -> the real pinned huggingface.co transport runs.
    clearModelDownloadFixture("tiny");
    removeRuntimeModelTier("tiny");

    const reachable = await page.request
      .get("https://huggingface.co/api/models/Systran/faster-whisper-tiny", { timeout: 10_000 })
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!reachable, "huggingface.co is unreachable from this lane; pinned-download proof skipped.");

    await bootstrapAndLogin(page, adminUser);
    const modelSelect = await openAdvancedSettings(page);
    await expect(modelSelect.locator('option[value="tiny"]')).toBeDisabled();

    await page.getByRole("button", { name: "Download tiny (74.6 MB)" }).click();
    await expect(
      page.getByRole("progressbar", { name: "Downloading tiny model" }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(modelSelect.locator('option[value="tiny"]')).toBeEnabled({ timeout: 240_000 });

    // Real bytes, not fixture stubs: the tiny model.bin is its pinned size.
    expect(runtimeModelTierFileSize("tiny", "model.bin")).toBe(75_538_270);
    expect(runtimeModelTierFileSize("tiny", "config.json")).toBe(2_249);
  });
});
