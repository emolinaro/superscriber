import { expect, test, type Page } from "@playwright/test";
import {
  accountRoleAuditRows,
  accountRoleFactsForEmail,
  adminUser,
  authSessionRowsForEmail,
  bootstrapAndLogin,
  chooseOptionByText,
  ensureLocalAccount,
  execRuntimeSql,
  login,
  queryRuntimeRows,
  uploadFixture,
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

const assignmentUser: LocalUser = {
  displayName: "Role Assigned Reviewer",
  email: "role-assigned@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const rollbackUser: LocalUser = {
  displayName: "Role Rollback Reviewer",
  email: "role-rollback@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const staleUser: LocalUser = {
  displayName: "Role Stale Reviewer",
  email: "role-stale@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const breakGlassTarget: LocalUser = {
  displayName: "Role Break Glass Admin",
  email: "role-break-glass@example.com",
  password: "Superscriber!123",
  role: "admin",
};

const staleActor: LocalUser = {
  displayName: "Role Stale Actor Admin",
  email: "role-stale-actor@example.com",
  password: "Superscriber!123",
  role: "admin",
};

const staleVictim: LocalUser = {
  displayName: "Role Stale Victim",
  email: "role-stale-victim@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const concurrentAdmin: LocalUser = {
  displayName: "Role Concurrent Admin",
  email: "role-concurrent-admin@example.com",
  password: "Superscriber!123",
  role: "admin",
};

const selfAdmin: LocalUser = {
  displayName: "Role Self Admin",
  email: "role-self-admin@example.com",
  password: "Superscriber!123",
  role: "admin",
};

type AuthControlSnapshot = {
  breakGlassUserId: string;
  updatedAt: string;
  updatedByUserId: string | null;
  changeReason: string;
};

function readAuthControl(): AuthControlSnapshot | undefined {
  return queryRuntimeRows<AuthControlSnapshot>(
    `select break_glass_user_id as breakGlassUserId, updated_at as updatedAt,
            updated_by_user_id as updatedByUserId, change_reason as changeReason
     from auth_control where id = 1`,
    [],
  )[0];
}

function restoreAuthControl(snapshot: AuthControlSnapshot | undefined) {
  execRuntimeSql("delete from auth_control where id = 1", []);
  if (!snapshot) {
    return;
  }
  execRuntimeSql(
    `insert into auth_control (
      id, break_glass_user_id, updated_at, updated_by_user_id, change_reason
    ) values (1, ?, ?, ${snapshot.updatedByUserId === null ? "null" : "?"}, ?)`,
    snapshot.updatedByUserId === null
      ? [snapshot.breakGlassUserId, snapshot.updatedAt, snapshot.changeReason]
      : [
          snapshot.breakGlassUserId,
          snapshot.updatedAt,
          snapshot.updatedByUserId,
          snapshot.changeReason,
        ],
  );
}

function accountRow(page: Page, account: LocalUser) {
  return page.getByRole("row").filter({
    has: page.getByRole("cell", { name: account.email }),
  });
}

function roleSelect(page: Page, account: LocalUser) {
  return page.getByRole("combobox", { name: `Role for ${account.displayName}` });
}

function accountRoleAlert(page: Page) {
  return page.locator("[data-account-role-alert]:visible");
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

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("combobox", { name: /Role for/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save role" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

    releaseRequest?.();
    await expect(
      page.getByRole("status").filter({ hasText: "Role Pending Reviewer's role changed" }),
    ).toContainText("from Reviewer to Approver");
    await expect(page.getByRole("combobox", { name: /Role for/ })).toHaveCount(0);
    const target = accountRoleFactsForEmail(pendingUser.email);
    expect(target?.role).toBe("approver");
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

  test("protects the final active administrator with actionable focus and no governed change", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    const actor = accountRoleFactsForEmail(adminUser.email)!;
    const adminStates = queryRuntimeRows<{ id: string; isActive: number }>(
      "select id, is_active as isActive from users where role = 'admin' order by id",
      [],
    );
    const originalControl = readAuthControl();

    try {
      execRuntimeSql("delete from auth_control where id = 1", []);
      execRuntimeSql(
        "update users set is_active = 0 where role = 'admin' and id <> ?",
        [actor.id],
      );
      await openAccount(page, adminUser);
      const before = accountRoleFactsForEmail(adminUser.email)!;
      const beforeAudits = accountRoleAuditRows(before.id).length;
      const beforeSessions = authSessionRowsForEmail(adminUser.email);
      const beforeState = queryRuntimeRows<{ stateVersion: number }>(
        "select state_version as stateVersion from app_state_meta where id = 1",
        [],
      )[0]!;
      const beforeSecurityEvents = queryRuntimeRows<{ count: number }>(
        "select count(*) as count from security_events",
        [],
      )[0]!.count;

      await saveRole(page, adminUser, "reviewer", "Final admin duties cannot change.");

      const alert = accountRoleAlert(page);
      await expect(alert).toContainText("At least one active administrator must remain");
      await expect(alert).toContainText("Promote another active account to Administrator");
      await expect(alert).toBeFocused();
      await expect(
        page.getByRole("textbox", { name: `Change reason for ${adminUser.displayName}` }),
      ).toHaveValue("Final admin duties cannot change.");
      expect(accountRoleFactsForEmail(adminUser.email)).toEqual(before);
      expect(accountRoleAuditRows(before.id)).toHaveLength(beforeAudits);
      expect(authSessionRowsForEmail(adminUser.email)).toEqual(beforeSessions);
      expect(
        queryRuntimeRows<{ stateVersion: number }>(
          "select state_version as stateVersion from app_state_meta where id = 1",
          [],
        )[0],
      ).toEqual(beforeState);
      expect(
        queryRuntimeRows<{ count: number }>(
          "select count(*) as count from security_events",
          [],
        )[0]!.count,
      ).toBe(beforeSecurityEvents + 1);
    } finally {
      for (const admin of adminStates) {
        execRuntimeSql("update users set is_active = ? where id = ?", [
          String(admin.isActive),
          admin.id,
        ]);
      }
      restoreAuthControl(originalControl);
    }
  });

  test("protects the designated break-glass administrator until designation transfer", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, breakGlassTarget);
    const target = accountRoleFactsForEmail(breakGlassTarget.email)!;
    const original = readAuthControl();
    const actor = accountRoleFactsForEmail(adminUser.email)!;

    try {
      execRuntimeSql(
        `insert into auth_control (
          id, break_glass_user_id, updated_at, updated_by_user_id, change_reason
        ) values (1, ?, ?, ?, ?)
        on conflict(id) do update set
          break_glass_user_id = excluded.break_glass_user_id,
          updated_at = excluded.updated_at,
          updated_by_user_id = excluded.updated_by_user_id,
          change_reason = excluded.change_reason`,
        [target.id, new Date().toISOString(), actor.id, "E2E protection coverage."],
      );
      await openAccount(page, breakGlassTarget);
      const before = accountRoleFactsForEmail(breakGlassTarget.email)!;
      const sessionsBefore = authSessionRowsForEmail(breakGlassTarget.email);
      const auditsBefore = accountRoleAuditRows(target.id).length;
      const stateBefore = queryRuntimeRows<{ stateVersion: number }>(
        "select state_version as stateVersion from app_state_meta where id = 1",
        [],
      )[0]!;
      const securityBefore = queryRuntimeRows<{ count: number }>(
        "select count(*) as count from security_events",
        [],
      )[0]!.count;
      await saveRole(
        page,
        breakGlassTarget,
        "reviewer",
        "Break glass duties changed safely.",
      );
      const alert = accountRoleAlert(page);
      await expect(alert).toContainText("designated break-glass administrator");
      await expect(alert).toContainText("Transfer the designation");
      await expect(alert).toBeFocused();
      await expect(
        page.getByRole("textbox", {
          name: `Change reason for ${breakGlassTarget.displayName}`,
        }),
      ).toHaveValue("Break glass duties changed safely.");
      expect(accountRoleFactsForEmail(breakGlassTarget.email)).toEqual(before);
      expect(authSessionRowsForEmail(breakGlassTarget.email)).toEqual(sessionsBefore);
      expect(accountRoleAuditRows(target.id)).toHaveLength(auditsBefore);
      expect(
        queryRuntimeRows<{ stateVersion: number }>(
          "select state_version as stateVersion from app_state_meta where id = 1",
          [],
        )[0],
      ).toEqual(stateBefore);
      expect(
        queryRuntimeRows<{ count: number }>(
          "select count(*) as count from security_events",
          [],
        )[0]!.count,
      ).toBe(securityBefore + 1);
      const denial = queryRuntimeRows<{ metadata: string }>(
        `select metadata from security_events
         where type = 'account.role_change.denied' order by created_at desc, id desc limit 1`,
        [],
      )[0]!;
      expect(denial.metadata).toContain(target.id);
      expect(denial.metadata).not.toContain("Break glass duties changed safely.");
      expect(denial.metadata).not.toContain(breakGlassTarget.email);

      execRuntimeSql(
        `update auth_control set break_glass_user_id = ?, updated_at = ?,
          updated_by_user_id = ?, change_reason = ? where id = 1`,
        [actor.id, new Date().toISOString(), actor.id, "E2E transfer coverage."],
      );
      await openAccount(page, breakGlassTarget);
      await saveRole(
        page,
        breakGlassTarget,
        "reviewer",
        "Break glass duties changed safely.",
      );
      await expect(page.getByRole("status")).toContainText(
        "Role Break Glass Admin's role changed from Admin to Reviewer",
      );
    } finally {
      restoreAuthControl(original);
    }
  });

  test("blocks an incompatible active assignment, links resolution, and succeeds after removal", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, assignmentUser);
    await uploadFixture(page, { title: "Role assignment blocker record" });

    await page.goto("/administration?section=assignments");
    await page.getByRole("button", { name: "Assign work" }).click();
    const dialog = page.getByRole("dialog", { name: "Assign governed work" });
    await chooseOptionByText(
      dialog.getByLabel("Recording", { exact: true }),
      "Role assignment blocker record",
    );
    await chooseOptionByText(
      dialog.getByLabel("Assigned user", { exact: true }),
      assignmentUser.displayName,
    );
    await dialog.getByRole("button", { name: "Assign recording" }).click();
    await expect(page.getByRole("status")).toContainText("Recording assignment updated");

    await openAccount(page, assignmentUser);
    await saveRole(
      page,
      assignmentUser,
      "approver",
      "Assigned duties changed safely.",
    );
    const alert = accountRoleAlert(page);
    await expect(alert).toContainText("Role assignment blocker record");
    await expect(alert).toContainText("1 Reviewer assignment");
    await expect(alert).toBeFocused();
    await expect(
      page.getByRole("textbox", {
        name: `Change reason for ${assignmentUser.displayName}`,
      }),
    ).toHaveValue("Assigned duties changed safely.");
    const resolutionLink = alert.getByRole("link", { name: "Open active assignments" });
    await expect(resolutionLink).toHaveAttribute("href", /section=assignments/);
    await expect(resolutionLink).toHaveAttribute("href", /status=active/);
    await expect(resolutionLink).toHaveAttribute(
      "href",
      new RegExp(`userId=${accountRoleFactsForEmail(assignmentUser.email)!.id}`),
    );
    await resolutionLink.click();
    await expect(page).toHaveURL(/section=assignments.*status=active.*userId=/);

    await page.getByRole("button", { name: "Remove assignment" }).first().click();
    const removeDialog = page.getByRole("dialog", { name: "Remove assignment" });
    await removeDialog.getByRole("button", { name: "Remove assignment" }).click();
    await expect(page.getByRole("status")).toContainText("Recording assignment removed");
    expect(
      queryRuntimeRows<{ status: string }>(
        `select ra.status from recording_assignments ra
         join users u on u.id = ra.user_id where u.email = ?`,
        [assignmentUser.email],
      ),
    ).toEqual([{ status: "removed" }]);

    await openAccount(page, assignmentUser);
    await saveRole(
      page,
      assignmentUser,
      "approver",
      "Assigned duties changed safely.",
    );
    await expect(page.getByRole("status")).toContainText(
      "Role Assigned Reviewer's role changed from Reviewer to Approver",
    );
  });

  test("rolls back an injected audit failure and permits a refresh-then-retry", async ({ browser, page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, rollbackUser);
    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    await login(targetPage, rollbackUser);
    const before = accountRoleFactsForEmail(rollbackUser.email)!;
    const sessionsBefore = authSessionRowsForEmail(rollbackUser.email);
    const stateBefore = queryRuntimeRows<{ stateVersion: number }>(
      "select state_version as stateVersion from app_state_meta where id = 1",
      [],
    )[0]!;
    const auditsBefore = accountRoleAuditRows(before.id).length;
    const securityBefore = queryRuntimeRows<{ count: number }>(
      "select count(*) as count from security_events",
      [],
    )[0]!.count;

    execRuntimeSql(
      `CREATE TRIGGER e2e_abort_account_role_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.type = 'account.role_changed'
       BEGIN
         SELECT RAISE(ABORT, 'e2e account role audit failure');
       END`,
      [],
    );
    try {
      await openAccount(page, rollbackUser);
      await saveRole(page, rollbackUser, "approver", "Rollback duties changed safely.");
      const alert = accountRoleAlert(page);
      await expect(alert).toContainText("could not be confirmed");
      await expect(alert).toContainText("Reference:");
      await expect(alert).not.toContainText("SQLITE");
      await expect(alert).toBeFocused();
      await expect(roleSelect(page, rollbackUser)).toHaveValue("approver");
      await expect(
        page.getByRole("textbox", { name: `Change reason for ${rollbackUser.displayName}` }),
      ).toHaveValue("Rollback duties changed safely.");
      expect(accountRoleFactsForEmail(rollbackUser.email)).toEqual(before);
      expect(authSessionRowsForEmail(rollbackUser.email)).toEqual(sessionsBefore);
      expect(accountRoleAuditRows(before.id)).toHaveLength(auditsBefore);
      expect(
        queryRuntimeRows<{ stateVersion: number }>(
          "select state_version as stateVersion from app_state_meta where id = 1",
          [],
        )[0],
      ).toEqual(stateBefore);
      expect(
        queryRuntimeRows<{ count: number }>(
          "select count(*) as count from security_events",
          [],
        )[0]!.count,
      ).toBe(securityBefore);
    } finally {
      execRuntimeSql("drop trigger if exists e2e_abort_account_role_audit", []);
      await targetContext.close();
    }

    await openAccount(page, rollbackUser);
    await saveRole(page, rollbackUser, "approver", "Rollback duties changed safely.");
    await expect(page.getByRole("status")).toContainText(
      "Role Rollback Reviewer's role changed from Reviewer to Approver",
    );
  });

  test("prevents a stale target tab from silently overwriting the winner", async ({ browser, page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, staleUser);
    const storageState = await page.context().storageState();
    const loserContext = await browser.newContext({ storageState });
    const loserPage = await loserContext.newPage();
    try {
      await openAccount(page, staleUser);
      await openAccount(loserPage, staleUser);
      await roleSelect(page, staleUser).selectOption("approver");
      await page
        .getByRole("textbox", { name: `Change reason for ${staleUser.displayName}` })
        .fill("Winning duties changed safely.");
      await roleSelect(loserPage, staleUser).selectOption("uploader");
      await loserPage
        .getByRole("textbox", { name: `Change reason for ${staleUser.displayName}` })
        .fill("Losing duties changed safely.");

      await loserPage.route("**/administration**", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await route.continue();
      });
      await Promise.all([
        page.getByRole("button", { name: "Save role" }).click(),
        loserPage.getByRole("button", { name: "Save role" }).click(),
      ]);
      await expect(page.getByRole("status")).toContainText("changed from Reviewer to Approver");
      const alert = accountRoleAlert(loserPage);
      await expect(alert).toContainText("role changed after the list loaded");
      await expect(alert).toBeFocused();
      await expect(roleSelect(loserPage, staleUser)).toHaveValue("uploader");
      expect(accountRoleFactsForEmail(staleUser.email)?.role).toBe("approver");
      expect(
        loserPage.getByRole("textbox", {
          name: `Change reason for ${staleUser.displayName}`,
        }),
      ).toHaveValue("Losing duties changed safely.");
    } finally {
      await loserContext.close();
    }
  });

  test("rejects a stale administrator's prepared second mutation", async ({ browser, page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, staleActor);
    await ensureLocalAccount(page, staleVictim);
    const staleContext = await browser.newContext();
    const stalePage = await staleContext.newPage();
    try {
      await login(stalePage, staleActor);
      await stalePage.route("**/api/auth/session-state", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"active":true}' });
      });
      await openAccount(stalePage, staleVictim);
      await roleSelect(stalePage, staleVictim).selectOption("approver");
      await stalePage
        .getByRole("textbox", { name: `Change reason for ${staleVictim.displayName}` })
        .fill("Stale actor duties changed.");

      await openAccount(page, staleActor);
      await saveRole(page, staleActor, "reviewer", "Administrator duties changed safely.");
      await expect(page.getByRole("status")).toContainText("changed from Admin to Reviewer");

      await stalePage.getByRole("button", { name: "Save role" }).click();
      await expect(stalePage).toHaveURL(/reason=session-expired/);
      expect(accountRoleFactsForEmail(staleVictim.email)?.role).toBe("reviewer");
      expect(accountRoleAuditRows(accountRoleFactsForEmail(staleVictim.email)!.id)).toHaveLength(0);
    } finally {
      await staleContext.close();
    }
  });

  test("keeps phone administration inspection-only in portrait and coarse landscape", async ({ browser, page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, staleUser);
    const admin = accountRoleFactsForEmail(adminUser.email)!;
    const persistedStaleRole = accountRoleFactsForEmail(staleUser.email)!.role;
    const storageState = await page.context().storageState();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const context = await browser.newContext({
        storageState,
        viewport,
        hasTouch: true,
        isMobile: true,
      });
      try {
        const phone = await context.newPage();
        await phone.goto("/administration?section=accounts");
        await expect(phone.getByRole("heading", { name: "Institutional accounts" })).toBeVisible();
        const accountFacts = phone.locator(
          `[data-testid="account-facts-${admin.id}"]:visible`,
        );
        await expect(accountFacts).toContainText(adminUser.email);
        await expect(phone.getByTestId("break-glass-status")).toBeVisible();
        await expect(phone.getByRole("combobox", { name: /Role for/ })).toHaveCount(0);
        await expect(phone.getByRole("textbox", { name: /Change reason for/ })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Save role" })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Cancel" })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Create account" })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Designate custodian" })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Enroll security key" })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Issue new recovery codes" })).toHaveCount(0);

        await phone.goto("/administration?section=assignments");
        await expect(phone.getByRole("heading", { name: "Assignments" })).toBeVisible();
        await expect(
          phone.getByText("Review active access grants and retained assignment history in explicit UTC."),
        ).toBeVisible();
        await expect(phone.getByRole("button", { name: "Assign work" })).toHaveCount(0);
        await expect(phone.getByRole("button", { name: "Remove assignment" })).toHaveCount(0);
      } finally {
        await context.close();
      }
    }

    await openAccount(page, staleUser);
    await roleSelect(page, staleUser).selectOption("uploader");
    await page
      .getByRole("textbox", { name: `Change reason for ${staleUser.displayName}` })
      .fill("Unsaved phone transition.");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("combobox", { name: /Role for/ })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(roleSelect(page, staleUser)).toHaveValue(persistedStaleRole);
    await expect(
      page.getByRole("textbox", { name: `Change reason for ${staleUser.displayName}` }),
    ).toHaveCount(0);
  });

  test("serializes two final-admin demotions so exactly one administrator remains", async ({ browser, page }) => {
    await bootstrapAndLogin(page, adminUser);
    await ensureLocalAccount(page, concurrentAdmin);
    const main = accountRoleFactsForEmail(adminUser.email)!;
    const other = accountRoleFactsForEmail(concurrentAdmin.email)!;
    const adminStates = queryRuntimeRows<{ id: string; isActive: number }>(
      "select id, is_active as isActive from users where role = 'admin' order by id",
      [],
    );
    const originalControl = readAuthControl();
    execRuntimeSql("delete from auth_control where id = 1", []);
    execRuntimeSql(
      `update users set is_active = case when id in (?, ?) then 1 else 0 end
       where role = 'admin'`,
      [main.id, other.id],
    );
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    try {
      await login(otherPage, concurrentAdmin);
      await openAccount(page, adminUser);
      await openAccount(otherPage, concurrentAdmin);
      await roleSelect(page, adminUser).selectOption("reviewer");
      await page
        .getByRole("textbox", { name: `Change reason for ${adminUser.displayName}` })
        .fill("Concurrent main demotion.");
      await roleSelect(otherPage, concurrentAdmin).selectOption("reviewer");
      await otherPage
        .getByRole("textbox", { name: `Change reason for ${concurrentAdmin.displayName}` })
        .fill("Concurrent second demotion.");

      await Promise.all([
        page.getByRole("button", { name: "Save role" }).click(),
        otherPage.getByRole("button", { name: "Save role" }).click(),
      ]);
      await expect
        .poll(
          () =>
            queryRuntimeRows<{ count: number }>(
              "select count(*) as count from users where role = 'admin' and is_active = 1",
              [],
            )[0]?.count,
        )
        .toBe(1);
      await expect
        .poll(async () => {
          const redirected = [page, otherPage].filter((candidate) =>
            candidate.url().includes("reason=role-changed"),
          ).length;
          const protectedAlert =
            (await accountRoleAlert(page).count()) +
            (await accountRoleAlert(otherPage).count());
          return redirected + protectedAlert;
        })
        .toBeGreaterThanOrEqual(2);
      const roleChangedPages = [page, otherPage].filter((candidate) =>
        candidate.url().includes("reason=role-changed"),
      );
      const protectedPages = [page, otherPage].filter(
        (candidate) => !candidate.url().includes("reason=role-changed"),
      );
      expect(roleChangedPages).toHaveLength(1);
      expect(protectedPages).toHaveLength(1);
      await expect(accountRoleAlert(protectedPages[0]!)).toContainText(
        "At least one active administrator must remain",
      );
    } finally {
      execRuntimeSql(
        "update users set role = 'admin', is_active = 1 where id in (?, ?)",
        [main.id, other.id],
      );
      for (const admin of adminStates) {
        execRuntimeSql("update users set is_active = ? where id = ?", [
          String(admin.isActive),
          admin.id,
        ]);
      }
      restoreAuthControl(originalControl);
      await otherContext.close();
    }
  });
});
