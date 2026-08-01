import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { assignRecordingToUser, removeRecordingAssignment } from "@/server/access/service";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import {
  approveRevisionCommand,
  reopenRevisionCommand,
  submitRevisionCommand,
} from "@/server/casefile/commands";
import { getCasefile } from "@/server/casefile/read-model";
import { openAppDatabase, type AppDatabase } from "@/server/db/client";
import { approvals, auditEvents, recordings, revisions, workspaces } from "@/server/db/schema";

const FIXED_NOW = "2026-08-01T12:00:00.000Z";

type TestBundle = ReturnType<typeof openAppDatabase>;

const baseSegments = [
  {
    id: "seg-1",
    speakerLabel: "Speaker A",
    startMs: 0,
    endMs: 5_000,
    text: "Hello world.",
    confidence: 0.92,
  },
] satisfies TranscriptRevision["segments"];

function insertWorkspace(bundle: TestBundle) {
  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();
}

function insertDraftRecording(
  bundle: TestBundle,
  params: { recordingId: string; title: string; uploadedByUserId: string },
) {
  bundle.db.insert(revisions).values({
    id: "rev-1",
    recordingId: params.recordingId,
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
    id: params.recordingId,
    workspaceId: "workspace-1",
    title: params.title,
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: `${params.recordingId}.wav`,
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: params.uploadedByUserId,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: "rev-1",
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    automationCursor: null,
  }).run();
}

async function createPrincipal(
  db: AppDatabase,
  input: { displayName: string; email: string; role: Principal["role"] },
) {
  const user = await createLocalUser(
    {
      ...input,
      password: "correct horse battery staple",
    },
    db,
  );

  return toPrincipal(user);
}

async function setupLifecycleFixture() {
  const bundle = openAppDatabase(":memory:");
  insertWorkspace(bundle);

  const uploader = await createPrincipal(bundle.db, {
    displayName: "Uploader",
    email: "uploader@example.com",
    role: "uploader",
  });
  const reviewer = await createPrincipal(bundle.db, {
    displayName: "Reviewer A",
    email: "reviewer-a@example.com",
    role: "reviewer",
  });
  const nextReviewer = await createPrincipal(bundle.db, {
    displayName: "Reviewer B",
    email: "reviewer-b@example.com",
    role: "reviewer",
  });
  const removedReviewer = await createPrincipal(bundle.db, {
    displayName: "Removed Reviewer",
    email: "reviewer-removed@example.com",
    role: "reviewer",
  });
  const approver = await createPrincipal(bundle.db, {
    displayName: "Approver",
    email: "approver@example.com",
    role: "approver",
  });
  const admin = await createPrincipal(bundle.db, {
    displayName: "Admin",
    email: "admin@example.com",
    role: "admin",
  });
  const outsider = await createPrincipal(bundle.db, {
    displayName: "Outsider",
    email: "outsider@example.com",
    role: "reviewer",
  });

  insertDraftRecording(bundle, {
    recordingId: "rec-1",
    title: "Lifecycle recording",
    uploadedByUserId: uploader.userId,
  });

  assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: reviewer.userId,
      assignedBy: admin,
    },
    bundle,
  );
  assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: approver.userId,
      assignedBy: admin,
    },
    bundle,
  );

  vi.setSystemTime(new Date("2026-08-01T12:01:00.000Z"));
  const pending = submitRevisionCommand(
    reviewer,
    {
      recordingId: "rec-1",
      expectedCurrentRevisionId: "rev-1",
      summary: "Pending review transcript.",
      segments: baseSegments,
      hasUnsavedChanges: false,
    },
    bundle,
  );

  vi.setSystemTime(new Date("2026-08-01T12:02:00.000Z"));
  const approved = approveRevisionCommand(
    approver,
    {
      recordingId: "rec-1",
      expectedPendingRevisionId: pending.id,
      note: "Approved.",
    },
    bundle,
  );

  vi.setSystemTime(new Date("2026-08-01T12:10:00.000Z"));
  const reopened = reopenRevisionCommand(
    approver,
    {
      recordingId: "rec-1",
      expectedApprovedRevisionId: approved.revision.id,
      reason: "New evidence requires a fresh cycle.",
    },
    bundle,
  );

  vi.setSystemTime(new Date("2026-08-01T12:11:00.000Z"));
  assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: nextReviewer.userId,
      assignedBy: admin,
    },
    bundle,
  );

  vi.setSystemTime(new Date("2026-08-01T12:12:00.000Z"));
  const removedAssignment = assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: removedReviewer.userId,
      assignedBy: admin,
    },
    bundle,
  ).assignment;
  removeRecordingAssignment(
    {
      assignmentId: removedAssignment.id,
      removedBy: admin,
    },
    bundle,
  );

  return {
    bundle,
    uploader,
    reviewer,
    nextReviewer,
    removedReviewer,
    approver,
    admin,
    outsider,
    approvedRevisionId: approved.revision.id,
    reopenedRevisionId: reopened.id,
  };
}

describe("getCasefile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides transcript, media, decisions, and audit from uploader status access", async () => {
    const { bundle, uploader } = await setupLifecycleFixture();

    try {
      const casefile = getCasefile(uploader, "rec-1", {}, bundle.db);
      expect(casefile).not.toBeNull();
      expect(casefile?.access.kind).toBe("uploader_status");
      expect(casefile?.revision).toBeNull();
      expect(casefile?.revisions).toEqual([]);
      expect(casefile?.decisions).toEqual([]);
      expect(casefile?.audit).toEqual([]);
      expect(casefile?.capabilities.canViewTranscript).toBe(false);
      expect(casefile?.capabilities.canViewMedia).toBe(false);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns the current governed casefile for an active assignee", async () => {
    const { bundle, nextReviewer, reopenedRevisionId } = await setupLifecycleFixture();

    try {
      const casefile = getCasefile(nextReviewer, "rec-1", {}, bundle.db);
      expect(casefile).toEqual(
        expect.objectContaining({
          stage: "reopened",
          revision: expect.objectContaining({ id: reopenedRevisionId }),
          access: expect.objectContaining({ kind: "active_reviewer" }),
        }),
      );
      expect(casefile?.capabilities.canEdit).toBe(true);
      expect(casefile?.nextActions).toEqual([
        expect.objectContaining({ capability: "canEdit" }),
        expect.objectContaining({ capability: "canSubmit" }),
      ]);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns only the approved completion snapshot for completed access", async () => {
    const { bundle, reviewer, approvedRevisionId } = await setupLifecycleFixture();

    try {
      const casefile = getCasefile(
        reviewer,
        "rec-1",
        { revisionId: approvedRevisionId },
        bundle.db,
      );

      expect(casefile).toEqual(
        expect.objectContaining({
          stage: "approved",
          revision: expect.objectContaining({ id: approvedRevisionId }),
          access: expect.objectContaining({
            kind: "completed_reviewer",
            revisionId: approvedRevisionId,
          }),
        }),
      );
      expect(casefile?.decisions.map((decision) => decision.state)).toEqual([
        "approved",
        "pending",
      ]);
      expect(casefile?.audit.some((event) => event.type === "approval.reopened")).toBe(false);
      expect(casefile?.capabilities.canExport).toBe(false);
      expect(casefile?.revision?.submittedByDisplay).toBe("Reviewer A");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("throws ACCESS_DENIED for removed or unassigned principals and returns null only for missing recordings", async () => {
    const { bundle, removedReviewer, outsider } = await setupLifecycleFixture();

    try {
      expect(getCasefile(outsider, "missing-recording", {}, bundle.db)).toBeNull();
      expect(() => getCasefile(removedReviewer, "rec-1", {}, bundle.db)).toThrowError(
        expect.objectContaining({ code: "ACCESS_DENIED" }),
      );
      expect(() => getCasefile(outsider, "rec-1", {}, bundle.db)).toThrowError(
        expect.objectContaining({ code: "ACCESS_DENIED" }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns current admin oversight with no governed capabilities outside action mode", async () => {
    const { bundle, admin, reopenedRevisionId } = await setupLifecycleFixture();

    try {
      const casefile = getCasefile(admin, "rec-1", {}, bundle.db);
      expect(casefile).toEqual(
        expect.objectContaining({
          stage: "reopened",
          revision: expect.objectContaining({ id: reopenedRevisionId }),
          access: expect.objectContaining({ kind: "admin_oversight" }),
        }),
      );
      expect(casefile?.capabilities.canViewTranscript).toBe(true);
      expect(casefile?.capabilities.canEdit).toBe(false);
      expect(casefile?.capabilities.denials.canEdit).toBe("admin_action_mode_required");
      expect(casefile?.nextActions).toEqual([]);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("normalizes legacy rejected decisions and actor attribution without mutating stored history", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const uploader = await createPrincipal(bundle.db, {
        displayName: "Uploader",
        email: "uploader@example.com",
        role: "uploader",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Reviewer",
        email: "reviewer@example.com",
        role: "reviewer",
      });
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      bundle.db.insert(revisions).values([
        {
          id: "rev-approved",
          recordingId: "rec-legacy",
          version: 1,
          state: "approved",
          basedOnRevisionId: null,
          createdByRole: "reviewer",
          createdByUserId: reviewer.userId,
          createdAt: FIXED_NOW,
          submittedByUserId: reviewer.userId,
          submittedAt: FIXED_NOW,
          approvedAt: FIXED_NOW,
          summary: "Approved revision",
          segmentsJson: JSON.stringify(baseSegments),
        },
        {
          id: "rev-current",
          recordingId: "rec-legacy",
          version: 2,
          state: "draft",
          basedOnRevisionId: "rev-approved",
          createdByRole: "reviewer",
          createdByUserId: reviewer.userId,
          createdAt: "2026-08-01T12:10:00.000Z",
          submittedByUserId: null,
          submittedAt: null,
          approvedAt: null,
          summary: "Reopened draft",
          segmentsJson: JSON.stringify(baseSegments),
        },
      ]).run();

      bundle.db.insert(recordings).values({
        id: "rec-legacy",
        workspaceId: "workspace-1",
        title: "Legacy attribution",
        source: "upload",
        mediaKind: "audio",
        mimeType: "audio/wav",
        mediaPath: null,
        originalFileName: "legacy.wav",
        languageHint: "en",
        uploadedByRole: "uploader",
        uploadedByUserId: uploader.userId,
        ingestionSessionId: null,
        transcriptJobId: null,
        integrityState: "verified",
        transcriptJobState: "completed",
        currentRevisionId: "rev-current",
        approvedRevisionId: null,
        pendingRevisionId: null,
        verificationSummary: "Ready",
        createdAt: FIXED_NOW,
        updatedAt: "2026-08-01T12:10:00.000Z",
        automationCursor: null,
      }).run();

      assignRecordingToUser(
        {
          recordingId: "rec-legacy",
          userId: reviewer.userId,
          assignedBy: admin,
        },
        bundle,
      );

      bundle.db.insert(approvals).values({
        id: "approval-legacy",
        recordingId: "rec-legacy",
        revisionId: "rev-approved",
        state: "rejected",
        actorRole: "reviewer",
        actorUserId: null,
        actorDisplayName: null,
        effectiveRole: null,
        adminActionSessionId: null,
        createdAt: "2026-08-01T12:05:00.000Z",
        note: "Legacy rejected note.",
      }).run();

      bundle.db.insert(auditEvents).values({
        id: "audit-legacy",
        workspaceId: "workspace-1",
        recordingId: "rec-legacy",
        actorRole: "reviewer",
        actorUserId: null,
        actorDisplayName: null,
        effectiveRole: null,
        adminActionSessionId: null,
        type: "approval.changes_requested",
        detail: "Legacy audit event without a resolvable user.",
        metadata: JSON.stringify({ version: 1, data: { legacy: true } }),
        createdAt: "2026-08-01T12:05:00.000Z",
      }).run();

      const casefile = getCasefile(reviewer, "rec-legacy", {}, bundle.db);
      expect(casefile?.decisions[0]).toEqual(
        expect.objectContaining({
          state: "rejected",
          label: "Changes requested (legacy)",
          actorDisplay: "Reviewer (legacy account unavailable)",
        }),
      );
      expect(casefile?.audit[0]).toEqual(
        expect.objectContaining({
          actorDisplay: "Reviewer (legacy account unavailable)",
        }),
      );
      expect(
        bundle.db
          .select({ state: approvals.state })
          .from(approvals)
          .where(eq(approvals.id, "approval-legacy"))
          .get()?.state,
      ).toBe("rejected");
    } finally {
      bundle.sqlite.close();
    }
  });
});
