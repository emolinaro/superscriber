import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  login,
  queryRuntimeRows,
  runtimeRootDir,
} from "./support/appliance";

/**
 * Unmanageable-instance recovery (captain ruling): when accounts survive but
 * no active administrator remains, the sign-up door surfaces an
 * operator-gated claim ceremony. A network attacker without the on-host
 * claim proof is refused; the host operator can claim a fresh administrator.
 */
const recoveryAdmin = {
  displayName: "Recovery Admin",
  email: "recovery-admin@example.com",
  password: "correct horse recovery staple",
  role: "admin",
} as const;

const WRONG_CLAIM_TOKEN = "deadbeef".repeat(8);
const PUBLIC_ATTACKER_HEADERS = {
  "x-forwarded-for": "203.0.113.44, 10.10.0.2",
};

function adminClaimTokenPath() {
  return join(runtimeRootDir(), "admin-claim.token");
}

function activeAdminCount() {
  return queryRuntimeRows<{ count: number }>(
    "select count(*) as count from users where role = ? and is_active = 1",
    ["admin"],
  )[0]!.count;
}

test.describe.serial("administrator recovery", () => {
  test.afterAll(() => {
    // Restore the shared fixture surface for every later spec: the original
    // admin (plus the claimed recovery admin) is active again.
    execRuntimeSql("update users set is_active = 1 where role = ?", ["admin"]);
  });

  test("surfaces the claim and refuses a network attacker without the host proof", async ({
    browser,
    page,
  }) => {
    // Baseline: a working admin exists. Then the instance loses its last
    // active administrator (deactivation, deletion, partial restore) while
    // every other account survives.
    await bootstrapAndLogin(page, adminUser);
    execRuntimeSql("update users set is_active = 0 where role = ?", ["admin"]);
    expect(activeAdminCount()).toBe(0);
    await page.context().clearCookies();
    await page.goto("/");

    // The unmanageable instance leads with the recovery path on the Sign up
    // door, and mints the operator-only claim proof next to the database.
    await expect(
      page.getByRole("heading", { name: "Administrator recovery" }),
    ).toBeVisible();
    await expect(
      page.getByText(/no active administrator remains/i).first(),
    ).toBeVisible();
    await expect(page.getByLabel("Operator claim token")).toBeVisible();

    const tokenPath = adminClaimTokenPath();
    expect(existsSync(tokenPath)).toBe(true);

    // An attacker who can merely reach the sign-up door has no proof: the
    // claim is refused and audited, and no administrator appears. (The
    // sign-in pane lives in the same DOM; scope every fill to the visible
    // Sign up tabpanel.)
    const attackerContext = await browser.newContext({
      extraHTTPHeaders: PUBLIC_ATTACKER_HEADERS,
    });
    const attackerPage = await attackerContext.newPage();
    await attackerPage.goto("/");
    const attackerPane = attackerPage.getByRole("tabpanel", { name: "Sign up" });
    await attackerPane.getByLabel("Administrator name").fill(recoveryAdmin.displayName);
    await attackerPane.getByLabel("Administrator email").fill(recoveryAdmin.email);
    await attackerPane.getByLabel(/^Password$/).fill(recoveryAdmin.password);
    await attackerPane.getByLabel("Confirm password").fill(recoveryAdmin.password);
    await attackerPane.getByLabel("Operator claim token").fill(WRONG_CLAIM_TOKEN);
    await attackerPane.getByRole("button", { name: "Claim administrator" }).click();

    await expect(
      attackerPane.getByText("The claim token did not match the proof on the appliance host.", {
        exact: true,
      }),
    ).toBeVisible();
    await attackerContext.close();

    expect(activeAdminCount()).toBe(0);
    expect(
      queryRuntimeRows("select id from users where email = ?", [recoveryAdmin.email]),
    ).toHaveLength(0);

    const denials = queryRuntimeRows<{
      type: string;
      outcome: string;
      sourceZone: string;
      detail: string;
      metadata: string;
    }>(
      `select type, outcome, source_zone as sourceZone, detail, metadata
         from security_events where type = ? and outcome = ? and source_zone = ?`,
      ["admin.recovery_claim", "denied", "public"],
    );
    expect(denials.length).toBeGreaterThan(0);
    for (const denial of denials) {
      expect(denial.sourceZone).toBe("public");
      expect(JSON.stringify(denial)).not.toContain(WRONG_CLAIM_TOKEN);
    }

    // The proof remains minted for the real operator.
    expect(readFileSync(tokenPath, "utf8").trim()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("lets the host operator claim a fresh admin and restores steady state", async ({
    page,
  }) => {
    // The operator reads the single-use proof from the appliance host and
    // completes the claim over the public network form. (Fresh context:
    // every admin is still inactive, so no account can sign in.)
    const hostToken = readFileSync(adminClaimTokenPath(), "utf8").trim();

    await page.goto("/");
    const claimPane = page.getByRole("tabpanel", { name: "Sign up" });
    await claimPane.getByLabel("Administrator name").fill(recoveryAdmin.displayName);
    await claimPane.getByLabel("Administrator email").fill(recoveryAdmin.email);
    await claimPane.getByLabel(/^Password$/).fill(recoveryAdmin.password);
    await claimPane.getByLabel("Confirm password").fill(recoveryAdmin.password);
    await claimPane.getByLabel("Operator claim token").fill(hostToken);
    await claimPane.getByRole("button", { name: "Claim administrator" }).click();

    await expect(page).toHaveURL(/notice=admin-recovery-complete/);
    await expect(
      page.getByText(
        "Administrator recovery is complete. Sign in with the admin account you just claimed.",
      ),
    ).toBeVisible();

    // The proof is consumed on use.
    expect(existsSync(adminClaimTokenPath())).toBe(false);

    await login(page, recoveryAdmin);
    await expect(page.getByRole("navigation", { name: "Primary" })).toContainText(
      "Administration",
    );

    const successes = queryRuntimeRows<{ outcome: string; user_id: string }>(
      "select outcome, user_id from security_events where type = ? and outcome = ?",
      ["admin.recovery_claim", "success"],
    );
    expect(successes.length).toBeGreaterThan(0);

    // Steady state restored: the sign-up door explains provisioned access
    // again instead of offering the claim.
    await page.context().clearCookies();
    await page.goto("/");
    await page.getByRole("tab", { name: "Sign up" }).click();
    await expect(
      page.getByRole("heading", { name: "First-time access" }),
    ).toBeVisible();
    await expect(page.getByLabel("Operator claim token")).toHaveCount(0);
  });
});
