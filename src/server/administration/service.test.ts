import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { listAdministration } from "@/server/administration/service";
import { openAppDatabase, type AppDatabase } from "@/server/db/client";
import {
  authControl,
  recordingAssignments,
  recordings,
  revisions,
  workspaces,
} from "@/server/db/schema";

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

function insertRecording(
  bundle: TestBundle,
  params: {
    recordingId: string;
    title: string;
    source?: "upload" | "record";
    uploadedByUserId: string;
    currentRevisionId?: string | null;
    currentRevisionState?: "draft" | "approved";
    approvedRevisionId?: string | null;
    integrityState?: "capturing" | "uploading" | "verifying" | "verified" | "verification_failed" | "interrupted";
    transcriptJobState?: "queued" | "running" | "partial_result" | "completed" | "failed" | "cancelled";
    updatedAt: string;
  },
) {
  if (params.currentRevisionId) {
    bundle.db.insert(revisions).values({
      id: params.currentRevisionId,
      recordingId: params.recordingId,
      version: 1,
      state: params.currentRevisionState ?? "draft",
      basedOnRevisionId: null,
      createdByRole: "reviewer",
      createdByUserId: null,
      createdAt: params.updatedAt,
      submittedByUserId: null,
      submittedAt: null,
      approvedAt: params.currentRevisionState === "approved" ? params.updatedAt : null,
      summary: params.title,
      segmentsJson: JSON.stringify(baseSegments),
    }).run();
  }

  bundle.db.insert(recordings).values({
    id: params.recordingId,
    workspaceId: "workspace-1",
    title: params.title,
    source: params.source ?? "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: `${params.recordingId}.wav`,
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: params.uploadedByUserId,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: params.integrityState ?? "verified",
    transcriptJobState: params.transcriptJobState ?? "completed",
    currentRevisionId: params.currentRevisionId ?? null,
    approvedRevisionId: params.approvedRevisionId ?? null,
    pendingRevisionId: null,
    verificationSummary: "Ready",
    createdAt: params.updatedAt,
    updatedAt: params.updatedAt,
    automationCursor: null,
  }).run();
}

function insertAssignment(
  bundle: TestBundle,
  params: {
    id: string;
    recordingId: string;
    userId: string;
    assignedByUserId: string;
    role: "reviewer" | "approver";
    status: "active" | "completed" | "removed";
    updatedAt: string;
    completedRevisionId?: string | null;
  },
) {
  bundle.db.insert(recordingAssignments).values({
    id: params.id,
    recordingId: params.recordingId,
    userId: params.userId,
    assignedByUserId: params.assignedByUserId,
    assignmentRole: params.role,
    status: params.status,
    isActive: params.status === "active",
    createdAt: params.updatedAt,
    updatedAt: params.updatedAt,
    endedAt: params.status === "active" ? null : params.updatedAt,
    endReason: params.status === "removed" ? "removed_by_admin" : null,
    completedRevisionId: params.completedRevisionId ?? null,
    removedByUserId: params.status === "removed" ? params.assignedByUserId : null,
  }).run();
}

describe("listAdministration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns searchable account facts with the exact columns", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });
      const uploader = await createPrincipal(bundle.db, {
        displayName: "Uploader",
        email: "uploader@example.com",
        role: "uploader",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Reviewer One",
        email: "reviewer@example.com",
        role: "reviewer",
      });

      insertRecording(bundle, {
        recordingId: "rec-accounts",
        title: "Account assignment",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-accounts",
        currentRevisionState: "draft",
        updatedAt: "2026-08-01T12:01:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-accounts",
        recordingId: "rec-accounts",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: "2026-08-01T12:01:00.000Z",
      });

      const view = listAdministration(admin, { section: "accounts", query: "reviewer" }, bundle.db);
      expect(view.section).toBe("accounts");
      if (view.section !== "accounts") {
        throw new Error("Expected accounts section.");
      }
      expect(view.columns.map((column) => column.id)).toEqual([
        "displayName",
        "email",
        "role",
        "activeAssignmentCount",
        "createdAt",
      ]);
      expect(view.users).toEqual([
        expect.objectContaining({
          displayName: "Reviewer One",
          activeAssignmentCount: 1,
          createdAtLabel: "01 Aug 2026, 12:00 UTC",
        }),
      ]);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("flags viewerIsCustodian only when the caller is the designated custodian", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const custodian = await createPrincipal(bundle.db, {
        displayName: "Custodian Admin",
        email: "custodian@example.com",
        role: "admin",
      });
      const other = await createPrincipal(bundle.db, {
        displayName: "Other Admin",
        email: "other@example.com",
        role: "admin",
      });

      bundle.db.insert(authControl).values({
        id: 1,
        breakGlassUserId: custodian.userId,
        updatedAt: FIXED_NOW,
        updatedByUserId: custodian.userId,
        changeReason: "Initial custodian setup.",
      }).run();

      const custodianView = listAdministration(
        custodian,
        { section: "accounts" },
        bundle.db,
      );
      if (custodianView.section !== "accounts") {
        throw new Error("Expected accounts section.");
      }
      expect(custodianView.breakGlass.viewerIsCustodian).toBe(true);
      expect(custodianView.breakGlass.designation).toEqual(
        expect.objectContaining({ userId: custodian.userId, displayName: "Custodian Admin" }),
      );
      expect(custodianView.breakGlass.enrolledKeyCount).toBe(0);
      expect(custodianView.breakGlass.recoveryCodeCount).toBe(0);

      const otherView = listAdministration(other, { section: "accounts" }, bundle.db);
      if (otherView.section !== "accounts") {
        throw new Error("Expected accounts section.");
      }
      expect(otherView.breakGlass.viewerIsCustodian).toBe(false);
      expect(otherView.breakGlass.designation).toEqual(
        expect.objectContaining({ userId: custodian.userId }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns active and history assignment sections with exact columns, UTC filters, and truthful compatibility facts", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });
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
      const approver = await createPrincipal(bundle.db, {
        displayName: "Approver",
        email: "approver@example.com",
        role: "approver",
      });

      insertRecording(bundle, {
        recordingId: "rec-draft",
        title: "Draft recording",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-draft",
        currentRevisionState: "draft",
        updatedAt: "2026-08-01T12:05:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-active",
        recordingId: "rec-draft",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: "2026-08-01T12:05:00.000Z",
      });

      insertRecording(bundle, {
        recordingId: "rec-approved",
        title: "Approved recording",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-approved",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-approved",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-completed",
        recordingId: "rec-approved",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "completed",
        updatedAt: "2026-08-01T12:03:00.000Z",
        completedRevisionId: "rev-approved",
      });
      insertAssignment(bundle, {
        id: "assignment-removed",
        recordingId: "rec-approved",
        userId: approver.userId,
        assignedByUserId: admin.userId,
        role: "approver",
        status: "removed",
        updatedAt: "2026-08-01T12:04:00.000Z",
      });

      insertRecording(bundle, {
        recordingId: "rec-record",
        title: "Recorded approval item",
        source: "record",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-record",
        currentRevisionState: "draft",
        transcriptJobState: "running",
        updatedAt: "2026-08-01T12:06:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-approver-active",
        recordingId: "rec-record",
        userId: approver.userId,
        assignedByUserId: admin.userId,
        role: "approver",
        status: "active",
        updatedAt: "2026-08-01T12:06:00.000Z",
      });

      const activeView = listAdministration(admin, { section: "assignments" }, bundle.db);
      expect(activeView.section).toBe("assignments");
      if (activeView.section !== "assignments") {
        throw new Error("Expected assignments section.");
      }
      expect(activeView.filters.status).toBe("active");
      expect(activeView.columns.map((column) => column.id)).toEqual([
        "recording",
        "stage",
        "user",
        "role",
        "updatedAt",
        "actions",
      ]);
      expect(activeView.assignments.map((assignment) => assignment.status)).toEqual([
        "active",
        "active",
      ]);
      expect(activeView.recordings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recordingId: "rec-draft",
            stageLabel: "Draft review",
            compatibility: expect.objectContaining({
              reviewer: expect.objectContaining({ allowed: true, label: "Actionable" }),
              approver: expect.objectContaining({ allowed: true, label: "Actionable" }),
            }),
          }),
          expect.objectContaining({
            recordingId: "rec-approved",
            stageLabel: "Approved",
            compatibility: expect.objectContaining({
              reviewer: expect.objectContaining({
                allowed: false,
                reason: "Reviewer work cannot be assigned to an approved casefile.",
              }),
              approver: expect.objectContaining({ allowed: true, label: "Reopen authority" }),
            }),
          }),
          expect.objectContaining({
            recordingId: "rec-record",
            stageLabel: "Transcribing",
            compatibility: expect.objectContaining({
              reviewer: expect.objectContaining({ allowed: true, label: "Waiting" }),
            }),
          }),
        ]),
      );

      const historyView = listAdministration(
        admin,
        {
          section: "assignments",
          status: "history",
          recordingId: "rec-approved",
          userId: reviewer.userId,
          role: "reviewer",
          from: "2026-08-01T12:02:00.000Z",
          to: "2026-08-01T12:03:30.000Z",
        },
        bundle.db,
      );
      if (historyView.section !== "assignments") {
        throw new Error("Expected assignments section.");
      }
      expect(historyView.columns.map((column) => column.id)).toEqual([
        "recording",
        "user",
        "role",
        "outcome",
        "completedRevision",
        "updatedAt",
      ]);
      expect(historyView.filters.from).toBe("2026-08-01T12:02:00.000Z");
      expect(historyView.filters.to).toBe("2026-08-01T12:03:30.000Z");
      expect(historyView.assignments.map((assignment) => assignment.status)).toEqual([
        "completed",
      ]);
      expect(historyView.assignments[0]).toEqual(
        expect.objectContaining({
          outcomeLabel: "Completed",
          completedRevisionId: "rev-approved",
          completedRevisionLabel: "Approved v1",
          href: "/recordings/rec-approved?revision=rev-approved",
        }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns the policy fact matrix without mutation controls", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      const view = listAdministration(admin, { section: "policy" }, bundle.db);
      expect(view.section).toBe("policy");
      if (view.section !== "policy") {
        throw new Error("Expected policy section.");
      }
      expect(view.profile).toEqual(
        expect.objectContaining({ id: "strict", label: expect.any(String) }),
      );
      expect(view.rows.map((row) => row.id)).toEqual([
        "playback",
        "raw-download",
        "draft-edit",
        "submit",
        "withdraw",
        "approve",
        "request-changes",
        "reopen",
        "export",
        "phone-safety",
      ]);
      expect(view.rows.find((row) => row.id === "playback")?.reviewer).toBe("Allowed");
      expect(view.rows.find((row) => row.id === "export")?.approver).toBe("Allowed");
      expect(view.rows.find((row) => row.id === "raw-download")?.uploader).toBe("Denied");
    } finally {
      bundle.sqlite.close();
    }
  });
});
