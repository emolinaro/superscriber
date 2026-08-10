import { eq } from "drizzle-orm";
import {
  adminPasswordResetInputSchema,
  PASSWORD_RESET_ADMIN_COPY,
  type AdminPasswordResetInput,
} from "@/lib/account-password-reset";
import { revalidateAdminActor } from "@/server/administration/actor-authority";
import { ensureAuditWorkspace } from "@/server/administration/account-role-service";
import {
  invalidateUserResetTokens,
  issueResetToken,
} from "@/server/auth/password-reset-tokens";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { retireUserSessions } from "@/server/auth/session-registry";
import { insertAuditEvent } from "@/server/casefile/audit";
import {
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { authControl, users } from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";

export type AdminPasswordResetFailure = {
  code:
    | "VALIDATION_ERROR"
    | "ACCESS_DENIED"
    | "NOT_FOUND"
    | "INACTIVE_TARGET"
    | "BREAK_GLASS_DESIGNEE"
    | "CREDENTIAL_DISABLED"
    | "MAIL_UNCONFIGURED"
    | "INTERNAL_ERROR";
  message: string;
  fieldErrors?: Record<string, string>;
};

export type AdminPasswordResetSuccess = {
  userId: string;
  targetDisplayName: string;
  targetEmail: string;
  rawToken: string;
  recordId: string;
  expiresAt: string;
  delivery: "email" | "operator_handoff";
  revokedSessionCount: number;
  resultingAuthVersion: number;
  actorMustRelogin: boolean;
};

export class AdminPasswordResetServiceError extends Error {
  constructor(readonly failure: AdminPasswordResetFailure) {
    super(failure.message);
    this.name = "AdminPasswordResetServiceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(failure: AdminPasswordResetFailure): never {
  throw new AdminPasswordResetServiceError(failure);
}

function validationFailure(input: unknown) {
  const parsed = adminPasswordResetInputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  const flattened = parsed.error.flatten();
  const fieldErrors = Object.fromEntries(
    Object.entries(flattened.fieldErrors)
      .filter(([, messages]) => typeof messages?.[0] === "string")
      .map(([field, messages]) => [field, messages![0]!]),
  );
  fail({
    code: "VALIDATION_ERROR",
    message:
      Object.values(fieldErrors)[0] ??
      flattened.formErrors[0] ??
      PASSWORD_RESET_ADMIN_COPY.VALIDATION_ERROR,
    ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
  });
}

function safeRecordDenial(
  actorUserId: string,
  targetUserId: string,
  failure: AdminPasswordResetFailure,
  db: AppDatabase,
) {
  try {
    recordSecurityEvent(
      {
        type: "admin.password_reset.issued",
        outcome: "denied",
        userId: actorUserId,
        detail: "Administrator password reset denied.",
        metadata: { targetUserId, denialCode: failure.code },
      },
      db,
    );
  } catch {
    // Diagnostics are best effort and cannot replace the typed denial.
  }
}

/**
 * Administrator manual reset (spec section 5). One governed transaction:
 * invalidate prior tokens (admin_precedence), retire every session from every
 * auth source, issue exactly one new token, write the governance audit event
 * and the redacted security event. The disclosure channel is decided by the
 * caller: the returned raw token is either revealed once (operator_handoff)
 * or emailed and discarded (email).
 */
export function adminIssuePasswordReset(
  params: {
    actorUserId: string;
    actorAuthSessionId: string;
    input: AdminPasswordResetInput;
  },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): AdminPasswordResetSuccess {
  let stage = "validation";

  try {
    return runImmediateGovernedTransaction((db, now) => {
      stage = "validation";
      const input = validationFailure(params.input);

      stage = "actor";
      const actor = revalidateAdminActor(db, params, now, () =>
        fail({ code: "ACCESS_DENIED", message: PASSWORD_RESET_ADMIN_COPY.ACCESS_DENIED }),
      );

      stage = "target";
      const target = db.select().from(users).where(eq(users.id, input.userId)).get();
      if (!target) {
        fail({ code: "NOT_FOUND", message: PASSWORD_RESET_ADMIN_COPY.NOT_FOUND });
      }
      if (!target.isActive) {
        fail({ code: "INACTIVE_TARGET", message: PASSWORD_RESET_ADMIN_COPY.INACTIVE_TARGET });
      }

      stage = "break-glass";
      const designation = db
        .select({ userId: authControl.breakGlassUserId })
        .from(authControl)
        .where(eq(authControl.id, 1))
        .get();
      if (designation?.userId === target.id) {
        fail({
          code: "BREAK_GLASS_DESIGNEE",
          message: PASSWORD_RESET_ADMIN_COPY.BREAK_GLASS_DESIGNEE,
        });
      }
      if (target.passwordHash?.startsWith("disabled:")) {
        fail({
          code: "CREDENTIAL_DISABLED",
          message: PASSWORD_RESET_ADMIN_COPY.CREDENTIAL_DISABLED,
        });
      }

      stage = "mail-config";
      if (input.delivery === "email" && loadResetMailConfig().mode !== "smtp") {
        fail({
          code: "MAIL_UNCONFIGURED",
          message: PASSWORD_RESET_ADMIN_COPY.MAIL_UNCONFIGURED,
        });
      }

      stage = "invalidate";
      invalidateUserResetTokens({ userId: target.id, reason: "admin_precedence" }, db, now);

      stage = "sessions";
      const { revokedCount } = retireUserSessions(
        { userId: target.id, reason: "admin_password_reset" },
        db,
      );

      stage = "token";
      const issued = issueResetToken(
        {
          userId: target.id,
          source: "admin",
          delivery: input.delivery,
          requestedByUserId: actor.id,
        },
        db,
        new Date(now),
      );

      const reloaded = db
        .select({ authVersion: users.authVersion })
        .from(users)
        .where(eq(users.id, target.id))
        .get();
      if (!reloaded) {
        throw new Error("The reset target could not be reloaded.");
      }

      stage = "audit";
      const workspace = ensureAuditWorkspace(db);
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
        type: "account.password_reset",
        detail: `${target.displayName}'s password was reset by an administrator.`,
        metadata: {
          targetUserId: target.id,
          targetDisplayName: target.displayName,
          reason: input.reason,
          delivery: input.delivery,
          revokedSessionCount: revokedCount,
          resultingAuthVersion: reloaded.authVersion,
        },
        createdAt: now,
      });

      recordSecurityEvent(
        {
          type: "admin.password_reset.issued",
          outcome: "success",
          userId: target.id,
          detail: "Administrator issued a password reset.",
          metadata: {
            actorUserId: actor.id,
            delivery: input.delivery,
            resetRecordId: issued.tokenId,
          },
        },
        db,
      );

      return {
        userId: target.id,
        targetDisplayName: target.displayName,
        targetEmail: target.email,
        rawToken: issued.rawToken,
        recordId: issued.tokenId,
        expiresAt: issued.expiresAt,
        delivery: input.delivery,
        revokedSessionCount: revokedCount,
        resultingAuthVersion: reloaded.authVersion,
        actorMustRelogin: actor.id === target.id,
      };
    }, bundle);
  } catch (error) {
    if (error instanceof AdminPasswordResetServiceError) {
      safeRecordDenial(params.actorUserId, params.input.userId ?? "", error.failure, bundle.db);
      throw error;
    }

    const correlationId = crypto.randomUUID();
    console.error("admin password reset failed", {
      correlationId,
      actorUserId: params.actorUserId,
      targetUserId: params.input?.userId,
      stage,
    });
    throw new AdminPasswordResetServiceError({
      code: "INTERNAL_ERROR",
      message: PASSWORD_RESET_ADMIN_COPY.INTERNAL_ERROR,
    });
  }
}
