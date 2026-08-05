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

  test("sign out revokes the durable session row before clearing the cookie", async ({
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/reason=logged-out/);
    const rows = authSessionRowsForEmail(adminUser.email);
    expect(rows.at(-1)).toMatchObject({ status: "revoked", revokedReason: "logout" });
  });

  test("a revoked session cannot reach protected routes on the next request", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    revokeAuthSessionsForEmail(adminUser.email);

    await page.goto("/workspace");
    await expect(page).toHaveURL(/reason=session-expired/);
  });
});
