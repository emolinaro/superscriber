import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type AppUser,
  type AssignmentRole,
  type Principal,
  type RecordingAssignment,
  type UserRole,
} from "@/domain/models";
import { toAppUser, toRecordingAssignment } from "@/server/db/mappers";
import { getAppDb, lookupAppDbBundle, type AppDatabase } from "@/server/db/client";
import { recordingAssignments, users } from "@/server/db/schema";
import { runGovernedTransaction } from "@/server/db/transaction";

function nowIso() {
  return new Date().toISOString();
}

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
  },
  db: AppDatabase = getAppDb(),
) {
  const conditions = [eq(recordingAssignments.status, "active")];

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
      userRole: users.role,
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
  params: {
    recordingId: string;
    userId: string;
    assignedByUserId: string;
  },
  db: AppDatabase = getAppDb(),
) {
  const user = db.select().from(users).where(eq(users.id, params.userId)).get();
  if (!user || !user.isActive) {
    throw new Error("Choose an active user before assigning a recording.");
  }

  if (user.role !== "reviewer" && user.role !== "approver") {
    throw new Error("Only reviewer and approver accounts can receive recording assignments.");
  }

  const assignmentRole = user.role as AssignmentRole;
  const timestamp = nowIso();
  const bundle = lookupAppDbBundle(db);

  const operation = (targetDb: AppDatabase) => {
    const existing = targetDb
      .select()
      .from(recordingAssignments)
      .where(
        and(
          eq(recordingAssignments.recordingId, params.recordingId),
          eq(recordingAssignments.userId, params.userId),
        ),
      )
      .get();

    if (existing) {
      targetDb.update(recordingAssignments)
        .set({
          assignmentRole,
          status: "active",
          isActive: true,
          assignedByUserId: params.assignedByUserId,
          updatedAt: timestamp,
          endedAt: null,
          endReason: null,
          completedRevisionId: null,
          removedByUserId: null,
        })
        .where(eq(recordingAssignments.id, existing.id))
        .run();

      return toRecordingAssignment({
        ...existing,
        assignmentRole,
        status: "active",
        isActive: true,
        assignedByUserId: params.assignedByUserId,
        updatedAt: timestamp,
        endedAt: null,
        endReason: null,
        completedRevisionId: null,
        removedByUserId: null,
      });
    }

    const assignment: RecordingAssignment = {
      id: crypto.randomUUID(),
      recordingId: params.recordingId,
      userId: params.userId,
      assignedByUserId: params.assignedByUserId,
      assignmentRole,
      status: "active",
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
      endReason: null,
      completedRevisionId: null,
      removedByUserId: null,
    };

    targetDb.insert(recordingAssignments).values(assignment).run();
    return assignment;
  };

  if (bundle) {
    return runGovernedTransaction((targetDb) => operation(targetDb), bundle);
  }

  return operation(db);
}

export function removeRecordingAssignment(
  assignmentId: string,
  db: AppDatabase = getAppDb(),
) {
  const existing = db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.id, assignmentId))
    .get();

  if (!existing || existing.status !== "active") {
    return false;
  }

  const timestamp = nowIso();
  const bundle = lookupAppDbBundle(db);
  const operation = (targetDb: AppDatabase) => {
    targetDb.update(recordingAssignments)
      .set({
        status: "removed",
        isActive: false,
        updatedAt: timestamp,
        endedAt: timestamp,
        endReason: null,
      })
      .where(eq(recordingAssignments.id, assignmentId))
      .run();

    return true;
  };

  if (bundle) {
    return runGovernedTransaction((targetDb) => operation(targetDb), bundle);
  }

  return operation(db);
}

export function visibleRecordingIdsForPrincipal(
  principal: Principal,
  db: AppDatabase = getAppDb(),
) {
  if (principal.role === "admin") {
    return null;
  }

  if (principal.role === "uploader") {
    return new Set<string>();
  }

  const assignments = listAssignments({ userId: principal.userId }, db);
  return new Set(assignments.map((assignment) => assignment.recordingId));
}

export function canAccessRecording(
  principal: Principal,
  recordingId: string,
  db: AppDatabase = getAppDb(),
) {
  const visibleIds = visibleRecordingIdsForPrincipal(principal, db);
  if (visibleIds === null) {
    return {
      allowed: true as const,
      reason: null,
    };
  }

  if (visibleIds.has(recordingId)) {
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
