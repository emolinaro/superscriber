import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasefileCommandError } from "@/server/casefile/errors";

const {
  getActivePrincipalMock,
  getActiveSessionMock,
  hasAnyActiveAdminMock,
  createRecoveryAdminMock,
  recordSecurityEventMock,
  loadAuthConfigMock,
  ensureAdminClaimTokenMock,
  cookiesMock,
  saveDraftCommandMock,
  submitRevisionCommandMock,
  withdrawRevisionCommandMock,
  requestChangesCommandMock,
  approveRevisionCommandMock,
  reopenRevisionCommandMock,
  getCasefileMock,
  createLocalUserMock,
  assignRecordingToUserMock,
  removeRecordingAssignmentMock,
  changeAccountRoleMock,
  enterActionModeMock,
  exitActionModeMock,
  hasAnyUsersMock,
  createBootstrapAdminMock,
  revalidatePathMock,
  adminIssuePasswordResetMock,
  sendPasswordResetEmailMock,
  headersMock,
  deleteRecordingPermanentlyMock,
} = vi.hoisted(() => ({
  getActivePrincipalMock: vi.fn(),
  getActiveSessionMock: vi.fn(),
  saveDraftCommandMock: vi.fn(),
  submitRevisionCommandMock: vi.fn(),
  withdrawRevisionCommandMock: vi.fn(),
  requestChangesCommandMock: vi.fn(),
  approveRevisionCommandMock: vi.fn(),
  reopenRevisionCommandMock: vi.fn(),
  getCasefileMock: vi.fn(),
  createLocalUserMock: vi.fn(),
  assignRecordingToUserMock: vi.fn(),
  removeRecordingAssignmentMock: vi.fn(),
  changeAccountRoleMock: vi.fn(),
  enterActionModeMock: vi.fn(),
  exitActionModeMock: vi.fn(),
  hasAnyUsersMock: vi.fn(),
  hasAnyActiveAdminMock: vi.fn(),
  createBootstrapAdminMock: vi.fn(),
  createRecoveryAdminMock: vi.fn(),
  recordSecurityEventMock: vi.fn(),
  loadAuthConfigMock: vi.fn(() => ({ mode: "local" })),
  ensureAdminClaimTokenMock: vi.fn(),
  cookiesMock: vi.fn(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() })),
  revalidatePathMock: vi.fn(),
  adminIssuePasswordResetMock: vi.fn(),
  sendPasswordResetEmailMock: vi.fn(),
  headersMock: vi.fn(() => new Map([["origin", "https://app.test"]])),
  deleteRecordingPermanentlyMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: headersMock,
  cookies: cookiesMock,
}));

vi.mock("@/server/administration/password-reset-service", () => {
  class AdminPasswordResetServiceError extends Error {
    constructor(readonly failure: { code: string; message: string }) {
      super(failure.message);
    }
  }
  return {
    adminIssuePasswordReset: adminIssuePasswordResetMock,
    AdminPasswordResetServiceError,
  };
});

vi.mock("@/server/auth/reset-mailer", () => ({
  sendPasswordResetEmail: sendPasswordResetEmailMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  getActivePrincipal: getActivePrincipalMock,
  getActiveSession: getActiveSessionMock,
}));

vi.mock("@/server/casefile/commands", () => ({
  saveDraftCommand: saveDraftCommandMock,
  submitRevisionCommand: submitRevisionCommandMock,
  withdrawRevisionCommand: withdrawRevisionCommandMock,
  requestChangesCommand: requestChangesCommandMock,
  approveRevisionCommand: approveRevisionCommandMock,
  reopenRevisionCommand: reopenRevisionCommandMock,
}));

vi.mock("@/server/casefile/read-model", () => ({
  getCasefile: getCasefileMock,
}));

vi.mock("@/server/auth/service", () => ({
  hasAnyUsers: hasAnyUsersMock,
  hasAnyActiveAdmin: hasAnyActiveAdminMock,
  createBootstrapAdmin: createBootstrapAdminMock,
  createLocalUser: createLocalUserMock,
}));

vi.mock("@/server/auth/recovery-claim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/recovery-claim")>()),
  createRecoveryAdmin: createRecoveryAdminMock,
  ensureAdminClaimToken: ensureAdminClaimTokenMock,
}));

vi.mock("@/server/auth/security-events", () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

vi.mock("@/server/auth/auth-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/auth-config")>()),
  loadAuthConfig: loadAuthConfigMock,
}));

vi.mock("@/server/access/service", () => ({
  assignRecordingToUser: assignRecordingToUserMock,
  removeRecordingAssignment: removeRecordingAssignmentMock,
}));

vi.mock("@/server/administration/account-role-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/administration/account-role-service")
  >()),
  changeAccountRole: changeAccountRoleMock,
}));

vi.mock("@/server/administration/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/administration/service")>()),
  deleteRecordingPermanently: deleteRecordingPermanentlyMock,
}));

vi.mock("@/server/casefile/action-mode", () => ({
  enterActionMode: enterActionModeMock,
  exitActionMode: exitActionModeMock,
}));

import { EMPTY_BOOTSTRAP_FORM_STATE } from "@/lib/auth-forms";
import {
  approveRevisionAction,
  requestChangesAction,
  reopenRevisionAction,
  saveDraftAction,
  submitRevisionAction,
  withdrawRevisionAction,
} from "@/server/actions/casefile-actions";
import {
  adminResetAccountPasswordAction,
  assignRecordingAction,
  changeAccountRoleAction,
  createUserAction,
  deleteRecordingAction,
  resetLedgerAction,
  unassignRecordingAction,
  updateWorkspacePolicyAction,
} from "@/server/actions/administration-actions";
import { AccountRoleChangeServiceError } from "@/server/administration/account-role-service";
import {
  enterAdminActionModeAction,
  exitAdminActionModeAction,
} from "@/server/actions/admin-action-mode-actions";
import {
  claimRecoveryAdminAction,
  createBootstrapAdminAction,
} from "@/server/actions/auth-actions";
import { EMPTY_RECOVERY_CLAIM_FORM_STATE } from "@/lib/auth-forms";
import { recoveryClaimLimiter } from "@/server/auth/recovery-claim";

const principal = {
  userId: "user-1",
  email: "reviewer@example.com",
  displayName: "Reviewer",
  role: "reviewer",
} as const;

const adminPrincipal = {
  userId: "admin-1",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
} as const;

const adminActiveSession = {
  user: adminPrincipal,
  expiresAt: "2099-01-01T00:00:00.000Z",
  authSessionId: "auth-session-admin-1",
} as const;

const casefile = {
  recordingId: "rec-1",
  stage: "draft_review",
  revision: {
    id: "rev-2",
    version: 2,
  },
};

const draftInput = {
  recordingId: "rec-1",
  expectedCurrentRevisionId: "rev-1",
  segments: [
    {
      id: "seg-1",
      speakerLabel: "Speaker 1",
      startMs: 0,
      endMs: 1000,
      text: "Hello world.",
      confidence: 0.9,
    },
  ],
  summary: "Updated transcript draft.",
  actionModeId: null,
};

const pendingInput = {
  recordingId: "rec-1",
  expectedPendingRevisionId: "rev-2",
  reason: "Need another pass before approval.",
  actionModeId: null,
};

const approveInput = {
  recordingId: "rec-1",
  expectedPendingRevisionId: "rev-2",
  note: "Looks good.",
  actionModeId: "mode-1",
};

const reopenInput = {
  recordingId: "rec-1",
  expectedApprovedRevisionId: "rev-3",
  reason: "A newly discovered issue needs correction.",
  actionModeId: null,
};

const staleSnapshot = {
  recordingId: "rec-1",
  loadedRevisionId: "rev-1",
  currentRevisionId: "rev-2",
  pendingRevisionId: null,
  approvedRevisionId: null,
  updatedAt: "2026-08-01T12:34:56.000Z",
  winningStage: "draft_review",
} as const;

function expectUnknownFailure(result: Awaited<ReturnType<typeof requestChangesAction>>) {
  expect(result).toMatchObject({
    ok: false,
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Try again.",
  });

  if (result.ok) {
    throw new Error("Expected an error result.");
  }

  expect(result.correlationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(result.message).not.toContain("sqlite");
}

describe("typed governed actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivePrincipalMock.mockResolvedValue(principal);
    getCasefileMock.mockReturnValue(casefile);
  });

  it("maps missing sessions without redirecting or losing client state", async () => {
    getActivePrincipalMock.mockResolvedValue(null);

    await expect(saveDraftAction(draftInput)).resolves.toEqual({
      ok: false,
      code: "AUTH_EXPIRED",
      message: "Session expired. Sign in again to continue.",
    });
  });

  it("returns validation field errors in place", async () => {
    saveDraftCommandMock.mockImplementation(() => {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "Review the highlighted fields and try again.",
        { segments: "Draft saves must include the full current segment array without structural changes." },
      );
    });

    await expect(saveDraftAction(draftInput)).resolves.toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Review the highlighted fields and try again.",
      fieldErrors: {
        segments:
          "Draft saves must include the full current segment array without structural changes.",
      },
    });
  });

  it("returns stale conflict snapshots for in-place refresh", async () => {
    submitRevisionCommandMock.mockImplementation(() => {
      throw new CasefileCommandError(
        "STALE_REVISION",
        "This recording changed since you opened it.",
        undefined,
        staleSnapshot,
      );
    });

    await expect(
      submitRevisionAction({
        ...draftInput,
        hasUnsavedChanges: true,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "STALE_REVISION",
      message: "This recording changed since you opened it.",
      latest: staleSnapshot,
    });
  });

  it("maps state changes, policy denials, action-mode expiry, and self-approval", async () => {
    approveRevisionCommandMock.mockImplementationOnce(() => {
      throw new CasefileCommandError(
        "STATE_CHANGED",
        "This pending revision already transitioned. Reload this recording and try again.",
        undefined,
        staleSnapshot,
      );
    });
    requestChangesCommandMock.mockImplementationOnce(() => {
      throw new CasefileCommandError(
        "ACCESS_DENIED",
        "Your account cannot approve transcripts.",
      );
    });
    approveRevisionCommandMock.mockImplementationOnce(() => {
      throw new CasefileCommandError(
        "ACTION_MODE_EXPIRED",
        "This admin action mode expired. Enter admin action mode again.",
      );
    });
    requestChangesCommandMock.mockImplementationOnce(() => {
      throw new CasefileCommandError(
        "SELF_APPROVAL_FORBIDDEN",
        "Submitters cannot approve or request changes on their own revisions.",
      );
    });

    await expect(approveRevisionAction(approveInput)).resolves.toEqual({
      ok: false,
      code: "STATE_CHANGED",
      message:
        "This pending revision already transitioned. Reload this recording and try again.",
      latest: staleSnapshot,
    });

    await expect(requestChangesAction(pendingInput)).resolves.toEqual({
      ok: false,
      code: "ACCESS_DENIED",
      message: "Your account cannot approve transcripts.",
    });

    await expect(approveRevisionAction(approveInput)).resolves.toEqual({
      ok: false,
      code: "ACTION_MODE_EXPIRED",
      message: "This admin action mode expired. Enter admin action mode again.",
    });

    await expect(requestChangesAction(pendingInput)).resolves.toEqual({
      ok: false,
      code: "SELF_APPROVAL_FORBIDDEN",
      message: "Submitters cannot approve or request changes on their own revisions.",
    });
  });

  it("returns safe unknown correlation ids", async () => {
    requestChangesCommandMock.mockImplementation(() => {
      throw new Error("sqlite busy while writing transcript decision");
    });

    expectUnknownFailure(await requestChangesAction(pendingInput));
  });

  it("returns retain focus for draft saves", async () => {
    saveDraftCommandMock.mockReturnValue({ id: "rev-2" });

    await expect(saveDraftAction(draftInput)).resolves.toEqual({
      ok: true,
      notice: "Draft revision saved server-side.",
      data: {
        casefile,
        nextPath: "/recordings/rec-1",
        focusTarget: "retain",
      },
    });
  });

  it("returns case-state focus for state changes", async () => {
    submitRevisionCommandMock.mockReturnValue({ id: "rev-2" });
    withdrawRevisionCommandMock.mockReturnValue({ id: "rev-3" });
    requestChangesCommandMock.mockReturnValue({ id: "rev-4" });
    approveRevisionCommandMock.mockReturnValue({
      revision: { id: "rev-2" },
      completedAssignments: [],
    });

    await expect(
      submitRevisionAction({
        ...draftInput,
        hasUnsavedChanges: false,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        focusTarget: "case-state",
      },
    });

    await expect(withdrawRevisionAction(pendingInput)).resolves.toMatchObject({
      ok: true,
      data: {
        focusTarget: "case-state",
      },
    });

    await expect(requestChangesAction(pendingInput)).resolves.toMatchObject({
      ok: true,
      data: {
        focusTarget: "case-state",
      },
    });

    await expect(approveRevisionAction(approveInput)).resolves.toMatchObject({
      ok: true,
      data: {
        focusTarget: "case-state",
      },
    });
  });

  it("returns the workspace reassignment notice when a completed approver reopens and loses current access", async () => {
    reopenRevisionCommandMock.mockReturnValue({ id: "rev-4" });
    getCasefileMock.mockImplementation(() => {
      throw new CasefileCommandError(
        "ACCESS_DENIED",
        "This casefile is not available to your account.",
      );
    });

    await expect(reopenRevisionAction(reopenInput)).resolves.toEqual({
      ok: true,
      notice: "Casefile reopened. An administrator must assign the new review cycle.",
      data: {
        casefile: null,
        nextPath: "/workspace",
        focusTarget: "case-state",
      },
    });

    expect(revalidatePathMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/workspace");
    expect(revalidatePathMock).not.toHaveBeenCalledWith("/recordings/rec-1");
  });

  it("keeps the in-place reopen notice when an admin still has casefile access", async () => {
    getActivePrincipalMock.mockResolvedValue(adminPrincipal);
    reopenRevisionCommandMock.mockReturnValue({ id: "rev-4" });

    await expect(
      reopenRevisionAction({
        ...reopenInput,
        actionModeId: "mode-1",
      }),
    ).resolves.toEqual({
      ok: true,
      notice: "Approved transcript reopened as a new draft cycle.",
      data: {
        casefile,
        nextPath: "/recordings/rec-1",
        focusTarget: "case-state",
      },
    });

    expect(revalidatePathMock).toHaveBeenNthCalledWith(1, "/workspace");
    expect(revalidatePathMock).toHaveBeenNthCalledWith(2, "/recordings/rec-1");
  });
});

describe("typed administration actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivePrincipalMock.mockResolvedValue(adminPrincipal);
    getActiveSessionMock.mockResolvedValue(adminActiveSession);
  });

  it("creates accounts without redirect query strings", async () => {
    createLocalUserMock.mockResolvedValue({
      id: "user-2",
      displayName: "Reviewer 2",
      email: "reviewer2@example.com",
      role: "reviewer",
      isActive: true,
      createdAt: "2026-08-01T12:10:00.000Z",
      updatedAt: "2026-08-01T12:10:00.000Z",
    });

    await expect(
      createUserAction({
        displayName: "Reviewer 2",
        email: "reviewer2@example.com",
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
        role: "reviewer",
      }),
    ).resolves.toEqual({
      ok: true,
      notice: "Reviewer 2 can now sign in as reviewer.",
      data: {
        href: "/administration?section=accounts",
        userId: "user-2",
        user: {
          id: "user-2",
          displayName: "Reviewer 2",
          email: "reviewer2@example.com",
          role: "reviewer",
          isActive: true,
          createdAt: "2026-08-01T12:10:00.000Z",
          updatedAt: "2026-08-01T12:10:00.000Z",
          activeAssignmentCount: 0,
        },
      },
    });
  });

  it("rejects a password confirmation mismatch before any account work", async () => {
    const result = await createUserAction({
      displayName: "Reviewer 2",
      email: "reviewer2@example.com",
      password: "correct horse battery staple",
      confirmPassword: "different horse battery staple",
      role: "reviewer",
    });

    expect(result).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Review the highlighted fields and try again.",
      fieldErrors: { confirmPassword: "Passwords must match." },
    });
    expect(createLocalUserMock).not.toHaveBeenCalled();
  });

  it("never forwards the password confirmation to account creation", async () => {
    createLocalUserMock.mockResolvedValue({
      id: "user-2",
      displayName: "Reviewer 2",
      email: "reviewer2@example.com",
      role: "reviewer",
      isActive: true,
      createdAt: "2026-08-01T12:10:00.000Z",
      updatedAt: "2026-08-01T12:10:00.000Z",
    });

    await createUserAction({
      displayName: "Reviewer 2",
      email: "reviewer2@example.com",
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
      role: "reviewer",
    });

    expect(createLocalUserMock).toHaveBeenCalledWith({
      displayName: "Reviewer 2",
      email: "reviewer2@example.com",
      password: "correct horse battery staple",
      role: "reviewer",
    });
  });

  it("keeps the destructive governance controls behind an admin gate (demo-governance-bringback)", async () => {
    // Reviewer-held sessions cannot reach the wipe, the purge, or the policy
    // switch; the typed confirmations alone are not a boundary.
    const reviewer = { ...adminPrincipal, role: "reviewer" } as unknown as typeof adminPrincipal;
    getActivePrincipalMock.mockResolvedValue(reviewer);

    for (const attempt of [
      () => resetLedgerAction({ expectedPhrase: "RESET REQUIRED" }),
      () => deleteRecordingAction({ recordingId: "rec-1", expectedTitle: "x" }),
      () => updateWorkspacePolicyAction({ profileId: "reviewable-approved-export" }),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ACCESS_DENIED");
      }
    }
  });

  it("returns the workspace destination after a permanent recording deletion", async () => {
    getActivePrincipalMock.mockResolvedValue(adminPrincipal);
    deleteRecordingPermanentlyMock.mockReturnValue({
      title: "Quarterly Review",
      revisionCount: 1,
    });

    await expect(
      deleteRecordingAction({
        recordingId: "rec-1",
        expectedTitle: "Quarterly Review",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { href: "/workspace", userId: "admin-1" },
      notice: 'Permanently deleted "Quarterly Review" and 1 revision; the ledger retains one deletion record and the pre-delete export snapshot.',
    });
  });

  it("updates assignments without redirects", async () => {
    assignRecordingToUserMock.mockReturnValue({
      assignment: { id: "assign-1" },
      alreadyActive: false,
    });
    removeRecordingAssignmentMock.mockReturnValue({ id: "assign-1" });

    await expect(
      assignRecordingAction({
        recordingId: "rec-1",
        userId: "user-2",
      }),
    ).resolves.toEqual({
      ok: true,
      notice: "Recording assignment updated.",
      data: {
        href: "/administration?section=assignments",
        assignmentId: "assign-1",
        alreadyActive: false,
      },
    });

    await expect(
      unassignRecordingAction({
        assignmentId: "assign-1",
      }),
    ).resolves.toEqual({
      ok: true,
      notice: "Recording assignment removed.",
      data: {
        href: "/administration?section=assignments",
        assignmentId: "assign-1",
      },
    });
  });

  it("changes a role using the live actor session and returns forced re-login copy", async () => {
    changeAccountRoleMock.mockReturnValue({
      user: {
        id: "user-2",
        displayName: "Reviewer 2",
        email: "reviewer2@example.com",
        role: "approver",
        isActive: true,
        createdAt: "2026-08-01T12:10:00.000Z",
        updatedAt: "2026-08-01T12:20:00.000Z",
        activeAssignmentCount: 0,
      },
      oldRole: "reviewer",
      newRole: "approver",
      revokedSessionCount: 2,
      actorMustRelogin: false,
      resultingAuthVersion: 2,
    });

    await expect(
      changeAccountRoleAction({
        userId: "user-2",
        expectedRole: "reviewer",
        newRole: "approver",
        reason: "  Duties changed for coverage.  ",
      }),
    ).resolves.toEqual({
      ok: true,
      notice:
        "Reviewer 2's role changed from Reviewer to Approver. Active sessions were revoked; they must sign in again.",
      data: expect.objectContaining({
        oldRole: "reviewer",
        newRole: "approver",
        actorMustRelogin: false,
      }),
    });
    expect(changeAccountRoleMock).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      actorAuthSessionId: "auth-session-admin-1",
      input: {
        userId: "user-2",
        expectedRole: "reviewer",
        newRole: "approver",
        reason: "Duties changed for coverage.",
      },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/administration");
    expect(revalidatePathMock).toHaveBeenCalledWith("/workspace");
  });

  it("rejects expired and malformed requests before service invocation", async () => {
    getActiveSessionMock.mockResolvedValueOnce(null);
    await expect(
      changeAccountRoleAction({
        userId: "user-2",
        expectedRole: "reviewer",
        newRole: "approver",
        reason: "Duties changed for coverage.",
      }),
    ).resolves.toEqual({
      ok: false,
      code: "AUTH_EXPIRED",
      message: "Session expired. Sign in again to continue.",
    });

    getActiveSessionMock.mockResolvedValue(adminActiveSession);
    await expect(
      changeAccountRoleAction({
        userId: "user-2",
        expectedRole: "reviewer",
        newRole: "reviewer",
        reason: "short",
        actorRole: "admin",
      } as never),
    ).resolves.toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(changeAccountRoleMock).not.toHaveBeenCalled();
  });

  it("preserves typed role failures and their recovery payload", async () => {
    changeAccountRoleMock.mockImplementation(() => {
      throw new AccountRoleChangeServiceError({
        code: "ASSIGNMENTS_INCOMPATIBLE",
        message: "Remove the listed active assignments before changing this account to Admin.",
        assignmentBlockers: {
          total: 1,
          byRole: [
            { role: "reviewer", count: 1, recordingTitles: ["Record one"] },
          ],
          managementHref:
            "/administration?section=assignments&status=active&userId=user-2",
        },
      });
    });

    await expect(
      changeAccountRoleAction({
        userId: "user-2",
        expectedRole: "reviewer",
        newRole: "admin",
        reason: "Duties changed for coverage.",
      }),
    ).resolves.toEqual({
      ok: false,
      code: "ASSIGNMENTS_INCOMPATIBLE",
      message: "Remove the listed active assignments before changing this account to Admin.",
      assignmentBlockers: {
        total: 1,
        byRole: [
          { role: "reviewer", count: 1, recordingTitles: ["Record one"] },
        ],
        managementHref:
          "/administration?section=assignments&status=active&userId=user-2",
      },
    });
  });

  it("keeps a committed success when either cache revalidation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    changeAccountRoleMock.mockReturnValue({
      user: {
        id: "admin-1",
        displayName: "Admin",
        email: "admin@example.com",
        role: "reviewer",
        isActive: true,
        createdAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:20:00.000Z",
        activeAssignmentCount: 0,
      },
      oldRole: "admin",
      newRole: "reviewer",
      revokedSessionCount: 1,
      actorMustRelogin: true,
      resultingAuthVersion: 2,
    });
    revalidatePathMock.mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });

    await expect(
      changeAccountRoleAction({
        userId: "admin-1",
        expectedRole: "admin",
        newRole: "reviewer",
        reason: "Self duties changed safely.",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { actorMustRelogin: true },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/administration");
    expect(revalidatePathMock).toHaveBeenCalledWith("/workspace");
    expect(consoleError).toHaveBeenCalledWith(
      "account role change committed but cache revalidation failed",
      expect.objectContaining({ targetUserId: "admin-1" }),
    );
  });

  it("maps raw failures to correlation-only internal errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    changeAccountRoleMock.mockImplementation(() => {
      throw new Error("SQLITE path /secret/database failed");
    });

    const result = await changeAccountRoleAction({
      userId: "user-2",
      expectedRole: "reviewer",
      newRole: "approver",
      reason: "Duties changed for coverage.",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The role change could not be confirmed. Refresh the account list before trying again.",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(result)).not.toContain("SQLITE");
    expect(consoleError).toHaveBeenCalledWith(
      "account role change action failed",
      expect.objectContaining({ actorUserId: "admin-1", targetUserId: "user-2" }),
    );
  });

  it("surfaces forged assignment compatibility denials without redirecting", async () => {
    assignRecordingToUserMock.mockImplementation(() => {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "Review work cannot be assigned until ingest recovers.",
      );
    });

    await expect(
      assignRecordingAction({
        recordingId: "rec-failed",
        userId: "user-2",
      }),
    ).resolves.toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Review work cannot be assigned until ingest recovers.",
    });
  });
});

describe("typed admin action mode actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivePrincipalMock.mockResolvedValue(adminPrincipal);
  });

  it("returns the validated session and in-place href when entering action mode", async () => {
    const session = {
      id: "mode-1",
      recordingId: "rec-1",
      effectiveRole: "approver",
      purpose: "Approve a governed transcript after escalation.",
      startedAt: "2026-08-01T12:00:00.000Z",
      expiresAt: "2026-08-01T12:30:00.000Z",
      adminUserId: "admin-1",
      adminDisplayName: "Admin",
      baseRole: "admin",
      endedAt: null,
      endReason: null,
    };
    enterActionModeMock.mockReturnValue(session);

    await expect(
      enterAdminActionModeAction({
        recordingId: "rec-1",
        effectiveRole: "approver",
        purpose: "Approve a governed transcript after escalation.",
      }),
    ).resolves.toEqual({
      ok: true,
      notice: "Admin action mode entered as approver.",
      data: {
        session,
        href: "/recordings/rec-1?actionMode=mode-1",
      },
    });
  });

  it("returns oversight href when exiting action mode", async () => {
    exitActionModeMock.mockReturnValue({ id: "mode-1" });

    await expect(
      exitAdminActionModeAction({
        recordingId: "rec-1",
        actionModeId: "mode-1",
      }),
    ).resolves.toEqual({
      ok: true,
      notice: "Admin action mode exited.",
      data: {
        href: "/recordings/rec-1",
      },
    });
  });
});

describe("bootstrap auth action", () => {
  let tempRoot = "";
  const originalDatabasePath = process.env.SUPERSCRIBER_DB_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-auth-actions-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.SUPERSCRIBER_DB_PATH = originalDatabasePath;
  });

  it("keeps the existing useActionState error shape", async () => {
    hasAnyUsersMock.mockResolvedValue(true);

    const formData = new FormData();
    formData.set("displayName", "Admin");
    formData.set("email", "admin@example.com");
    formData.set("password", "correct horse battery staple");
    formData.set("confirmPassword", "correct horse battery staple");

    await expect(
      createBootstrapAdminAction(EMPTY_BOOTSTRAP_FORM_STATE, formData),
    ).resolves.toEqual({
      formError:
        "First-run setup is already complete. Sign in with an existing account.",
      values: {
        displayName: "Admin",
        email: "admin@example.com",
      },
    });
  });
});

describe("admin recovery claim action", () => {
  let tempRoot = "";
  const originalDatabasePath = process.env.SUPERSCRIBER_DB_PATH;
  const originalManagementNetworksPath = process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE;

  function claimFormData(overrides: Record<string, string> = {}) {
    const formData = new FormData();
    formData.set("displayName", "Recovery Admin");
    formData.set("email", "recovery@example.com");
    formData.set("password", "correct horse battery staple");
    formData.set("confirmPassword", "correct horse battery staple");
    formData.set("claimToken", "0123456789abcdef0123456789abcdef");
    for (const [key, value] of Object.entries(overrides)) {
      formData.set(key, value);
    }
    return formData;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    recoveryClaimLimiter.reset();
    loadAuthConfigMock.mockImplementation(() => ({ mode: "local" }));
    headersMock.mockImplementation(() => new Map([["origin", "https://app.test"]]));
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-recovery-actions-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");
    delete process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE;
    hasAnyUsersMock.mockResolvedValue(true);
    hasAnyActiveAdminMock.mockResolvedValue(false);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.SUPERSCRIBER_DB_PATH = originalDatabasePath;
    if (originalManagementNetworksPath === undefined) {
      delete process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE;
    } else {
      process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE = originalManagementNetworksPath;
    }
  });

  it("refuses the claim while an active administrator still exists", async () => {
    hasAnyActiveAdminMock.mockResolvedValue(true);

    await expect(
      claimRecoveryAdminAction(EMPTY_RECOVERY_CLAIM_FORM_STATE, claimFormData()),
    ).resolves.toEqual({
      formError: "An active administrator already exists. Sign in with an existing account.",
      values: { displayName: "Recovery Admin", email: "recovery@example.com" },
    });
    expect(createRecoveryAdminMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("active administrator"),
      }),
    );
  });

  it("steers zero-account appliances back to first-run setup", async () => {
    hasAnyUsersMock.mockResolvedValue(false);

    await expect(
      claimRecoveryAdminAction(EMPTY_RECOVERY_CLAIM_FORM_STATE, claimFormData()),
    ).resolves.toEqual({
      formError:
        "No accounts exist on this appliance. Use first-run setup to create the first administrator.",
      values: { displayName: "Recovery Admin", email: "recovery@example.com" },
    });
    expect(createRecoveryAdminMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("no existing accounts"),
      }),
    );
  });

  it("withholds the claim under authentik-primary, where a local admin could not sign in", async () => {
    loadAuthConfigMock.mockImplementation(() => ({ mode: "authentik-primary" }));

    const result = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData(),
    );

    expect(result.formError).toContain("institutional sign-in");
    expect(createRecoveryAdminMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("local claims unavailable"),
      }),
    );
  });

  it("maps schema violations onto field errors and records a redacted denial", async () => {
    const result = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData({ password: "short", confirmPassword: "different" }),
    );

    expect(result.formError).toBe("Review the highlighted fields and try again.");
    expect(result.fieldErrors?.password).toBe("Use at least 10 characters.");
    expect(result.fieldErrors?.confirmPassword).toBe("Passwords must match.");
    expect(createRecoveryAdminMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("form validation"),
      }),
    );
    expect(JSON.stringify(recordSecurityEventMock.mock.calls)).not.toContain(
      "0123456789abcdef",
    );
  });

  it("charges malformed submissions to one shared bucket when client identity is untrusted", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      headersMock.mockImplementationOnce(
        () => new Map([["x-forwarded-for", `203.0.113.${attempt + 1}`]]),
      );
      const result = await claimRecoveryAdminAction(
        EMPTY_RECOVERY_CLAIM_FORM_STATE,
        claimFormData({ claimToken: "" }),
      );
      expect(result.formError).toBe("Review the highlighted fields and try again.");
    }

    headersMock.mockImplementationOnce(
      () => new Map([["x-forwarded-for", "198.51.100.44"]]),
    );
    const lockedOut = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData(),
    );

    expect(lockedOut.formError).toBe(
      "Too many administrator claim attempts. Wait a few minutes and try again.",
    );
    expect(createRecoveryAdminMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledTimes(6);
  });

  it("audits and generically refuses an invalid claim token", async () => {
    const { RecoveryClaimError } = await import("@/server/auth/recovery-claim");
    createRecoveryAdminMock.mockRejectedValue(
      new RecoveryClaimError("claim_token_invalid", "nope"),
    );

    const result = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData(),
    );

    expect(result.formError).toBe(
      "The administrator claim was not accepted. Check the operator claim token and try again.",
    );
    expect(result.fieldErrors?.claimToken).toBe(
      "The claim token did not match the proof on the appliance host.",
    );
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: "Recovery administrator claim refused.",
      }),
    );
    // The recorded event never carries the attempted token.
    const recorded = recordSecurityEventMock.mock.calls[0]![0] as {
      detail?: string;
      metadata?: Record<string, unknown>;
    };
    expect(JSON.stringify(recorded)).not.toContain("0123456789abcdef");
  });

  it("locks out claim attempts after the brute-force budget is spent", async () => {
    const { RecoveryClaimError } = await import("@/server/auth/recovery-claim");
    createRecoveryAdminMock.mockRejectedValue(
      new RecoveryClaimError("claim_token_invalid", "nope"),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await claimRecoveryAdminAction(
        EMPTY_RECOVERY_CLAIM_FORM_STATE,
        claimFormData(),
      );
      expect(result.formError).toContain("not accepted");
    }
    expect(createRecoveryAdminMock).toHaveBeenCalledTimes(5);

    const lockedOut = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData(),
    );
    expect(lockedOut.formError).toBe(
      "Too many administrator claim attempts. Wait a few minutes and try again.",
    );
    expect(createRecoveryAdminMock).toHaveBeenCalledTimes(5);
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("rate limit"),
      }),
    );
  });

  it("maps a taken email onto the email field error", async () => {
    const { RecoveryClaimError } = await import("@/server/auth/recovery-claim");
    createRecoveryAdminMock.mockRejectedValue(
      new RecoveryClaimError("email_taken", "An account with that email already exists."),
    );

    const result = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData(),
    );

    expect(result.formError).toBe("Review the highlighted fields and try again.");
    expect(result.fieldErrors?.email).toBe("An account with that email already exists.");
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("email unavailable"),
      }),
    );
  });

  it.each([
    ["admin_exists", "An active administrator already exists."],
    ["requires_existing_users", "Existing accounts are required."],
  ] as const)("audits a redacted %s transaction-race denial", async (code, message) => {
    const { RecoveryClaimError } = await import("@/server/auth/recovery-claim");
    createRecoveryAdminMock.mockRejectedValue(new RecoveryClaimError(code, message));

    const result = await claimRecoveryAdminAction(
      EMPTY_RECOVERY_CLAIM_FORM_STATE,
      claimFormData(),
    );

    expect(result.formError).toBe(message);
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.recovery_claim",
        outcome: "denied",
        detail: expect.stringContaining("state changed"),
      }),
    );
  });

  it("delegates the transactional success audit and redirects to sign-in", async () => {
    createRecoveryAdminMock.mockResolvedValue({
      id: "user-recovery-1",
      email: "recovery@example.com",
      displayName: "Recovery Admin",
      role: "admin",
      isActive: true,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    const { redirect: redirectMock } = await import("next/navigation");

    await claimRecoveryAdminAction(EMPTY_RECOVERY_CLAIM_FORM_STATE, claimFormData());

    expect(createRecoveryAdminMock).toHaveBeenCalledWith({
      displayName: "Recovery Admin",
      email: "recovery@example.com",
      password: "correct horse battery staple",
      claimToken: "0123456789abcdef0123456789abcdef",
      sourceZone: "public",
    });
    expect(recordSecurityEventMock).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/?notice=admin-recovery-complete");
  });
});

describe("adminResetAccountPasswordAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveSessionMock.mockResolvedValue(adminActiveSession);
  });

  it("returns AUTH_EXPIRED without a live session", async () => {
    getActiveSessionMock.mockResolvedValue(null);
    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "admin-1",
      userId: "user-2",
      reason: "User forgot their password at the front desk.",
      delivery: "operator_handoff",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("AUTH_EXPIRED");
    expect(adminIssuePasswordResetMock).not.toHaveBeenCalled();
  });

  it("validates the reason before touching the service", async () => {
    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "admin-1",
      userId: "user-2",
      reason: "short",
      delivery: "operator_handoff",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("VALIDATION_ERROR");
    expect(adminIssuePasswordResetMock).not.toHaveBeenCalled();
  });

  it("rejects a changed actor before reset issuance", async () => {
    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "previous-admin",
      userId: "user-2",
      reason: "User forgot their password at the front desk.",
      delivery: "operator_handoff",
    });

    expect(result).toEqual({
      ok: false,
      code: "AUTH_EXPIRED",
      message: "Your signed-in account changed. Refresh and try again.",
    });
    expect(adminIssuePasswordResetMock).not.toHaveBeenCalled();
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
  });

  it("returns the one-time reveal URL for handoff delivery", async () => {
    adminIssuePasswordResetMock.mockReturnValue({
      userId: "user-2",
      targetDisplayName: "Reviewer One",
      targetEmail: "reviewer1@example.com",
      rawToken: "raw-token-value",
      recordId: "record-1",
      expiresAt: "2026-08-10T13:00:00.000Z",
      delivery: "operator_handoff",
      revokedSessionCount: 2,
      resultingAuthVersion: 3,
      actorMustRelogin: false,
    });

    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "admin-1",
      userId: "user-2",
      reason: "User forgot their password at the front desk.",
      delivery: "operator_handoff",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notice).toContain("Reviewer One");
      expect(result.data.resetUrl).toBe("https://app.test/reset/raw-token-value");
      expect(result.data.expiresAt).toBe("2026-08-10T13:00:00.000Z");
    }
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
  });

  it("emails and never reveals the link for email delivery", async () => {
    process.env.SUPERSCRIBER_RESET_MAIL_MODE = "smtp";
    process.env.SUPERSCRIBER_RESET_MAIL_SMTP_HOST = "mail.example.test";
    process.env.SUPERSCRIBER_RESET_MAIL_SMTP_PORT = "587";
    process.env.SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS = "reset@example.test";
    process.env.SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE = "/run/secrets/pw";
    adminIssuePasswordResetMock.mockReturnValue({
      userId: "user-2",
      targetDisplayName: "Reviewer One",
      targetEmail: "reviewer1@example.com",
      rawToken: "raw-token-value",
      recordId: "record-1",
      expiresAt: "2026-08-10T13:00:00.000Z",
      delivery: "email",
      revokedSessionCount: 0,
      resultingAuthVersion: 2,
      actorMustRelogin: false,
    });

    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "admin-1",
      userId: "user-2",
      reason: "User forgot their password at the front desk.",
      delivery: "email",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.resetUrl).toBeNull();
      expect(result.notice).toContain("emailed");
    }
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    const [, message] = sendPasswordResetEmailMock.mock.calls[0]!;
    expect(message.to).toBe("reviewer1@example.com");
    expect(message.resetUrl).toBe("https://app.test/reset/raw-token-value");

    delete process.env.SUPERSCRIBER_RESET_MAIL_MODE;
    delete process.env.SUPERSCRIBER_RESET_MAIL_SMTP_HOST;
    delete process.env.SUPERSCRIBER_RESET_MAIL_SMTP_PORT;
    delete process.env.SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS;
    delete process.env.SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE;
  });

  it("forces self-reset requests to handoff delivery", async () => {
    adminIssuePasswordResetMock.mockReturnValue({
      userId: "admin-1",
      targetDisplayName: "Admin",
      targetEmail: "admin@example.com",
      rawToken: "raw-token-value",
      recordId: "record-1",
      expiresAt: "2026-08-10T13:00:00.000Z",
      delivery: "operator_handoff",
      revokedSessionCount: 1,
      resultingAuthVersion: 3,
      actorMustRelogin: true,
    });

    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "admin-1",
      userId: "admin-1",
      reason: "Rotating my own password after a device loss.",
      delivery: "email",
    });

    expect(adminIssuePasswordResetMock).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      actorAuthSessionId: "auth-session-admin-1",
      input: {
        userId: "admin-1",
        reason: "Rotating my own password after a device loss.",
        delivery: "operator_handoff",
      },
    });
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      data: {
        resetUrl: "https://app.test/reset/raw-token-value",
        actorMustRelogin: true,
      },
    });
  });

  it("maps typed service failures onto the failure result", async () => {
    const { AdminPasswordResetServiceError } = await import(
      "@/server/administration/password-reset-service"
    );
    adminIssuePasswordResetMock.mockImplementation(() => {
      throw new AdminPasswordResetServiceError({
        code: "BREAK_GLASS_DESIGNEE",
        message: "The break-glass administrator's password rotates only through the emergency ceremony.",
      });
    });

    const result = await adminResetAccountPasswordAction({
      expectedActorUserId: "admin-1",
      userId: "bg-1",
      reason: "Trying to rotate the emergency account outside ceremony.",
      delivery: "operator_handoff",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("BREAK_GLASS_DESIGNEE");
  });
});
