import { expect, test } from "@playwright/test";
import { hashSync } from "bcryptjs";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  login,
  queryRuntimeRows,
} from "./support/appliance";

/**
 * Password reset on the default appliance: the mail seam is unconfigured, so
 * self-service requests answer identically and send nothing, and recovery
 * runs operator-assisted through Administration > Accounts.
 */

const REVIEWER = {
  id: "e2e-reset-reviewer",
  email: "reset-reviewer@example.com",
  password: "Reviewer!pass123",
  newPassword: "Reviewer!newpass456",
};
const REVIEWER_HASH = hashSync(REVIEWER.password, 12);

const NO_MAIL_CONFIRMATION =
  "This instance does not send email. Your administrator can reset your password for you from Administration > Accounts.";
const GENERIC_FAILURE =
  "That reset link is no longer valid. Ask your administrator for a new one or request another reset.";

function seedReviewer() {
  execRuntimeSql(
    `INSERT INTO users (id, email, display_name, password_hash, role, is_active, auth_version, created_at, updated_at)
     VALUES (?, ?, 'Reset Reviewer', ?, 'reviewer', 1, 1, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
    [REVIEWER.id, REVIEWER.email, REVIEWER_HASH, new Date().toISOString(), new Date().toISOString()],
  );
}

function tokenRows(email: string) {
  return queryRuntimeRows(
    `SELECT t.id, t.used_at AS usedAt, t.invalidated_at AS invalidatedAt, t.invalidated_reason AS invalidatedReason
     FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?`,
    [email],
  ) as Array<{
    id: string;
    usedAt: string | null;
    invalidatedAt: string | null;
    invalidatedReason: string | null;
  }>;
}

async function issueHandoffReset(page: import("@playwright/test").Page) {
  await page.goto("/administration?section=accounts");
  const row = page.getByTestId(`account-facts-${REVIEWER.id}`).first();
  await row.getByRole("button", { name: "Reset password" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("Reviewer forgot their password at the front desk.");
  await dialog.getByRole("button", { name: "Issue reset" }).click();
  const reveal = dialog.getByLabel("Reset link");
  await expect(reveal).toBeVisible();
  return reveal.inputValue();
}

test.afterAll(() => {
  // Leave the shared appliance directory pristine for later spec files.
  const emails = ["reset-reviewer@example.com", "reset-bg-admin@example.com"];
  execRuntimeSql(
    `DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN (?, ?))`,
    emails,
  );
  execRuntimeSql(
    `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email IN (?, ?))`,
    emails,
  );
  execRuntimeSql(`DELETE FROM auth_control WHERE id = 1`, []);
  execRuntimeSql(
    `DELETE FROM audit_events WHERE actor_user_id IN (SELECT id FROM users WHERE email IN (?, ?))`,
    emails,
  );
  execRuntimeSql(`DELETE FROM users WHERE email IN (?, ?)`, emails);
});

test.describe.serial("password reset (mail unconfigured)", () => {
  test("self-service request answers identically for known and unknown emails", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    seedReviewer();

    for (const email of [REVIEWER.email, "ghost@example.com"]) {
      await page.goto("/reset-request");
      await page.getByLabel(/email/i).fill(email);
      await page.getByRole("button", { name: /reset password/i }).click();
      await expect(page.getByText(NO_MAIL_CONFIRMATION)).toBeVisible();
    }

    expect(tokenRows(REVIEWER.email)).toHaveLength(0);
  });

  test("operator-assisted handoff resets the password and revokes sessions", async ({
    page,
    browser,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    seedReviewer();

    // The reviewer holds a live session in a second context.
    const reviewerContext = await browser.newContext();
    const reviewerPage = await reviewerContext.newPage();
    await login(reviewerPage, {
      displayName: "Reset Reviewer",
      email: REVIEWER.email,
      password: REVIEWER.password,
      role: "reviewer",
    });
    await expect(reviewerPage.getByRole("navigation", { name: "Primary" })).toBeVisible();

    // Breadth fixture: the reviewer also holds Authentik- and break-glass-sourced rows.
    execRuntimeSql(
      `INSERT INTO auth_sessions (id, user_id, auth_source, auth_version, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ('e2e-reset-oidc-session', ?, 'authentik', 1, 'active', ?, ?, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
              ('e2e-reset-bg-session', ?, 'break_glass', 1, 'active', ?, ?, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      [REVIEWER.id, new Date().toISOString(), new Date().toISOString(), REVIEWER.id, new Date().toISOString(), new Date().toISOString()],
    );

    const resetUrl = await issueHandoffReset(page);

    // The reviewer's session is retired at issuance.
    await expect(async () => {
      const rows = queryRuntimeRows(
        `SELECT status, revoked_reason AS revokedReason FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ? AND s.status = 'revoked'`,
        [REVIEWER.email],
      ) as Array<{ status: string; revokedReason: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.filter((r) => r.revokedReason === "admin_password_reset")).toHaveLength(3);
    }).toPass({ timeout: 10_000 });

    // Complete the reset in a fresh context.
    const resetContext = await browser.newContext();
    const resetPage = await resetContext.newPage();
    await resetPage.goto(resetUrl);
    await resetPage.getByLabel(/^new password$/i).fill(REVIEWER.newPassword);
    await resetPage.getByLabel(/confirm new password/i).fill(REVIEWER.newPassword);
    await resetPage.getByRole("button", { name: /set new password/i }).click();
    await expect(resetPage.getByText("Your password has been reset.")).toBeVisible();

    // New password signs in through the real form; the old one is rejected.
    await reviewerContext.close();
    await resetContext.close();
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto("/");
    await freshPage.getByLabel(/^Email$/).fill(REVIEWER.email);
    await freshPage.getByLabel(/^Password$/).fill(REVIEWER.newPassword);
    await freshPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(freshPage.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 15_000,
    });
    await freshContext.close();

    const staleContext = await browser.newContext();
    const stalePage = await staleContext.newPage();
    await stalePage.goto("/");
    await stalePage.getByLabel(/^Email$/).fill(REVIEWER.email);
    await stalePage.getByLabel(/^Password$/).fill(REVIEWER.password);
    await stalePage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(stalePage.getByText(/Email or password was not accepted/)).toBeVisible();
    await staleContext.close();

    const tokens = tokenRows(REVIEWER.email);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.usedAt).not.toBeNull();
  });

  test("reused and expired links show one generic failure", async ({ page, browser }) => {
    await bootstrapAndLogin(page, adminUser);
    seedReviewer();

    // Reuse: complete once, then submit again on the same URL.
    const resetUrl = await issueHandoffReset(page);
    const firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    await firstPage.goto(resetUrl);
    await firstPage.getByLabel(/^new password$/i).fill(REVIEWER.newPassword);
    await firstPage.getByLabel(/confirm new password/i).fill(REVIEWER.newPassword);
    await firstPage.getByRole("button", { name: /set new password/i }).click();
    await expect(firstPage.getByText("Your password has been reset.")).toBeVisible();

    await firstPage.goto(resetUrl);
    await firstPage.getByLabel(/^new password$/i).fill("Another!pass9999");
    await firstPage.getByLabel(/confirm new password/i).fill("Another!pass9999");
    await firstPage.getByRole("button", { name: /set new password/i }).click();
    await expect(firstPage.getByText(GENERIC_FAILURE)).toBeVisible();
    await firstContext.close();

    // Expiry: backdate the token past its TTL.
    const secondUrl = await issueHandoffReset(page);
    execRuntimeSql(
      `UPDATE password_reset_tokens SET expires_at = ? WHERE used_at IS NULL AND invalidated_at IS NULL`,
      ["2000-01-01T00:00:00.000Z"],
    );
    const expiredContext = await browser.newContext();
    const expiredPage = await expiredContext.newPage();
    await expiredPage.goto(secondUrl);
    await expiredPage.getByLabel(/^new password$/i).fill("Whatever!pass123");
    await expiredPage.getByLabel(/confirm new password/i).fill("Whatever!pass123");
    await expiredPage.getByRole("button", { name: /set new password/i }).click();
    await expect(expiredPage.getByText(GENERIC_FAILURE)).toBeVisible();
    await expiredContext.close();
  });

  test("admin policies deny inactive and break-glass designee targets", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    seedReviewer();
    execRuntimeSql(`UPDATE users SET is_active = 0 WHERE id = ?`, [REVIEWER.id]);
    // Denied attempts must create no new token rows. Existing rows from earlier
    // serial tests accumulate, so compare counts.
    const reviewerTokenCountBefore = tokenRows(REVIEWER.email).length;

    // Inactive target.
    const inactiveUrl = await page.goto("/administration?section=accounts");
    expect(inactiveUrl?.ok()).toBe(true);
    const row = page.getByTestId(`account-facts-${REVIEWER.id}`).first();
    await row.getByRole("button", { name: "Reset password" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Reason/).fill("Checking the inactive-account denial path.");
    await dialog.getByRole("button", { name: "Issue reset" }).click();
    await expect(dialog.getByText("Inactive accounts cannot be reset.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Break-glass designee: a dedicated seeded admin holds the designation.
    execRuntimeSql(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, auth_version, created_at, updated_at)
       VALUES ('e2e-reset-bg-admin', 'reset-bg-admin@example.com', 'Reset BG Admin', 'hash', 'admin', 1, 1, ?, ?)
       ON CONFLICT (email) DO NOTHING`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    execRuntimeSql(`DELETE FROM auth_control WHERE id = 1`, []);
    execRuntimeSql(
      `INSERT INTO auth_control (id, break_glass_user_id, updated_at, updated_by_user_id, change_reason)
       VALUES (1, 'e2e-reset-bg-admin', ?, NULL, 'e2e designation')`,
      [new Date().toISOString()],
    );
    await page.goto("/administration?section=accounts");
    const designeeRow = page.getByTestId("account-facts-e2e-reset-bg-admin").first();
    await designeeRow.getByRole("button", { name: "Reset password" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Reason/).fill("Checking the break-glass denial path.");
    await dialog.getByRole("button", { name: "Issue reset" }).click();
    await expect(
      dialog.getByText(/rotates only through the emergency ceremony/),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    expect(tokenRows(REVIEWER.email)).toHaveLength(reviewerTokenCountBefore);
    expect(tokenRows("reset-bg-admin@example.com")).toHaveLength(0);
  });

  test("phone viewport hides admin reset controls; recovery pages stay usable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrapAndLogin(page, adminUser);
    seedReviewer();

    await page.goto("/administration?section=accounts");
    await expect(page.getByRole("heading", { name: "Institutional accounts" })).toBeVisible();
    expect(await page.getByRole("button", { name: "Reset password" }).count()).toBe(0);

    await page.goto("/reset-request");
    await page.getByLabel(/email/i).fill(REVIEWER.email);
    await page.getByRole("button", { name: /reset password/i }).click();
    await expect(page.getByText(NO_MAIL_CONFIRMATION)).toBeVisible();
  });
});
