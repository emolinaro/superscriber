import { expect, test } from "@playwright/test";
import { login, withRuntimeDb } from "./support/appliance";
import {
  E2E_OIDC_GROUPS,
  startFakeOidcServer,
  type FakeOidcServer,
} from "./support/fake-oidc";
import { oidcSignIn, RUNNING_IN_CONTAINER, seedOidcLinkedUser } from "./support/oidc";

const reviewer = {
  email: "oidc-reviewer@example.com",
  displayName: "OIDC Reviewer",
  role: "reviewer" as const,
  subject: "e2e-oidc-sub-1",
  password: "Superscriber!123",
};

test.describe.serial("authentik oidc dual login", () => {
  // The fake provider binds 127.0.0.1 on the Playwright host; the container
  // harness reaches it only from slice 8 onwards.
  test.skip(RUNNING_IN_CONTAINER, "slice 8 adds the container-hosted OIDC fake");

  let fake: FakeOidcServer;
  test.beforeAll(async () => {
    fake = await startFakeOidcServer();
  });
  test.afterAll(async () => {
    await fake?.close();
  });

  test("a linked user signs in through the provider and lands in the workspace", async ({
    page,
  }) => {
    const { userId } = seedOidcLinkedUser(reviewer);
    fake.setUser({
      sub: reviewer.subject,
      name: reviewer.displayName,
      sid: "e2e-sid-1",
      groups: [E2E_OIDC_GROUPS.reviewer],
    });

    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Sign in with institutional account" }),
    ).toBeVisible();

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

    const rows = withRuntimeDb(
      (db) =>
        db
          .prepare(
            `select auth_sessions.auth_source as authSource, auth_sessions.provider_sid as providerSid, external_identities.id as identityId
             from auth_sessions
             join external_identities on external_identities.id = auth_sessions.external_identity_id
             where auth_sessions.user_id = ? order by auth_sessions.created_at desc`,
          )
          .all(userId) as Array<{ authSource: string; providerSid: string | null; identityId: string }>,
    );
    expect(rows[0]).toMatchObject({ authSource: "authentik", providerSid: "e2e-sid-1" });
    expect(rows[0]?.identityId).toBeTruthy();
  });

  test("an authenticated but unlinked provider user gets one generic denial", async ({ page }) => {
    fake.setUser({ sub: "e2e-stranger", groups: [E2E_OIDC_GROUPS.reviewer] });

    await oidcSignIn(page);

    await expect(page).toHaveURL(/127\.0\.0\.1:3105\/\?error=/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(
      page.locator("p.banner").getByText("Access is not provisioned for this account"),
    ).toBeVisible();

    // Generic denial: no existence signal about subject, user, or group.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("e2e-stranger");
    expect(bodyText).not.toContain(E2E_OIDC_GROUPS.reviewer);
    expect(bodyText.toLowerCase()).not.toContain("provisioned for e2e-stranger");

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name.includes("session-token"))).toBe(false);
  });

  test("a linked user whose role claim maps to zero groups is denied generically", async ({
    page,
  }) => {
    seedOidcLinkedUser({ ...reviewer, email: "oidc-zero@example.com", subject: "e2e-oidc-sub-2" });
    fake.setUser({ sub: "e2e-oidc-sub-2", groups: [] });

    await oidcSignIn(page);

    await expect(page).toHaveURL(/127\.0\.0\.1:3105\/\?error=/);
    await expect(
      page.locator("p.banner").getByText("Access is not provisioned for this account"),
    ).toBeVisible();
  });

  test("the same local principal results from OIDC and credentials in dual mode", async ({
    page,
  }) => {
    const { userId } = seedOidcLinkedUser({
      ...reviewer,
      email: "oidc-both@example.com",
      subject: "e2e-oidc-sub-3",
    });

    fake.setUser({
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
