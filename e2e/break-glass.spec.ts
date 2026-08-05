import { expect, test, type Page } from "@playwright/test";
import { adminUser, bootstrapAndLogin, login } from "./support/appliance";

/**
 * Break-glass ceremony end to end with CDP virtual authenticators.
 *
 * Custody model honored by construction: one virtual authenticator (the
 * hardware key) per browser context (the custodian's own machine). Custodian
 * A enrolls key A and performs the emergency logins; custodian B enrolls key
 * B from a second browser. Resident credentials never leave their device.
 */

const MANAGEMENT_HEADERS = { "x-forwarded-for": "10.10.4.9, 10.10.0.2" };
const REASON = "Simulated IdP outage for quarterly rehearsal.";

async function addVirtualKey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test.describe.serial("break-glass emergency access", () => {
  test("designate, enroll two keys with separate custodians, emergency login with key and recovery code", async ({
    browser,
  }) => {
    // Custodian A's browser, on the management network, with hardware key A.
    const contextA = await browser.newContext({ extraHTTPHeaders: MANAGEMENT_HEADERS });
    const pageA = await contextA.newPage();
    await addVirtualKey(pageA);
    await bootstrapAndLogin(pageA, adminUser);

    // 1. Designate via the administration panel.
    await pageA.goto("/administration?section=accounts");
    await expect(pageA.getByTestId("break-glass-status")).toContainText(
      "No break-glass administrator is designated",
    );
    await pageA.getByLabel("Designate active admin").selectOption({ label: adminUser.displayName });
    await pageA.getByLabel("Change reason").fill("Initial custodian setup.");
    await pageA.getByRole("button", { name: "Designate custodian" }).click();
    await expect(pageA.getByTestId("break-glass-status")).toContainText("E2E Admin");

    // 2. Custodian A enrolls key A.
    await pageA.getByLabel("Security key label").fill("Custodian A key");
    await pageA.getByRole("button", { name: "Enroll security key" }).click();
    await expect(pageA.getByTestId("break-glass-status")).toContainText(
      "Security keys enrolled: 1",
    );

    // 3. Custodian B: separate browser, own key, own session.
    const contextB = await browser.newContext({ extraHTTPHeaders: MANAGEMENT_HEADERS });
    const pageB = await contextB.newPage();
    await addVirtualKey(pageB);
    await login(pageB, adminUser);
    await pageB.goto("/administration?section=accounts");
    await pageB.getByLabel("Security key label").fill("Custodian B key");
    await pageB.getByRole("button", { name: "Enroll security key" }).click();
    await expect(pageB.getByTestId("break-glass-status")).toContainText(
      "Security keys enrolled: 2",
    );
    await contextB.close();

    // 4. Issue recovery codes once; capture them from the single-render list.
    await pageA.goto("/administration?section=accounts");
    await pageA.getByRole("button", { name: "Issue new recovery codes" }).click();
    const codeItems = pageA.locator(".break-glass-codes code");
    await expect(codeItems).toHaveCount(10);
    const recoveryCodes = await codeItems.allTextContents();
    const firstCode = recoveryCodes[0].trim();
    expect(firstCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // 5. Non-management browser never sees the disclosure.
    const publicContext = await browser.newContext();
    const publicPage = await publicContext.newPage();
    await publicPage.goto("/");
    await expect(publicPage.getByTestId("break-glass-disclosure")).toHaveCount(0);
    await publicContext.close();

    // 6. Custodian A: password + key emergency login (normal session ended).
    await pageA.goto("/api/auth/session-state");
    await pageA.context().clearCookies();
    await pageA.goto("/");
    const disclosure = pageA.getByTestId("break-glass-disclosure");
    await expect(disclosure).toBeVisible();
    await disclosure.locator("summary").click();
    await pageA.getByLabel("Custodian password").fill(adminUser.password);
    await pageA.getByLabel("Incident reason").fill(REASON);
    await pageA.getByRole("button", { name: "Continue to security key" }).click();
    await pageA.getByRole("button", { name: "Use security key" }).click();

    await expect(pageA).toHaveURL(/\/workspace$/, { timeout: 20_000 });
    const banner = pageA
      .getByRole("alert")
      .filter({ hasText: "Emergency administrator session" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(REASON);
    await expect(banner).toContainText("Expires");

    await pageA.getByRole("button", { name: "End emergency session" }).click();
    await expect(pageA).toHaveURL(/reason=logged-out/);

    // 7. Recovery procedure: both hardware keys unavailable.
    await pageA.goto("/");
    await pageA.getByTestId("break-glass-disclosure").locator("summary").click();
    await pageA.getByLabel("Custodian password").fill(adminUser.password);
    await pageA.getByLabel("Incident reason").fill(REASON);
    await pageA.getByRole("button", { name: "Continue to security key" }).click();
    await pageA.getByRole("button", { name: "Use a recovery code instead" }).click();
    await pageA.getByLabel("Recovery code").fill(firstCode);
    await pageA.getByRole("button", { name: "Start emergency session" }).click();

    await expect(pageA).toHaveURL(/\/workspace$/, { timeout: 20_000 });
    await expect(
      pageA.getByRole("alert").filter({ hasText: "Emergency administrator session" }),
    ).toBeVisible();

    await pageA.getByRole("button", { name: "End emergency session" }).click();
    await expect(pageA).toHaveURL(/reason=logged-out/);

    // 8. The consumed recovery code cannot be replayed.
    await pageA.goto("/");
    await pageA.getByTestId("break-glass-disclosure").locator("summary").click();
    await pageA.getByLabel("Custodian password").fill(adminUser.password);
    await pageA.getByLabel("Incident reason").fill(REASON);
    await pageA.getByRole("button", { name: "Continue to security key" }).click();
    await pageA.getByRole("button", { name: "Use a recovery code instead" }).click();
    await pageA.getByLabel("Recovery code").fill(firstCode);
    await pageA.getByRole("button", { name: "Start emergency session" }).click();
    await expect(
      pageA
        .getByTestId("break-glass-disclosure")
        .locator("p.banner")
        .getByText("The emergency access request was not accepted."),
    ).toBeVisible();

    await contextA.close();
  });
});
