import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { assignRecordingToUser } from "@/server/access/service";
import { enterActionMode } from "@/server/casefile/action-mode";
import {
  approveRevisionCommand,
  renameSpeakerCommand,
  requestChangesCommand,
  reopenRevisionCommand,
  saveDraftCommand,
  submitRevisionCommand,
  withdrawRevisionCommand,
} from "@/server/casefile/commands";
import { openAppDatabase } from "@/server/db/client";
import { toRevision } from "@/server/db/mappers";
import {
  adminActionSessions,
  approvals,
  appStateMeta,
  auditEvents,
  recordingAssignments,
  recordings,
  revisions,
  workspaces,
} from "@/server/db/schema";

const FIXED_NOW = "2026-08-01T12:00:00.000Z";

type TestBundle = ReturnType<typeof openAppDatabase>;

type DraftInput = {
  recordingId: string;
  expectedCurrentRevisionId: string;
  summary: string;
  segments: TranscriptRevision["segments"];
  actionModeId?: string | null;
};

const baseSegments = [
  {
    id: "seg-1",
    speakerLabel: "Speaker A",
    startMs: 0,
    endMs: 5_000,
    text: "Hello world.",
    confidence: 0.92,
  },
  {
    id: "seg-2",
    speakerLabel: "Speaker B",
    startMs: 5_000,
    endMs: 9_000,
    text: "Please review this governed transcript.",
    confidence: 0.91,
  },
] satisfies TranscriptRevision["segments"];

function cloneSegments(segments: TranscriptRevision["segments"]) {
  return segments.map((segment) => ({ ...segment }));
}

function insertDraftFixture(bundle: TestBundle) {
  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();

  bundle.db.insert(revisions).values({
    id: "rev-1",
    recordingId: "rec-1",
    version: 1,
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdByUserId: null,
    createdAt: FIXED_NOW,
    submittedByUserId: null,
    submittedAt: null,
    approvedAt: null,
    summary: "Initial draft",
    segmentsJson: JSON.stringify(baseSegments),
  }).run();

  bundle.db.insert(recordings).values({
    id: "rec-1",
    workspaceId: "workspace-1",
    title: "Recording 1",
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: "recording.wav",
    languageHint: "en",
    transcriptModel: null,
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: "rev-1",
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready for review.",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    automationCursor: null,
  }).run();
}

async function createPrincipal(
  bundle: TestBundle,
  input: { displayName: string; email: string; role: Principal["role"] },
) {
  const user = await createLocalUser(
    {
      ...input,
      password: "correct horse battery staple",
    },
    bundle.db,
  );

  return toPrincipal(user);
}

async function setupDraftFixture() {
  const bundle = openAppDatabase(":memory:");
  insertDraftFixture(bundle);
  const reviewer = await createPrincipal(bundle, {
    displayName: "Reviewer",
    email: "reviewer@example.com",
    role: "reviewer",
  });
  const approver = await createPrincipal(bundle, {
    displayName: "Approver",
    email: "approver@example.com",
    role: "approver",
  });
  const admin = await createPrincipal(bundle, {
    displayName: "Admin",
    email: "admin@example.com",
    role: "admin",
  });

  assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: reviewer.userId,
      assignedBy: admin,
    },
    bundle,
  );

  const draftInput: DraftInput = {
    recordingId: "rec-1",
    expectedCurrentRevisionId: "rev-1",
    summary: "Updated transcript draft.",
    segments: cloneSegments(baseSegments).map((segment, index) => ({
      ...segment,
      text: `${segment.text} Edited ${index + 1}.`,
    })),
  };

  return { bundle, reviewer, approver, admin, draftInput };
}

async function setupPendingFixture(options?: {
  submitter?: "reviewer" | "admin";
  legacySubmitterIdentity?: boolean;
}) {
  const { bundle, reviewer, approver, admin, draftInput } = await setupDraftFixture();

  assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: approver.userId,
      assignedBy: admin,
    },
    bundle,
  );

  const submitter = options?.submitter === "admin" ? admin : reviewer;
  const submitActionModeId =
    options?.submitter === "admin"
      ? enterActionMode({
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "reviewer",
          purpose: "Review this transcript before submitting it.",
        }, bundle).id
      : null;

  const pending = submitRevisionCommand(
    submitter,
    {
      ...draftInput,
      hasUnsavedChanges: true,
      actionModeId: submitActionModeId,
    },
    bundle,
  );

  if (options?.legacySubmitterIdentity) {
    bundle.db.update(revisions)
      .set({ submittedByUserId: null })
      .where(eq(revisions.id, pending.id))
      .run();
  }

  return {
    bundle,
    reviewer,
    approver,
    admin,
    submitter,
    pending,
    submitActionModeId,
  };
}

function readRecording(bundle: TestBundle) {
  return bundle.db.select().from(recordings).where(eq(recordings.id, "rec-1")).get();
}

function readRevision(bundle: TestBundle, revisionId: string) {
  const row = bundle.db
    .select()
    .from(revisions)
    .where(eq(revisions.id, revisionId))
    .get();

  return row ? toRevision(row) : null;
}

function listApprovalRows(bundle: TestBundle) {
  return bundle.db
    .select()
    .from(approvals)
    .where(eq(approvals.recordingId, "rec-1"))
    .all();
}

function listAuditRows(bundle: TestBundle) {
  return bundle.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.recordingId, "rec-1"))
    .all();
}

function listRevisionAuditRows(bundle: TestBundle) {
  return listAuditRows(bundle).filter((row) => row.type.startsWith("revision."));
}

function listAssignmentRows(bundle: TestBundle) {
  return bundle.db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.recordingId, "rec-1"))
    .all();
}

function getStateVersion(bundle: TestBundle) {
  return bundle.db.select().from(appStateMeta).where(eq(appStateMeta.id, 1)).get()?.stateVersion;
}

function makeReason(length: number) {
  return "r".repeat(length);
}

async function createSharedPendingFixture() {
  const tempRoot = mkdtempSync(join(tmpdir(), "superscriber-commands-"));
  const databasePath = join(tempRoot, "state.db");
  const first = openAppDatabase(databasePath);
  const second = openAppDatabase(databasePath);

  insertDraftFixture(first);
  const reviewer = await createPrincipal(first, {
    displayName: "Reviewer",
    email: "reviewer@example.com",
    role: "reviewer",
  });
  const approver = await createPrincipal(first, {
    displayName: "Approver",
    email: "approver@example.com",
    role: "approver",
  });
  const admin = await createPrincipal(first, {
    displayName: "Admin",
    email: "admin@example.com",
    role: "admin",
  });

  assignRecordingToUser({
    recordingId: "rec-1",
    userId: reviewer.userId,
    assignedBy: admin,
  }, first);
  assignRecordingToUser({
    recordingId: "rec-1",
    userId: approver.userId,
    assignedBy: admin,
  }, first);

  const pending = submitRevisionCommand(reviewer, {
    recordingId: "rec-1",
    expectedCurrentRevisionId: "rev-1",
    summary: "Updated transcript draft.",
    segments: cloneSegments(baseSegments),
    hasUnsavedChanges: true,
  }, first);

  return {
    tempRoot,
    first,
    second,
    reviewer,
    approver,
    pendingId: pending.id,
    cleanup() {
      first.sqlite.close();
      second.sqlite.close();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

describe("casefile draft commands", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("supersedes the prior draft and saves a complete next revision", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      const beforeVersion = getStateVersion(bundle);
      const beforeAuditCount = listRevisionAuditRows(bundle).length;
      const saved = saveDraftCommand(reviewer, draftInput, bundle);

      expect(saved.version).toBe(2);
      expect(saved.state).toBe("draft");
      expect(saved.createdByUserId).toBe(reviewer.userId);
      expect(readRevision(bundle, "rev-1")?.state).toBe("superseded");
      expect(readRecording(bundle)?.currentRevisionId).toBe(saved.id);
      expect(listRevisionAuditRows(bundle)).toHaveLength(beforeAuditCount + 1);
      expect(listRevisionAuditRows(bundle).at(-1)?.type).toBe("revision.saved");
      expect(getStateVersion(bundle)).toBe((beforeVersion ?? 0) + 1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("atomically saves unsaved content and submits the resulting revision", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      const beforeVersion = getStateVersion(bundle);
      const beforeAuditCount = listRevisionAuditRows(bundle).length;
      const submitted = submitRevisionCommand(reviewer, {
        ...draftInput,
        hasUnsavedChanges: true,
      }, bundle);

      expect(submitted.version).toBe(2);
      expect(submitted.state).toBe("pending_approval");
      expect(submitted.submittedByUserId).toBe(reviewer.userId);
      expect(readRevision(bundle, "rev-1")?.state).toBe("superseded");
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: submitted.id,
          pendingRevisionId: submitted.id,
        }),
      );
      expect(listApprovalRows(bundle)).toHaveLength(1);
      expect(listApprovalRows(bundle)[0]).toEqual(
        expect.objectContaining({
          revisionId: submitted.id,
          state: "pending",
          actorUserId: reviewer.userId,
          effectiveRole: "reviewer",
        }),
      );
      expect(listRevisionAuditRows(bundle)).toHaveLength(beforeAuditCount + 1);
      expect(listRevisionAuditRows(bundle).at(-1)?.type).toBe("revision.submitted");
      expect(getStateVersion(bundle)).toBe((beforeVersion ?? 0) + 1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("lets only the submitting user withdraw before a decision", async () => {
    const { bundle, submitter, pending } = await setupPendingFixture();

    try {
      const draft = withdrawRevisionCommand(submitter, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        reason: "I found a material transcript omission.",
      }, bundle);

      expect(readRevision(bundle, pending.id)?.state).toBe("withdrawn");
      expect(draft.basedOnRevisionId).toBe(pending.id);
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: draft.id,
          pendingRevisionId: null,
        }),
      );
      expect(listAssignmentRows(bundle)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "active", assignmentRole: "reviewer" }),
          expect.objectContaining({ status: "active", assignmentRole: "approver" }),
        ]),
      );
      expect(listApprovalRows(bundle).map((row) => row.state)).toEqual(["pending", "withdrawn"]);
      expect(listAuditRows(bundle).map((row) => row.type)).toContain("revision.withdrawn");
    } finally {
      bundle.sqlite.close();
    }
  });

  it.each(["approve", "requestChanges"] as const)(
    "admin passes the not-the-submitter rule: administrator may %s a revision they submitted (captain ruling 2026-08-06)",
    async (action) => {
      const { bundle, admin, pending } = await setupPendingFixture({ submitter: "admin" });

      try {
        const approverActionModeId = enterActionMode({
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "approver",
          purpose: "Record the governed approval decision for this transcript.",
        }, bundle).id;

        const runDecision = () =>
          action === "approve"
            ? approveRevisionCommand(admin, {
                recordingId: "rec-1",
                expectedPendingRevisionId: pending.id,
                note: "Looks good.",
                actionModeId: approverActionModeId,
              }, bundle)
            : requestChangesCommand(admin, {
                recordingId: "rec-1",
                expectedPendingRevisionId: pending.id,
                reason: "Please correct the transcript summary before approval.",
                actionModeId: approverActionModeId,
              }, bundle);

        expect(runDecision).not.toThrow();

        // Attribution under the wider rule: the decision row still records
        // the acting identity plus the action-mode session it ran under.
        expect(listApprovalRows(bundle)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              actorUserId: admin.userId,
              adminActionSessionId: approverActionModeId,
              effectiveRole: "approver",
            }),
          ]),
        );
      } finally {
        bundle.sqlite.close();
      }
    },
  );

  // Admin ledger access (captain ruling): an administrator in reviewer
  // action mode may withdraw a pending revision submitted by someone else.
  // The submitter-only rule still binds non-admin roles, and the decision
  // and audit rows keep full attribution of the acting admin.
  it("lets an admin in reviewer action mode withdraw another user's pending revision", async () => {
    const { bundle, admin, reviewer, pending } = await setupPendingFixture();

    try {
      // Without action mode the governed semantic-audit still fails closed.
      expect(() =>
        withdrawRevisionCommand(admin, {
          recordingId: "rec-1",
          expectedPendingRevisionId: pending.id,
          reason: "The submitter is unavailable; returning the draft to review.",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }));

      const reviewerActionModeId = enterActionMode({
        principal: admin,
        recordingId: "rec-1",
        effectiveRole: "reviewer",
        purpose: "Withdraw a stalled submission while the reviewer is away.",
      }, bundle).id;

      const draft = withdrawRevisionCommand(admin, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        reason: "The submitter is unavailable; returning the draft to review.",
        actionModeId: reviewerActionModeId,
      }, bundle);

      expect(readRevision(bundle, pending.id)?.state).toBe("withdrawn");
      expect(draft.basedOnRevisionId).toBe(pending.id);
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: draft.id,
          pendingRevisionId: null,
        }),
      );

      const withdrawnDecision = listApprovalRows(bundle).find((row) => row.state === "withdrawn");
      expect(withdrawnDecision).toEqual(
        expect.objectContaining({
          actorUserId: admin.userId,
          actorRole: "admin",
          effectiveRole: "reviewer",
          adminActionSessionId: reviewerActionModeId,
        }),
      );

      const withdrawnAudit = listAuditRows(bundle).find((row) => row.type === "revision.withdrawn");
      expect(withdrawnAudit).toEqual(
        expect.objectContaining({
          actorUserId: admin.userId,
          actorRole: "admin",
          effectiveRole: "reviewer",
          adminActionSessionId: reviewerActionModeId,
        }),
      );
      const withdrawnMetadata = JSON.parse(withdrawnAudit?.metadata ?? "{}") as {
        data?: Record<string, unknown>;
      };
      expect(withdrawnMetadata.data).toEqual(
        expect.objectContaining({
          submitterUserId: reviewer.userId,
          submitterOverrideByAdmin: true,
        }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("keeps the legacy-submitter withdrawal veto for an admin in reviewer action mode", async () => {
    const { bundle, admin, pending } = await setupPendingFixture({ legacySubmitterIdentity: true });

    try {
      const reviewerActionModeId = enterActionMode({
        principal: admin,
        recordingId: "rec-1",
        effectiveRole: "reviewer",
        purpose: "Attempt to withdraw a legacy submission without identity.",
      }, bundle).id;

      expect(() =>
        withdrawRevisionCommand(admin, {
          recordingId: "rec-1",
          expectedPendingRevisionId: pending.id,
          reason: "Legacy submissions without an identity stay locked.",
          actionModeId: reviewerActionModeId,
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("denies withdrawal when the pending revision has no known submitter identity", async () => {
    const { bundle, reviewer, pending } = await setupPendingFixture({ legacySubmitterIdentity: true });

    try {
      expect(() =>
        withdrawRevisionCommand(reviewer, {
          recordingId: "rec-1",
          expectedPendingRevisionId: pending.id,
          reason: "I need to replace this legacy submission safely.",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("accepts trimmed withdrawal reasons at the 10 and 500 character bounds", async () => {
    const first = await setupPendingFixture();
    const second = await setupPendingFixture();

    try {
      const minDraft = withdrawRevisionCommand(first.submitter, {
        recordingId: "rec-1",
        expectedPendingRevisionId: first.pending.id,
        reason: `  ${makeReason(10)}  `,
      }, first.bundle);
      const maxDraft = withdrawRevisionCommand(second.submitter, {
        recordingId: "rec-1",
        expectedPendingRevisionId: second.pending.id,
        reason: ` ${makeReason(500)} `,
      }, second.bundle);

      const minReason = listApprovalRows(first.bundle).find((row) => row.state === "withdrawn")?.note;
      const maxReason = listApprovalRows(second.bundle).find((row) => row.state === "withdrawn")?.note;

      expect(minDraft.state).toBe("draft");
      expect(maxDraft.state).toBe("draft");
      expect(minReason).toHaveLength(10);
      expect(maxReason).toHaveLength(500);
    } finally {
      first.bundle.sqlite.close();
      second.bundle.sqlite.close();
    }
  });

  it("rejects request changes reasons outside the 10 to 500 character bounds", async () => {
    const short = await setupPendingFixture();
    const long = await setupPendingFixture();

    try {
      expect(() =>
        requestChangesCommand(short.approver, {
          recordingId: "rec-1",
          expectedPendingRevisionId: short.pending.id,
          reason: makeReason(9),
        }, short.bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

      expect(() =>
        requestChangesCommand(long.approver, {
          recordingId: "rec-1",
          expectedPendingRevisionId: long.pending.id,
          reason: makeReason(501),
        }, long.bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      short.bundle.sqlite.close();
      long.bundle.sqlite.close();
    }
  });

  it("clones a complete draft when changes are requested and preserves assignments", async () => {
    const { bundle, approver, pending } = await setupPendingFixture();

    try {
      const draft = requestChangesCommand(approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        reason: "Please correct the segment wording before this can be approved.",
      }, bundle);

      expect(readRevision(bundle, pending.id)?.state).toBe("changes_requested");
      expect(draft.basedOnRevisionId).toBe(pending.id);
      expect(draft.summary).toBe(pending.summary);
      expect(draft.segments).toEqual(pending.segments);
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: draft.id,
          pendingRevisionId: null,
          approvedRevisionId: null,
        }),
      );
      expect(listAssignmentRows(bundle)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "active", assignmentRole: "reviewer" }),
          expect.objectContaining({ status: "active", assignmentRole: "approver" }),
        ]),
      );
      expect(listApprovalRows(bundle).map((row) => row.state)).toEqual([
        "pending",
        "changes_requested",
      ]);
      expect(listAuditRows(bundle).map((row) => row.type)).toContain("approval.changes_requested");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("allows authorized approvers to decide legacy pending revisions with no submitter identity", async () => {
    const { bundle, approver, pending } = await setupPendingFixture({ legacySubmitterIdentity: true });

    try {
      const approved = approveRevisionCommand(approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        note: "",
      }, bundle);

      expect(approved.revision.state).toBe("approved");
      expect(readRecording(bundle)?.approvedRevisionId).toBe(pending.id);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("accepts approval notes up to 500 characters and rejects longer notes", async () => {
    const valid = await setupPendingFixture();
    const invalid = await setupPendingFixture();

    try {
      const approved = approveRevisionCommand(valid.approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: valid.pending.id,
        note: ` ${makeReason(500)} `,
      }, valid.bundle);

      const approvedRow = listApprovalRows(valid.bundle).find((row) => row.state === "approved");
      expect(approved.revision.state).toBe("approved");
      expect(approvedRow?.note).toHaveLength(500);

      expect(() =>
        approveRevisionCommand(invalid.approver, {
          recordingId: "rec-1",
          expectedPendingRevisionId: invalid.pending.id,
          note: makeReason(501),
        }, invalid.bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      valid.bundle.sqlite.close();
      invalid.bundle.sqlite.close();
    }
  });

  it("approves a pending revision, updates pointers, and completes all active assignments atomically", async () => {
    const { bundle, approver, pending } = await setupPendingFixture();

    try {
      const beforeVersion = getStateVersion(bundle);
      const approved = approveRevisionCommand(approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        note: "Approved with governed lifecycle semantics.",
      }, bundle);

      expect(approved.revision.id).toBe(pending.id);
      expect(approved.revision.state).toBe("approved");
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: pending.id,
          pendingRevisionId: null,
          approvedRevisionId: pending.id,
        }),
      );
      expect(approved.completedAssignments).toHaveLength(2);
      expect(approved.completedAssignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assignmentRole: "reviewer", completedRevisionId: pending.id }),
          expect.objectContaining({ assignmentRole: "approver", completedRevisionId: pending.id }),
        ]),
      );
      expect(listAssignmentRows(bundle)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "completed", completedRevisionId: pending.id }),
          expect.objectContaining({ status: "completed", completedRevisionId: pending.id }),
        ]),
      );
      expect(listApprovalRows(bundle).map((row) => row.state)).toEqual(["pending", "approved"]);
      expect(listAuditRows(bundle).map((row) => row.type)).toEqual(
        expect.arrayContaining(["approval.approved", "assignment.completed", "assignment.completed"]),
      );
      expect(getStateVersion(bundle)).toBe((beforeVersion ?? 0) + 1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("attributes admin approver action mode decisions on both decision and audit rows", async () => {
    const { bundle, admin, pending } = await setupPendingFixture();

    try {
      const actionModeId = enterActionMode({
        principal: admin,
        recordingId: "rec-1",
        effectiveRole: "approver",
        purpose: "Approve this transcript under admin oversight.",
      }, bundle).id;

      approveRevisionCommand(admin, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        note: "Approved after admin oversight.",
        actionModeId,
      }, bundle);

      expect(listApprovalRows(bundle).find((row) => row.state === "approved")).toEqual(
        expect.objectContaining({
          actorRole: "admin",
          actorUserId: admin.userId,
          effectiveRole: "approver",
          adminActionSessionId: actionModeId,
        }),
      );
      expect(listAuditRows(bundle).find((row) => row.type === "approval.approved")).toEqual(
        expect.objectContaining({
          actorRole: "admin",
          actorUserId: admin.userId,
          effectiveRole: "approver",
          adminActionSessionId: actionModeId,
        }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("reopens an approved revision by clearing the approved pointer and never reactivating assignments", async () => {
    const { bundle, approver, pending } = await setupPendingFixture();

    try {
      const approved = approveRevisionCommand(approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: pending.id,
        note: "Approved before reopen.",
      }, bundle);

      const draft = reopenRevisionCommand(approver, {
        recordingId: "rec-1",
        expectedApprovedRevisionId: approved.revision.id,
        reason: "New evidence requires a fresh governed draft cycle.",
      }, bundle);

      expect(readRevision(bundle, approved.revision.id)?.state).toBe("approved");
      expect(draft.basedOnRevisionId).toBe(approved.revision.id);
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: draft.id,
          pendingRevisionId: null,
          approvedRevisionId: null,
        }),
      );
      expect(
        bundle.db.select().from(recordingAssignments).where(
          and(
            eq(recordingAssignments.recordingId, "rec-1"),
            eq(recordingAssignments.status, "active"),
          ),
        ).all(),
      ).toHaveLength(0);
      expect(listAssignmentRows(bundle)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "completed", completedRevisionId: approved.revision.id }),
          expect.objectContaining({ status: "completed", completedRevisionId: approved.revision.id }),
        ]),
      );
      expect(listApprovalRows(bundle).map((row) => row.state)).toEqual([
        "pending",
        "approved",
        "reopened",
      ]);
      expect(listAuditRows(bundle).map((row) => row.type)).toContain("approval.reopened");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects reopen reasons outside the 10 to 500 character bounds", async () => {
    const short = await setupPendingFixture();
    const long = await setupPendingFixture();

    try {
      const shortApproved = approveRevisionCommand(short.approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: short.pending.id,
        note: "Approved before testing reopen bounds.",
      }, short.bundle);
      const longApproved = approveRevisionCommand(long.approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: long.pending.id,
        note: "Approved before testing reopen bounds.",
      }, long.bundle);

      expect(() =>
        reopenRevisionCommand(short.approver, {
          recordingId: "rec-1",
          expectedApprovedRevisionId: shortApproved.revision.id,
          reason: makeReason(9),
        }, short.bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

      expect(() =>
        reopenRevisionCommand(long.approver, {
          recordingId: "rec-1",
          expectedApprovedRevisionId: longApproved.revision.id,
          reason: makeReason(501),
        }, long.bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      short.bundle.sqlite.close();
      long.bundle.sqlite.close();
    }
  });

  it("returns STATE_CHANGED when approval wins a two-connection decision race", async () => {
    const fixture = await createSharedPendingFixture();

    try {
      approveRevisionCommand(fixture.approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: fixture.pendingId,
        note: "",
      }, fixture.first);

      expect(() =>
        withdrawRevisionCommand(fixture.reviewer, {
          recordingId: "rec-1",
          expectedPendingRevisionId: fixture.pendingId,
          reason: "I need to correct newly discovered context.",
        }, fixture.second),
      ).toThrowError(
        expect.objectContaining({
          code: "STATE_CHANGED",
          latest: expect.objectContaining({
            currentRevisionId: fixture.pendingId,
            approvedRevisionId: fixture.pendingId,
            pendingRevisionId: null,
            winningStage: "approved",
          }),
        }),
      );

      expect(listApprovalRows(fixture.first).map((row) => row.state)).toEqual(["pending", "approved"]);
      expect(listAuditRows(fixture.first).filter((row) => row.type === "approval.approved")).toHaveLength(1);
      expect(listAuditRows(fixture.first).filter((row) => row.type === "revision.withdrawn")).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns STATE_CHANGED when request changes wins the opposite two-connection decision race", async () => {
    const fixture = await createSharedPendingFixture();

    try {
      requestChangesCommand(fixture.approver, {
        recordingId: "rec-1",
        expectedPendingRevisionId: fixture.pendingId,
        reason: "Please add the omitted context before approval.",
      }, fixture.first);

      expect(() =>
        approveRevisionCommand(fixture.approver, {
          recordingId: "rec-1",
          expectedPendingRevisionId: fixture.pendingId,
          note: "",
        }, fixture.second),
      ).toThrowError(
        expect.objectContaining({
          code: "STATE_CHANGED",
          latest: expect.objectContaining({
            pendingRevisionId: null,
            approvedRevisionId: null,
            winningStage: "changes_requested",
          }),
        }),
      );

      expect(listApprovalRows(fixture.first).map((row) => row.state)).toEqual([
        "pending",
        "changes_requested",
      ]);
      expect(listAuditRows(fixture.first).filter((row) => row.type === "approval.changes_requested")).toHaveLength(1);
      expect(listAuditRows(fixture.first).filter((row) => row.type === "approval.approved")).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects save when the loaded revision id is missing", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          expectedCurrentRevisionId: "",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the client drops part of the complete segment array", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          segments: [draftInput.segments[0]!],
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the replacement draft removes all existing segments", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          segments: [],
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns a stale conflict snapshot without mutating the winning draft", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      const saved = saveDraftCommand(reviewer, draftInput, bundle);
      const stateVersion = getStateVersion(bundle);

      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          expectedCurrentRevisionId: "rev-1",
          summary: "Stale retry",
        }, bundle),
      ).toThrowError(
        expect.objectContaining({
          code: "STALE_REVISION",
          latest: expect.objectContaining({
            recordingId: "rec-1",
            loadedRevisionId: "rev-1",
            currentRevisionId: saved.id,
            winningStage: "draft_review",
          }),
        }),
      );

      expect(getStateVersion(bundle)).toBe(stateVersion);
      expect(readRecording(bundle)?.currentRevisionId).toBe(saved.id);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the current revision is already pending approval", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      bundle.db.update(revisions)
        .set({ state: "pending_approval", submittedAt: FIXED_NOW, submittedByUserId: reviewer.userId })
        .where(eq(revisions.id, "rev-1"))
        .run();
      bundle.db.update(recordings)
        .set({ pendingRevisionId: "rev-1" })
        .where(eq(recordings.id, "rec-1"))
        .run();

      expect(() => saveDraftCommand(reviewer, draftInput, bundle)).toThrowError(
        /pending/i,
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the current revision is approved", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      bundle.db.update(revisions)
        .set({ state: "approved", approvedAt: FIXED_NOW })
        .where(eq(revisions.id, "rev-1"))
        .run();
      bundle.db.update(recordings)
        .set({ approvedRevisionId: "rev-1" })
        .where(eq(recordings.id, "rec-1"))
        .run();

      expect(() => saveDraftCommand(reviewer, draftInput, bundle)).toThrowError(
        /reopened|approved/i,
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("requires an active reviewer assignment for reviewer draft commands", async () => {
    const bundle = openAppDatabase(":memory:");
    insertDraftFixture(bundle);
    const reviewer = await createPrincipal(bundle, {
      displayName: "Reviewer",
      email: "reviewer@example.com",
      role: "reviewer",
    });

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          summary: "Updated transcript draft.",
          segments: cloneSegments(baseSegments),
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("requires admin reviewer action mode before saving a draft", async () => {
    const { bundle, admin, draftInput } = await setupDraftFixture();

    try {
      expect(() => saveDraftCommand(admin, draftInput, bundle)).toThrowError(
        expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects expired admin reviewer action mode", async () => {
    const { bundle, admin, draftInput } = await setupDraftFixture();

    try {
      const session = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "reviewer",
          purpose: "Review this governed draft carefully.",
        },
        bundle,
      );

      vi.setSystemTime(new Date("2026-08-01T12:31:00.000Z"));

      expect(() =>
        saveDraftCommand(admin, {
          ...draftInput,
          actionModeId: session.id,
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_EXPIRED" }));

      expect(
        bundle.db.select().from(adminActionSessions).where(eq(adminActionSessions.id, session.id)).get()
          ?.id,
      ).toBe(session.id);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("renames a speaker across every segment as one governed revision", async () => {
    const { bundle, reviewer } = await setupDraftFixture();

    try {
      const result = renameSpeakerCommand(reviewer, {
        recordingId: "rec-1",
        expectedCurrentRevisionId: "rev-1",
        fromSpeaker: "Speaker B",
        toSpeaker: "Dana",
        summary: "",
      }, bundle);

      expect(result.revision.version).toBe(2);
      expect(result.revision.state).toBe("draft");
      expect(result.revision.segments.map((segment) => segment.speakerLabel)).toEqual([
        "Speaker A",
        "Dana",
      ]);
      expect(result.rename.renamedSegmentCount).toBe(1);
      expect(result.rename.mergesWithExisting).toBe(false);
      expect(readRevision(bundle, "rev-1")?.state).toBe("superseded");
      expect(readRecording(bundle)?.currentRevisionId).toBe(result.revision.id);

      const auditRow = listAuditRows(bundle).at(-1);
      expect(auditRow?.type).toBe("revision.speakers_renamed");
      expect(auditRow?.actorUserId).toBe(reviewer.userId);
      expect(auditRow?.detail).toContain('Renamed "Speaker B" to "Dana" across 1 segment.');
    } finally {
      bundle.sqlite.close();
    }
  });

  it("merges both names when the target speaker already exists", async () => {
    const { bundle, reviewer } = await setupDraftFixture();

    try {
      const result = renameSpeakerCommand(reviewer, {
        recordingId: "rec-1",
        expectedCurrentRevisionId: "rev-1",
        fromSpeaker: "Speaker B",
        toSpeaker: "Speaker A",
      }, bundle);

      expect(
        new Set(result.revision.segments.map((segment) => segment.speakerLabel)),
      ).toEqual(new Set(["Speaker A"]));
      expect(result.rename.mergesWithExisting).toBe(true);
      expect(result.rename.existingTargetSegmentCount).toBe(1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects a rename with an empty, oversized, or unchanged speaker name", async () => {
    const { bundle, reviewer } = await setupDraftFixture();

    try {
      expect(() =>
        renameSpeakerCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          fromSpeaker: "Speaker B",
          toSpeaker: "  ",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

      expect(() =>
        renameSpeakerCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          fromSpeaker: "Speaker B",
          toSpeaker: "x".repeat(81),
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

      expect(() =>
        renameSpeakerCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          fromSpeaker: "Speaker B",
          toSpeaker: "Speaker B",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects a rename for a speaker with no attributed segments", async () => {
    const { bundle, reviewer } = await setupDraftFixture();

    try {
      expect(() =>
        renameSpeakerCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          fromSpeaker: "Speaker Z",
          toSpeaker: "Dana",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects a rename once the revision leaves draft state", async () => {
    const { bundle, reviewer, pending } = await setupPendingFixture();

    try {
      expect(() =>
        renameSpeakerCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: pending.id,
          fromSpeaker: "Speaker B",
          toSpeaker: "Dana",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects a rename against a stale current revision", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      saveDraftCommand(reviewer, draftInput, bundle);

      expect(() =>
        renameSpeakerCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          fromSpeaker: "Speaker B",
          toSpeaker: "Dana",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "STALE_REVISION" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("denies a rename without an active reviewer assignment", async () => {
    const bundle = openAppDatabase(":memory:");
    insertDraftFixture(bundle);
    const outsider = await createPrincipal(bundle, {
      displayName: "Outsider",
      email: "outsider@example.com",
      role: "reviewer",
    });

    try {
      expect(() =>
        renameSpeakerCommand(outsider, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          fromSpeaker: "Speaker B",
          toSpeaker: "Dana",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    } finally {
      bundle.sqlite.close();
    }
  });
});
