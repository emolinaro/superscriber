import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  openAssignedCasefile,
  openAssignedDraft,
  uploadFixture,
  reviewerUser,
} from "./support/appliance";

const PHONE_VIEWPORTS = [
  { width: 320, height: 800 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
];

// Confidence values depend on the transcription engine: the mock engine and a
// real Whisper model render 93/90/86, while the internal-engine container flow
// pins a deliberately missing model and falls back to the Python stub, which
// renders a fixed 72. scripts/run-e2e-appliance.sh exports
// SUPERSCRIBER_E2E_ENGINE=stub so this assertion stays engine-aware rather
// than blindly accepting any value.
const CONFIDENCE_PATTERN =
  process.env.SUPERSCRIBER_E2E_ENGINE === "stub"
    ? /Confidence 72%/
    : /Confidence 9[03]%|Confidence 86%/;

test.describe.serial("phone safety governed casefile regression", () => {
  test("keeps phone-sized work read-only while preserving supported auth, media, status, and upload surfaces", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Phone safety governed record" });
    await createAndAssignUsers(page, recordingId);

    for (const viewport of PHONE_VIEWPORTS) {
      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport,
      });
      const phonePage = await context.newPage();

      await openAssignedDraft(phonePage, reviewerUser);
      await expect(phonePage.getByRole("heading", { name: "Phone safety governed record" })).toBeVisible();
      await expect(phonePage.getByText("Draft review").first()).toBeVisible();
      await expect(phonePage.getByRole("group", { name: "Recording playback" })).toBeVisible();
      await expect(phonePage.getByText(CONFIDENCE_PATTERN).first()).toBeVisible();
      await expect(phonePage.getByRole("button", { name: /Save draft|Submit for approval|Withdraw revision|Request changes|Approve and complete work|Reopen as draft|Export approved transcript|Enter .* action mode/ })).toHaveCount(0);
      await expect(phonePage.getByRole("textbox")).toHaveCount(0);
      await expect(phonePage.getByRole("button", { name: "Jump back 10 seconds" })).toBeVisible();
      await expect(phonePage.getByLabel("Playback rate")).toBeVisible();
      await expect(phonePage.getByRole("article", { name: /Transcript segment 1, / })).toBeVisible();

      await context.close();
    }

    const phoneAdminContext = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const phoneAdminPage = await phoneAdminContext.newPage();
    await phoneAdminPage.goto("/");
    await expect(phoneAdminPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await phoneAdminPage.getByLabel("Email").fill(adminUser.email);
    await phoneAdminPage.getByLabel("Password").fill(adminUser.password);
    await phoneAdminPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(phoneAdminPage).toHaveURL(/\/workspace$/);
    await phoneAdminPage.goto("/ingest");
    await expect(phoneAdminPage.getByRole("heading", { name: /Source, details, and transfer/ })).toBeVisible();
    await expect(phoneAdminPage.locator("#upload-file")).toBeVisible();
    await expect(phoneAdminPage.getByRole("button", { name: "Upload file" })).toBeVisible();
    await phoneAdminContext.close();
  });
});
