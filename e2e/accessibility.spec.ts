import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  adminUser,
  approverUser,
  bootstrapAndLogin,
  completeReasonDialog,
  createAndAssignUsers,
  firstTranscriptRow,
  login,
  openAssignedCasefile,
  openAssignedDraft,
  openCasefile,
  reviewerUser,
  uploadFixture,
} from "./support/appliance";

async function expectNoViolations(page: Parameters<typeof openCasefile>[0], label: string) {
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 10_000 });

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, label).toEqual([]);
}

test.describe.serial("accessibility workflows", () => {
  test("passes axe across auth, inbox, casefile, export, and administration surfaces", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /First-run setup|Sign in/ })).toBeVisible();
    await expectNoViolations(page, "landing auth surface");

    await bootstrapAndLogin(page, adminUser);
    await expectNoViolations(page, "admin inbox");

    const recordingId = await uploadFixture(page, { title: "Accessible governed record" });
    await createAndAssignUsers(page, recordingId);
    await openAssignedDraft(page, reviewerUser);
    await expectNoViolations(page, "review draft");

    await firstTranscriptRow(page).getByRole("textbox", { name: /Transcript for segment 1, / }).fill("Accessible governed transcript.");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await page.getByRole("dialog", { name: "Submit for approval" }).getByRole("button", { name: "Submit for approval" }).last().click();

    await login(page, approverUser);
    await openAssignedCasefile(page);
    await expectNoViolations(page, "pending approval casefile");

    await page.getByRole("button", { name: "Approve and complete work" }).click();
    await page.getByRole("dialog", { name: "Approve and complete work" }).getByRole("button", { name: "Approve and complete work" }).last().click();
    await page.getByRole("button", { name: "Export approved transcript" }).click();
    await expectNoViolations(page, "approved export dialog");

    await login(page, adminUser);
    await page.goto("/administration?section=accounts");
    await expectNoViolations(page, "admin accounts");
    await page.goto("/administration?section=assignments");
    await expectNoViolations(page, "admin assignments");
    await page.goto("/administration?section=policy");
    await expectNoViolations(page, "admin policy");
  });

  test("supports keyboard focus restoration, 200 percent zoom, and reduced motion", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Accessible keyboard record" });
    await createAndAssignUsers(page, recordingId);
    await openAssignedDraft(page, reviewerUser);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.addStyleTag({ content: "html { zoom: 2; }" });
    await expect(page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).resolves.toBe(true);

    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await page.getByRole("button", { name: "Open governance" }).click();
    await expect(page.locator("#app-root")).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open governance" })).toBeFocused();

    await saveAndRecoverSession(page);
  });
});

async function saveAndRecoverSession(page: Parameters<typeof openCasefile>[0]) {
  await firstTranscriptRow(page).getByRole("textbox", { name: /Transcript for segment 1, / }).fill("Accessible session recovery text.");
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Save draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Session expired" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Email").fill("reviewer@example.com");
  await dialog.getByLabel("Password").fill("Superscriber!123");
  await dialog.getByRole("button", { name: "Recover session" }).click();
  await expect(dialog).toHaveCount(0);
}
