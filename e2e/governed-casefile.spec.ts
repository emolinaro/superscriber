import { expect, test } from "@playwright/test";
import {
  actionModeIdFromUrl,
  adminUser,
  approverUser,
  assignmentRows,
  auditRows,
  bootstrapAndLogin,
  completeReasonDialog,
  createAndAssignUsers,
  currentRevisionLabel,
  enterAdminActionMode,
  expireActionMode,
  firstTranscriptRow,
  login,
  openAssignedCasefile,
  openAssignedDraft,
  openCasefile,
  openGovernanceTab,
  openSameDraft,
  reviewerUser,
  saveEditedDraft,
  sharedCasefile,
  uploadFixture,
} from "./support/appliance";

async function confirmDialog(page: Parameters<typeof openCasefile>[0], name: string) {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name }).last().click();
}

async function submitForApproval(page: Parameters<typeof openCasefile>[0]) {
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await confirmDialog(page, "Submit for approval");
}

async function approveRevision(page: Parameters<typeof openCasefile>[0], note = "") {
  await page.getByRole("button", { name: "Approve and complete work" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve and complete work" });
  await expect(dialog).toBeVisible();
  if (note) {
    await dialog.getByLabel("Approval note, optional").fill(note);
  }
  await dialog.getByRole("button", { name: "Approve and complete work" }).last().click();
}

test.describe.serial("governed casefile workflows", () => {
  test("moves one revision through withdrawal, changes, approval, export, and reopen", async ({
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Governed lifecycle casefile" });
    await createAndAssignUsers(page, recordingId);

    await openAssignedDraft(page, reviewerUser);
    await expect(page).toHaveURL(new RegExp(`/recordings/${recordingId}`));
    const firstRevision = await currentRevisionLabel(page);
    const editor = firstTranscriptRow(page).getByRole("textbox", { name: /Transcript for segment 1, / });
    await editor.fill("Reviewed governed transcript.");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status")).toContainText("Draft revision saved server-side.");
    await expect(editor).toBeFocused();
    await expect(await currentRevisionLabel(page)).not.toBe(firstRevision);

    await submitForApproval(page);
    await expect(page.getByText("Pending approval").first()).toBeVisible();

    await page.getByRole("button", { name: "Withdraw revision" }).click();
    await completeReasonDialog(page, "A material omission requires another review pass.");
    await expect(page.getByText("Draft review").first()).toBeVisible();

    await saveEditedDraft(page, "Resubmitted governed transcript.");
    await submitForApproval(page);
    await logoutToWorkspace(page);

    await login(page, approverUser);
    await openAssignedCasefile(page);
    await page.getByRole("button", { name: "Request changes" }).click();
    await completeReasonDialog(page, "Please restore the missing governed detail before approval.");
    await expect(page.getByText("Changes requested").first()).toBeVisible();

    await openAssignedDraft(page, reviewerUser);
    await saveEditedDraft(page, "Returned draft resubmitted after approver changes.");
    await submitForApproval(page);

    await login(page, approverUser);
    await openAssignedCasefile(page);
    await approveRevision(page, "Governed approval note.");
    await expect(page.getByText("Approved").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Export approved transcript" })).toBeVisible();
    const approvedRevision = await currentRevisionLabel(page);

    const assignments = assignmentRows(recordingId);
    expect(assignments.filter((assignment) => assignment.status === "completed")).toHaveLength(2);

    await login(page, reviewerUser);
    await page.goto("/workspace?tab=completed");
    await expect(page.getByText("Completed snapshot").first()).toBeVisible();
    await page.getByRole("link", { name: "Governed lifecycle casefile" }).first().click();
    await expect(page.getByText("Completed snapshot").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);

    await login(page, approverUser);
    await openCasefile(page, recordingId);
    await page.getByRole("button", { name: "Export approved transcript" }).click();
    const dialog = page.getByRole("dialog", { name: "Export approved transcript" });
    await expect(dialog).toBeVisible();
    for (const format of ["DOCX", "TXT", "SRT", "VTT", "CSV", "TSV", "JSON"]) {
      await expect(dialog.getByRole("button", { name: format })).toBeVisible();
    }
    expect(await page.getByTestId("export-backdrop").evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    expect(await page.locator("#app-root").getAttribute("inert")).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Export approved transcript" })).toBeFocused();

    const formats = [
      ["docx", [0x50, 0x4b]],
      ["txt", [0x54, 0x69]],
      ["srt", [0x31, 0x0a]],
      ["vtt", [0x57, 0x45]],
      ["csv", [0x22, 0x73]],
      ["tsv", [0x22, 0x73]],
      ["json", [0x7b, 0x22]],
    ] as const;
    for (const [format, expectedPrefix] of formats) {
      const response = await page.request.get(`/api/recordings/${recordingId}/transcript?format=${format}`);
      expect(response.ok()).toBeTruthy();
      const body = Buffer.from(await response.body());
      expect(Array.from(body.subarray(0, expectedPrefix.length))).toEqual(expectedPrefix);
    }

    await page.getByRole("button", { name: "Reopen as draft" }).click();
    await completeReasonDialog(page, "A new governed cycle must capture follow-up changes.");
    await expect(page).toHaveURL(/\/workspace(?:\?.*)?$/);
    await expect(
      page.getByText(
        "Casefile reopened. An administrator must assign the new review cycle.",
        { exact: true },
      ),
    ).toBeVisible();

    const reopenedAssignments = assignmentRows(recordingId);
    expect(reopenedAssignments.filter((assignment) => assignment.status === "completed")).toHaveLength(2);
    expect(reopenedAssignments.filter((assignment) => assignment.status === "active")).toHaveLength(0);

    await login(page, adminUser);
    await openCasefile(page, recordingId);
    await expect(page.getByText("Reopened", { exact: true }).first()).toBeVisible();
    await expect(await currentRevisionLabel(page)).not.toBe(approvedRevision);
    await expect(page.getByRole("button", { name: "Export approved transcript" })).toHaveCount(0);

    await page.goto("/administration?section=assignments");
    await page.getByRole("button", { name: "Assign work" }).click();
    const assignDialog = page.getByRole("dialog", { name: "Assign governed work" });
    await assignDialog.getByLabel("Recording search").fill("Governed lifecycle casefile");
    await assignDialog.getByLabel("Assigned user search").fill(reviewerUser.displayName);
    await expect(assignDialog.getByText("Current state: Actionable")).toBeVisible();
    await assignDialog.getByRole("button", { name: "Assign recording" }).click();
    await expect(page.getByRole("status")).toContainText("Recording assignment updated.");

    const reassignedAssignments = assignmentRows(recordingId);
    const completedAssignments = reassignedAssignments.filter((assignment) => assignment.status === "completed");
    const activeAssignments = reassignedAssignments.filter((assignment) => assignment.status === "active");
    expect(completedAssignments.map((assignment) => assignment.id).sort()).toEqual(
      assignments.map((assignment) => assignment.id).sort(),
    );
    expect(activeAssignments).toHaveLength(1);
    expect(activeAssignments[0]?.assignmentRole).toBe("reviewer");
    expect(activeAssignments[0]?.id).not.toBe(assignments[0]?.id);
    expect(activeAssignments[0]?.id).not.toBe(assignments[1]?.id);

    await login(page, reviewerUser);
    await openAssignedCasefile(page);
    await expect(page.getByText("Reopened", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
    await expect(
      firstTranscriptRow(page).getByRole("textbox", { name: /Transcript for segment 1, / }),
    ).toBeEditable();
  });

  test("requires audited admin action mode without implicit assignment", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Governed admin action mode" });
    await createAndAssignUsers(page, recordingId);

    await openCasefile(page, recordingId);
    await expect(page.getByRole("button", { name: "Approve and complete work" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit for approval" })).toHaveCount(0);

    await enterAdminActionMode(page, "reviewer", "Cover the assigned reviewer's documented absence.");
    await saveEditedDraft(page, "Admin reviewer mode draft.");
    await submitForApproval(page);
    await expect(page.getByLabel("Admin action mode")).toContainText("Admin action mode: Reviewer");

    const reviewerModeId = actionModeIdFromUrl(page);
    expect(reviewerModeId).toBeTruthy();
    expireActionMode(reviewerModeId!);
    await page.goto(`/recordings/${recordingId}?actionMode=${reviewerModeId}`);

    await expect(
      page
        .getByText("Pending approval", { exact: true })
        .or(page.getByText("Draft review", { exact: true }))
        .first(),
    ).toBeVisible();
    await expect(page.getByLabel("Admin action mode")).toHaveCount(0);
    await expect(page.getByText("This admin action mode expired. Enter admin action mode again.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Exit action mode" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit for approval" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve and complete work" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Request changes" })).toHaveCount(0);
    await expect(
      firstTranscriptRow(page).getByRole("textbox", { name: /Transcript for segment 1, / }),
    ).toHaveCount(0);
    await expect(firstTranscriptRow(page).getByText("Admin reviewer mode draft.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enter approver action mode" })).toHaveCount(0);

    const reviewerEntry = page.getByRole("button", { name: "Enter reviewer action mode" });
    if ((await reviewerEntry.count()) > 0) {
      await expect(reviewerEntry).toBeVisible();
    }

    const rows = auditRows(recordingId);
    expect(
      rows.some(
        (row) =>
          row.type === "admin.action_mode.entered" &&
          row.effectiveRole === "reviewer" &&
          row.adminActionSessionId === reviewerModeId,
      ),
    ).toBeTruthy();
    expect(
      rows.some(
        (row) =>
          row.type === "admin.action_mode.exited" &&
          row.adminActionSessionId === reviewerModeId &&
          row.detail === "Admin action mode expired.",
      ),
    ).toBeTruthy();
    expect(
      rows.some((row) => row.type === "admin.action_mode.entered" && row.effectiveRole === "approver"),
    ).toBeFalsy();
    expect(assignmentRows(recordingId).filter((assignment) => assignment.status === "active")).toHaveLength(2);
  });

  test("preserves local text during stale draft races and isolates completed snapshots from reopened cycles", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Governed conflict casefile" });
    await createAndAssignUsers(page, recordingId);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    await login(firstPage, reviewerUser);
    await login(secondPage, reviewerUser);
    await Promise.all([openSameDraft(firstPage), openSameDraft(secondPage)]);
    await saveEditedDraft(firstPage, "First writer text");
    await firstTranscriptRow(secondPage)
      .getByRole("textbox", { name: /Transcript for segment 1, / })
      .fill("Second writer local text");
    await secondPage.getByRole("button", { name: "Save draft" }).click();
    await expect(secondPage.getByRole("region", { name: "Revision conflict" })).toBeVisible();
    await expect(
      secondPage.getByRole("region", { name: "Transcript document" }).getByText("Second writer local text"),
    ).toBeVisible();
    await expect(secondPage.getByRole("button", { name: "Save draft" })).toHaveCount(0);
    await expect(secondPage.getByRole("button", { name: "Submit for approval" })).toHaveCount(0);
    await firstContext.close();
    await secondContext.close();

    await openAssignedDraft(page, reviewerUser);
    await saveEditedDraft(page, "Approved snapshot source text.");
    await submitForApproval(page);
    await login(page, approverUser);
    await openAssignedCasefile(page);
    await approveRevision(page);

    await login(page, reviewerUser);
    await page.goto("/workspace?tab=completed");
    await page
      .getByRole("table", { name: "Work recordings" })
      .getByRole("link", { name: "Governed conflict casefile" })
      .click();
    await expect(page.getByText("Approved snapshot source text.")).toBeVisible();

    await login(page, approverUser);
    await openCasefile(page, recordingId);
    await page.getByRole("button", { name: "Reopen as draft" }).click();
    await completeReasonDialog(page, "Governed reopening creates a new active cycle.");

    await login(page, reviewerUser);
    await page.goto("/workspace?tab=completed");
    await page
      .getByRole("table", { name: "Work recordings" })
      .getByRole("link", { name: "Governed conflict casefile" })
      .click();
    await expect(page.getByText("Historical snapshot")).toBeVisible();
    await expect(page.getByText("Approved snapshot source text.")).toBeVisible();
  });
});

async function logoutToWorkspace(page: Parameters<typeof openCasefile>[0]) {
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/reason=logged-out/);
}
