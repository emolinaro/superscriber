import { expect, test, type Page } from "@playwright/test";
import {
  actionModeIdFromUrl,
  adminUser,
  approverUser,
  auditRows,
  bootstrapAndLogin,
  buildSilentWavBuffer,
  chooseOptionByText,
  completeReasonDialog,
  ensureLocalAccount,
  enterAdminActionMode,
  firstTranscriptRow,
  login,
  openCasefile,
  outsiderUser,
  queryRuntimeRows,
  reviewerUser,
  saveEditedDraft,
  setUploadFile,
  uploaderUser,
  type LocalUser,
} from "./support/appliance";

async function submitForApproval(page: Page) {
  await page.getByRole("button", { name: "Submit for approval" }).click();
  const dialog = page.getByRole("dialog", { name: "Submit for approval" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Submit for approval" }).last().click();
}

// Uploader-role ingest lands back on the workspace with a notice (the
// status-only lane), so the recording id comes from the ledger itself.
async function uploadAsUploader(page: Page, title: string): Promise<string> {
  await login(page, uploaderUser);
  await page.goto("/ingest");
  await page.waitForLoadState("networkidle");
  await page.locator("#recording-title").click();
  await page.locator("#recording-title").pressSequentially(title);
  await expect(page.locator("#recording-title")).toHaveValue(title);
  await page.locator("#recording-language").selectOption("english");
  await setUploadFile(page, {
    name: "fixture.wav",
    mimeType: "audio/wav",
    buffer: buildSilentWavBuffer(),
  });
  await page.getByRole("button", { name: "Upload file" }).click();
  await expect(page).toHaveURL(/\/workspace\?notice=/, { timeout: 30_000 });

  for (let attempt = 0; attempt < 15; attempt += 1) {
    const rows = queryRuntimeRows<{ id: string }>(
      `select id from recordings where title = ? order by created_at desc limit 1`,
      [title],
    );
    if (rows[0]?.id) {
      return rows[0].id;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(`Recording "${title}" did not reach the ledger.`);
}

async function assignRecording(page: Page, recordingTitle: string, user: LocalUser) {
  await page.goto("/administration?section=assignments");
  await page.getByRole("button", { name: "Assign work" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign governed work" });
  await expect(dialog).toBeVisible();
  await chooseOptionByText(dialog.getByLabel("Recording", { exact: true }), recordingTitle);
  await chooseOptionByText(dialog.getByLabel("Assigned user", { exact: true }), user.displayName);
  await dialog.getByRole("button", { name: "Assign recording" }).click();
  await expect(page.getByRole("status")).toContainText("Recording assignment updated.");
}

async function waitForTranscript(page: Page) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await firstTranscriptRow(page).isVisible().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(2_000);
    await page.reload();
  }

  await expect(firstTranscriptRow(page)).toBeVisible();
}

// Admin ledger access (captain ruling): an administrator must see and manage
// every ledger item regardless of owner. The recording in this spec is
// uploaded by the uploader account - the admin neither owns it nor holds an
// assignment on it - and the pending revision is submitted by the reviewer.
test.describe.serial("admin ledger access", () => {
  test("admin sees and manages another user's recording with full audit attribution", async ({
    page,
  }) => {
    // The upload runs through the real container transcription pipeline;
    // sibling governed specs budget 240s for the same class of wait.
    test.setTimeout(240_000);

    await bootstrapAndLogin(page, adminUser);
    for (const user of [uploaderUser, reviewerUser, approverUser, outsiderUser]) {
      await ensureLocalAccount(page, user);
    }

    // Another user owns this recording: the admin never uploads it and is
    // never assigned to it.
    const recordingId = await uploadAsUploader(page, "Admin ledger access casefile");

    await login(page, adminUser);
    await assignRecording(page, "Admin ledger access casefile", reviewerUser);
    await assignRecording(page, "Admin ledger access casefile", approverUser);

    await login(page, reviewerUser);
    await openCasefile(page, recordingId);
    await waitForTranscript(page);
    await saveEditedDraft(page, "Reviewer-submitted governed text.");
    await submitForApproval(page);
    await expect(page.getByText("Pending approval").first()).toBeVisible();

    const ownerRows = queryRuntimeRows<{ uploadedByUserId: string | null }>(
      `select uploaded_by_user_id as uploadedByUserId from recordings where id = ?`,
      [recordingId],
    );
    const adminId = queryRuntimeRows<{ id: string }>(
      `select id from users where email = ?`,
      [adminUser.email],
    )[0]?.id;
    expect(adminId).toBeTruthy();
    expect(ownerRows[0]?.uploadedByUserId).toBeTruthy();
    expect(ownerRows[0]?.uploadedByUserId).not.toBe(adminId);

    // The admin sees the other user's recording in the oversight work list
    // and follows its row link into the full casefile - transcript,
    // provenance, and decisions.
    await login(page, adminUser);
    await page.goto("/workspace?tab=all");
    const rowLink = page
      .getByRole("table", { name: "Work recordings" })
      .getByRole("row", { name: new RegExp(recordingId) })
      .getByRole("link", { name: "Admin ledger access casefile" });
    await expect(rowLink).toBeVisible();
    await rowLink.click();
    await expect(page).toHaveURL(new RegExp(`/recordings/${recordingId}`));
    await expect(page.getByText("Pending approval", { exact: true }).first()).toBeVisible();
    await expect(
      firstTranscriptRow(page).getByText("Reviewer-submitted governed text."),
    ).toBeVisible();

    // Read-only oversight still fails closed: the pending revision's submitter
    // is the reviewer, so no withdraw control exists before action mode.
    await expect(page.getByRole("button", { name: "Withdraw revision" })).toHaveCount(0);

    // Both audited entry points are offered on another user's pending
    // casefile; reviewer mode is what unlocks the withdrawal below.
    await expect(page.getByRole("button", { name: "Enter approver action mode" })).toBeVisible();
    await enterAdminActionMode(
      page,
      "reviewer",
      "Return a stalled submission to draft while the reviewer is unavailable.",
    );
    const reviewerModeId = actionModeIdFromUrl(page);
    expect(reviewerModeId).toBeTruthy();

    await page.getByRole("button", { name: "Withdraw revision" }).click();
    await completeReasonDialog(page, "Submitter unavailable; returning the draft for correction.");
    await expect(page.getByText("Draft review", { exact: true }).first()).toBeVisible();

    // Manage, not just view: the admin edits the returned draft in the same
    // audited reviewer session.
    await saveEditedDraft(page, "Admin-corrected draft after governed withdrawal.");

    // Attribution: the withdrawal decision and the audit trail name the
    // acting admin, the reviewer effective role, and the action-mode session.
    const withdrawnDecision = queryRuntimeRows<{
      actorUserId: string | null;
      actorRole: string;
      effectiveRole: string | null;
      adminActionSessionId: string | null;
    }>(
      `select actor_user_id as actorUserId, actor_role as actorRole,
              effective_role as effectiveRole, admin_action_session_id as adminActionSessionId
       from approvals where recording_id = ? and state = 'withdrawn'`,
      [recordingId],
    )[0];
    expect(withdrawnDecision).toEqual(
      expect.objectContaining({
        actorUserId: adminId,
        actorRole: "admin",
        effectiveRole: "reviewer",
        adminActionSessionId: reviewerModeId,
      }),
    );

    const withdrawnAudit = auditRows(recordingId).find((row) => row.type === "revision.withdrawn");
    expect(withdrawnAudit).toEqual(
      expect.objectContaining({
        effectiveRole: "reviewer",
        adminActionSessionId: reviewerModeId,
      }),
    );
    const overrideFlag = queryRuntimeRows<{ override: number | null }>(
      `select json_extract(metadata, '$.data.submitterOverrideByAdmin') as override
       from audit_events where recording_id = ? and type = 'revision.withdrawn'`,
      [recordingId],
    )[0];
    expect(overrideFlag?.override).toBe(1);
  });
});
