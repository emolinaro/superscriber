import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  actionModeIdFromUrl,
  adminUser,
  auditRows,
  bootstrapAndLogin,
  enterAdminActionMode,
  openCasefile,
  openGovernanceTab,
  queryRuntimeRows,
  runtimeRootDir,
  saveEditedDraft,
  uploadFixture,
} from "./support/appliance";

/**
 * Demo governance bring-back (captain-approved 2026-08-10, decision record
 * superscriber-security-audit-decision-demo-rulings-bringback): replays the
 * demo lane's governance surface onto main - action mode's admin self-
 * approval override (D-4), policy profile editing, version history with
 * any-revision export (D-3 contract delta) and snapshot deep links (D-8
 * read expansion), the recording danger zone and ledger reset with the D-5
 * pre-delete export-snapshot compensating control.
 */

function ledgerSnapshotFiles() {
  const container = process.env.SUPERSCRIBER_E2E_CONTAINER_NAME?.trim();
  if (container) {
    const output = execFileSync(
      "docker",
      ["exec", "--user", "node", container, "sh", "-c", "ls /app/data/ledger-snapshots 2>/dev/null || true"],
      { encoding: "utf8" },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  const dir = join(runtimeRootDir(), "ledger-snapshots");
  return existsSync(dir) ? readdirSync(dir).filter(Boolean) : [];
}

test.describe.serial("demo governance bring-back", () => {
  test("one administrator edits, submits, and approves the same casefile (D-4)", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Admin universal role record" });

    await openCasefile(page, recordingId);
    await enterAdminActionMode(page, "reviewer", "Admin covers the full review loop.");
    await saveEditedDraft(page, "Admin universal role draft.");
    await expect(page.getByLabel("Admin action mode")).toContainText(
      "Admin action mode: Reviewer",
    );

    // Submit the revision the admin just produced, still under reviewer mode.
    await page.getByRole("button", { name: "Submit for approval" }).click();
    const submitDialog = page.getByRole("dialog", { name: "Submit for approval" });
    await expect(submitDialog).toBeVisible();
    await submitDialog.getByRole("button", { name: "Submit for approval" }).last().click();
    await expect(page.getByText("Pending approval", { exact: true }).first()).toBeVisible();

    // Leave reviewer mode, then enter approver mode and approve the SAME
    // admin-submitted revision - the ruling's core assertion.
    await page.getByRole("button", { name: "Exit action mode" }).click();
    await enterAdminActionMode(page, "approver", "Admin approves own submission under ruling.");

    await page.getByRole("button", { name: "Approve and complete work" }).click();
    const approveDialog = page.getByRole("dialog", { name: "Approve and complete work" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByRole("button", { name: "Approve and complete work" }).last().click();

    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("Transcript approved and locked under policy."),
    ).toBeVisible();

    // Attribution under the wider rule: the decision row names the acting
    // admin AND the approver action-mode session the decision ran under.
    const adminRow = queryRuntimeRows<{ id: string }>(
      "SELECT id FROM users WHERE email = ?",
      [adminUser.email],
    )[0];
    const decisionRows = queryRuntimeRows<{ actorUserId: string; sessionId: string | null; effectiveRole: string }>(
      'SELECT actor_user_id AS "actorUserId", admin_action_session_id AS "sessionId", effective_role AS "effectiveRole" FROM approvals WHERE recording_id = ?',
      [recordingId],
    );
    expect(decisionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: adminRow.id,
          effectiveRole: "approver",
        }),
      ]),
    );

    // The approval's session id matches the audit trail's approver-mode entry.
    const approvedRow = decisionRows.find((row) => row.effectiveRole === "approver");
    const rows = auditRows(recordingId);
    expect(rows.some((row) => row.type === "approval.approved")).toBeTruthy();
    const approverEntry = rows.find(
      (row) => row.type === "admin.action_mode.entered" && row.effectiveRole === "approver",
    );
    expect(approverEntry?.adminActionSessionId).toBe(approvedRow?.sessionId);
  });

  test("version history, any-revision export, recovery, policy editing, purge, ledger reset", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Governance bring-back record" });

    // Danger zone + export affordance are visible to admin oversight before
    // any approval exists (D-13: honest empty state instead of no button).
    await openCasefile(page, recordingId);
    await expect(page.getByRole("heading", { name: "Danger zone" })).toBeVisible();
    await page.getByRole("button", { name: "Export transcript" }).click();
    const emptyExport = page.getByRole("dialog", { name: "Export approved transcript" });
    await expect(emptyExport).toBeVisible();
    await expect(emptyExport.getByText(/No approved revision yet/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Export transcript" })).toBeFocused();

    // Admin universal role: review, submit, approve the same casefile.
    await enterAdminActionMode(page, "reviewer", "Admin covers the review loop.");
    await saveEditedDraft(page, "Governance bring-back draft.");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    const submitDialog = page.getByRole("dialog", { name: "Submit for approval" });
    await submitDialog.getByRole("button", { name: "Submit for approval" }).last().click();
    await expect(page.getByText("Pending approval", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Exit action mode" }).click();
    await enterAdminActionMode(page, "approver", "Admin approves under the 2026-08 ruling.");
    const approverModeId = actionModeIdFromUrl(page);
    expect(approverModeId).toBeTruthy();

    await page.getByRole("button", { name: "Approve and complete work" }).click();
    const approveDialog = page.getByRole("dialog", { name: "Approve and complete work" });
    await approveDialog.getByRole("button", { name: "Approve and complete work" }).last().click();
    await expect(
      page.getByText("Transcript approved and locked under policy."),
    ).toBeVisible();

    // Diff highlight: the approved revision's edited segment is flagged vs
    // its parent revision inline.
    await expect(page.getByText("Edited vs v1")).toBeVisible();

    // Revision lineage and snapshot deep links (D-8 read expansion).
    await openGovernanceTab(page, "Revisions");
    await expect(page.getByText("Active").first()).toBeVisible();
    const revisionRows = queryRuntimeRows<{ id: string; version: number; state: string }>(
      "SELECT id, version, state FROM revisions WHERE recording_id = ? ORDER BY version",
      [recordingId],
    );
    expect(revisionRows.map((row) => row.version)).toEqual([1, 2]);
    const v1Id = revisionRows[0].id;
    const v2Id = revisionRows[1].id;

    const snapshotLink = page.getByRole("link", { name: "View snapshot" });
    await expect(snapshotLink).toHaveAttribute("href", new RegExp(`revision=${v1Id}`));
    await snapshotLink.click();
    await expect(page).toHaveURL(new RegExp(`revision=${v1Id}`));
    await expect(page.getByText("Historical snapshot").first()).toBeVisible();

    // Header revision navigator gets the current view back without dead ends.
    const navigator = page.getByRole("combobox", { name: "Choose a revision snapshot" });
    await expect(navigator).toBeVisible();
    const orderedOptions = await navigator.locator("option").allTextContents();
    expect(orderedOptions).toHaveLength(2);
    await navigator.selectOption(v2Id);
    await expect(page).toHaveURL(new RegExp(`revision=${v2Id}`));
    await expect(page.locator(".case-header")).not.toContainText("Historical snapshot");
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

    // Any-revision export (D-3 contract delta): the v1 draft exports under
    // the same authority, audited with the revision identity.
    const draftMd = await page.request.get(
      `/api/recordings/${recordingId}/transcript?format=md&revisionId=${v1Id}&actionModeId=${approverModeId}`,
    );
    expect(draftMd.ok()).toBeTruthy();
    expect(draftMd.headers()["content-disposition"]).toContain("-v1.md");
    expect(await draftMd.text()).toContain("# Governance bring-back record");

    const approvedMd = await page.request.get(
      `/api/recordings/${recordingId}/transcript?format=md&actionModeId=${approverModeId}`,
    );
    expect(approvedMd.ok()).toBeTruthy();
    expect(approvedMd.headers()["content-disposition"]).toContain("-approved-v2.md");

    const exportEvents = queryRuntimeRows<{ metadata: string }>(
      "SELECT metadata FROM audit_events WHERE recording_id = ? AND type = 'export.issued'",
      [recordingId],
    );
    expect(exportEvents).toHaveLength(2);
    expect(exportEvents.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([expect.stringContaining(`"revisionId":"${v1Id}"`)]),
    );

    // Admin recovery: v1 becomes the active draft as a new v3; lineage intact.
    await openGovernanceTab(page, "Revisions");
    await page.getByTestId("recover-v1").click();
    const recoverDialog = page.getByRole("dialog", { name: "Recover revision" });
    await expect(recoverDialog).toBeVisible();
    await recoverDialog.getByRole("button", { name: "Recover v1 as active draft" }).click();

    const postRecoverRows = queryRuntimeRows<{ id: string; version: number; state: string; summary: string }>(
      "SELECT id, version, state, summary FROM revisions WHERE recording_id = ? ORDER BY version",
      [recordingId],
    );
    expect(postRecoverRows.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(postRecoverRows[2]).toMatchObject({ state: "draft" });
    expect(postRecoverRows[2].summary).toContain("Recovered from v1");
    expect(
      auditRows(recordingId).some((row) => row.type === "revision.recovered"),
    ).toBeTruthy();

    // Policy profile editing: admin switches the workspace profile and the
    // audited before/after is recorded.
    await page.goto("/administration?section=policy");
    await page.getByLabel("Workspace policy profile").selectOption("reviewable-approved-export");
    await page.getByRole("button", { name: "Apply policy" }).click();
    await expect(page.getByText("Workspace policy profile updated.")).toBeVisible();
    const workspaceRows = queryRuntimeRows<{ policyProfileId: string }>(
      "SELECT policy_profile_id AS policyProfileId FROM workspaces LIMIT 1",
      [],
    );
    expect(workspaceRows[0]?.policyProfileId).toBe("reviewable-approved-export");

    // Danger zone purge (D-5): typed-title confirm; casefile rows die, one
    // deletion record survives, and the pre-delete export snapshot holds the
    // removed rows outside the database.
    await page.goto("/recordings/" + recordingId);
    await page.getByRole("button", { name: "Delete recording permanently..." }).click();
    const purgeDialog = page.getByRole("dialog", { name: "Delete this recording permanently?" });
    await expect(purgeDialog).toBeVisible();
    await purgeDialog.getByLabel("Type the recording title to confirm").fill("Governance bring-back record");
    await purgeDialog.getByRole("button", { name: "Delete permanently" }).click();
    // The danger zone hard-navigates away from the deleted casefile; the root
    // page then client-redirects authenticated sessions to /workspace. Wait
    // for that chain to settle before driving further navigation.
    await expect(page).toHaveURL(/\/workspace(?:\?.*)?$/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    expect(
      queryRuntimeRows("SELECT id FROM recordings WHERE id = ?", [recordingId]),
    ).toHaveLength(0);
    expect(auditRows(recordingId)).toHaveLength(0);
    const deletionEvents = queryRuntimeRows<{ type: string; metadata: string }>(
      "SELECT type, metadata FROM security_events WHERE type = 'recording.deleted'",
      [],
    );
    expect(deletionEvents).toHaveLength(1);
    expect(deletionEvents[0].metadata).toContain("snapshotPath");
    expect(ledgerSnapshotFiles().some((name) => name.startsWith("recording.purge-"))).toBe(true);

    // Data discipline reset (D-5): everything dies except the reset record,
    // which names the snapshot that holds every cleared row.
    await page.goto("/administration?section=discipline");
    await expect(page.getByRole("heading", { name: "Data discipline" })).toBeVisible();
    await page.getByRole("button", { name: "Reset the governed ledger..." }).click();
    const resetDialog = page.getByRole("dialog", { name: "Reset the governed ledger?" });
    await expect(resetDialog).toBeVisible();
    await resetDialog.getByLabel("Type RESET REQUIRED to confirm").fill("RESET REQUIRED");
    await resetDialog.getByRole("button", { name: "Reset the ledger" }).click();
    await expect(page.getByText(/Ledger reset complete/).first()).toBeVisible();

    const survivingSecurity = queryRuntimeRows<{ type: string; metadata: string }>(
      "SELECT type, metadata FROM security_events",
      [],
    );
    expect(survivingSecurity).toHaveLength(1);
    expect(survivingSecurity[0].type).toBe("ledger.reset");
    expect(survivingSecurity[0].metadata).toContain("snapshotPath");
    expect(
      queryRuntimeRows("SELECT id FROM audit_events LIMIT 1", []),
    ).toHaveLength(0);
    expect(ledgerSnapshotFiles().some((name) => name.startsWith("ledger.reset-"))).toBe(true);
  });
});
