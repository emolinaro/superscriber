import { expect, test } from "@playwright/test";
import {
  adminUser,
  authSessionRowsForEmail,
  bootstrapAndLogin,
  revokeAuthSessionsForEmail,
} from "./support/appliance";

test.describe.serial("session registry revocation", () => {
  test("sign-in mints a durable registry session row", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    const rows = authSessionRowsForEmail(adminUser.email);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)).toMatchObject({ status: "active", authSource: "local" });
  });

  test("an open UI converges to session-expired within seconds after revocation", async ({
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    revokeAuthSessionsForEmail(adminUser.email);

    await expect(page).toHaveURL(/reason=session-expired/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /First-run setup|Sign in/ })).toBeVisible();
  });

  test("a revoked session cannot reach protected routes on the next request", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    revokeAuthSessionsForEmail(adminUser.email);

    await page.goto("/workspace");
    await expect(page).toHaveURL(/reason=session-expired/);
  });
});
