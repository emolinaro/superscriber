import { expect, test, type Page } from "@playwright/test";
import {
  accountRoleAuditRows,
  accountRoleFactsForEmail,
  adminUser,
  authSessionRowsForEmail,
  bootstrapAndLogin,
  ensureLocalAccount,
  login,
  type LocalUser,
} from "./support/appliance";

const keyboardUser: LocalUser = {
  displayName: "Role Keyboard Reviewer",
  email: "role-keyboard@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const pendingUser: LocalUser = {
  displayName: "Role Pending Reviewer",
  email: "role-pending@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const sessionUser: LocalUser = {
  displayName: "Role Session Reviewer",
  email: "role-session@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const selfAdmin: LocalUser = {
  displayName: "Role Self Admin",
  email: "role-self-admin@example.com",
  password: "Superscriber!123",
  role: "admin",
};

function accountRow(page: Page, account: LocalUser) {
  return page.getByRole("row").filter({
    has: page.getByRole("cell", { name: account.email }),
  });
}

function roleSelect(page: Page, account: LocalUser) {
  return page.getByRole("combobox", { name: `Role for ${account.displayName}` });
}

async function openAccount(page: Page, account: LocalUser) {
  await page.goto("/administration?section=accounts");
  const search = page.getByRole("searchbox", { name: "Search accounts" });
  await search.fill(account.email);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(roleSelect(page, account)).toBeVisible();
}

async function saveRole(
  page: Page,
  account: LocalUser,
  newRole: LocalUser["role"],
  reason: string,
) {
  const row = accountRow(page, account);
  await row.getByRole("combobox", { name: `Role for ${account.displayName}` }).selectOption(newRole);
  await row
    .getByRole("textbox", { name: `Change reason for ${account.displayName}` })
    .fill(reason);
  await row.getByRole("button", { name: "Save role" }).click();
}

test.describe.serial("governed account role management", () => {
  test("discovers and completes the inline flow on desktop and tablet with keyboard focus", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, keyboardUser);
    await openAccount(page, keyboardUser);

    const desktopSelect = roleSelect(page, keyboardUser);
    await expect(desktopSelect).toHaveValue("reviewer");

    const storageState = await page.context().storageState();
    const tabletContext = await browser.newContext({
      storageState,
      viewport: { width: 768, height: 1024 },
    });
    try {
      const tablet = await tabletContext.newPage();
      await openAccount(tablet, keyboardUser);
      await expect(roleSelect(tablet, keyboardUser)).toHaveValue("reviewer");
    } finally {
      await tabletContext.close();
    }

    await desktopSelect.focus();
    await page.keyboard.press("a");
    await expect(desktopSelect).toHaveValue("approver");
    await expect(desktopSelect).toBeFocused();

    await page.keyboard.press("Tab");
    const reason = page.getByRole("textbox", {
      name: `Change reason for ${keyboardUser.displayName}`,
    });
    await expect(reason).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Save role" })).toBeFocused();
    await page.keyboard.press("Tab");
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(desktopSelect).toHaveValue("reviewer");
    await expect(desktopSelect).toBeFocused();

    await page.keyboard.press("a");
    await page.keyboard.press("Tab");
    await reason.fill("Keyboard duties changed safely.");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("status")).toContainText(
      "Role Keyboard Reviewer's role changed from Reviewer to Approver",
    );
    await expect(desktopSelect).toHaveValue("approver");
    await expect(desktopSelect).toBeFocused();
    expect(accountRoleFactsForEmail(keyboardUser.email)?.role).toBe("approver");
  });

  test("shows one pending request and prevents duplicate role submissions", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, pendingUser);
    await openAccount(page, pendingUser);

    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let rolePostCount = 0;
    await page.route("**/administration**", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      rolePostCount += 1;
      await requestGate;
      await route.continue();
    });

    await saveRole(page, pendingUser, "approver", "Pending duties changed safely.");
    const saving = page.getByRole("button", { name: "Saving role..." });
    await expect(saving).toBeVisible();
    await expect(saving).toBeDisabled();
    await expect(roleSelect(page, pendingUser)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    expect(rolePostCount).toBe(1);

    releaseRequest?.();
    await expect(page.getByRole("status")).toContainText(
      "Role Pending Reviewer's role changed from Reviewer to Approver",
    );
    const target = accountRoleFactsForEmail(pendingUser.email);
    expect(accountRoleAuditRows(target!.id)).toHaveLength(1);
    expect(rolePostCount).toBe(1);
  });

  test("revokes every target context and requires re-login with the new role", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, sessionUser);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const firstTarget = await firstContext.newPage();
    const secondTarget = await secondContext.newPage();
    try {
      await login(firstTarget, sessionUser);
      await login(secondTarget, sessionUser);
      const before = accountRoleFactsForEmail(sessionUser.email)!;
      expect(authSessionRowsForEmail(sessionUser.email).filter((row) => row.status === "active")).toHaveLength(2);

      await openAccount(page, sessionUser);
      await saveRole(page, sessionUser, "uploader", "Session duties changed safely.");
      await expect(page.getByRole("status")).toContainText(
        "Active sessions were revoked; they must sign in again",
      );

      const after = accountRoleFactsForEmail(sessionUser.email)!;
      expect(after.role).toBe("uploader");
      expect(after.authVersion).toBe(before.authVersion + 1);
      expect(
        authSessionRowsForEmail(sessionUser.email)
          .filter((row) => row.status === "revoked")
          .every((row) => row.revokedReason === "account_role_changed"),
      ).toBe(true);

      await firstTarget.goto("/workspace");
      await expect(firstTarget).toHaveURL(/reason=session-expired/);
      await expect(secondTarget).toHaveURL(/reason=session-expired/, {
        timeout: 15_000,
      });

      await login(firstTarget, { ...sessionUser, role: "uploader" });
      await expect(firstTarget.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await expect(
        firstTarget.getByRole("link", { name: "Administration" }),
      ).not.toBeVisible();
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  });

  test("allows safe self-demotion and focuses the forced sign-in surface", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, selfAdmin);
    await login(page, selfAdmin);
    await openAccount(page, selfAdmin);

    await saveRole(page, selfAdmin, "reviewer", "Self duties changed safely.");

    await expect(page).toHaveURL(/reason=role-changed/);
    await expect(page.getByText("Your account role changed. Sign in again to continue.")).toBeVisible();
    const heading = page.getByRole("heading", { name: "Sign in" });
    await expect(heading).toBeFocused();

    const target = accountRoleFactsForEmail(selfAdmin.email)!;
    expect(target.role).toBe("reviewer");
    expect(accountRoleAuditRows(target.id).at(-1)).toMatchObject({
      actorUserId: target.id,
      actorRole: "admin",
    });
    expect(authSessionRowsForEmail(selfAdmin.email).at(-1)).toMatchObject({
      status: "revoked",
      revokedReason: "account_role_changed",
    });

    await login(page, { ...selfAdmin, role: "reviewer" });
    await expect(page.getByRole("link", { name: "Administration" })).not.toBeVisible();
  });
});
