import { assertMayDeactivate } from "@/server/auth/account-lifecycle";
import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  accountLifecycleInputSchema,
  temporaryAccountInputSchema,
  type AccountLifecycleInput,
  type TemporaryAccountInput,
} from "@/lib/account-lifecycle";
import { revalidateAdminActor } from "./actor-authority";
import { ensureAuditWorkspace } from "./account-role-service";
import { listLocalUsers } from "@/server/access/service";
import { invalidateUserResetTokens } from "@/server/auth/password-reset-tokens";
import { revokeUserSessions } from "@/server/auth/session-registry";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { insertAuditEvent } from "@/server/casefile/audit";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getAppDbBundle, type AppDatabaseBundle } from "@/server/db/client";
import { externalIdentities, users } from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";

type Actor = { actorUserId: string; actorAuthSessionId: string };
function removedEmailFor(userId: string) {
  return `removed:${userId}`;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = Object.fromEntries(
    result.error.issues.map((issue) => [issue.path[0], issue.message]),
  );
  throw new CasefileCommandError(
    "VALIDATION_ERROR",
    result.error.issues[0]?.message ?? "Check the form.",
    fields,
  );
}
function denyActor(): never {
  throw new CasefileCommandError(
    "ACCESS_DENIED",
    "An active administrator session is required. Sign in again.",
  );
}

export function changeAccountLifecycle(
  params: Actor & { input: AccountLifecycleInput },
  bundle: AppDatabaseBundle = getAppDbBundle(),
) {
  try {
    return runImmediateGovernedTransaction((db, now) => {
      const input = parse(accountLifecycleInputSchema, params.input);
      const actor = revalidateAdminActor(db, params, now, denyActor);
      const target = db
        .select()
        .from(users)
        .where(eq(users.id, input.userId))
        .get();
      if (!target)
        throw new CasefileCommandError(
          "NOT_FOUND",
          "This account is no longer available.",
        );
      if (target.removedAt !== null) {
        throw new CasefileCommandError(
          input.action === "reactivate" ? "ACCESS_DENIED" : "STATE_CHANGED",
          "Removed accounts are terminal. Create a new account for returning access.",
        );
      }
      if (
        target.isActive !== input.expectedIsActive ||
        (input.action === "reactivate" && target.isActive) ||
        (input.action === "deactivate" && !target.isActive)
      ) {
        throw new CasefileCommandError(
          "STATE_CHANGED",
          "The account state changed. Close this dialog and review the refreshed account.",
        );
      }
      if (input.action !== "reactivate") {
        assertMayDeactivate(target, db);
        if (actor.id === target.id) {
          throw new CasefileCommandError(
            "ACCESS_DENIED",
            "Another administrator must deactivate or remove your own account.",
          );
        }
      }

      const isActive = input.action === "reactivate";
      db.update(users)
        .set({
          isActive,
          deactivatedByUserId: isActive ? null : actor.id,
          authVersion: sql`${users.authVersion} + 1`,
          updatedAt: now,
          ...(input.action === "remove"
            ? {
                email: removedEmailFor(target.id),
                passwordHash: null,
                mustChangePassword: false,
                removedAt: now,
              }
            : {}),
        })
        .where(eq(users.id, target.id))
        .run();
      if (input.action === "remove") {
        db.update(externalIdentities)
          .set({
            status: "retired",
            retiredAt: now,
            retiredByUserId: actor.id,
            changeReason: input.reason,
          })
          .where(
            and(
              eq(externalIdentities.userId, target.id),
              eq(externalIdentities.status, "active"),
            ),
          )
          .run();
      }
      invalidateUserResetTokens(
        { userId: target.id, reason: "admin_precedence" },
        db,
        now,
      );
      const revokedSessionCount = revokeUserSessions(
        target.id,
        `account_${input.action}`,
        db,
        { now: new Date(now) },
      );
      const type =
        input.action === "remove"
          ? "account.removed"
          : input.action === "reactivate"
            ? "account.reactivated"
            : "account.deactivated";
      insertAuditEvent(db, {
        workspaceId: ensureAuditWorkspace(db).id,
        recordingId: null,
        actor: {
          actorRole: "admin",
          actorUserId: actor.id,
          actorDisplayName: actor.displayName,
          effectiveRole: "admin",
          adminActionSessionId: null,
        },
        type,
        detail: `${target.displayName}: ${input.action === "remove" ? "account access removed; identity and history retained" : isActive ? "account reactivated" : "account deactivated"}.`,
        metadata: {
          targetUserId: target.id,
          reason: input.reason,
          previousIsActive: target.isActive,
          isActive,
          revokedSessionCount,
          resultingAuthVersion: target.authVersion + 1,
        },
        createdAt: now,
      });
      return { userId: target.id, isActive, revokedSessionCount };
    }, bundle);
  } catch (error) {
    if (error instanceof CasefileCommandError) {
      try {
        recordSecurityEvent(
          {
            type: "account.lifecycle.denied",
            outcome: "denied",
            userId: params.actorUserId,
            detail: "Account lifecycle action denied.",
            metadata: {
              targetUserId: params.input?.userId,
              denialCode: error.code,
            },
          },
          bundle.db,
        );
      } catch {
        /* Preserve the original denial. */
      }
    }
    throw error;
  }
}

export async function createAccountWithTemporaryPassword(
  params: Actor & { input: TemporaryAccountInput },
  bundle: AppDatabaseBundle = getAppDbBundle(),
) {
  const input = parse(temporaryAccountInputSchema, params.input);
  // Check before expensive hashing, then again inside the write transaction.
  revalidateAdminActor(bundle.db, params, new Date().toISOString(), denyActor);
  const temporaryPassword = randomBytes(24).toString("base64url");
  const passwordHash = await hash(temporaryPassword, 12);
  return runImmediateGovernedTransaction((db, now) => {
    const actor = revalidateAdminActor(db, params, now, denyActor);
    const email = input.email.toLowerCase();
    if (
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .get()
    ) {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "An account with that email already exists.",
        { email: "An account with that email already exists." },
      );
    }
    const id = randomUUID();
    db.insert(users)
      .values({
        id,
        displayName: input.displayName,
        email,
        role: input.role,
        passwordHash,
        isActive: true,
        mustChangePassword: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertAuditEvent(db, {
      workspaceId: ensureAuditWorkspace(db).id,
      recordingId: null,
      actor: {
        actorRole: "admin",
        actorUserId: actor.id,
        actorDisplayName: actor.displayName,
        effectiveRole: "admin",
        adminActionSessionId: null,
      },
      type: "account.created",
      detail: "Local account created with a generated temporary password.",
      metadata: { targetUserId: id, role: input.role, reason: input.reason },
      createdAt: now,
    });
    return {
      user: listLocalUsers(db).find((user) => user.id === id)!,
      temporaryPassword,
    };
  }, bundle);
}
