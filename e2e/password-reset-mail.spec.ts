import { expect, test } from "@playwright/test";
import { hashSync } from "bcryptjs";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  login,
} from "./support/appliance";
import { e2eSmtpControl } from "./support/fake-smtp";

/**
 * Password reset with the seam configured: runs only when the appliance was
 * started with SUPERSCRIBER_E2E_RESET_MAIL=smtp (fake SMTP sidecar).
 */

const MAIL_ON = process.env.SUPERSCRIBER_E2E_RESET_MAIL === "smtp";
test.skip(!MAIL_ON, "requires SUPERSCRIBER_E2E_RESET_MAIL=smtp appliance");

const MAIL_USER = {
  id: "e2e-mail-reviewer",
  email: "mail-reviewer@example.com",
  password: "MailReviewer!123",
  newPassword: "MailReviewer!456",
};
const MAIL_HASH = hashSync(MAIL_USER.password, 12);

function seedMailUser() {
  execRuntimeSql(
    `INSERT INTO users (id, email, display_name, password_hash, role, is_active, auth_version, created_at, updated_at)
     VALUES (?, ?, 'Mail Reviewer', ?, 'reviewer', 1, 1, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
    [MAIL_USER.id, MAIL_USER.email, MAIL_HASH, new Date().toISOString(), new Date().toISOString()],
  );
}

async function requestReset(page: import("@playwright/test").Page) {
  await page.goto("/reset-request");
  await page.getByLabel(/email/i).fill(MAIL_USER.email);
  await page.getByRole("button", { name: /reset password/i }).click();
  await expect(page.getByText(/If an account matches that email/)).toBeVisible();
}

/** nodemailer quoted-printable soft-wraps long lines; undo soft breaks first. */
function unwrap(text: string) {
  return text.replace(/=\r?\n/g, "");
}

function extractResetUrl(text: string) {
  const match = unwrap(text).match(/https?:\/\/\S+\/reset\/\S+/);
  expect(match, "reset URL present in the mail body").toBeTruthy();
  return match![0]!;
}

test.afterAll(() => {
  if (!MAIL_ON) {
    return;
  }
  const emails = ["mail-reviewer@example.com"];
  execRuntimeSql(
    `DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN (?))`,
    emails,
  );
  execRuntimeSql(
    `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email IN (?))`,
    emails,
  );
  execRuntimeSql(`DELETE FROM users WHERE email IN (?)`, emails);
});

test.describe.serial("password reset (mail configured)", () => {
  test("the reset link is emailed once and rotates the credential", async ({
    page,
    browser,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    seedMailUser();
    const control = e2eSmtpControl();
    await control.reset();

    await requestReset(page);

    await expect(async () => {
      const messages = await control.messages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.to).toEqual([MAIL_USER.email]);
      expect(messages[0]!.subject).toBe("Superscriber password reset");
      const body = unwrap(messages[0]!.text);
      expect(body).toContain("/reset/");
      expect(body).toContain("contact your administrator");
      expect(body).not.toContain("transcript");
    }).toPass({ timeout: 15_000 });

    const [message] = await control.messages();
    const resetUrl = extractResetUrl(message!.text);

    const resetContext = await browser.newContext();
    const resetPage = await resetContext.newPage();
    await resetPage.goto(resetUrl);
    await resetPage.getByLabel(/^new password$/i).fill(MAIL_USER.newPassword);
    await resetPage.getByLabel(/confirm new password/i).fill(MAIL_USER.newPassword);
    await resetPage.getByRole("button", { name: /set new password/i }).click();
    await expect(resetPage.getByText("Your password has been reset.")).toBeVisible();
    await resetContext.close();

    const signInContext = await browser.newContext();
    const signInPage = await signInContext.newPage();
    await login(signInPage, {
      displayName: "Mail Reviewer",
      email: MAIL_USER.email,
      password: MAIL_USER.newPassword,
      role: "reviewer",
    });
    await expect(signInPage.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await signInContext.close();

    // The link is single-use.
    const reuseContext = await browser.newContext();
    const reusePage = await reuseContext.newPage();
    await reusePage.goto(resetUrl);
    await reusePage.getByLabel(/^new password$/i).fill("Whatever!pass123");
    await reusePage.getByLabel(/confirm new password/i).fill("Whatever!pass123");
    await reusePage.getByRole("button", { name: /set new password/i }).click();
    await expect(reusePage.getByText(/no longer valid/)).toBeVisible();
    await reuseContext.close();
  });

  test("a newer request supersedes the earlier mailed link", async ({ page, browser }) => {
    await bootstrapAndLogin(page, adminUser);
    seedMailUser();
    const control = e2eSmtpControl();
    await control.reset();

    await requestReset(page);
    await expect(async () => {
      expect(await control.messages()).toHaveLength(1);
    }).toPass({ timeout: 15_000 });

    await requestReset(page);
    await expect(async () => {
      expect(await control.messages()).toHaveLength(2);
    }).toPass({ timeout: 15_000 });

    const [first, second] = await control.messages();
    expect(first!.text).not.toBe(second!.text);

    const staleContext = await browser.newContext();
    const stalePage = await staleContext.newPage();
    await stalePage.goto(extractResetUrl(first!.text));
    await stalePage.getByLabel(/^new password$/i).fill("Whatever!pass123");
    await stalePage.getByLabel(/confirm new password/i).fill("Whatever!pass123");
    await stalePage.getByRole("button", { name: /set new password/i }).click();
    await expect(stalePage.getByText(/no longer valid/)).toBeVisible();
    await staleContext.close();

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(extractResetUrl(second!.text));
    await freshPage.getByLabel(/^new password$/i).fill(MAIL_USER.newPassword);
    await freshPage.getByLabel(/confirm new password/i).fill(MAIL_USER.newPassword);
    await freshPage.getByRole("button", { name: /set new password/i }).click();
    await expect(freshPage.getByText("Your password has been reset.")).toBeVisible();
    await freshContext.close();
  });
});
