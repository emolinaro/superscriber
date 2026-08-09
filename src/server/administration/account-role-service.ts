import { and, eq, ne, sql } from "drizzle-orm";
import { type UserRole } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";
import {
  ACCOUNT_ROLE_CHANGE_COPY,
  assignmentsIncompatibleMessage,
  type AccountRoleChangeFailure,
  type AssignmentBlockers,
  type ChangeAccountRoleInput,
  changeAccountRoleInputSchema,
} from "@/lib/account-role-management";
import {
  listLocalUsers,
  type AccountDirectoryEntry,
} from "@/server/access/service";
import { revokeUserSessions } from "@/server/auth/session-registry";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { insertAuditEvent } from "@/server/casefile/audit";
import {
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import {
  authControl,
  recordingAssignments,
  recordings,
  users,
  workspaces,
} from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";

export type ChangeAccountRoleServiceSuccess = {
  user: AccountDirectoryEntry;
  oldRole: UserRole;
  newRole: UserRole;
  revokedSessionCount: number;
  actorMustRelogin: boolean;
  resultingAuthVersion: number;
};

export class AccountRoleChangeServiceError extends Error {
  constructor(readonly failure: AccountRoleChangeFailure) {
    super(failure.message);
    this.name = "AccountRoleChangeServiceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(failure: AccountRoleChangeFailure): never {
  throw new AccountRoleChangeServiceError(failure);
}

function validationFailure(input: unknown) {
  const parsed = changeAccountRoleInputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  const flattened = parsed.error.flatten();
  const fieldErrors = Object.fromEntries(
    Object.entries(flattened.fieldErrors)
      .filter(([, messages]) => typeof messages?.[0] === "string")
      .map(([field, messages]) => [field, messages![0]!]),
  );
  const message =
    Object.values(fieldErrors)[0] ??
    flattened.formErrors[0] ??
    ACCOUNT_ROLE_CHANGE_COPY.VALIDATION_ERROR;

  fail({
    code: "VALIDATION_ERROR",
    message,
    ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
  });
}

function assignmentBlockers(
  db: AppDatabase,
  targetUserId: string,
  newRole: UserRole,
): AssignmentBlockers | null {
  const rows = db
    .select({
      role: recordingAssignments.assignmentRole,
      recordingTitle: recordings.title,
    })
    .from(recordingAssignments)
    .innerJoin(recordings, eq(recordings.id, recordingAssignments.recordingId))
    .where(
      and(
        eq(recordingAssignments.userId, targetUserId),
        eq(recordingAssignments.status, "active"),
      ),
    )
    .all()
    .filter((row) => row.role !== newRole);

  if (rows.length === 0) {
    return null;
  }

  const byRole: AssignmentBlockers["byRole"] = [];
  for (const role of ["reviewer", "approver"] as const) {
    const matching = rows
      .filter((row) => row.role === role)
      .map((row) => row.recordingTitle)
      .sort((left, right) => left.localeCompare(right));
    if (matching.length > 0) {
      byRole.push({
        role,
        count: matching.length,
        recordingTitles: matching.slice(0, 3),
      });
    }
  }

  return {
    total: rows.length,
    byRole,
    managementHref: `/administration?section=assignments&status=active&userId=${encodeURIComponent(targetUserId)}`,
  };
}

function safeRecordDenial(
  actorUserId: string,
  targetUserId: string,
  failure: AccountRoleChangeFailure,
  db: AppDatabase,
) {
  try {
    recordSecurityEvent(
      {
        type: "account.role_change.denied",
        outcome: "denied",
        userId: actorUserId,
        detail: "Account role change denied.",
        metadata: {
          targetUserId,
          denialCode: failure.code,
        },
      },
      db,
    );
  } catch {
    // Diagnostics are best effort and cannot replace the typed denial.
  }
}

export function changeAccountRole(
  params: { actorUserId: string; input: ChangeAccountRoleInput },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): ChangeAccountRoleServiceSuccess {
  let stage = "validation";

  try {
    return runImmediateGovernedTransaction((db, now) => {
      stage = "validation";
      const input = validationFailure(params.input);

      stage = "actor";
      const actor = db
        .select()
        .from(users)
        .where(eq(users.id, params.actorUserId))
        .get();
      if (!actor || !actor.isActive || actor.role !== "admin") {
        fail({
          code: "ACCESS_DENIED",
          message: ACCOUNT_ROLE_CHANGE_COPY.ACCESS_DENIED,
        });
      }

      stage = "target";
      const target = db
        .select()
        .from(users)
        .where(eq(users.id, input.userId))
        .get();
      if (!target) {
        fail({ code: "NOT_FOUND", message: ACCOUNT_ROLE_CHANGE_COPY.NOT_FOUND });
      }
      if (target.role !== input.expectedRole) {
        fail({
          code: "STATE_CHANGED",
          message: ACCOUNT_ROLE_CHANGE_COPY.STATE_CHANGED,
          currentRole: target.role,
        });
      }

      stage = "break-glass";
      const designation = db
        .select({ userId: authControl.breakGlassUserId })
        .from(authControl)
        .where(eq(authControl.id, 1))
        .get();
      if (designation?.userId === target.id && input.newRole !== "admin") {
        fail({
          code: "BREAK_GLASS_PROTECTED",
          message: ACCOUNT_ROLE_CHANGE_COPY.BREAK_GLASS_PROTECTED,
        });
      }

      stage = "active-admin";
      if (target.isActive && target.role === "admin" && input.newRole !== "admin") {
        const otherActiveAdmin = db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              ne(users.id, target.id),
              eq(users.role, "admin"),
              eq(users.isActive, true),
            ),
          )
          .get();
        if (!otherActiveAdmin) {
          fail({
            code: "LAST_ACTIVE_ADMIN",
            message: ACCOUNT_ROLE_CHANGE_COPY.LAST_ACTIVE_ADMIN,
          });
        }
      }

      stage = "assignments";
      const blockers = assignmentBlockers(db, target.id, input.newRole);
      if (blockers) {
        fail({
          code: "ASSIGNMENTS_INCOMPATIBLE",
          message: assignmentsIncompatibleMessage(formatRoleLabel(input.newRole)),
          assignmentBlockers: blockers,
        });
      }

      stage = "workspace";
      const workspace = db.select({ id: workspaces.id }).from(workspaces).get();
      if (!workspace) {
        throw new Error("The account role audit workspace is unavailable.");
      }

      stage = "role-update";
      const update = db
        .update(users)
        .set({
          role: input.newRole,
          authVersion: sql`${users.authVersion} + 1`,
          updatedAt: now,
        })
        .where(and(eq(users.id, target.id), eq(users.role, input.expectedRole)))
        .run();
      if (update.changes !== 1) {
        const current = db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, target.id))
          .get();
        fail({
          code: "STATE_CHANGED",
          message: ACCOUNT_ROLE_CHANGE_COPY.STATE_CHANGED,
          ...(current ? { currentRole: current.role } : {}),
        });
      }

      const updated = db
        .select({ authVersion: users.authVersion })
        .from(users)
        .where(eq(users.id, target.id))
        .get();
      if (!updated) {
        throw new Error("The updated account could not be reloaded.");
      }

      stage = "sessions";
      const revokedSessionCount = revokeUserSessions(
        target.id,
        "account_role_changed",
        db,
        { now: new Date(now) },
      );

      stage = "audit";
      insertAuditEvent(db, {
        workspaceId: workspace.id,
        recordingId: null,
        actor: {
          actorRole: "admin",
          actorUserId: actor.id,
          actorDisplayName: actor.displayName,
          effectiveRole: "admin",
          adminActionSessionId: null,
        },
        type: "account.role_changed",
        detail: `${target.displayName}'s account role changed from ${formatRoleLabel(target.role)} to ${formatRoleLabel(input.newRole)}.`,
        metadata: {
          targetUserId: target.id,
          targetDisplayName: target.displayName,
          oldRole: target.role,
          newRole: input.newRole,
          reason: input.reason,
          resultingAuthVersion: updated.authVersion,
          revokedSessionCount,
        },
        createdAt: now,
      });

      const user = listLocalUsers(db).find((entry) => entry.id === target.id);
      if (!user) {
        throw new Error("The updated account directory entry is unavailable.");
      }

      stage = "state-version";
      return {
        user,
        oldRole: target.role,
        newRole: input.newRole,
        revokedSessionCount,
        actorMustRelogin: actor.id === target.id,
        resultingAuthVersion: updated.authVersion,
      };
    }, bundle);
  } catch (error) {
    if (error instanceof AccountRoleChangeServiceError) {
      safeRecordDenial(
        params.actorUserId,
        params.input.userId,
        error.failure,
        bundle.db,
      );
      throw error;
    }

    const correlationId = crypto.randomUUID();
    console.error("account role change failed", {
      correlationId,
      actorUserId: params.actorUserId,
      targetUserId: params.input.userId,
      stage,
    });
    throw new AccountRoleChangeServiceError({
      code: "INTERNAL_ERROR",
      message: ACCOUNT_ROLE_CHANGE_COPY.INTERNAL_ERROR,
      correlationId,
    });
  }
}
