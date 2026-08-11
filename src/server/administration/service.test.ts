import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import {
  deleteRecordingPermanently,
  listAdministration,
  recoverRevisionVersion,
  resetWorkspaceLedger,
  setWorkspacePolicyProfile,
} from "@/server/administration/service";
import { openAppDatabase, type AppDatabase } from "@/server/db/client";
import {
  adminActionSessions,
  approvals,
  auditEvents,
  authControl,
  externalIdentities,
  ingestionSessions,
  recordingAssignments,
  recordings,
  revisions,
  securityEvents,
  transcriptJobs,
  users,
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

  it("returns non-authoritative role management facts for every account kind", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "facts-admin@example.com",
        role: "admin",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Linked Reviewer",
        email: "facts-reviewer@example.com",
        role: "reviewer",
      });
      const approver = await createPrincipal(bundle.db, {
        displayName: "Approver",
        email: "facts-approver@example.com",
        role: "approver",
      });
      bundle.db.insert(users).values({
        id: "shadow-inactive",
        email: "shadow@example.com",
        displayName: "Inactive Shadow",
        passwordHash: null,
        role: "uploader",
        isActive: false,
        authVersion: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }).run();
      bundle.db.insert(externalIdentities).values([
        {
          id: "identity-reviewer",
          userId: reviewer.userId,
          issuer: "https://issuer.example/",
          subject: "reviewer-subject",
          status: "active",
          linkedAt: FIXED_NOW,
          linkedByUserId: admin.userId,
          changeReason: "Reviewer link.",
        },
        {
          id: "identity-shadow",
          userId: "shadow-inactive",
          issuer: "https://issuer.example/",
          subject: "shadow-subject",
          status: "active",
          linkedAt: FIXED_NOW,
          linkedByUserId: admin.userId,
          changeReason: "Shadow link.",
        },
      ]).run();
      bundle.db.insert(authControl).values({
        id: 1,
        breakGlassUserId: admin.userId,
        updatedAt: FIXED_NOW,
        updatedByUserId: admin.userId,
        changeReason: "Initial custodian.",
      }).run();

      insertRecording(bundle, {
        recordingId: "rec-reviewer-facts",
        title: "Reviewer facts",
        uploadedByUserId: admin.userId,
        updatedAt: FIXED_NOW,
      });
      insertRecording(bundle, {
        recordingId: "rec-approver-facts",
        title: "Approver facts",
        uploadedByUserId: admin.userId,
        updatedAt: FIXED_NOW,
      });
      insertRecording(bundle, {
        recordingId: "rec-history-facts",
        title: "Historical facts",
        uploadedByUserId: admin.userId,
        updatedAt: FIXED_NOW,
      });
      insertAssignment(bundle, {
        id: "assignment-reviewer-facts",
        recordingId: "rec-reviewer-facts",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: FIXED_NOW,
      });
      insertAssignment(bundle, {
        id: "assignment-approver-facts",
        recordingId: "rec-approver-facts",
        userId: approver.userId,
        assignedByUserId: admin.userId,
        role: "approver",
        status: "active",
        updatedAt: FIXED_NOW,
      });
      insertAssignment(bundle, {
        id: "assignment-history-facts",
        recordingId: "rec-history-facts",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "removed",
        updatedAt: FIXED_NOW,
      });

      const view = listAdministration(admin, { section: "accounts" }, bundle.db);
      if (view.section !== "accounts") {
        throw new Error("Expected accounts section.");
      }
      expect(view.users.find((user) => user.id === admin.userId)).toMatchObject({
        activeAssignments: { reviewer: 0, approver: 0 },
        hasActiveOidcIdentity: false,
        isBreakGlassAdministrator: true,
        isSoleActiveAdministrator: true,
      });
      expect(view.users.find((user) => user.id === reviewer.userId)).toMatchObject({
        activeAssignmentCount: 1,
        activeAssignments: { reviewer: 1, approver: 0 },
        hasActiveOidcIdentity: true,
        isBreakGlassAdministrator: false,
        isSoleActiveAdministrator: false,
      });
      expect(view.users.find((user) => user.id === approver.userId)).toMatchObject({
        activeAssignments: { reviewer: 0, approver: 1 },
      });
      expect(view.users.find((user) => user.id === "shadow-inactive")).toMatchObject({
        hasActiveOidcIdentity: true,
        activeAssignments: { reviewer: 0, approver: 0 },
      });

      await createPrincipal(bundle.db, {
        displayName: "Second Admin",
        email: "facts-admin-2@example.com",
        role: "admin",
      });
      const multiAdminView = listAdministration(
        admin,
        { section: "accounts" },
        bundle.db,
      );
      if (multiAdminView.section !== "accounts") {
        throw new Error("Expected accounts section.");
      }
      expect(
        multiAdminView.users
          .filter((user) => user.role === "admin")
          .every((user) => !user.isSoleActiveAdministrator),
      ).toBe(true);
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


describe("policy profile editing (demo-governance-bringback)", () => {
  it("switches the workspace policy profile, records the audited before/after, and validates input", async () => {
    const bundle = openAppDatabase(":memory:");
    try {
      insertWorkspace(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Ada Admin",
        email: "ada@example.com",
        role: "admin",
      });

      expect(() =>
        setWorkspacePolicyProfile(
          { profileId: "nonsense" as never, actorUserId: admin.userId },
          bundle.db,
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

      const noop = setWorkspacePolicyProfile(
        { profileId: "strict", actorUserId: admin.userId },
        bundle.db,
      );
      expect(noop).toEqual({ profileId: "strict", changed: false });
      expect(bundle.db.select().from(securityEvents).all()).toHaveLength(0);

      const result = setWorkspacePolicyProfile(
        { profileId: "reviewable-approved-export", actorUserId: admin.userId },
        bundle.db,
      );
      expect(result).toEqual({ profileId: "reviewable-approved-export", changed: true });

      const workspace = bundle.db.select().from(workspaces).get()!;
      expect(workspace.policyProfileId).toBe("reviewable-approved-export");

      const events = bundle.db.select().from(securityEvents).all();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("policy.updated");
      expect(events[0].userId).toBe(admin.userId);
      expect(events[0].metadata).toContain("reviewable-approved-export");
    } finally {
      bundle.sqlite.close();
    }
  });
});

describe("revision recovery (demo-governance-bringback)", () => {
  it("recovers an archived revision as the active draft with provenance + audit, and never rewrites history", async () => {
    const bundle = openAppDatabase(":memory:");
    try {
      insertWorkspace(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Ada Admin",
        email: "ada@example.com",
        role: "admin",
      });

      insertRecording(bundle, {
        recordingId: "rec-1",
        title: "History casefile",
        uploadedByUserId: admin.userId,
        currentRevisionId: "rev-v2",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-v2",
        updatedAt: FIXED_NOW,
      });
      bundle.db
        .update(revisions)
        .set({ version: 2 })
        .where(eq(revisions.id, "rev-v2"))
        .run();
      bundle.db.insert(revisions).values({
        id: "rev-v1",
        recordingId: "rec-1",
        version: 1,
        state: "superseded",
        basedOnRevisionId: null,
        createdByRole: "reviewer",
        createdByUserId: null,
        createdAt: FIXED_NOW,
        submittedByUserId: null,
        submittedAt: null,
        approvedAt: null,
        summary: "Original wording",
        segmentsJson: JSON.stringify(baseSegments),
      }).run();

      const result = recoverRevisionVersion(
        { recordingId: "rec-1", sourceRevisionId: "rev-v1", actorUserId: admin.userId },
        bundle.db,
      );
      expect(result.newVersion).toBe(3);

      const recovered = bundle.db.select().from(revisions).where(eq(revisions.id, result.newRevisionId)).get()!;
      expect(recovered.state).toBe("draft");
      expect(recovered.basedOnRevisionId).toBe("rev-v1");
      expect(recovered.summary).toContain("Recovered from v1");
      expect(recovered.segmentsJson).toContain("Hello world.");

      // Lineage intact: v1 and v2 still exist.
      const allVersions = bundle.db.select({ version: revisions.version }).from(revisions).where(eq(revisions.recordingId, "rec-1")).all();
      expect(allVersions.map((row) => row.version).sort()).toEqual([1, 2, 3]);

      const recordingAfter = bundle.db.select().from(recordings).where(eq(recordings.id, "rec-1")).get()!;
      expect(recordingAfter.currentRevisionId).toBe(result.newRevisionId);
      expect(recordingAfter.approvedRevisionId).toBeNull();
      expect(recordingAfter.pendingRevisionId).toBeNull();

      const auditRows = bundle.db.select().from(auditEvents).all();
      expect(auditRows.some((row) => row.type === "revision.recovered" && row.metadata.includes("rev-v1"))).toBe(true);

      expect(() =>
        recoverRevisionVersion(
          { recordingId: "rec-1", sourceRevisionId: result.newRevisionId, actorUserId: admin.userId },
          bundle.db,
        ),
      ).toThrowError(expect.objectContaining({ code: "STATE_CHANGED" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("reject while a submission is pending instead of orphaning the pending row (captain decision 2026-08-10)", async () => {
    const bundle = openAppDatabase(":memory:");
    try {
      insertWorkspace(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Ada Admin",
        email: "ada@example.com",
        role: "admin",
      });

      insertRecording(bundle, {
        recordingId: "rec-pending",
        title: "Pending casefile",
        uploadedByUserId: admin.userId,
        currentRevisionId: "rev-v1",
        updatedAt: FIXED_NOW,
      });
      bundle.db.insert(revisions).values({
        id: "rev-v2-pending",
        recordingId: "rec-pending",
        version: 2,
        state: "pending_approval",
        basedOnRevisionId: "rev-v1",
        createdByRole: "reviewer",
        createdByUserId: null,
        createdAt: FIXED_NOW,
        submittedByUserId: admin.userId,
        submittedAt: FIXED_NOW,
        approvedAt: null,
        summary: "Pending submission",
        segmentsJson: JSON.stringify(baseSegments),
      }).run();
      bundle.db
        .update(recordings)
        .set({
          currentRevisionId: "rev-v2-pending",
          pendingRevisionId: "rev-v2-pending",
        })
        .where(eq(recordings.id, "rec-pending"))
        .run();

      const revisionsBefore = bundle.db.select().from(revisions).all().length;
      expect(() =>
        recoverRevisionVersion(
          { recordingId: "rec-pending", sourceRevisionId: "rev-v1", actorUserId: admin.userId },
          bundle.db,
        ),
      ).toThrowError(expect.objectContaining({ code: "STATE_CHANGED" }));

      // Nothing mutated: the pending row is untouched, no active swap happened.
      expect(bundle.db.select().from(revisions).all()).toHaveLength(revisionsBefore);
      const after = bundle.db.select().from(recordings).where(eq(recordings.id, "rec-pending")).get()!;
      expect(after.currentRevisionId).toBe("rev-v2-pending");
      expect(after.pendingRevisionId).toBe("rev-v2-pending");
    } finally {
      bundle.sqlite.close();
    }
  });
});

describe("recording deletion (demo-governance-bringback)", () => {
  it("deletes the whole casefile, snapshots it before deletion, keeps a single deletion record, and enforces the typed title", async () => {
    const bundle = openAppDatabase(":memory:");
    const snapshotDir = mkdtempSync(join(tmpdir(), "superscriber-purge-snapshot-"));
    try {
      insertWorkspace(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Ada Admin",
        email: "ada@example.com",
        role: "admin",
      });

      insertRecording(bundle, {
        recordingId: "rec-del",
        title: "Delete me now",
        uploadedByUserId: admin.userId,
        currentRevisionId: "rev-v2",
        updatedAt: FIXED_NOW,
      });
      bundle.db.insert(auditEvents).values({
        id: "audit-old",
        recordingId: "rec-del",
        workspaceId: "workspace-1",
        type: "revision.submitted",
        detail: "Submitted.",
        actorRole: "admin",
        actorUserId: admin.userId,
        metadata: "{}",
        createdAt: FIXED_NOW,
      }).run();
      bundle.db.insert(approvals).values({
        id: "approval-1",
        recordingId: "rec-del",
        revisionId: "rev-v2",
        state: "approved",
        actorRole: "approver",
        actorUserId: null,
        actorDisplayName: "Approver",
        effectiveRole: null,
        adminActionSessionId: null,
        createdAt: FIXED_NOW,
        note: null,
      }).run();

      // Gate: exact title required; a mismatch touches nothing and writes no snapshot.
      expect(() =>
        deleteRecordingPermanently(
          { recordingId: "rec-del", expectedTitle: "delete me now", actorUserId: admin.userId },
          bundle.db,
          snapshotDir,
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
      expect(bundle.db.select().from(recordings).all()).toHaveLength(1);
      expect(bundle.db.select().from(securityEvents).all()).toHaveLength(0);

      const result = deleteRecordingPermanently(
        { recordingId: "rec-del", expectedTitle: "Delete me now", actorUserId: admin.userId },
        bundle.db,
        snapshotDir,
      );
      expect(result.title).toBe("Delete me now");
      expect(result.revisionCount).toBe(1);

      // The pre-wipe snapshot (D-5 compensating control) preserves the casefile
      // rows outside the database.
      const snapshot = JSON.parse(readFileSync(result.snapshotPath, "utf8")) as {
        type: string;
        actorUserId: string;
        tables: Record<string, unknown[]>;
      };
      expect(snapshot.type).toBe("recording.purge");
      expect(snapshot.actorUserId).toBe(admin.userId);
      expect(snapshot.tables.auditEvents).toHaveLength(1);
      expect(snapshot.tables.approvals).toHaveLength(1);
      expect(snapshot.tables.revisions).toHaveLength(1);
      expect(snapshot.tables.recording).toHaveLength(1);

      // Every casefile table is empty for that recording.
      expect(bundle.db.select().from(recordings).where(eq(recordings.id, "rec-del")).all()).toHaveLength(0);
      for (const [table, label] of [
        [revisions, "revisions"],
        [approvals, "approvals"],
        [ingestionSessions, "ingestion_sessions"],
        [transcriptJobs, "transcript_jobs"],
        [recordingAssignments, "recording_assignments"],
        [auditEvents, "audit_events"],
      ] as const) {
        expect(
          bundle.db
            .select()
            .from(table)
            .where(eq(table.recordingId, "rec-del"))
            .all(),
          label,
        ).toHaveLength(0);
      }

      // The surviving deletion record in security_events, pointing at the snapshot.
      const security = bundle.db.select().from(securityEvents).all();
      expect(security).toHaveLength(1);
      expect(security[0].type).toBe("recording.deleted");
      expect(security[0].detail).toContain("Delete me now");
      expect(security[0].userId).toBe(admin.userId);
      expect(security[0].metadata).toContain("rec-del");
      expect(security[0].metadata).toContain(result.snapshotPath);

      // Unknown recording is a clean NOT_FOUND and writes no snapshot.
      expect(() =>
        deleteRecordingPermanently(
          { recordingId: "rec-nope", expectedTitle: "x", actorUserId: admin.userId },
          bundle.db,
          snapshotDir,
        ),
      ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    } finally {
      bundle.sqlite.close();
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});

describe("ledger reset (demo-governance-bringback)", () => {
  it("wipes governed ledger tables, snapshots them first, keeps one reset record, enforces the phrase", async () => {
    const bundle = openAppDatabase(":memory:");
    const snapshotDir = mkdtempSync(join(tmpdir(), "superscriber-reset-snapshot-"));
    try {
      insertWorkspace(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Ada Admin",
        email: "ada@example.com",
        role: "admin",
      });
      const approver = await createPrincipal(bundle.db, {
        displayName: "Ari Approver",
        email: "ari@example.com",
        role: "approver",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Riley Reviewer",
        email: "riley@example.com",
        role: "reviewer",
      });
      insertRecording(bundle, {
        recordingId: "rec-reset",
        title: "Ledger reset fixture",
        uploadedByUserId: admin.userId,
        currentRevisionId: "rev-reset",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-reset",
        updatedAt: FIXED_NOW,
      });
      insertAssignment(bundle, {
        id: "assignment-completed",
        recordingId: "rec-reset",
        userId: approver.userId,
        assignedByUserId: admin.userId,
        role: "approver",
        status: "completed",
        completedRevisionId: "rev-reset",
        updatedAt: FIXED_NOW,
      });
      insertAssignment(bundle, {
        id: "assignment-removed",
        recordingId: "rec-reset",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "removed",
        updatedAt: FIXED_NOW,
      });
      insertAssignment(bundle, {
        id: "assignment-active",
        recordingId: "rec-reset",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: FIXED_NOW,
      });

      bundle.db.insert(auditEvents).values({
        id: "a1", workspaceId: "workspace-1", recordingId: null, type: "recording.created",
        detail: "x", actorRole: "admin", actorUserId: admin.userId, metadata: "{}", createdAt: FIXED_NOW,
      }).run();
      bundle.db.insert(securityEvents).values({
        id: "s1", type: "recording.deleted", outcome: "success", userId: admin.userId,
        detail: "old", metadata: "{}", createdAt: FIXED_NOW,
      }).run();

      expect(() =>
        resetWorkspaceLedger(
          { actorUserId: admin.userId, expectedPhrase: "reset required" },
          bundle.db,
          snapshotDir,
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
      expect(bundle.db.select().from(auditEvents).all()).toHaveLength(1);

      const result = resetWorkspaceLedger(
        { actorUserId: admin.userId, expectedPhrase: "RESET REQUIRED" },
        bundle.db,
        snapshotDir,
      );
      expect(result.before.auditEvents).toBe(1);
      expect(result.before.endedAssignments).toBe(2);
      expect(result.before.securityEvents).toBe(1);

      // The pre-wipe snapshot (D-5 compensating control) holds every cleared row.
      const snapshot = JSON.parse(readFileSync(result.snapshotPath, "utf8")) as {
        type: string;
        tables: Record<string, unknown[]>;
      };
      expect(snapshot.type).toBe("ledger.reset");
      expect(snapshot.tables.auditEvents).toHaveLength(1);
      expect(snapshot.tables.endedAssignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "assignment-completed" }),
          expect.objectContaining({ id: "assignment-removed" }),
        ]),
      );
      expect(snapshot.tables.endedAssignments).toHaveLength(2);
      expect(snapshot.tables.securityEvents).toHaveLength(1);

      expect(bundle.db.select().from(auditEvents).all()).toHaveLength(0);
      expect(bundle.db.select().from(approvals).all()).toHaveLength(0);
      expect(bundle.db.select().from(adminActionSessions).all()).toHaveLength(0);
      expect(bundle.db.select().from(recordingAssignments).all()).toEqual([
        expect.objectContaining({ id: "assignment-active" }),
      ]);

      const surviving = bundle.db.select().from(securityEvents).all();
      expect(surviving).toHaveLength(1);
      expect(surviving[0].type).toBe("ledger.reset");
      expect(surviving[0].userId).toBe(admin.userId);
      expect(surviving[0].detail).toContain("1 audit events");
      expect(surviving[0].metadata).toContain("clearedSecurityEvents");
      expect(surviving[0].metadata).toContain(result.snapshotPath);
    } finally {
      bundle.sqlite.close();
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});
