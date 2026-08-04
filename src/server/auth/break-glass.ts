import { createHmac, randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { resolveAuthSecret } from "@/server/auth/secret";
import {
  createAuthSession,
  retireUserSessions,
  type AuthSessionRecord,
} from "@/server/auth/session-registry";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  authControl,
  authSessions,
  breakGlassRecoveryCodes,
  emergencyActivations,
  users,
} from "@/server/db/schema";

/**
 * Exactly-one break-glass controls (plan section 8).
 *
 * The auth_control singleton names the single designated emergency local
 * admin. Database triggers hard-enforce the invariants (no second row, only
 * an active admin may be designated, the designee cannot be demoted,
 * deactivated, or deleted); these functions add service-level validation,
 * redacted events, and transactional transfer semantics on top.
 *
 * The break-glass session carries the registry's shortened bounds (15 min
 * absolute, 5 min idle) via authSource "break_glass".
 */

export const EMERGENCY_REASON_MIN = 10;
export const EMERGENCY_REASON_MAX = 500;

export type BreakGlassDesignation = typeof authControl.$inferSelect;

function safeRecord(input: Parameters<typeof recordSecurityEvent>[0], db: AppDatabase) {
  try {
    recordSecurityEvent(input, db);
  } catch {
    // The event stream must never break the control operation it observes.
  }
}

export function getBreakGlassDesignation(
  db: AppDatabase = getAppDb(),
): BreakGlassDesignation | null {
  return db.select().from(authControl).where(eq(authControl.id, 1)).get() ?? null;
}

function requireActiveAdmin(userId: string, db: AppDatabase) {
  const user = db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!user || user.role !== "admin" || !user.isActive) {
    throw new Error("Break-glass designation requires an active local admin user.");
  }
}

export function designateBreakGlassUser(
  params: {
    userId: string;
    actorUserId?: string | null;
    changeReason: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): BreakGlassDesignation {
  requireActiveAdmin(params.userId, db);
  const now = (params.now ?? new Date()).toISOString();

  const existing = getBreakGlassDesignation(db);
  let designation: BreakGlassDesignation;

  if (!existing) {
    designation = {
      id: 1,
      breakGlassUserId: params.userId,
      updatedAt: now,
      updatedByUserId: params.actorUserId ?? null,
      changeReason: params.changeReason,
    };
    db.insert(authControl).values(designation).run();
  } else {
    db.update(authControl)
      .set({
        breakGlassUserId: params.userId,
        updatedAt: now,
        updatedByUserId: params.actorUserId ?? null,
        changeReason: params.changeReason,
      })
      .where(eq(authControl.id, 1))
      .run();
    designation = getBreakGlassDesignation(db)!;
  }

  safeRecord(
    {
      type: "breakglass.designated",
      outcome: "success",
      userId: params.userId,
      detail: "Break-glass designation updated.",
      metadata: { actorUserId: params.actorUserId ?? null },
      now: params.now,
    },
    db,
  );

  return designation;
}

/**
 * Atomic transfer ceremony (8.3): the old account's local path is disabled
 * (password replaced with an unknowable random hash) and all of its sessions
 * are revoked before the singleton pointer moves. A second concurrent
 * break-glass account is never created.
 */
export function transferBreakGlassDesignation(
  params: {
    newUserId: string;
    actorUserId?: string | null;
    changeReason: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): BreakGlassDesignation {
  const current = getBreakGlassDesignation(db);
  if (!current) {
    throw new Error("No break-glass designation exists to transfer.");
  }
  requireActiveAdmin(params.newUserId, db);

  db.transaction((tx) => {
    // Disable the old local credential path without touching profile data.
    tx.update(users)
      .set({
        passwordHash: `disabled:${randomBytes(32).toString("hex")}`,
        updatedAt: (params.now ?? new Date()).toISOString(),
      })
      .where(eq(users.id, current.breakGlassUserId))
      .run();

    retireUserSessions(
      { userId: current.breakGlassUserId, reason: "break_glass_transfer" },
      tx as AppDatabase,
    );

    tx.update(authControl)
      .set({
        breakGlassUserId: params.newUserId,
        updatedAt: (params.now ?? new Date()).toISOString(),
        updatedByUserId: params.actorUserId ?? null,
        changeReason: params.changeReason,
      })
      .where(eq(authControl.id, 1))
      .run();
  });

  safeRecord(
    {
      type: "breakglass.transferred",
      outcome: "success",
      userId: params.newUserId,
      detail: "Break-glass designation transferred.",
      metadata: { actorUserId: params.actorUserId ?? null },
      now: params.now,
    },
    db,
  );

  return getBreakGlassDesignation(db)!;
}

export async function verifyBreakGlassPassword(
  params: { userId: string; password: string },
  db: AppDatabase = getAppDb(),
): Promise<boolean> {
  const designation = getBreakGlassDesignation(db);
  if (!designation || designation.breakGlassUserId !== params.userId) {
    return false;
  }

  const user = db
    .select({ passwordHash: users.passwordHash, isActive: users.isActive, role: users.role })
    .from(users)
    .where(eq(users.id, params.userId))
    .get();

  if (!user?.passwordHash || !user.isActive || user.role !== "admin") {
    return false;
  }
  if (user.passwordHash.startsWith("disabled:")) {
    return false;
  }

  return compare(params.password, user.passwordHash);
}

/**
 * Password rotation (8.3): new hash, auth version bump, and revocation of all
 * existing sessions, so no stale path survives the rotation.
 */
export async function rotateBreakGlassPassword(
  params: {
    userId: string;
    newPassword: string;
    actorUserId?: string | null;
    changeReason: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): Promise<void> {
  const designation = getBreakGlassDesignation(db);
  if (!designation || designation.breakGlassUserId !== params.userId) {
    throw new Error("Password rotation applies only to the designated break-glass user.");
  }

  const passwordHash = await hash(params.newPassword, 12);

  db.transaction((tx) => {
    tx.update(users)
      .set({ passwordHash, updatedAt: (params.now ?? new Date()).toISOString() })
      .where(eq(users.id, params.userId))
      .run();
    retireUserSessions(
      { userId: params.userId, reason: "break_glass_rotation" },
      tx as AppDatabase,
    );
  });

  safeRecord(
    {
      type: "breakglass.password_rotated",
      outcome: "success",
      userId: params.userId,
      detail: "Break-glass password rotated.",
      metadata: { actorUserId: params.actorUserId ?? null },
      now: params.now,
    },
    db,
  );
}

function hashRecoveryCode(code: string) {
  return createHmac("sha256", resolveAuthSecret()).update(code).digest("hex");
}

function generateRecoveryCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = randomBytes(12);
  const raw = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export const RECOVERY_CODE_COUNT = 10;

/**
 * Recovery custody (8.3): codes are shown to the operator exactly once; only
 * HMAC hashes persist. Generating rotates the full previous set.
 */
export function generateBreakGlassRecoveryCodes(
  params: { userId: string; actorUserId?: string | null; now?: Date },
  db: AppDatabase = getAppDb(),
): { codes: string[] } {
  const designation = getBreakGlassDesignation(db);
  if (!designation || designation.breakGlassUserId !== params.userId) {
    throw new Error("Recovery codes apply only to the designated break-glass user.");
  }

  const now = (params.now ?? new Date()).toISOString();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

  db.transaction((tx) => {
    tx.update(breakGlassRecoveryCodes)
      .set({ rotatedAt: now })
      .where(
        and(
          eq(breakGlassRecoveryCodes.breakGlassUserId, params.userId),
          isNull(breakGlassRecoveryCodes.usedAt),
          isNull(breakGlassRecoveryCodes.rotatedAt),
        ),
      )
      .run();

    for (const code of codes) {
      tx.insert(breakGlassRecoveryCodes)
        .values({
          id: crypto.randomUUID(),
          breakGlassUserId: params.userId,
          codeHash: hashRecoveryCode(code),
          createdAt: now,
          usedAt: null,
          rotatedAt: null,
        })
        .run();
    }
  });

  safeRecord(
    {
      type: "breakglass.recovery_generated",
      outcome: "success",
      userId: params.userId,
      detail: "Break-glass recovery code set rotated.",
      metadata: { count: codes.length, actorUserId: params.actorUserId ?? null },
      now: params.now,
    },
    db,
  );

  return { codes };
}

/**
 * Single-use recovery code redemption. The row is claimed atomically so a
 * code can never be used twice, even concurrently.
 */
export function useBreakGlassRecoveryCode(
  params: { userId: string; code: string; now?: Date },
  db: AppDatabase = getAppDb(),
): boolean {
  const normalized = params.code.trim().toUpperCase();
  const now = (params.now ?? new Date()).toISOString();

  const result = db
    .update(breakGlassRecoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(breakGlassRecoveryCodes.breakGlassUserId, params.userId),
        eq(breakGlassRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(breakGlassRecoveryCodes.usedAt),
        isNull(breakGlassRecoveryCodes.rotatedAt),
      ),
    )
    .run();

  if (result.changes === 0) {
    return false;
  }

  safeRecord(
    {
      type: "breakglass.recovery_used",
      outcome: "success",
      userId: params.userId,
      detail: "Break-glass recovery code redeemed; rotate the remaining set.",
      now: params.now,
    },
    db,
  );

  return true;
}

export type EmergencyActivation = typeof emergencyActivations.$inferSelect;

export function openEmergencyActivation(
  params: {
    userId: string;
    reason: string;
    sourceZone: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): { activation: EmergencyActivation; session: AuthSessionRecord } {
  if (
    params.reason.length < EMERGENCY_REASON_MIN ||
    params.reason.length > EMERGENCY_REASON_MAX
  ) {
    throw new Error(
      `Emergency reason must be ${EMERGENCY_REASON_MIN}-${EMERGENCY_REASON_MAX} characters.`,
    );
  }

  const correlationId = `emg-${crypto.randomUUID()}`;
  const activation: EmergencyActivation = {
    id: crypto.randomUUID(),
    correlationId,
    breakGlassUserId: params.userId,
    reason: params.reason,
    sourceZone: params.sourceZone,
    openedAt: (params.now ?? new Date()).toISOString(),
    endsAt: "",
    closedAt: null,
  };

  const session = createAuthSession(
    {
      userId: params.userId,
      authSource: "break_glass",
      emergencyActivationId: activation.id,
      now: params.now,
    },
    db,
  );
  activation.endsAt = session.absoluteExpiresAt;

  db.insert(emergencyActivations).values(activation).run();

  safeRecord(
    {
      type: "breakglass.emergency_opened",
      outcome: "success",
      userId: params.userId,
      sessionId: session.id,
      correlationId,
      sourceZone: params.sourceZone,
      detail: "Emergency administrator session opened.",
      metadata: { reason: params.reason },
      now: params.now,
    },
    db,
  );

  return { activation, session };
}

/**
 * Emergency banner state for an active session (8.4). Returns null when the
 * session is not a break-glass session.
 */
export function readEmergencyContext(
  authSessionId: string,
  db: AppDatabase = getAppDb(),
): {
  correlationId: string;
  reason: string;
  absoluteExpiresAt: string;
} | null {
  const row = db
    .select({
      correlationId: emergencyActivations.correlationId,
      reason: emergencyActivations.reason,
      endsAt: emergencyActivations.endsAt,
    })
    .from(authSessions)
    .innerJoin(
      emergencyActivations,
      eq(authSessions.emergencyActivationId, emergencyActivations.id),
    )
    .where(eq(authSessions.id, authSessionId))
    .get();

  if (!row) {
    return null;
  }

  return {
    correlationId: row.correlationId,
    reason: row.reason,
    absoluteExpiresAt: row.endsAt,
  };
}
