import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type AppUser,
  type AssignmentRole,
  type AssignmentStatus,
  type Principal,
  type RecordingAssignment,
  type UserRole,
} from "@/domain/models";
import {
  actorContextForPrincipal,
  insertAuditEvent,
  type ActorContext,
} from "@/server/casefile/audit";
import { CasefileCommandError } from "@/server/casefile/errors";
import {
  getAppDb,
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { toAppUser, toRecordingAssignment } from "@/server/db/mappers";
import { recordingAssignments, recordings, users } from "@/server/db/schema";
import { runGovernedTransaction } from "@/server/db/transaction";

export type AssignmentSummary = {
  id: string;
  recordingId: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  userRole: UserRole;
  createdAt: string;
  updatedAt: string;
};

export type AccountDirectoryEntry = AppUser & {
  activeAssignmentCount: number;
};

export type CasefileAccessGrant =
  | {
      kind: "admin_oversight";
      recordingId: string;
    }
  | {
      kind: "uploader_status";
      recordingId: string;
    }
  | {
      kind: "active_reviewer" | "active_approver";
      recordingId: string;
      assignmentId: string;
    }
  | {
      kind: "completed_reviewer" | "completed_approver";
      recordingId: string;
      assignmentId: string;
      revisionId: string;
    };

function nowIso() {
  return new Date().toISOString();
}

function isIngestFailure(recording: {
  integrityState: "capturing" | "uploading" | "verifying" | "verified" | "verification_failed" | "interrupted";
  transcriptJobState: "queued" | "running" | "partial_result" | "completed" | "failed" | "cancelled";
}) {
  return (
    recording.integrityState === "interrupted" ||
    recording.integrityState === "verification_failed" ||
    recording.transcriptJobState === "failed" ||
    recording.transcriptJobState === "cancelled"
  );
}

function isProcessing(recording: {
  integrityState: "capturing" | "uploading" | "verifying" | "verified" | "verification_failed" | "interrupted";
  transcriptJobState: "queued" | "running" | "partial_result" | "completed" | "failed" | "cancelled";
}) {
  return (
    recording.integrityState === "capturing" ||
    recording.integrityState === "uploading" ||
    recording.integrityState === "verifying" ||
    recording.transcriptJobState === "queued" ||
    recording.transcriptJobState === "running" ||
    recording.transcriptJobState === "partial_result"
  );
}

export function assertAssignmentCompatible(
  recording: {
    integrityState: "capturing" | "uploading" | "verifying" | "verified" | "verification_failed" | "interrupted";
    transcriptJobState: "queued" | "running" | "partial_result" | "completed" | "failed" | "cancelled";
    approvedRevisionId: string | null;
    currentRevisionId: string | null;
  },
  assignmentRole: AssignmentRole,
): "Actionable" | "Waiting" | "Reopen authority" {
  if (isIngestFailure(recording)) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Review work cannot be assigned until ingest recovers.",
    );
  }

  if (recording.approvedRevisionId && assignmentRole === "reviewer") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Reviewer work cannot be assigned to an approved casefile.",
    );
  }

  if (recording.approvedRevisionId) {
    return "Reopen authority";
  }

  if (isProcessing(recording)) {
    return "Waiting";
  }

  return "Actionable";
}

function activeStatusCondition(statuses: AssignmentStatus[]) {
  return statuses.length === 1
    ? eq(recordingAssignments.status, statuses[0])
    : inArray(recordingAssignments.status, statuses);
}

function getRecordingContext(db: AppDatabase, recordingId: string) {
  return db
    .select({
      id: recordings.id,
      workspaceId: recordings.workspaceId,
      currentRevisionId: recordings.currentRevisionId,
      approvedRevisionId: recordings.approvedRevisionId,
      integrityState: recordings.integrityState,
      transcriptJobState: recordings.transcriptJobState,
      uploadedByUserId: recordings.uploadedByUserId,
    })
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .get();
}

function getRecordingContextOrThrow(db: AppDatabase, recordingId: string) {
  const recording = getRecordingContext(db, recordingId);
  if (!recording) {
    throw new Error("Choose a valid recording before updating assignments.");
  }

  return recording;
}

function findActiveAssignment(
  db: AppDatabase,
  userId: string,
  recordingId: string,
  assignmentRole?: AssignmentRole,
) {
  const conditions = [
    eq(recordingAssignments.recordingId, recordingId),
    eq(recordingAssignments.userId, userId),
    eq(recordingAssignments.status, "active"),
  ];

  if (assignmentRole) {
    conditions.push(eq(recordingAssignments.assignmentRole, assignmentRole));
  }

  return db
    .select()
    .from(recordingAssignments)
    .where(and(...conditions))
    .get();
}

function findCompletedAssignment(
  db: AppDatabase,
  userId: string,
  recordingId: string,
  requestedRevisionId: string | null,
) {
  if (!requestedRevisionId) {
    return null;
  }

  return db
    .select()
    .from(recordingAssignments)
    .where(
      and(
        eq(recordingAssignments.recordingId, recordingId),
        eq(recordingAssignments.userId, userId),
        eq(recordingAssignments.status, "completed"),
        eq(recordingAssignments.completedRevisionId, requestedRevisionId),
      ),
    )
    .orderBy(desc(recordingAssignments.updatedAt))
    .get();
}

function completedGrantForAssignment(assignment: typeof recordingAssignments.$inferSelect) {
  return {
    kind:
      assignment.assignmentRole === "reviewer"
        ? "completed_reviewer"
        : "completed_approver",
    recordingId: assignment.recordingId,
    assignmentId: assignment.id,
    revisionId: assignment.completedRevisionId!,
  } satisfies CasefileAccessGrant;
}

function isActiveAssignmentUniqueConstraintError(error: unknown) {
  return (
    error instanceof Error &&
    /recording_assignments_active_unique|UNIQUE constraint failed: recording_assignments\./.test(
      error.message,
    )
  );
}

export function listLocalUsers(db: AppDatabase = getAppDb()) {
  const rows = db.select().from(users).orderBy(users.role, users.displayName).all();

  const counts = db
    .select({
      userId: recordingAssignments.userId,
      id: recordingAssignments.id,
    })
    .from(recordingAssignments)
    .where(eq(recordingAssignments.status, "active"))
    .all()
    .reduce<Map<string, number>>((map, row) => {
      map.set(row.userId, (map.get(row.userId) ?? 0) + 1);
      return map;
    }, new Map());

  return rows.map((row) => ({
    ...toAppUser(row),
    activeAssignmentCount: counts.get(row.id) ?? 0,
  })) satisfies AccountDirectoryEntry[];
}

export function listAssignableUsers(db: AppDatabase = getAppDb()) {
  return listLocalUsers(db).filter((user) => user.role === "reviewer" || user.role === "approver");
}

export function listAssignments(
  filters?: {
    recordingIds?: string[];
    userId?: string;
    statuses?: AssignmentStatus[];
  },
  db: AppDatabase = getAppDb(),
) {
  const statuses = filters?.statuses?.length ? filters.statuses : (["active"] satisfies AssignmentStatus[]);
  const conditions = [activeStatusCondition(statuses)];

  if (filters?.recordingIds && filters.recordingIds.length > 0) {
    conditions.push(inArray(recordingAssignments.recordingId, filters.recordingIds));
  }
  if (filters?.userId) {
    conditions.push(eq(recordingAssignments.userId, filters.userId));
  }

  const rows = db
    .select({
      id: recordingAssignments.id,
      recordingId: recordingAssignments.recordingId,
      userId: recordingAssignments.userId,
      createdAt: recordingAssignments.createdAt,
      updatedAt: recordingAssignments.updatedAt,
      userDisplayName: users.displayName,
      userEmail: users.email,
      userRole: recordingAssignments.assignmentRole,
    })
    .from(recordingAssignments)
    .innerJoin(users, eq(recordingAssignments.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(recordingAssignments.createdAt))
    .all();

  return rows satisfies AssignmentSummary[];
}

export function assignmentMapByRecordingId(
  recordingIds: string[],
  db: AppDatabase = getAppDb(),
) {
  const map = new Map<string, AssignmentSummary[]>();

  if (recordingIds.length === 0) {
    return map;
  }

  for (const assignment of listAssignments({ recordingIds }, db)) {
    const existing = map.get(assignment.recordingId) ?? [];
    existing.push(assignment);
    map.set(assignment.recordingId, existing);
  }

  return map;
}

export function assignRecordingToUser(
  params: { recordingId: string; userId: string; assignedBy: Principal },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): { assignment: RecordingAssignment; alreadyActive: boolean } {
  const user = bundle.db.select().from(users).where(eq(users.id, params.userId)).get();
  if (!user || !user.isActive) {
    throw new Error("Choose an active user before assigning a recording.");
  }

  if (user.role !== "reviewer" && user.role !== "approver") {
    throw new Error("Only reviewer and approver accounts can receive recording assignments.");
  }

  const assignmentRole = user.role as AssignmentRole;

  return runGovernedTransaction((db, now) => {
    const active = findActiveAssignment(db, params.userId, params.recordingId, assignmentRole);
    if (active) {
      return { assignment: toRecordingAssignment(active), alreadyActive: true };
    }

    const recording = getRecordingContextOrThrow(db, params.recordingId);
    assertAssignmentCompatible(recording, assignmentRole);

    const assignment: RecordingAssignment = {
      id: crypto.randomUUID(),
      recordingId: params.recordingId,
      userId: params.userId,
      assignedByUserId: params.assignedBy.userId,
      assignmentRole,
      status: "active",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      endReason: null,
      completedRevisionId: null,
      removedByUserId: null,
    };

    try {
      db.insert(recordingAssignments).values(assignment).run();
    } catch (error) {
      if (!isActiveAssignmentUniqueConstraintError(error)) {
        throw error;
      }

      const raced = findActiveAssignment(db, params.userId, params.recordingId, assignmentRole);
      if (!raced) {
        throw error;
      }

      return { assignment: toRecordingAssignment(raced), alreadyActive: true };
    }

    insertAuditEvent(db, {
      workspaceId: recording.workspaceId,
      recordingId: recording.id,
      actor: actorContextForPrincipal(params.assignedBy),
      type: "assignment.created",
      detail: `Recording assigned to ${user.displayName} as ${assignmentRole}.`,
      metadata: {
        assignmentId: assignment.id,
        assignedUserId: params.userId,
        assignmentRole,
      },
      createdAt: now,
    });

    return { assignment, alreadyActive: false };
  }, bundle);
}

export function removeRecordingAssignment(
  params: { assignmentId: string; removedBy: Principal },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): RecordingAssignment {
  const existing = bundle.db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.id, params.assignmentId))
    .get();

  if (!existing) {
    throw new Error("Recording assignment not found.");
  }

  if (existing.status !== "active") {
    return toRecordingAssignment(existing);
  }

  return runGovernedTransaction((db, now) => {
    const current = db
      .select()
      .from(recordingAssignments)
      .where(eq(recordingAssignments.id, params.assignmentId))
      .get();

    if (!current) {
      throw new Error("Recording assignment not found.");
    }

    if (current.status !== "active") {
      return toRecordingAssignment(current);
    }

    db.update(recordingAssignments)
      .set({
        status: "removed",
        isActive: false,
        endedAt: now,
        endReason: "removed_by_admin",
        removedByUserId: params.removedBy.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(recordingAssignments.id, params.assignmentId),
          eq(recordingAssignments.status, "active"),
        ),
      )
      .run();

    const removed = db
      .select()
      .from(recordingAssignments)
      .where(eq(recordingAssignments.id, params.assignmentId))
      .get();

    if (!removed) {
      throw new Error("Recording assignment not found.");
    }

    const recording = getRecordingContextOrThrow(db, removed.recordingId);
    insertAuditEvent(db, {
      workspaceId: recording.workspaceId,
      recordingId: recording.id,
      actor: actorContextForPrincipal(params.removedBy),
      type: "assignment.removed",
      detail: "Recording assignment removed.",
      metadata: {
        assignmentId: removed.id,
        assignedUserId: removed.userId,
        assignmentRole: removed.assignmentRole,
      },
      createdAt: now,
    });

    return toRecordingAssignment(removed);
  }, bundle);
}

export function completeActiveAssignmentsForApproval(
  params: { recordingId: string; revisionId: string; actor: ActorContext },
  db: AppDatabase,
  now: string,
): RecordingAssignment[] {
  const activeRows = db
    .select()
    .from(recordingAssignments)
    .where(
      and(
        eq(recordingAssignments.recordingId, params.recordingId),
        eq(recordingAssignments.status, "active"),
      ),
    )
    .all();

  if (activeRows.length === 0) {
    return [];
  }

  const recording = getRecordingContextOrThrow(db, params.recordingId);

  db.update(recordingAssignments)
    .set({
      status: "completed",
      isActive: false,
      endedAt: now,
      endReason: null,
      completedRevisionId: params.revisionId,
      removedByUserId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(recordingAssignments.recordingId, params.recordingId),
        eq(recordingAssignments.status, "active"),
      ),
    )
    .run();

  const completedAssignments = activeRows.map((row) =>
    toRecordingAssignment({
      ...row,
      status: "completed",
      isActive: false,
      endedAt: now,
      endReason: null,
      completedRevisionId: params.revisionId,
      removedByUserId: null,
      updatedAt: now,
    }),
  );

  for (const assignment of completedAssignments) {
    insertAuditEvent(db, {
      workspaceId: recording.workspaceId,
      recordingId: recording.id,
      actor: params.actor,
      type: "assignment.completed",
      detail: `Recording assignment completed for approved revision ${params.revisionId}.`,
      metadata: {
        assignmentId: assignment.id,
        assignedUserId: assignment.userId,
        assignmentRole: assignment.assignmentRole,
        revisionId: params.revisionId,
      },
      createdAt: now,
    });
  }

  return completedAssignments;
}

export function resolveCasefileAccess(
  principal: Principal,
  recordingId: string,
  requestedRevisionId: string | null,
  db: AppDatabase = getAppDb(),
): CasefileAccessGrant | null {
  if (principal.role === "admin") {
    return { kind: "admin_oversight", recordingId };
  }

  const recording = getRecordingContext(db, recordingId);
  if (!recording) {
    return null;
  }

  if (recording.uploadedByUserId === principal.userId) {
    return { kind: "uploader_status", recordingId };
  }

  const active = findActiveAssignment(db, principal.userId, recordingId);
  if (active) {
    return {
      kind: active.assignmentRole === "reviewer" ? "active_reviewer" : "active_approver",
      recordingId,
      assignmentId: active.id,
    };
  }

  const completed = findCompletedAssignment(db, principal.userId, recordingId, requestedRevisionId);
  return completed ? completedGrantForAssignment(completed) : null;
}

export function visibleRecordingIdsForPrincipal(
  principal: Principal,
  db: AppDatabase = getAppDb(),
) {
  if (principal.role === "admin") {
    return null;
  }

  const visibleIds = new Set<string>();

  for (const row of db
    .select({ id: recordings.id })
    .from(recordings)
    .where(eq(recordings.uploadedByUserId, principal.userId))
    .all()) {
    visibleIds.add(row.id);
  }

  for (const row of db
    .select({ recordingId: recordingAssignments.recordingId })
    .from(recordingAssignments)
    .where(
      and(
        eq(recordingAssignments.userId, principal.userId),
        eq(recordingAssignments.status, "active"),
      ),
    )
    .all()) {
    visibleIds.add(row.recordingId);
  }

  for (const row of db
    .select({ recordingId: recordingAssignments.recordingId })
    .from(recordingAssignments)
    .innerJoin(recordings, eq(recordingAssignments.recordingId, recordings.id))
    .where(
      and(
        eq(recordingAssignments.userId, principal.userId),
        eq(recordingAssignments.status, "completed"),
        eq(recordingAssignments.completedRevisionId, recordings.currentRevisionId),
      ),
    )
    .all()) {
    visibleIds.add(row.recordingId);
  }

  return visibleIds;
}

export function canAccessRecording(
  principal: Principal,
  recordingId: string,
  db: AppDatabase = getAppDb(),
) {
  const requestedRevisionId =
    db
      .select({ currentRevisionId: recordings.currentRevisionId })
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .get()?.currentRevisionId ?? null;

  const access = resolveCasefileAccess(principal, recordingId, requestedRevisionId, db);
  if (access) {
    return {
      allowed: true as const,
      reason: null,
    };
  }

  return {
    allowed: false as const,
    reason: "This recording is not assigned to your account.",
  };
}
