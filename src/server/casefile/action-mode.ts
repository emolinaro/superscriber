import { and, eq, isNull } from "drizzle-orm";
import { validateGovernedReason } from "@/domain/casefile";
import type { AdminActionSession, Principal } from "@/domain/models";
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
import { adminActionSessions, recordings } from "@/server/db/schema";
import { runGovernedTransaction } from "@/server/db/transaction";

const ACTION_MODE_DURATION_MS = 30 * 60 * 1000;

export type ResolveActorContextInput = {
  recordingId: string;
  requiredEffectiveRole: AdminActionSession["effectiveRole"];
  actionModeId?: string | null;
};

export type EnterActionModeInput = {
  principal: Principal;
  recordingId: string;
  effectiveRole: AdminActionSession["effectiveRole"];
  purpose: string;
};

export type ExitActionModeInput = {
  principal: Principal;
  recordingId: string;
  actionModeId: string;
};

export type ResolvedAdminActionMode = Pick<AdminActionSession, "id" | "effectiveRole" | "expiresAt">;

function toAdminActionSession(
  row: typeof adminActionSessions.$inferSelect,
): AdminActionSession {
  return {
    id: row.id,
    adminUserId: row.adminUserId,
    recordingId: row.recordingId,
    effectiveRole: row.effectiveRole,
    purpose: row.purpose,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
  };
}

function requireAdmin(principal: Principal, message: string) {
  if (principal.role !== "admin") {
    throw new CasefileCommandError("ACTION_MODE_FORBIDDEN", message);
  }
}

function actionModeRequiredError() {
  return new CasefileCommandError(
    "ACTION_MODE_REQUIRED",
    "Enter admin action mode again before performing this governed action.",
  );
}

function actionModeExpiredError() {
  return new CasefileCommandError(
    "ACTION_MODE_EXPIRED",
    "This admin action mode expired. Enter admin action mode again.",
  );
}

function actionModeEndedError() {
  return new CasefileCommandError(
    "ACTION_MODE_ENDED",
    "This admin action mode has already ended. Enter admin action mode again.",
  );
}

function getRecordingContext(db: AppDatabase, recordingId: string) {
  return db
    .select({
      id: recordings.id,
      workspaceId: recordings.workspaceId,
    })
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .get();
}

function getRecordingContextOrThrow(db: AppDatabase, recordingId: string) {
  const recording = getRecordingContext(db, recordingId);
  if (!recording) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Choose a valid recording before entering admin action mode.",
      {
        recordingId: "Choose a valid recording before entering admin action mode.",
      },
    );
  }

  return recording;
}

function getActionModeById(db: AppDatabase, actionModeId: string) {
  return db
    .select()
    .from(adminActionSessions)
    .where(eq(adminActionSessions.id, actionModeId))
    .get();
}

function findActiveActionMode(
  db: AppDatabase,
  adminUserId: string,
  recordingId: string,
) {
  return db
    .select()
    .from(adminActionSessions)
    .where(
      and(
        eq(adminActionSessions.adminUserId, adminUserId),
        eq(adminActionSessions.recordingId, recordingId),
        isNull(adminActionSessions.endedAt),
      ),
    )
    .get();
}

function actionModeActor(
  principal: Principal,
  session: Pick<AdminActionSession, "id" | "effectiveRole">,
): ActorContext {
  return {
    ...actorContextForPrincipal(principal),
    effectiveRole: session.effectiveRole,
    adminActionSessionId: session.id,
  };
}

function endActionModeSession(
  db: AppDatabase,
  session: typeof adminActionSessions.$inferSelect,
  endReason: NonNullable<AdminActionSession["endReason"]>,
  now: string,
  principal: Principal,
) {
  const result = db
    .update(adminActionSessions)
    .set({
      endedAt: now,
      endReason,
    })
    .where(
      and(eq(adminActionSessions.id, session.id), isNull(adminActionSessions.endedAt)),
    )
    .run();

  const endedRow =
    result.changes > 0
      ? {
          ...session,
          endedAt: now,
          endReason,
        }
      : getActionModeById(db, session.id);

  if (!endedRow) {
    throw actionModeRequiredError();
  }

  if (result.changes > 0) {
    const recording = getRecordingContextOrThrow(db, session.recordingId);
    insertAuditEvent(db, {
      workspaceId: recording.workspaceId,
      recordingId: session.recordingId,
      actor: actionModeActor(principal, session),
      type: "admin.action_mode.exited",
      detail: `Admin action mode ${endReason}.`,
      metadata: {
        actionModeId: session.id,
        effectiveRole: session.effectiveRole,
        endReason,
      },
      createdAt: now,
    });
  }

  return toAdminActionSession(endedRow);
}

function loadValidatedAdminActionMode(
  db: AppDatabase,
  principal: Principal,
  input: ResolveActorContextInput,
) {
  if (!input.actionModeId) {
    throw actionModeRequiredError();
  }

  const session = getActionModeById(db, input.actionModeId);
  if (
    !session ||
    session.adminUserId !== principal.userId ||
    session.recordingId !== input.recordingId ||
    session.effectiveRole !== input.requiredEffectiveRole
  ) {
    throw actionModeRequiredError();
  }

  return session;
}

function isExpired(session: Pick<AdminActionSession, "expiresAt">, now: string) {
  return Date.parse(now) >= Date.parse(session.expiresAt);
}

export function enterActionMode(
  input: EnterActionModeInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): AdminActionSession {
  requireAdmin(input.principal, "Only admins can enter admin action mode.");

  return runGovernedTransaction((db, now) => {
    const recording = getRecordingContextOrThrow(db, input.recordingId);
    const purpose = validateGovernedReason(input.purpose);
    const activeSession = findActiveActionMode(db, input.principal.userId, input.recordingId);

    if (activeSession) {
      endActionModeSession(db, activeSession, "switched", now, input.principal);
    }

    const row = {
      id: crypto.randomUUID(),
      adminUserId: input.principal.userId,
      recordingId: input.recordingId,
      effectiveRole: input.effectiveRole,
      purpose,
      startedAt: now,
      expiresAt: new Date(Date.parse(now) + ACTION_MODE_DURATION_MS).toISOString(),
      endedAt: null,
      endReason: null,
    } satisfies typeof adminActionSessions.$inferInsert;

    db.insert(adminActionSessions).values(row).run();
    insertAuditEvent(db, {
      workspaceId: recording.workspaceId,
      recordingId: input.recordingId,
      actor: actionModeActor(input.principal, row),
      type: "admin.action_mode.entered",
      detail: `Admin entered ${input.effectiveRole} action mode.`,
      metadata: {
        actionModeId: row.id,
        effectiveRole: row.effectiveRole,
        purpose: row.purpose,
        expiresAt: row.expiresAt,
      },
      createdAt: now,
    });

    return toAdminActionSession(row);
  }, bundle);
}

export function exitActionMode(
  input: ExitActionModeInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): AdminActionSession {
  requireAdmin(input.principal, "Only admins can exit admin action mode.");

  return runGovernedTransaction((db, now) => {
    const session = loadValidatedAdminActionMode(db, input.principal, {
      recordingId: input.recordingId,
      requiredEffectiveRole: getActionModeById(db, input.actionModeId)?.effectiveRole ?? "reviewer",
      actionModeId: input.actionModeId,
    });

    if (session.endedAt) {
      throw actionModeEndedError();
    }

    if (isExpired(session, now)) {
      endActionModeSession(db, session, "expired", now, input.principal);
      throw actionModeExpiredError();
    }

    return endActionModeSession(db, session, "exited", now, input.principal);
  }, bundle);
}

export function resolveActorContext(
  principal: Principal,
  input: ResolveActorContextInput,
  db: AppDatabase = getAppDb(),
  now = new Date().toISOString(),
): ActorContext {
  if (principal.role !== "admin") {
    if (input.actionModeId) {
      throw new CasefileCommandError(
        "ACTION_MODE_FORBIDDEN",
        "Only admins may use admin action mode.",
      );
    }

    if (principal.role !== input.requiredEffectiveRole) {
      throw new CasefileCommandError(
        "ACTION_MODE_FORBIDDEN",
        "Your account cannot perform this governed action.",
      );
    }

    return actorContextForPrincipal(principal);
  }

  const session = loadValidatedAdminActionMode(db, principal, input);
  if (session.endedAt) {
    throw actionModeEndedError();
  }

  if (isExpired(session, now)) {
    endActionModeSession(db, session, "expired", now, principal);
    throw actionModeExpiredError();
  }

  return actionModeActor(principal, session);
}

export function resolveActionMode(
  principal: Principal,
  input: ResolveActorContextInput,
  db: AppDatabase = getAppDb(),
  now = new Date().toISOString(),
): ResolvedAdminActionMode | null {
  if (principal.role !== "admin") {
    return null;
  }

  const session = loadValidatedAdminActionMode(db, principal, input);
  if (session.endedAt) {
    throw actionModeEndedError();
  }

  if (isExpired(session, now)) {
    endActionModeSession(db, session, "expired", now, principal);
    throw actionModeExpiredError();
  }

  return {
    id: session.id,
    effectiveRole: session.effectiveRole,
    expiresAt: session.expiresAt,
  };
}
