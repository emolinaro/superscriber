import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  actionModeIdFromUrl,
  adminUser,
  bootstrapAndLogin,
  enterAdminActionMode,
  openCasefile,
  openGovernanceTab,
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
 * read expansion), the recording danger zone and the ledger reset with the
 * D-5 pre-delete export-snapshot compensating control.
 *
 * All assertions run through the app surface (UI or HTTP). The one exception
 * is filesystem-level: the ledger-snapshot directory is plain files, so the
 * pre-delete snapshot control is verifiable without a second SQLite reader
 * (docker-exec DB readers on the container lane observe checkpoint lag and
 * cannot be trusted for same-second consistency).
 */

function ledgerSnapshotFiles() {
  // In the container lane the app writes to /app/data, which is the bind
  // mount of the host data dir; listing it from the host is equivalent.
  const dir = join(runtimeRootDir(), "ledger-snapshots");
  return existsSync(dir) ? readdirSync(dir).filter(Boolean) : [];
}

test.describe.serial("demo governance bring-back", () => {
  // These tests upload and wait through the real container transcription
  // pipeline; under loaded hosts the 90s default was observed to expire
  // (same guard as the governed casefile suite).
  test.setTimeout(240_000);

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

    // Attribution under the wider rule stays visible on the surface: the
    // decision names the acting admin, and the audit trail keeps the
    // approver action-mode entry that the decision ran under.
    await openGovernanceTab(page, "Decisions");
    await expect(page.getByText("E2E Admin").first()).toBeVisible();
    await openGovernanceTab(page, "Audit");
    await expect(page.getByText("admin.action_mode.entered").first()).toBeVisible();
    await expect(page.getByText("approval.approved").first()).toBeVisible();
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

    // Revision lineage, snapshot deep links, and id capture from the header
    // navigator (the option ids ARE revision ids - no out-of-band DB read).
    await openGovernanceTab(page, "Revisions");
    const revisionsPanel = page.getByRole("tabpanel");
    await expect(revisionsPanel.getByText("Active", { exact: true })).toBeVisible();
    await expect(revisionsPanel.getByText("Superseded")).toBeVisible();

    const snapshotLink = page.getByRole("link", { name: "View snapshot" });
    const snapshotHref = await snapshotLink.getAttribute("href");
    expect(snapshotHref).toContain("revision=");
    const v1Id = snapshotHref?.split("revision=")[1] ?? "";
    expect(v1Id.length).toBeGreaterThan(0);
    await snapshotLink.click();
    await expect(page).toHaveURL(new RegExp(`revision=${v1Id}`));
    await expect(page.getByText("Historical snapshot").first()).toBeVisible();

    // Header revision navigator gets the current view back without dead ends.
    const navigator = page.getByRole("combobox", { name: "Choose a revision snapshot" });
    await expect(navigator).toBeVisible();
    const v2Option = await navigator
      .locator("option", { hasText: "v2 · Approved" })
      .getAttribute("value");
    expect(v2Option).toBeTruthy();
    await navigator.selectOption(v2Option!);
    await expect(page).toHaveURL(new RegExp(`revision=${v2Option}`));
    await expect(page.locator(".case-header")).not.toContainText("Historical snapshot");

    // Any-revision export (D-3 contract delta): the archived v1 draft exports
    // under the same authority, and the audit trail names the revision.
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

    // The export picker also surfaces the choice: default is the approved
    // revision. (Download byte paths are covered by the route tests; the
    // picker contract here is the default selection.)
    await page.getByRole("button", { name: "Export approved transcript" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export approved transcript" });
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.getByLabel("Revision to export")).toHaveValue(v2Option!);
    await exportDialog.getByLabel("Revision to export").selectOption(v1Id);
    await page.keyboard.press("Escape");

    // Admin recovery: v1 becomes the active draft as a new v3; lineage intact.
    await openGovernanceTab(page, "Revisions");
    await page.getByTestId("recover-v1").click();
    const recoverDialog = page.getByRole("dialog", { name: "Recover revision" });
    await expect(recoverDialog).toBeVisible();
    await recoverDialog.getByRole("button", { name: "Recover v1 as active draft" }).click();

    await openGovernanceTab(page, "Revisions");
    const postRecoverPanel = page.getByRole("tabpanel");
    await expect(postRecoverPanel.getByText("Recovered from v1")).toBeVisible();
    await expect(postRecoverPanel.getByText("v3")).toBeVisible();
    await openGovernanceTab(page, "Audit");
    await expect(page.getByText("revision.recovered").first()).toBeVisible();

    // Policy profile editing: admin switches the workspace profile; the
    // audited change persists immediately.
    await page.goto("/administration?section=policy");
    await page.getByLabel("Workspace policy profile").selectOption("reviewable-approved-export");
    await page.getByRole("button", { name: "Apply policy" }).click();
    await expect(page.getByText("Workspace policy profile updated.")).toBeVisible();

    // Danger zone purge (D-5): typed-title confirm; the casefile disappears,
    // and the pre-delete export snapshot survives outside the database.
    await page.goto(`/recordings/${recordingId}`);
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
    await expect(
      page.getByRole("link", { name: "Governance bring-back record" }),
    ).toHaveCount(0);
    expect(ledgerSnapshotFiles().some((name) => name.startsWith("recording.purge-"))).toBe(true);

    // Data discipline reset (D-5): the ledger counts drop to the reset's own
    // record, and the pre-wipe export snapshot holds every cleared row.
    await page.goto("/administration?section=discipline");
    await expect(page.getByRole("heading", { name: "Data discipline" })).toBeVisible();
    await page.getByRole("button", { name: "Reset the governed ledger..." }).click();
    const resetDialog = page.getByRole("dialog", { name: "Reset the governed ledger?" });
    await expect(resetDialog).toBeVisible();
    await resetDialog.getByLabel("Type RESET REQUIRED to confirm").fill("RESET REQUIRED");
    await resetDialog.getByRole("button", { name: "Reset the ledger" }).click();
    await expect(page.getByText(/Ledger reset complete/).first()).toBeVisible();

    await expect(page.locator(".discipline-section__counts")).toContainText("Audit events");
    const counts = await page.locator(".discipline-section__counts dd").allTextContents();
    expect(counts.map((value) => value.trim())).toEqual(["0", "0", "0", "0", "1"]);
    expect(ledgerSnapshotFiles().some((name) => name.startsWith("ledger.reset-"))).toBe(true);
  });
});
