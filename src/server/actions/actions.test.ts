import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasefileCommandError } from "@/server/casefile/errors";

const {
  getActivePrincipalMock,
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
  enterActionModeMock,
  exitActionModeMock,
  hasAnyUsersMock,
  createBootstrapAdminMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  getActivePrincipalMock: vi.fn(),
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
  enterActionModeMock: vi.fn(),
  exitActionModeMock: vi.fn(),
  hasAnyUsersMock: vi.fn(),
  createBootstrapAdminMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  getActivePrincipal: getActivePrincipalMock,
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
  createBootstrapAdmin: createBootstrapAdminMock,
  createLocalUser: createLocalUserMock,
}));

vi.mock("@/server/access/service", () => ({
  assignRecordingToUser: assignRecordingToUserMock,
  removeRecordingAssignment: removeRecordingAssignmentMock,
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
  assignRecordingAction,
  createUserAction,
  unassignRecordingAction,
} from "@/server/actions/administration-actions";
import {
  enterAdminActionModeAction,
  exitAdminActionModeAction,
} from "@/server/actions/admin-action-mode-actions";
import { createBootstrapAdminAction } from "@/server/actions/auth-actions";

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
