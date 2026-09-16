import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  login,
  queryRuntimeRows,
  type LocalUser,
} from "./support/appliance";

async function createGeneratedAccount(page: Page): Promise<LocalUser> {
  const account: LocalUser = {
    displayName: "Lifecycle Reviewer",
    email: `lifecycle-${Date.now()}@example.com`,
    password: "",
    role: "reviewer",
  };
  await page.goto("/administration?section=accounts");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use a generated temporary password" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create account with temporary password",
  });
  await dialog.getByLabel("Name", { exact: true }).fill(account.displayName);
  await dialog.getByLabel("Email", { exact: true }).fill(account.email);
  await dialog
    .getByLabel("Reason (required)")
    .fill("Account lifecycle browser test");
  await expect(
    new AxeBuilder({ page })
      .include('[role="dialog"]')
      .analyze()
      .then((result) => result.violations),
  ).resolves.toEqual([]);
  await dialog
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  const password = dialog.getByLabel("Temporary password");
  await expect(password).toBeVisible();
  account.password = await password.inputValue();
  await expect(dialog.getByText(/does not expire automatically/)).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(password).toHaveCount(0);
  return account;
}

async function lifecycle(page: Page, email: string, label: string) {
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: email, exact: true }) });
  await row.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`^${label}:`) });
  await dialog
    .getByLabel("Reason (required)")
    .fill("Account lifecycle browser test");
  await expect(
    new AxeBuilder({ page })
      .include('[role="dialog"]')
      .analyze()
      .then((result) => result.violations),
  ).resolves.toEqual([]);
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return row;
}

test("generated account handoff, durable deactivation, explicit reactivation, and governed removal", async ({
  page,
  browser,
}) => {
  await bootstrapAndLogin(page, adminUser);
  const account = await createGeneratedAccount(page);
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  try {
    await login(userPage, account);
    await userPage.getByRole("button", { name: "Open account menu" }).click();
    await userPage
      .getByRole("link", { name: "Your account", exact: true })
      .click();
    await expect(
      userPage.getByRole("heading", { name: "Your account" }),
    ).toBeVisible();
    await expect(
      userPage.getByText(account.email, { exact: true }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page: userPage }).analyze()).violations,
    ).toEqual([]);

    await userPage
      .getByRole("button", { name: "Deactivate my account" })
      .click();
    const selfDialog = userPage.getByRole("dialog", {
      name: "Deactivate your account",
    });
    await selfDialog.getByLabel("Reason (required)").fill("Taking a break");
    expect(
      (
        await new AxeBuilder({ page: userPage })
          .include('[role="dialog"]')
          .analyze()
      ).violations,
    ).toEqual([]);
    await selfDialog
      .getByRole("button", { name: "Deactivate and sign out" })
      .click();
    await expect(userPage).toHaveURL(/reason=account-deactivated/);
    const inactive = queryRuntimeRows<{ is_active: number; self: number }>(
      "SELECT is_active, deactivated_by_user_id = id AS self FROM users WHERE email = ?",
      [account.email],
    );
    expect(inactive).toEqual([{ is_active: 0, self: 1 }]);
    await login(userPage, account);
    await page.reload();
    await lifecycle(page, account.email, "Deactivate account");
    await userPage.reload();
    await expect(
      userPage.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    await userPage.getByLabel("Email", { exact: true }).fill(account.email);
    await userPage
      .getByLabel("Password", { exact: true })
      .fill(account.password);
    await userPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(
      userPage.getByRole("alert", { name: "There is a problem" }),
    ).toContainText("Email or password was not accepted.");
    await userPage.goto("/account");
    await expect(
      userPage.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: account.email }),
    ).toContainText("Deactivated");

    await lifecycle(page, account.email, "Reactivate account");
    await login(userPage, account);
    await lifecycle(page, account.email, "Remove account");
    await userPage.goto("/account");
    await expect(
      userPage.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    const facts = queryRuntimeRows<{
      is_active: number;
      password_hash: string | null;
    }>("SELECT is_active, password_hash FROM users WHERE email = ?", [
      account.email,
    ]);
    expect(facts).toEqual([{ is_active: 0, password_hash: null }]);
    const events = queryRuntimeRows<{
      type: string;
      actor_user_id: string;
      metadata: string;
    }>(
      "SELECT a.type, a.actor_user_id, a.metadata FROM audit_events a WHERE json_extract(a.metadata, '$.data.targetUserId') = (SELECT id FROM users WHERE email = ?) ORDER BY a.created_at",
      [account.email],
    );
    expect(events.map((event) => event.type)).toEqual([
      "account.created",
      "account.self_deactivated",
      "account.self_reactivated",
      "account.deactivated",
      "account.reactivated",
      "account.removed",
    ]);
    expect(events.every((event) => Boolean(event.actor_user_id))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(account.password);
  } finally {
    await userContext.close();
  }
});

test("phone surfaces are read-only and account administration protects self-actions", async ({
  page,
}) => {
  await bootstrapAndLogin(page, adminUser);
  await page.goto("/administration?section=accounts");
  const ownRow = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: adminUser.email, exact: true }),
  });
  await expect(
    ownRow.getByRole("button", { name: "Deactivate account", exact: true }),
  ).toBeDisabled();
  await expect(
    ownRow.getByRole("button", { name: "Remove account", exact: true }),
  ).toBeDisabled();
  const emailCell = ownRow.getByRole("cell", {
    name: adminUser.email,
    exact: true,
  });
  expect(
    await emailCell.evaluate((cell) => cell.scrollWidth <= cell.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", {
      name: /Create account|Deactivate account|Reactivate account|Remove account/,
    }),
  ).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.goto("/account");
  await expect(
    page.getByText("Phone safety mode: account information is read-only."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open account administration" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Deactivate my account" }),
  ).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
