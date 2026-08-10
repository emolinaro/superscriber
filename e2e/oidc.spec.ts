import { expect, test } from "@playwright/test";
import {
  accountRoleAuditRows,
  accountRoleFactsForEmail,
  adminUser,
  bootstrapAndLogin,
  login,
  queryRuntimeRows,
} from "./support/appliance";
import {
  E2E_OIDC_GROUPS,
  E2E_OIDC_ISSUER,
  type OidcControl,
} from "./support/fake-oidc";
import {
  authSessionOidcdRows,
  oidcSignIn,
  seedOidcLinkedUser,
  startOidcControl,
} from "./support/oidc";

const reviewer = {
  email: "oidc-reviewer@example.com",
  displayName: "OIDC Reviewer",
  role: "reviewer" as const,
  subject: "e2e-oidc-sub-1",
  password: "Superscriber!123",
};

const linkedRoleUser = {
  email: "oidc-role-change@example.com",
  displayName: "OIDC Role Reviewer",
  role: "reviewer" as const,
  subject: "e2e-oidc-role-change-sub",
  password: "Superscriber!123",
};

function appUrlWithErrorPattern() {
  const port = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3105").port || "3105";
  return new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\/\\?.*error=`);
}

test.describe.serial("authentik oidc dual login", () => {
  // In container mode the suite's sidecar serves the same issuer; locally an
  // in-process fake is started on the same port. Behavior is identical.
  let control: OidcControl;
  let closeControl: () => Promise<void>;

  test.beforeAll(async () => {
    const started = await startOidcControl();
    control = started.control;
    closeControl = started.close;
  });
  test.afterAll(async () => {
    await closeControl?.();
  });

  test("a linked identity follows the governed local role after an administrator change", async ({
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const { userId } = seedOidcLinkedUser(linkedRoleUser);
    const identityBefore = queryRuntimeRows<{
      id: string;
      userId: string;
      issuer: string;
      subject: string;
    }>(
      `select id, user_id as userId, issuer, subject from external_identities
       where user_id = ? and status = 'active'`,
      [userId],
    )[0]!;

    await control.setUser({
      sub: linkedRoleUser.subject,
      name: linkedRoleUser.displayName,
      groups: [E2E_OIDC_GROUPS.reviewer],
    });
    await oidcSignIn(page);
    await expect(page).toHaveURL(/\/workspace$/);

    await login(page, adminUser);
    await page.goto("/administration?section=accounts");
    await page.getByRole("searchbox", { name: "Search accounts" }).fill(linkedRoleUser.email);
    await page.getByRole("button", { name: "Search" }).click();
    const role = page.getByRole("combobox", {
      name: `Role for ${linkedRoleUser.displayName}`,
    });
    await expect(role).toHaveValue("reviewer");
    await role.selectOption("approver");
    await page
      .getByRole("textbox", { name: `Change reason for ${linkedRoleUser.displayName}` })
      .fill("OIDC approver duties changed safely.");
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByRole("status")).toContainText("changed from Reviewer to Approver");

    expect(accountRoleFactsForEmail(linkedRoleUser.email)).toMatchObject({
      id: userId,
      role: "approver",
    });
    const identityAfter = queryRuntimeRows<{
      id: string;
      userId: string;
      issuer: string;
      subject: string;
    }>(
      `select id, user_id as userId, issuer, subject from external_identities
       where user_id = ? and status = 'active'`,
      [userId],
    )[0]!;
    expect(identityAfter).toEqual(identityBefore);

    await control.setUser({
      sub: linkedRoleUser.subject,
      name: linkedRoleUser.displayName,
      groups: [E2E_OIDC_GROUPS.reviewer],
    });
    await oidcSignIn(page);
    await expect(page.locator("p.banner")).toContainText("Access is not provisioned");
    const denial = queryRuntimeRows<{ metadata: string }>(
      `select metadata from security_events
       where type = 'oidc.admission.denied' and user_id = ?
       order by created_at desc, id desc limit 1`,
      [userId],
    )[0]!;
    expect(JSON.parse(denial.metadata)).toMatchObject({
      data: { reason: "role_mismatch" },
    });
    expect(denial.metadata).not.toContain(linkedRoleUser.subject);
    expect(denial.metadata).not.toContain(E2E_OIDC_GROUPS.reviewer);

    await control.setUser({
      sub: linkedRoleUser.subject,
      name: linkedRoleUser.displayName,
      groups: [E2E_OIDC_GROUPS.approver],
    });
    await oidcSignIn(page);
    await expect(page).toHaveURL(/\/workspace$/);
    const oidcSession = (await (await page.request.get("/api/auth/session")).json()) as {
      user: { id: string; role?: string };
    };
    expect(oidcSession.user.id).toBe(userId);
    expect(JSON.stringify(oidcSession)).not.toContain(linkedRoleUser.subject);
    expect(JSON.stringify(oidcSession)).not.toContain(E2E_OIDC_GROUPS.approver);

    const roleAudit = accountRoleAuditRows(userId).at(-1)!;
    expect(roleAudit.metadata).toContain('"newRole":"approver"');
    expect(roleAudit.metadata).not.toContain(linkedRoleUser.subject);
    expect(roleAudit.metadata).not.toContain(E2E_OIDC_GROUPS.approver);

    await login(page, { ...linkedRoleUser, role: "approver" });
    const localSession = (await (await page.request.get("/api/auth/session")).json()) as {
      user: { id: string; role?: string };
    };
    expect(localSession.user.id).toBe(userId);
    expect(localSession.user.role).toBe("approver");
  });

  test("a linked user signs in through the provider and lands in the workspace", async ({
    page,
  }) => {
    const { userId } = seedOidcLinkedUser(reviewer);
    await control.setUser({
      sub: reviewer.subject,
      name: reviewer.displayName,
      sid: "e2e-sid-1",
      groups: [E2E_OIDC_GROUPS.reviewer],
    });

    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Sign in with institutional account" }),
    ).toBeVisible();
    const brand = page.locator(".auth-surface__primary .superscriber-logo");
    await expect(brand).toBeVisible();
    await expect(brand.locator(".superscriber-logo-name")).toHaveAttribute(
      "aria-label",
      "Superscriber",
    );

    await oidcSignIn(page);
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    // Session exposes the local identity and auth source, never provider data.
    const session = (await (await page.request.get("/api/auth/session")).json()) as {
      user: { id: string; name?: string | null; email?: string | null };
      authSource?: string;
    };
    expect(session.user.id).toBe(userId);
    expect(session.user.name).toBe(reviewer.displayName);
    expect(session.user.email).toBe(reviewer.email);
    expect(session.authSource).toBe("authentik");
    expect(JSON.stringify(session)).not.toContain(reviewer.subject);
    expect(JSON.stringify(session)).not.toContain(E2E_OIDC_GROUPS.reviewer);

    const rows = authSessionOidcdRows(userId);
    expect(rows[0]).toMatchObject({ authSource: "authentik", providerSid: "e2e-sid-1" });
    expect(rows[0]?.identityId).toBeTruthy();
  });

  test("an authenticated but unlinked provider user gets one generic denial", async ({ page }) => {
    await control.setUser({ sub: "e2e-stranger", groups: [E2E_OIDC_GROUPS.reviewer] });

    await oidcSignIn(page);

    await expect(page).toHaveURL(appUrlWithErrorPattern());
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(
      page.locator("p.banner").getByText("Access is not provisioned for this account"),
    ).toBeVisible();

    // Generic denial: no existence signal about subject, user, or group.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("e2e-stranger");
    expect(bodyText).not.toContain(E2E_OIDC_GROUPS.reviewer);

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name.includes("session-token"))).toBe(false);
  });

  test("a provider-side cancel surfaces the same generic denial", async ({ page }) => {
    await control.setUser({ sub: "e2e-cancel", groups: [E2E_OIDC_GROUPS.reviewer] });
    await control.failAuthorizeOnce("access_denied");

    await oidcSignIn(page);

    await expect(page).toHaveURL(appUrlWithErrorPattern());
    await expect(
      page.locator("p.banner").getByText("Access is not provisioned for this account"),
    ).toBeVisible();
  });

  test("a linked user whose role claim maps to zero groups is denied generically", async ({
    page,
  }) => {
    seedOidcLinkedUser({ ...reviewer, email: "oidc-zero@example.com", subject: "e2e-oidc-sub-2" });
    await control.setUser({ sub: "e2e-oidc-sub-2", groups: [] });

    await oidcSignIn(page);

    await expect(page).toHaveURL(appUrlWithErrorPattern());
    await expect(
      page.locator("p.banner").getByText("Access is not provisioned for this account"),
    ).toBeVisible();
  });

  test("back-channel logout revokes the provider session and the open UI converges", async ({
    page,
  }) => {
    seedOidcLinkedUser({
      ...reviewer,
      email: "oidc-bclogout@example.com",
      subject: "e2e-oidc-sub-4",
    });
    await control.setUser({
      sub: "e2e-oidc-sub-4",
      name: reviewer.displayName,
      sid: "e2e-sid-backchannel",
      groups: [E2E_OIDC_GROUPS.reviewer],
    });

    await oidcSignIn(page);
    await expect(page).toHaveURL(/\/workspace$/);

    const logoutToken = await control.signLogoutToken({
      iss: E2E_OIDC_ISSUER,
      aud: "superscriber",
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      sid: "e2e-sid-backchannel",
    });

    const response = await page.request.post("/api/auth/backchannel-logout/authentik", {
      form: { logout_token: logoutToken },
    });
    expect(response.status()).toBe(200);

    // The open page converges to session-expired within one poll cycle.
    await expect(page).toHaveURL(/reason=session-expired/, { timeout: 15_000 });

    // Retried delivery of the same (issuer, jti) is an idempotent success.
    const replay = await page.request.post("/api/auth/backchannel-logout/authentik", {
      form: { logout_token: logoutToken },
    });
    expect(replay.status()).toBe(200);
  });

  test("the same local principal results from OIDC and credentials in dual mode", async ({
    page,
  }) => {
    const { userId } = seedOidcLinkedUser({
      ...reviewer,
      email: "oidc-both@example.com",
      subject: "e2e-oidc-sub-3",
    });

    await control.setUser({
      sub: "e2e-oidc-sub-3",
      name: reviewer.displayName,
      groups: [E2E_OIDC_GROUPS.reviewer],
    });
    await oidcSignIn(page);
    await expect(page).toHaveURL(/\/workspace$/);
    const oidcSession = (await (await page.request.get("/api/auth/session")).json()) as {
      user: { id: string };
    };

    await login(page, {
      displayName: reviewer.displayName,
      email: "oidc-both@example.com",
      password: reviewer.password,
      role: "reviewer",
    });
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const localSession = (await (await page.request.get("/api/auth/session")).json()) as {
      user: { id: string };
    };

    expect(localSession.user.id).toBe(oidcSession.user.id);
    expect(localSession.user.id).toBe(userId);
  });
});
