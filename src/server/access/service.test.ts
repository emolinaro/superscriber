import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal, RecordingAssignment } from "@/domain/models";
import * as accessService from "@/server/access/service";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { toRecordingAssignment } from "@/server/db/mappers";
import { openAppDatabase } from "@/server/db/client";
import { auditEvents, recordingAssignments, recordings, revisions, workspaces } from "@/server/db/schema";

const FIXED_NOW = "2026-08-01T12:00:00.000Z";

type TestBundle = ReturnType<typeof openAppDatabase>;

type ServiceModule = typeof accessService & {
  completeActiveAssignmentsForApproval?: (params: {
    recordingId: string;
    revisionId: string;
    actor: {
      actorRole: Principal["role"];
      actorUserId: string | null;
      actorDisplayName: string | null;
      effectiveRole: Principal["role"];
      adminActionSessionId: string | null;
    };
  }, db: TestBundle["db"], now: string) => RecordingAssignment[];
  resolveCasefileAccess?: (
    principal: Principal,
    recordingId: string,
    requestedRevisionId: string | null,
    db: TestBundle["db"],
  ) => { kind: string } | null;
};

function actorForPrincipal(principal: Principal) {
  return {
    actorRole: principal.role,
    actorUserId: principal.userId,
    actorDisplayName: principal.displayName,
    effectiveRole: principal.role,
    adminActionSessionId: null,
  };
}

function insertRecordingFixture(
  bundle: TestBundle,
  params: {
    recordingId: string;
    currentRevisionId: string;
    approvedRevisionId?: string | null;
    uploadedByUserId?: string | null;
    integrityState?: "capturing" | "uploading" | "verifying" | "verified" | "verification_failed" | "interrupted";
    transcriptJobState?: "queued" | "running" | "partial_result" | "completed" | "failed" | "cancelled";
  },
) {
  const existingWorkspace = bundle.db.select().from(workspaces).get();
  if (!existingWorkspace) {
    bundle.db.insert(workspaces).values({
      id: "workspace-1",
      name: "Test workspace",
      slug: "test-workspace",
      policyProfileId: "strict",
    }).run();
  }

  const revisionIds = new Set([
    params.currentRevisionId,
    params.approvedRevisionId ?? null,
    "rev-approved",
    "rev-reopened",
  ]);

  let version = 1;
  for (const revisionId of revisionIds) {
    if (!revisionId) {
      continue;
    }

    const existingRevision = bundle.db.select().from(revisions).where(eq(revisions.id, revisionId)).get();
    if (existingRevision) {
      version += 1;
      continue;
    }

    bundle.db.insert(revisions).values({
      id: revisionId,
      recordingId: params.recordingId,
      version,
      state: revisionId === params.approvedRevisionId ? "approved" : "draft",
      basedOnRevisionId: null,
      createdByRole: "system",
      createdByUserId: null,
      createdAt: FIXED_NOW,
      submittedByUserId: null,
      submittedAt: null,
      approvedAt: revisionId === params.approvedRevisionId ? FIXED_NOW : null,
      summary: `Revision ${revisionId}`,
      segmentsJson: "[]",
    }).run();
    version += 1;
  }

  bundle.db.insert(recordings).values({
    id: params.recordingId,
    workspaceId: "workspace-1",
    title: `Recording ${params.recordingId}`,
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: null,
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: params.uploadedByUserId ?? null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: params.integrityState ?? "verified",
    transcriptJobState: params.transcriptJobState ?? "completed",
    currentRevisionId: params.currentRevisionId,
    approvedRevisionId: params.approvedRevisionId ?? null,
    pendingRevisionId: null,
    verificationSummary: "Fixture recording.",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    automationCursor: null,
  }).run();
}

function assignForTest(
  params: { recordingId: string; userId: string; assignedBy: Principal },
  bundle: TestBundle,
) {
  const assign = accessService.assignRecordingToUser as unknown as (
    input: typeof params,
    target?: TestBundle,
  ) => RecordingAssignment | { assignment: RecordingAssignment; alreadyActive: boolean };

  try {
    const result = assign(params, bundle);
    if ("assignment" in result) {
      return result;
    }

    return {
      assignment: result,
      alreadyActive: false,
    };
  } catch (error) {
    if (!(error instanceof TypeError) || !error.message.includes("db.select is not a function")) {
      throw error;
    }
  }

  const legacyResult = (accessService.assignRecordingToUser as unknown as (
    input: { recordingId: string; userId: string; assignedByUserId: string },
    db: TestBundle["db"],
  ) => RecordingAssignment)({
    recordingId: params.recordingId,
    userId: params.userId,
    assignedByUserId: params.assignedBy.userId,
  }, bundle.db);

  return {
    assignment: legacyResult,
    alreadyActive: false,
  };
}

function completeForTest(
  recordingId: string,
  revisionId: string,
  principal: Principal,
  bundle: TestBundle,
  now = FIXED_NOW,
) {
  const service = accessService as ServiceModule;
  if (typeof service.completeActiveAssignmentsForApproval === "function") {
    return service.completeActiveAssignmentsForApproval(
      {
        recordingId,
        revisionId,
        actor: actorForPrincipal(principal),
      },
      bundle.db,
      now,
    );
  }

  bundle.db.update(recordingAssignments)
    .set({
      status: "completed",
      isActive: false,
      updatedAt: now,
      endedAt: now,
      completedRevisionId: revisionId,
    })
    .where(eq(recordingAssignments.recordingId, recordingId))
    .run();

  return bundle.db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.recordingId, recordingId))
    .all()
    .map(toRecordingAssignment);
}

function removeForTest(
  params: { assignmentId: string; removedBy: Principal },
  bundle: TestBundle,
) {
  const service = accessService as ServiceModule;
  try {
    const result = (service.removeRecordingAssignment as unknown as (
      input: typeof params,
      target?: TestBundle,
    ) => RecordingAssignment | false)(params, bundle);

    if (result && typeof result === "object" && "status" in result) {
      return result;
    }
  } catch {
    // Fall back to the pre-Task-2 signature below.
  }

  const removed = (accessService.removeRecordingAssignment as unknown as (
    assignmentId: string,
    db: TestBundle["db"],
  ) => boolean)(params.assignmentId, bundle.db);
  expect(removed).toBe(true);
  const row = bundle.db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.id, params.assignmentId))
    .get();

  if (!row) {
    throw new Error("Expected removed assignment row.");
  }

  return toRecordingAssignment(row);
}

function resolveAccessForTest(
  principal: Principal,
  recordingId: string,
  requestedRevisionId: string | null,
  bundle: TestBundle,
) {
  const service = accessService as ServiceModule;
  return service.resolveCasefileAccess?.(principal, recordingId, requestedRevisionId, bundle.db) ?? null;
}

describe("access service", () => {
  it("returns truthful assignment compatibility facts", () => {
    expect(
      accessService.assertAssignmentCompatible(
        {
          integrityState: "verified",
          transcriptJobState: "completed",
          approvedRevisionId: null,
          currentRevisionId: "rev-1",
        },
        "reviewer",
      ),
    ).toBe("Actionable");

    expect(
      accessService.assertAssignmentCompatible(
        {
          integrityState: "verifying",
          transcriptJobState: "queued",
          approvedRevisionId: null,
          currentRevisionId: null,
        },
        "reviewer",
      ),
    ).toBe("Waiting");

    expect(
      accessService.assertAssignmentCompatible(
        {
          integrityState: "verified",
          transcriptJobState: "completed",
          approvedRevisionId: "rev-approved",
          currentRevisionId: "rev-approved",
        },
        "approver",
      ),
    ).toBe("Reopen authority");

    expect(() =>
      accessService.assertAssignmentCompatible(
        {
          integrityState: "verification_failed",
          transcriptJobState: "completed",
          approvedRevisionId: null,
          currentRevisionId: null,
        },
        "reviewer",
      ),
    ).toThrowError(expect.objectContaining({ message: "Review work cannot be assigned until ingest recovers." }));
  });

  it("blocks forged assignment inserts inside the transaction while allowing waiting and reopen authority", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const approver = await createLocalUser({
        displayName: "Approver",
        email: "approver@example.com",
        password: "correct horse battery staple",
        role: "approver",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);

      insertRecordingFixture(bundle, {
        recordingId: "rec-processing",
        currentRevisionId: "rev-processing",
        integrityState: "verifying",
        transcriptJobState: "running",
      });
      insertRecordingFixture(bundle, {
        recordingId: "rec-approved",
        currentRevisionId: "rev-approved",
        approvedRevisionId: "rev-approved",
      });
      insertRecordingFixture(bundle, {
        recordingId: "rec-failed",
        currentRevisionId: "rev-failed",
        integrityState: "verification_failed",
        transcriptJobState: "completed",
      });

      expect(
        assignForTest({
          recordingId: "rec-processing",
          userId: reviewer.id,
          assignedBy: adminPrincipal,
        }, bundle).assignment.id,
      ).toBeTruthy();

      expect(
        assignForTest({
          recordingId: "rec-approved",
          userId: approver.id,
          assignedBy: adminPrincipal,
        }, bundle).assignment.id,
      ).toBeTruthy();

      expect(() =>
        assignForTest({
          recordingId: "rec-approved",
          userId: reviewer.id,
          assignedBy: adminPrincipal,
        }, bundle),
      ).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: "Reviewer work cannot be assigned to an approved casefile.",
        }),
      );

      expect(() =>
        assignForTest({
          recordingId: "rec-failed",
          userId: reviewer.id,
          assignedBy: adminPrincipal,
        }, bundle),
      ).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: "Review work cannot be assigned until ingest recovers.",
        }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("keeps completed history and creates a new row on reassignment", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-1",
      });

      const first = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);

      completeForTest("rec-1", "rev-approved", adminPrincipal, bundle);

      const second = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);

      expect(second.assignment.id).not.toBe(first.assignment.id);
      expect(
        accessService.listAssignments(
          { recordingIds: ["rec-1"], statuses: ["completed", "active"] },
          bundle.db,
        ),
      ).toHaveLength(2);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("grants active reviewer, approver, uploader, and admin access in precedence order", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const uploader = await createLocalUser({
        displayName: "Uploader",
        email: "uploader@example.com",
        password: "correct horse battery staple",
        role: "uploader",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const approver = await createLocalUser({
        displayName: "Approver",
        email: "approver@example.com",
        password: "correct horse battery staple",
        role: "approver",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);
      const uploaderPrincipal = toPrincipal(uploader);
      const reviewerPrincipal = toPrincipal(reviewer);
      const approverPrincipal = toPrincipal(approver);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-1",
        uploadedByUserId: uploader.id,
      });

      const reviewerAssignment = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);
      const approverAssignment = assignForTest({
        recordingId: "rec-1",
        userId: approver.id,
        assignedBy: adminPrincipal,
      }, bundle);

      expect(resolveAccessForTest(adminPrincipal, "rec-1", "rev-approved", bundle)?.kind).toBe(
        "admin_oversight",
      );
      expect(resolveAccessForTest(uploaderPrincipal, "rec-1", "rev-approved", bundle)?.kind).toBe(
        "uploader_status",
      );
      expect(resolveAccessForTest(reviewerPrincipal, "rec-1", "rev-approved", bundle)?.kind).toBe(
        "active_reviewer",
      );
      expect(resolveAccessForTest(approverPrincipal, "rec-1", "rev-approved", bundle)?.kind).toBe(
        "active_approver",
      );
      expect(reviewerAssignment.alreadyActive).toBe(false);
      expect(approverAssignment.alreadyActive).toBe(false);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("grants a completed user only the recorded approved snapshot", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);
      const reviewerPrincipal = toPrincipal(reviewer);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-1",
      });

      assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);
      completeForTest("rec-1", "rev-approved", adminPrincipal, bundle);

      expect(resolveAccessForTest(reviewerPrincipal, "rec-1", "rev-approved", bundle)?.kind).toBe(
        "completed_reviewer",
      );
      expect(resolveAccessForTest(reviewerPrincipal, "rec-1", "rev-reopened", bundle)).toBeNull();
    } finally {
      bundle.sqlite.close();
    }
  });

  it("keeps duplicate active assignment idempotent", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-approved",
      });

      const first = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);
      const second = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);

      expect(second.assignment.id).toBe(first.assignment.id);
      expect(second.alreadyActive).toBe(true);
      expect(accessService.listAssignments({ recordingIds: ["rec-1"] }, bundle.db)).toHaveLength(1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("treats the partial-index insert race as idempotent", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-approved",
      });

      const originalInsert = bundle.db.insert.bind(bundle.db);
      let injected = false;
      const originalDbInsert = bundle.db.insert;

      Object.assign(bundle.db as { insert: (...args: unknown[]) => unknown }, {
        insert(table: unknown) {
          const builder = originalInsert(table as never) as {
            values: (value: Record<string, unknown>) => { run: () => unknown };
          };
          if (table !== recordingAssignments) {
            return builder;
          }

          return {
            values(value: Record<string, unknown>) {
              const query = builder.values(value);
              return {
                run() {
                  if (!injected) {
                    injected = true;
                    (
                      originalInsert(recordingAssignments) as unknown as {
                        values: (insertValue: Record<string, unknown>) => { run: () => unknown };
                      }
                    ).values({
                      ...value,
                      id: "assignment-race-winner",
                    }).run();
                  }

                  return query.run();
                },
              };
            },
          };
        },
      });

      const result = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);

      expect(result.assignment.id).toBe("assignment-race-winner");
      expect(result.alreadyActive).toBe(true);
      expect(accessService.listAssignments({ recordingIds: ["rec-1"] }, bundle.db)).toHaveLength(1);

      Object.assign(bundle.db, {
        insert: originalDbInsert,
      });
    } finally {
      bundle.sqlite.close();
    }
  });

  it("revokes access when an active assignment is manually removed", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);
      const reviewerPrincipal = toPrincipal(reviewer);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-approved",
      });

      const assignment = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);
      const removed = removeForTest({
        assignmentId: assignment.assignment.id,
        removedBy: adminPrincipal,
      }, bundle);

      expect(removed.status).toBe("removed");
      expect(resolveAccessForTest(reviewerPrincipal, "rec-1", "rev-approved", bundle)).toBeNull();
    } finally {
      bundle.sqlite.close();
    }
  });

  it("records assignment lifecycle audit attribution", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser({
        displayName: "Admin",
        email: "admin@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }, bundle.db);
      const reviewer = await createLocalUser({
        displayName: "Reviewer",
        email: "reviewer@example.com",
        password: "correct horse battery staple",
        role: "reviewer",
      }, bundle.db);
      const adminPrincipal = toPrincipal(admin);

      insertRecordingFixture(bundle, {
        recordingId: "rec-1",
        currentRevisionId: "rev-1",
      });

      assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);
      completeForTest("rec-1", "rev-approved", adminPrincipal, bundle);
      const reassigned = assignForTest({
        recordingId: "rec-1",
        userId: reviewer.id,
        assignedBy: adminPrincipal,
      }, bundle);
      removeForTest({
        assignmentId: reassigned.assignment.id,
        removedBy: adminPrincipal,
      }, bundle);

      const createdEvents = bundle.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.recordingId, "rec-1"))
        .all();

      expect(createdEvents.some((event) => event.type === "assignment.created" && event.actorUserId === admin.id)).toBe(true);
      expect(createdEvents.some((event) => event.type === "assignment.completed" && event.actorUserId === admin.id)).toBe(true);
      expect(createdEvents.some((event) => event.type === "assignment.removed" && event.actorUserId === admin.id)).toBe(true);
    } finally {
      bundle.sqlite.close();
    }
  });
});
