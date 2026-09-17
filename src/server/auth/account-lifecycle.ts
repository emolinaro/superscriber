import { compare, hash } from "bcryptjs";
import { and, eq, ne, sql } from "drizzle-orm";
import { revalidateActiveActor } from "@/server/administration/actor-authority";
import { ensureAuditWorkspace } from "@/server/administration/account-role-service";
import { accountReasonSchema } from "@/lib/account-lifecycle";
import { insertAuditEvent } from "@/server/casefile/audit";
import { CasefileCommandError } from "@/server/casefile/errors";
import {
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { appStateMeta, authControl, authSessions, users } from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";
import { invalidateUserResetTokens } from "./password-reset-tokens";
import { revokeUserSessions } from "./session-registry";

type UserRow = typeof users.$inferSelect;

export function assertMayDeactivate(target: UserRow, db: AppDatabase) {
  const designation = db
    .select()
    .from(authControl)
    .where(eq(authControl.id, 1))
    .get();
  if (designation?.breakGlassUserId === target.id) {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Transfer the break-glass designation before deactivating or removing this account.",
    );
  }
  if (
    target.isActive &&
    target.role === "admin" &&
    !db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          ne(users.id, target.id),
          eq(users.role, "admin"),
          eq(users.isActive, true),
        ),
      )
      .get()
  ) {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "The last active administrator must remain active.",
    );
  }
}

export async function completeMandatoryPasswordChange(
  params: {
    actorUserId: string;
    actorAuthSessionId: string;
    password: string;
    confirmPassword: string;
  },
  bundle: AppDatabaseBundle = getAppDbBundle(),
) {
  if (params.password.length < 10) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Use at least 10 characters.", {
      password: "Use at least 10 characters.",
    });
  }
  if (params.password.length > 200) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Passwords must stay under 200 characters.", {
      password: "Passwords must stay under 200 characters.",
    });
  }
  if (params.password !== params.confirmPassword) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Passwords must match.", {
      confirmPassword: "Passwords must match.",
    });
  }
  const current = bundle.db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, params.actorUserId))
    .get();
  if (current?.passwordHash && await compare(params.password, current.passwordHash)) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Choose a new password.", {
      password: "Choose a new password.",
    });
  }
  const passwordHash = await hash(params.password, 12);
  return runImmediateGovernedTransaction((db, now) => {
    const actor = revalidateActiveActor(db, params, now, () => {
      throw new CasefileCommandError(
        "ACCESS_DENIED",
        "Your session is no longer active. Sign in again.",
      );
    });
    if (!actor.mustChangePassword) {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "This account does not need a temporary password change.",
      );
    }
    db.update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: now })
      .where(eq(users.id, actor.id))
      .run();
    db.update(authSessions)
      .set({ status: "revoked", revokedAt: now, revokedReason: "password_changed" })
      .where(
        and(
          eq(authSessions.userId, actor.id),
          eq(authSessions.status, "active"),
          ne(authSessions.id, params.actorAuthSessionId),
        ),
      )
      .run();
    invalidateUserResetTokens(
      { userId: actor.id, reason: "user_reset_completed" },
      db,
      now,
    );
    insertAuditEvent(db, {
      workspaceId: ensureAuditWorkspace(db).id,
      recordingId: null,
      actor: {
        actorRole: actor.role,
        actorUserId: actor.id,
        actorDisplayName: actor.displayName,
        effectiveRole: actor.role,
        adminActionSessionId: null,
      },
      type: "account.password_reset",
      detail: "Temporary password replaced at first sign-in.",
      metadata: { targetUserId: actor.id, source: "temporary_password" },
      createdAt: now,
    });
    return { userId: actor.id };
  }, bundle);
}

export function deactivateOwnAccount(
  params: { actorUserId: string; actorAuthSessionId: string; reason: string },
  bundle: AppDatabaseBundle = getAppDbBundle(),
) {
  return runImmediateGovernedTransaction((db, now) => {
    const reason = accountReasonSchema.safeParse(params.reason);
    if (!reason.success)
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        reason.error.issues[0]!.message,
        { reason: reason.error.issues[0]!.message },
      );
    const actor = revalidateActiveActor(db, params, now, () => {
      throw new CasefileCommandError(
        "ACCESS_DENIED",
        "Your session is no longer active. Sign in again.",
      );
    });
    assertMayDeactivate(actor, db);
    db.update(users)
      .set({
        isActive: false,
        deactivatedByUserId: actor.id,
        authVersion: sql`${users.authVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(users.id, actor.id))
      .run();
    invalidateUserResetTokens(
      { userId: actor.id, reason: "admin_precedence" },
      db,
      now,
    );
    const revokedSessionCount = revokeUserSessions(
      actor.id,
      "account_self_deactivated",
      db,
      { now: new Date(now) },
    );
    insertAuditEvent(db, {
      workspaceId: ensureAuditWorkspace(db).id,
      recordingId: null,
      actor: {
        actorRole: actor.role,
        actorUserId: actor.id,
        actorDisplayName: actor.displayName,
        effectiveRole: actor.role,
        adminActionSessionId: null,
      },
      type: "account.self_deactivated",
      detail:
        "Account deactivated by its owner. A new authenticated sign-in may revive it.",
      metadata: {
        targetUserId: actor.id,
        deactivatedByUserId: actor.id,
        reason: reason.data,
        revokedSessionCount,
      },
      createdAt: now,
    });
    return { userId: actor.id };
  }, bundle);
}

/** Only call after credential/provider validation, within the sign-in transaction.
 * Never call from session refresh, account provisioning, or password reset. */
export function reviveAtSignIn(
  target: UserRow,
  db: AppDatabase,
  now: string,
): boolean {
  if (target.isActive) return true;
  if (target.deactivatedByUserId !== target.id) return false;
  const changed = db
    .update(users)
    .set({
      isActive: true,
      deactivatedByUserId: null,
      authVersion: sql`${users.authVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(users.id, target.id),
        eq(users.isActive, false),
        eq(users.deactivatedByUserId, target.id),
        eq(users.authVersion, target.authVersion),
      ),
    )
    .run();
  if (changed.changes !== 1) return false;
  insertAuditEvent(db, {
    workspaceId: ensureAuditWorkspace(db).id,
    recordingId: null,
    actor: {
      actorRole: target.role,
      actorUserId: target.id,
      actorDisplayName: target.displayName,
      effectiveRole: target.role,
      adminActionSessionId: null,
    },
    type: "account.self_reactivated",
    detail: "Account revived at sign-in after self-deactivation.",
    metadata: {
      targetUserId: target.id,
      previousDeactivatedByUserId: target.id,
    },
    createdAt: now,
  });
  const bumped = db
    .update(appStateMeta)
    .set({ stateVersion: sql`${appStateMeta.stateVersion} + 1` })
    .where(eq(appStateMeta.id, 1))
    .run();
  if (bumped.changes !== 1)
    throw new Error("Account revival could not advance governed state.");
  return true;
}
