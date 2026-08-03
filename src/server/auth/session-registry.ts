import { and, eq, ne, sql } from "drizzle-orm";
import { recordSecurityEvent } from "@/server/auth/security-events";
import type { UserRole } from "@/domain/models";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  authSessions,
  users,
  type AuthSessionStatus,
  type AuthSource,
} from "@/server/db/schema";

/**
 * Local, revocable session registry (plan section 7.1-7.3).
 *
 * Auth.js remains the cookie transport, but the cookie only carries a pointer
 * (`authSessionId`) into this registry. Every validation reads the session row
 * and the live user row in one select, so revocation, suspension, role change,
 * and auth-version bumps take effect on the next request.
 *
 * Only users.auth_version invalidates sessions. Authentik-internal display or
 * profile edits never do.
 */

export const TOKEN_SCHEMA_VERSION = 2;

const NORMAL_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const NORMAL_IDLE_MS = 30 * 60 * 1000;
const BREAK_GLASS_ABSOLUTE_MS = 15 * 60 * 1000;
const BREAK_GLASS_IDLE_MS = 5 * 60 * 1000;

/** Minimum spacing between last_seen_at writes for one session. */
const LAST_SEEN_TOUCH_THROTTLE_MS = 60 * 1000;

function idleWindowMs(source: AuthSource) {
  return source === "break_glass" ? BREAK_GLASS_IDLE_MS : NORMAL_IDLE_MS;
}

function absoluteWindowMs(source: AuthSource) {
  return source === "break_glass" ? BREAK_GLASS_ABSOLUTE_MS : NORMAL_ABSOLUTE_MS;
}

export type AuthSessionRecord = typeof authSessions.$inferSelect;

export type SessionUserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  authVersion: number;
};

export type AuthSessionDenialReason =
  | "missing"
  | "revoked"
  | "idle_expired"
  | "absolute_expired"
  | "auth_version_mismatch"
  | "user_inactive"
  | "unavailable";

export type AuthSessionValidation =
  | { ok: true; session: AuthSessionRecord; user: SessionUserRecord }
  | { ok: false; reason: AuthSessionDenialReason };

function safeRecordSecurityEvent(
  input: Parameters<typeof recordSecurityEvent>[0],
  db: AppDatabase,
) {
  try {
    recordSecurityEvent(input, db);
  } catch {
    // The security event stream must never break the request it observes.
  }
}

export function createAuthSession(
  params: {
    userId: string;
    authSource: AuthSource;
    providerSid?: string | null;
    emergencyActivationId?: string | null;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): AuthSessionRecord {
  const now = params.now ?? new Date();
  const user = db
    .select({ authVersion: users.authVersion })
    .from(users)
    .where(eq(users.id, params.userId))
    .get();

  if (!user) {
    throw new Error(`Cannot create an auth session for unknown user ${params.userId}.`);
  }

  const row: AuthSessionRecord = {
    id: crypto.randomUUID(),
    userId: params.userId,
    authSource: params.authSource,
    authVersion: user.authVersion,
    providerSid: params.providerSid ?? null,
    status: "active",
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    idleExpiresAt: new Date(now.getTime() + idleWindowMs(params.authSource)).toISOString(),
    absoluteExpiresAt: new Date(
      now.getTime() + absoluteWindowMs(params.authSource),
    ).toISOString(),
    revokedAt: null,
    revokedReason: null,
    emergencyActivationId: params.emergencyActivationId ?? null,
  };

  db.insert(authSessions).values(row).run();

  safeRecordSecurityEvent(
    {
      type: "auth.session.created",
      outcome: "success",
      userId: params.userId,
      sessionId: row.id,
      detail: `Session created; auth source: ${params.authSource}.`,
      metadata: { authSource: params.authSource },
      now,
    },
    db,
  );

  return row;
}

function markSession(
  db: AppDatabase,
  sessionId: string,
  status: AuthSessionStatus,
  now: Date,
  revokedReason: string | null,
) {
  db.update(authSessions)
    .set({
      status,
      revokedAt: status === "revoked" ? now.toISOString() : null,
      revokedReason,
    })
    .where(eq(authSessions.id, sessionId))
    .run();
}

export function validateAuthSession(
  sessionId: string,
  options: { now?: Date } = {},
  db: AppDatabase = getAppDb(),
): AuthSessionValidation {
  try {
    const row = db
      .select({
        session: authSessions,
        user: {
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          isActive: users.isActive,
          authVersion: users.authVersion,
        },
      })
      .from(authSessions)
      .innerJoin(users, eq(authSessions.userId, users.id))
      .where(eq(authSessions.id, sessionId))
      .get();

    if (!row) {
      return { ok: false, reason: "missing" };
    }

    const { session, user } = row;
    const now = options.now ?? new Date();
    const nowMs = now.getTime();

    if (session.status === "revoked") {
      return { ok: false, reason: "revoked" };
    }

    if (nowMs >= Date.parse(session.absoluteExpiresAt)) {
      if (session.status !== "expired") {
        markSession(db, session.id, "expired", now, null);
        safeRecordSecurityEvent(
          {
            type: "auth.session.expired",
            outcome: "success",
            userId: session.userId,
            sessionId: session.id,
            detail: "Session reached its absolute expiry.",
            metadata: { cause: "absolute" },
            now,
          },
          db,
        );
      }
      return { ok: false, reason: "absolute_expired" };
    }

    if (nowMs >= Date.parse(session.idleExpiresAt)) {
      if (session.status !== "expired") {
        markSession(db, session.id, "expired", now, null);
        safeRecordSecurityEvent(
          {
            type: "auth.session.expired",
            outcome: "success",
            userId: session.userId,
            sessionId: session.id,
            detail: "Session reached its idle expiry.",
            metadata: { cause: "idle" },
            now,
          },
          db,
        );
      }
      return { ok: false, reason: "idle_expired" };
    }

    if (session.status === "expired") {
      return { ok: false, reason: "idle_expired" };
    }

    if (session.authVersion !== user.authVersion) {
      markSession(db, session.id, "revoked", now, "auth_version_changed");
      safeRecordSecurityEvent(
        {
          type: "auth.session.revoked",
          outcome: "success",
          userId: session.userId,
          sessionId: session.id,
          detail: "Session revoked because the user auth version changed.",
          metadata: { reason: "auth_version_changed" },
          now,
        },
        db,
      );
      return { ok: false, reason: "auth_version_mismatch" };
    }

    if (!user.isActive) {
      markSession(db, session.id, "revoked", now, "user_inactive");
      safeRecordSecurityEvent(
        {
          type: "auth.session.revoked",
          outcome: "success",
          userId: session.userId,
          sessionId: session.id,
          detail: "Session revoked because the user is inactive.",
          metadata: { reason: "user_inactive" },
          now,
        },
        db,
      );
      return { ok: false, reason: "user_inactive" };
    }

    if (nowMs - Date.parse(session.lastSeenAt) >= LAST_SEEN_TOUCH_THROTTLE_MS) {
      const idleExpiresAt = new Date(nowMs + idleWindowMs(session.authSource)).toISOString();
      db.update(authSessions)
        .set({ lastSeenAt: now.toISOString(), idleExpiresAt })
        .where(eq(authSessions.id, session.id))
        .run();
      session.lastSeenAt = now.toISOString();
      session.idleExpiresAt = idleExpiresAt;
    }

    return { ok: true, session, user };
  } catch {
    // A session-check outage must fail closed (plan section 7.3).
    return { ok: false, reason: "unavailable" };
  }
}

export function revokeAuthSession(
  sessionId: string,
  reason: string,
  db: AppDatabase = getAppDb(),
): boolean {
  const now = new Date();
  const result = db
    .update(authSessions)
    .set({ status: "revoked", revokedAt: now.toISOString(), revokedReason: reason })
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.status, "active")))
    .run();

  if (result.changes === 0) {
    return false;
  }

  const session = db
    .select({ userId: authSessions.userId })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .get();

  safeRecordSecurityEvent(
    {
      type: "auth.session.revoked",
      outcome: "success",
      userId: session?.userId ?? null,
      sessionId,
      detail: `Session revoked (${reason}).`,
      metadata: { reason },
      now,
    },
    db,
  );

  return true;
}

export function revokeUserSessions(
  userId: string,
  reason: string,
  db: AppDatabase = getAppDb(),
  options: { exceptSessionId?: string } = {},
): number {
  const now = new Date();
  const active = db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      options.exceptSessionId
        ? and(
            eq(authSessions.userId, userId),
            eq(authSessions.status, "active"),
            ne(authSessions.id, options.exceptSessionId),
          )
        : and(eq(authSessions.userId, userId), eq(authSessions.status, "active")),
    )
    .all();

  for (const session of active) {
    db.update(authSessions)
      .set({ status: "revoked", revokedAt: now.toISOString(), revokedReason: reason })
      .where(eq(authSessions.id, session.id))
      .run();

    safeRecordSecurityEvent(
      {
        type: "auth.session.revoked",
        outcome: "success",
        userId,
        sessionId: session.id,
        detail: `User session revoked (${reason}).`,
        metadata: { reason },
        now,
      },
      db,
    );
  }

  return active.length;
}

export function bumpUserAuthVersion(userId: string, db: AppDatabase = getAppDb()): void {
  db.update(users)
    .set({
      authVersion: sql<number>`${users.authVersion} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, userId))
    .run();
}

/**
 * Plan section 7.3: user suspension, local role change, identity retirement,
 * password rotation, break-glass rotation, or administrator revoke increments
 * users.auth_version and revokes active session rows in one transaction.
 */
export function retireUserSessions(
  params: { userId: string; reason: string },
  db: AppDatabase = getAppDb(),
): { revokedCount: number } {
  return db.transaction((tx) => {
    tx.update(users)
      .set({
        authVersion: sql<number>`${users.authVersion} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, params.userId))
      .run();

    const revokedCount = revokeUserSessions(params.userId, params.reason, tx as AppDatabase);
    return { revokedCount };
  });
}
